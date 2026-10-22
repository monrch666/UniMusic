import { test } from "node:test";
import assert from "node:assert/strict";
import { YandexMusic, yandexTrack, yandexUrl } from "../electron/yandex";
import { MediaProxy } from "../electron/media";
import { durableTrack, validateSnapshot } from "../electron/state";
import { trackKey } from "../src/playbackQueue";
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const song = { id: 17, title: "Song", durationMs: 180000, artists: [{ id: 4, name: "Artist" }], albums: [{ id: 7, title: "Album" }], coverUri: "avatars.yandex.net/image/%%" };

test("Yandex device flow keeps credentials in main, supports pending and confirmed login", async () => {
  let token: string | null = null; let polls = 0;
  const api = new YandexMusic(async (url, init) => {
    if (String(url).endsWith("/device/code")) return response({ device_code: "private-device", user_code: "ABCD", verification_url: "https://ya.ru/device", interval: 5, expires_in: 600 });
    if (String(url).endsWith("/token")) { polls++; assert.equal(new URLSearchParams(String(init?.body)).get("code"), "private-device"); return response({ access_token: "fixture-yandex-token" }); }
    assert.equal(new Headers(init?.headers).get("Authorization"), "OAuth fixture-yandex-token");
    return response({ result: { account: { uid: 42, displayName: "Person" }, plus: { hasPlus: true } } });
  }, () => token, async value => { token = value; });
  const waiting = await api.auth("begin"); assert.equal(waiting.code, "ABCD"); assert.equal(JSON.stringify(waiting).includes("private-device"), false);
  const done = await api.auth("poll"); assert.equal(done.profile?.plus, true); assert.equal(done.profile?.id, 42);
  assert.equal(JSON.stringify(done).includes("fixture-yandex-token"), false); assert.equal(polls, 1);
  await api.auth("logout"); assert.equal(token, null);
});

test("Yandex polling obeys the interval and cancellation rejects late credentials", async () => {
  let polls = 0; let saved = false;
  const api = new YandexMusic(async url => {
    if (String(url).endsWith("/device/code")) return response({ device_code: "private", user_code: "CODE", verification_url: "https://oauth.yandex.ru/device", interval: 5, expires_in: 600 });
    polls++; return response({ error: "authorization_pending" }, 400);
  }, () => null, async () => { saved = true; });
  await api.auth("begin"); await api.auth("poll"); await api.auth("poll"); assert.equal(polls, 1);
  await api.auth("cancel"); await assert.rejects(api.auth("poll")); assert.equal(saved, false);
  let release!: (value: Response) => void;
  const pending = new YandexMusic(async url => String(url).endsWith("/device/code") ? response({ device_code: "private", user_code: "CODE", verification_url: "https://ya.ru/device", expires_in: 600 }) : new Promise(resolve => { release = resolve; }), () => null, async () => { saved = true; });
  await pending.auth("begin"); const task = pending.auth("poll"); await pending.auth("cancel"); release(response({ access_token: "late-token-must-not-save" }));
  assert.equal((await task).step, "idle"); assert.equal(saved, false);
});

test("Yandex collection resolves paginated references and preserves service identity", async () => {
  const api = new YandexMusic(async (url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "OAuth fixture-token");
    if (String(url).endsWith("account/status")) return response({ result: { account: { uid: 42 }, plus: { hasPlus: false } } });
    if (String(url).endsWith("likes/tracks")) return response({ result: { library: { tracks: [{ id: 17 }, { id: 18 }] } } });
    assert.equal(new URLSearchParams(String(init?.body)).get("track-ids"), "18"); return response({ result: [{ ...song, id: 18 }] });
  }, () => "fixture-token", async () => {});
  const page = await api.browse({ kind: "library", source: "yandex", offset: 1 });
  assert.equal(page.count, 2); assert.equal(page.tracks[0].saved, true); assert.equal(page.tracks[0].id, 18);
  const track = durableTrack(page.tracks[0]); const key = trackKey(track);
  assert.equal(key, "yandex:0_18"); assert.notEqual(key, trackKey({ ...track, source: "vk" }));
  const restored = validateSnapshot({ queue: [track], order: [key], currentKey: key, source: { source: "yandex", kind: "library" } });
  assert.equal(restored?.source?.source, "yandex"); assert.equal(restored?.currentKey, key); assert.equal(restored?.queue[0].albumRef?.kind, "album");
});

test("Yandex refuses preview tracks and never sends OAuth to CDN", async () => {
  let preview = true; let cdnCalls = 0;
  const api = new YandexMusic(async (url, init) => {
    if (String(url).endsWith("/tracks")) return response({ result: [song] });
    if (String(url).includes("api.music.yandex.net")) return response({ result: [{ codec: "mp3", preview, bitrateInKbps: 320, downloadInfoUrl: "https://storage.yandex.net/info" }] });
    cdnCalls++; assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return new Response("<download-info><host>storage.yandex.net</host><path>/song.mp3</path><ts>68beac3a</ts><s>salt</s></download-info>");
  }, () => "fixture-token", async () => {});
  await assert.rejects(api.resolve(yandexTrack(song)), (e: any) => e.code === 402); assert.equal(cdnCalls, 0);
  preview = false; const result = await api.resolve(yandexTrack(song)); assert.match(result.url, /^https:\/\/storage.yandex.net\/get-mp3\/[a-f0-9]{32}\/68beac3a\/song.mp3$/);
});

test("My Wave continues after feedback, deduplicates batches and stops an empty sequence", async () => {
  let calls = 0; const events: any[] = [];
  const api = new YandexMusic(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/feedback")) { assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json"); events.push(JSON.parse(String(init?.body))); return response({ result: "ok" }); }
    if (url.pathname.includes("rotor/")) {
      calls++;
      if (calls > 1) assert.equal(url.searchParams.get("queue"), "17");
      return response({ result: { batchId: `batch-${calls}`, sequence: (calls === 1 ? [song] : calls === 2 ? [song, { ...song, id: 18 }] : []).map(track => ({ track })) } });
    }
    if (url.pathname.endsWith("account/status")) return response({ result: { account: { uid: 42 } } });
    return response({ result: { library: { tracks: [] } } });
  }, () => "fixture-token", async () => {});
  const first = await api.browse({ source: "yandex", kind: "recommendations" });
  assert.equal(first.tracks.length, 1); assert.equal(first.count, 2);
  await api.waveFeedback(first.tracks[0], "trackStarted", 0);
  await api.waveFeedback(first.tracks[0], "skip", 12.5);
  assert.deepEqual(events.map(e => e.type), ["radioStarted", "trackStarted", "skip"]);
  assert.equal(events[2].totalPlayedSeconds, 12.5);
  const second = await api.browse({ source: "yandex", kind: "recommendations", offset: 1 });
  assert.deepEqual(second.tracks.map(t => t.id), [18]);
  const end = await api.browse({ source: "yandex", kind: "recommendations", offset: 2 });
  assert.equal(end.count, 2); assert.equal(end.tracks.length, 0);
  await api.auth("logout");
  await api.waveFeedback(first.tracks[0], "skip", 1); assert.equal(events.length, 3);
});

test("Yandex lyrics use a signed request and fetch text without OAuth or redirects", async () => {
  let foreign = false;
  const api = new YandexMusic(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.music.yandex.net") {
      assert.equal(url.searchParams.get("format"), "TEXT"); assert.ok(url.searchParams.get("sign")); assert.ok(url.searchParams.get("timeStamp"));
      return response({ result: { downloadUrl: foreign ? "https://yandex.net.evil.test/text" : "https://storage.yandex.net/text" } });
    }
    assert.equal(new Headers(init?.headers).has("Authorization"), false); assert.equal(init?.redirect, "error");
    return new Response("Тестовый текст\nВторая строка");
  }, () => "fixture-token", async () => {});
  assert.equal(await api.lyrics(17), "Тестовый текст\nВторая строка");
  foreign = true; await assert.rejects(api.lyrics(17), /Недопустимый адрес/);
});

test("Yandex media rejects lookalike hosts and cross-service redirects", async () => {
  for (const url of ["https://yandex.net.evil.test/a", "http://yandex.net/a", "https://user:pass@yandex.net/a", "https://127.0.0.1/a"]) assert.throws(() => yandexUrl(url));
  const proxy = new MediaProxy(async () => new Response(null, { status: 302, headers: { Location: "https://vk.com/a.mp3" } }));
  const url = proxy.register("https://storage.yandex.net/a.mp3"); assert.equal((await proxy.handle(new Request(url))).status, 502);
});

test("Yandex permission and session errors stop playback without VK session error codes", async () => {
  for (const [status, code] of [[401,401],[403,402],[429,429]]) {
    const api = new YandexMusic(async () => response({}, status), () => "fixture-token", async () => {});
    await assert.rejects(api.profile(), (error: any) => error.code === code && !error.message.includes("fixture-token"));
  }
});

test("Yandex search, playlists, artist albums and likes use their own routes", async () => {
  const calls: string[] = [];
  const p = { kind: 8, owner: { uid: 42 }, title: "Playlist", trackCount: 2 };
  const api = new YandexMusic(async (input, init) => {
    const url = new URL(String(input)); const path = url.pathname; calls.push(path);
    const params = new URLSearchParams(String(init?.body ?? ""));
    if (path === "/account/status") return response({ result: { account: { uid: 42 }, plus: { hasPlus: true } } });
    if (path === "/users/42/likes/tracks") return response({ result: { library: { tracks: [{ id: 17 }] } } });
    if (path === "/users/42/dislikes/tracks") return response({ result: { library: { tracks: [] } } });
    if (path === "/search") {
      assert.equal(url.searchParams.get("page"), "1"); assert.equal(url.searchParams.get("text"), "Song");
      return response({ result: { tracks: { total: 21, results: [song] } } });
    }
    if (path === "/users/42/playlists/list") return response({ result: [p] });
    if (path === "/users/42/playlists/8") return response({ result: { ...p, tracks: [{ id: 18 }, { id: 17 }] } });
    if (path === "/tracks") return response({ result: params.get("track-ids") === "18,17" ? [song, { ...song, id: 18 }] : [song] });
    if (path === "/albums/7/with-tracks") return response({ result: { volumes: [[song]] } });
    if (path === "/artists/4/tracks") return response({ result: { tracks: [song], pager: { total: 1 } } });
    if (path === "/artists/4/direct-albums") return response({ result: { albums: [{ id: 7, title: "Album", trackCount: 1 }], pager: { total: 1 } } });
    if (path === "/users/42/likes/tracks/add-multiple" || path === "/users/42/likes/tracks/remove") {
      assert.equal(params.get("track-ids"), "17"); return response({ result: { revision: 2 } });
    }
    throw new Error(`Unexpected route: ${path}`);
  }, () => "fixture-token", async () => {});
  const search = await api.browse({ source: "yandex", kind: "search", query: "Song", offset: 20 });
  assert.equal(search.tracks[0].saved, true); assert.equal(search.count, 21);
  const playlists = await api.playlists(); assert.equal(playlists.items[0].source, "yandex");
  const page = await api.browse({ kind: "playlist", playlist: playlists.items[0] }); assert.deepEqual(page.tracks.map(t => t.id), [18,17]);
  const albums = await api.browse({ kind: "catalog", artistId: "4" });
  assert.equal(albums.playlists[0].original?.kind, "album");
  assert.equal((await api.browse({ kind: "playlist", playlist: albums.playlists[0].original })).tracks[0].id, 17);
  assert.equal((await api.browse({ kind: "artist", artistId: "4" })).tracks[0].id, 17);
  const added = await api.library({ type: "add", track: yandexTrack(song) }); assert.equal(added.track?.saved, true);
  const removed = await api.library({ type: "delete", track: added.track! }); assert.equal(removed.track?.saved, false);
  assert.ok(calls.includes("/users/42/likes/tracks/remove"));
});

test("missing Yandex recordings retain their queue position as unavailable", async () => {
  const api = new YandexMusic(async input => {
    if (String(input).endsWith("account/status")) return response({ result: { account: { uid: 42 } } });
    if (String(input).endsWith("likes/tracks")) return response({ result: { library: { tracks: [{ id: 18 }, { id: 17 }] } } });
    return response({ result: [song] });
  }, () => "fixture-token", async () => {});
  const result = await api.browse({ kind: "library" });
  assert.deepEqual(result.tracks.map(t => t.id), [18,17]); assert.equal(result.tracks[0].restricted, true);
  assert.equal(result.count, 2);
});

test("Yandex likes and dislikes are mutually exclusive and can be undone", async () => {
  let liked = true, disliked = false;
  const api = new YandexMusic(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/account/status") return response({ result: { account: { uid: 42 } } });
    if (path === "/tracks") return response({ result: [song] });
    if (path.endsWith("/add-multiple") || path.endsWith("/remove")) {
      assert.equal(new URLSearchParams(String(init?.body)).get("track-ids"), "17");
      if (path.includes("/dislikes/")) { disliked = path.endsWith("/add-multiple"); if (disliked) liked = false; }
      else { liked = path.endsWith("/add-multiple"); if (liked) disliked = false; }
      return response({ result: { revision: 3 } });
    }
    return response({ result: { library: { tracks: (path.includes("/dislikes/") ? disliked : liked) ? [{ id: 17 }] : [] } } });
  }, () => "fixture-token", async () => {});
  const track = yandexTrack(song);
  const down = await api.library({ type: "dislike", track });
  assert.equal(down.track?.disliked, true); assert.equal(down.track?.saved, false);
  const undone = await api.library({ type: "undislike", track }); assert.equal(undone.track?.disliked, false);
  await api.library({ type: "dislike", track });
  const up = await api.library({ type: "add", track }); assert.equal(up.track?.saved, true); assert.equal(up.track?.disliked, false);
  const current = await api.library({ type: "reactions", track }); assert.equal(current.track?.saved, true); assert.equal(current.track?.disliked, false);
});
