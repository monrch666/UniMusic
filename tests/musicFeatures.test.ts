import { updateSavedTracks } from "../src/libraryState";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPreferences, durableTrack, JsonFile, selectAutoCacheTrack, validatePreferences, validateSnapshot } from "../electron/state";
import { MediaProxy } from "../electron/media";
import { OfflineStore, safeFileName, saveHls } from "../electron/offline";
import { VkClient } from "../electron/vk";
import { insertNext, orderedQueue, shuffledOrder, trackKey } from "../src/playbackQueue";
import type { Track } from "../src/shared";
const track = (id: number): Track => ({ id, ownerId: 12, title: `Track ${id}`, artist: "Artist", duration: 60, url: "", restricted: false });

test("shuffle visits each track once and insertion/reordering preserve one copy", () => {
  const tracks = [track(1), track(2), track(3), track(4)];
  const order = shuffledOrder(tracks, trackKey(tracks[1]), () => .2);
  assert.equal(order[0], "12_2");
  assert.equal(new Set(order).size, 4);
  assert.deepEqual(orderedQueue(tracks, order).map(trackKey), order);
  const inserted = insertNext(tracks, tracks[0], tracks[3]);
  assert.deepEqual(inserted.map(t => t.id), [1, 4, 2, 3]);
  assert.equal(insertNext(tracks, tracks[0], tracks[0]), tracks);
});

test("persisted queue strips media URLs and unknown secrets, validates references", () => {
  const data = validateSnapshot({ queue: [{ ...track(1), url: "https://cdn.test/?token=secret", cover: "https://cdn.test/private", accessToken: "secret" }],
    currentKey: "12_1", order: ["12_1", "12_1", "12_8"], position: 35, shuffle: true, repeat: "all", loaded: 1, total: 300,
    source: { kind: "library", access_token: "secret" } })!;
  assert.equal(JSON.stringify(data).includes("secret"), false);
  assert.deepEqual(data.order, ["12_1"]);
  assert.equal(data.total, 300);
  assert.equal(data.position, 35);
  assert.throws(() => durableTrack({ ...track(1), id: "../secret" }));
});

test("network preferences reject credentials and renderer-controlled download paths", () => {
  const previous = defaultPreferences("C:/Music");
  for (const url of ["file:///C:/secret", "http://user:pass@host", "http://host/?token=x"]) assert.throws(() => validatePreferences({ proxyAddress: url }, previous));
  assert.throws(() => validatePreferences({ equalizer: [13,0,0,0,0] }, previous));
  assert.throws(() => validatePreferences({ proxyMode: "custom" }, previous));
  assert.equal(validatePreferences({ downloadDirectory: "C:/Windows" }, previous).downloadDirectory, "C:/Music");
  assert.equal(validatePreferences({ proxyMode: "direct" }, previous).proxyMode, "direct");
});

test("local media supports seeking and cannot open a renderer-chosen path", async () => {
  const folder = await mkdtemp(join(tmpdir(), "unimusic-files-"));
  try {
    const path = join(folder, "track.mp3"); await writeFile(path, "0123456789");
    const proxy = new MediaProxy(async () => { throw new Error("must remain offline"); });
    const url = proxy.registerFile(path);
    assert.equal(url.includes(folder), false);
    const response = await proxy.handle(new Request(url, { headers: { Range: "bytes=3-6" } }));
    assert.equal(response.status, 206); assert.equal(await response.text(), "3456");
    assert.equal(response.headers.get("content-range"), "bytes 3-6/10");
    assert.equal((await proxy.handle(new Request(url, { headers: { Range: "bytes=99-" } }))).status, 416);
    assert.equal(await (await proxy.handle(new Request(url, { headers: { Range: "bytes=-2" } }))).text(), "89");
    assert.equal((await proxy.handle(new Request("unimusic-media://file/C:/Windows/file.mp3"))).status, 404);
    proxy.clear(); assert.equal((await proxy.handle(new Request(url))).status, 404);
  } finally { await rm(folder, { recursive: true, force: true }); }
});


test("HLS download materializes key, map and segments without network URLs in manifest", async () => {
  const folder = await mkdtemp(join(tmpdir(), "unimusic-hls-"));
  const base = "unimusic-media://stream/";
  const manifest = `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${base}key/audio.bin"\n#EXT-X-MAP:URI="${base}map/audio.mp4"\n#EXTINF:5,\n${base}part/audio.ts\n#EXT-X-ENDLIST`;
  try {
    const path = await saveHls(base + "playlist/audio.m3u8", folder, async url => new Response(url.endsWith(".m3u8") ? manifest : "bytes"), new AbortController().signal, () => {});
    const text = await readFile(path, "utf8");
    assert.equal(text.includes("unimusic-media"), false);
    assert.match(text, /URI="part-0.bin"/);
    await assert.rejects(() => saveHls(base + "playlist", folder, async () => new Response("#EXTM3U\nhttps://evil.test/a\n#EXT-X-ENDLIST"), new AbortController().signal, () => {}));
    assert.equal(safeFileName('A/B:<Test>?'), "A_B__Test__");
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("state writes are serialized and newest snapshot wins", async () => {
  const folder = await mkdtemp(join(tmpdir(), "unimusic-state-"));
  try {
    const file = new JsonFile<number>(folder, "state.json");
    await Promise.all([file.write(1), file.write(2), file.write(3)]);
    assert.equal(await file.read(0), 3);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("library mutations validate ownership, playlist access keys and search filters", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const vk = new VkClient(async (method, params) => { calls.push({ method, params }); return { response: method === "audio.searchArtists" ? { items: [{ id: "artist-a", name: "Artist" }], count: 1 } : { items: [], count: 0 } }; },
    { accessToken: "vk1.a.fixture", userId: 12, expiresAt: null });
  await assert.rejects(() => vk.library({ type: "delete", track: { id: 1, ownerId: 99 } }));
  assert.equal(calls.length, 0);
  await vk.library({ type: "addToPlaylist", playlist: { ownerId: 12, id: 10, accessKey: "key" }, tracks: [{ ownerId: -3, id: 8, accessKey: "access" }] });
  assert.equal(calls[0].params.audio_ids, "-3_8_access");
  assert.equal(calls[0].params.access_key, "key");
  const artists = await vk.browse({ kind: "search", query: "Artist", filters: { type: "artists" } });
  assert.equal(artists.artists[0].id, "artist-a");
  await vk.browse({ kind: "search", query: "Artist", filters: { own: true, performer: true, lyrics: true, autocomplete: false, sort: 2 } });
  assert.equal(calls[2].params.search_own, 1);
  assert.equal(calls[2].params.auto_complete, 0);
  assert.equal(calls[2].params.sort, 2);
});

test("downloaded file resolves offline after saving and reopening the store", async () => {
  const folder = await mkdtemp(join(tmpdir(), "unimusic-download-"));
  const wav = Buffer.alloc(44 + 22050 * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
  const proxy = new MediaProxy(async () => new Response(wav, { headers: { "Content-Type": "audio/wav" } }));
  const song = { ...track(1), duration: 1 };
  const store = new OfflineStore(folder, proxy, () => folder, async t => ({ ...t, url: proxy.register("https://test.example/file.wav") }));
  try {
    await store.init(); await store.enqueue([song], false, true);
    for (let i = 0; i < 200 && ["queued", "downloading"].includes(store.state().entries[0].state); i++) await new Promise(r => setTimeout(r, 25));
    assert.equal(store.state().entries[0].state, "complete", store.state().entries[0].error);
    await store.cancelAutoCache(song);
    assert.equal(store.state().entries[0].state, "complete");
    assert.match((await store.resolve(song))!.url, /^unimusic-media:\/\/file\//);
    await store.enqueue([song]); // Flush the completed snapshot before simulating restart.
    const saved = new OfflineStore(folder, proxy, () => folder, async () => { throw new Error("network unavailable"); });
    await saved.init(); assert.match((await saved.resolve(song))!.url, /^unimusic-media:\/\/file\//);
    assert.ok((await saved.info(song))!.size! > 1000);
    await saved.enqueue([song, song]);
    assert.equal(saved.state().entries.length, 1);
    assert.equal(saved.state().entries[0].state, "complete");
    const yandexSong = { ...song, source: "yandex" as const };
    await store.enqueue([yandexSong, yandexSong]);
    for (let i = 0; i < 200 && store.state().entries.some(e => ["queued", "downloading"].includes(e.state)); i++) await new Promise(r => setTimeout(r, 25));
    assert.equal(store.state().entries.length, 2);
    assert.ok(store.state().entries.every(e => e.state === "complete"));
    await store.enqueue([yandexSong]);
    const reopened = new OfflineStore(folder, proxy, () => folder, async () => { throw new Error("offline"); });
    await reopened.init();
    const vkFile = await reopened.resolve(song), yandexFile = await reopened.resolve(yandexSong);
    assert.ok(vkFile && yandexFile); assert.notEqual(vkFile.url, yandexFile.url);
    assert.equal(yandexFile.source, "yandex");
    await store.clear();
    await saved.clear(); assert.equal(saved.state().entries.length, 0);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("saved song status stays synchronized across original and library copies", () => {
  const original = { ...track(1), ownerId: 99 };
  const saved = track(8);
  const added = updateSavedTracks({}, original, saved);
  assert.equal(added[trackKey(original)], saved);
  assert.equal(added[trackKey(saved)], saved);
  const removed = updateSavedTracks(added, saved, null, saved);
  assert.equal(removed[trackKey(original)], null);
  assert.equal(removed[trackKey(saved)], null);
});
test("adding retains the owned reference when VK metadata is not yet available", async () => {
  const vk = new VkClient(async method => ({ response: method === "audio.add" ? 77 : [] }),
    { accessToken: "vk1.a.fixture", userId: 12, expiresAt: null });
  const result = await vk.library({ type: "add", track: { ...track(1), ownerId: 99 } });
  assert.equal(result.track?.ownerId, 12);
  assert.equal(result.track?.id, 77);
});

test("auto-cache is enabled by default, accepts only booleans and preserves existing preferences", () => {
  const defaults = defaultPreferences("C:/Music");
  assert.equal(defaults.autoCache, true);
  assert.equal(validatePreferences({ preferDownloads: false }, defaults).autoCache, true);
  const disabled = validatePreferences({ autoCache: false }, defaults);
  assert.equal(disabled.autoCache, false);
  assert.equal(validatePreferences({ closeToTray: true }, disabled).autoCache, false);
  assert.throws(() => validatePreferences({ autoCache: "true" }, defaults));
});

test("auto-cache accepts only liked VK and Yandex songs, including My Wave", () => {
  const owned = track(1);
  const wave = { ...track(2), source: "yandex" as const, ownerId: 0 };
  assert.equal(selectAutoCacheTrack(owned, true, 12), owned);
  assert.equal(selectAutoCacheTrack(owned, false, 12), null);
  assert.equal(selectAutoCacheTrack(owned, true), null);
  assert.equal(selectAutoCacheTrack({ ...owned, ownerId: 99, saved: true }, true, 12), null);
  assert.equal(selectAutoCacheTrack({ ...owned, saved: false }, true, 12), null);
  assert.equal(selectAutoCacheTrack(wave, true, 12), null);
  assert.equal(selectAutoCacheTrack({ ...wave, saved: false }, true, 12), null);
  const liked = { ...wave, saved: true };
  assert.equal(selectAutoCacheTrack(liked, true), liked);
  assert.equal(selectAutoCacheTrack({ ...liked, disliked: true }, true), null);
  assert.equal(selectAutoCacheTrack({ ...liked, restricted: true }, true), null);
  assert.equal(selectAutoCacheTrack({ ...owned, source: "local", saved: true }, true, 12), null);
});

test("like changes override stale playback metadata and keep VK aliases synchronized", () => {
  const original = { ...track(1), ownerId: 99 };
  const owned = { ...track(77), saved: true };
  const liked = updateSavedTracks({}, original, owned);
  assert.equal(selectAutoCacheTrack(original, true, 12, liked), owned);
  const unliked = updateSavedTracks(liked, owned, null, owned);
  assert.equal(selectAutoCacheTrack(original, true, 12, unliked), null);
  assert.equal(selectAutoCacheTrack(owned, true, 12, unliked), null);
  const wave = { ...track(77), source: "yandex" as const, ownerId: 0, saved: true };
  assert.equal(selectAutoCacheTrack(wave, true, 12, unliked), wave);
  assert.equal(selectAutoCacheTrack(wave, true, 12, updateSavedTracks(unliked, wave, null, wave)), null);
});

test("unlike cancels automatic jobs and preserves explicit download requests", async () => {
  const folder = await mkdtemp(join(tmpdir(), "unimusic-autocache-"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store = new OfflineStore(folder, new MediaProxy(async () => { throw new Error("No network expected"); }), () => folder,
    async () => { await gate; throw new Error("Fixture finished"); });
  try {
    await store.init();
    await store.enqueue([track(1), track(2), track(3)], false, true);
    await store.enqueue([track(2)]);
    await store.enqueue([track(4)]);
    await store.cancelAutoCache(track(1));
    await store.cancelAutoCache(track(2));
    await store.cancelAutoCache(track(3));
    await store.cancelAutoCache(track(4));
    const entries = store.state().entries;
    assert.equal(entries.find(e => e.track.id === 1)?.state, "cancelled");
    assert.equal(entries.find(e => e.track.id === 3)?.state, "cancelled");
    assert.equal(entries.find(e => e.track.id === 2)?.state, "queued");
    assert.equal(entries.find(e => e.track.id === 4)?.state, "queued");
    assert.ok(entries.every(e => !("automatic" in e)));
  } finally {
    release(); await store.clear();
    assert.ok(folder.startsWith(join(tmpdir(), "unimusic-autocache-")));
    await rm(folder, { recursive: true, force: true });
  }
});
