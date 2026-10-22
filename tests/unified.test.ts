import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnifiedStore } from "../electron/unified";
const vk = { source: "vk", id: 17, ownerId: 0, title: "Song", artist: "Artist", duration: 30, restricted: false, url: "https://example.test?token=secret" };
test("UniMusic mixes services, serializes edits, deduplicates and survives restart without media URLs", async () => {
  const folder = await mkdtemp(join(tmpdir(), "unimusic-unified-"));
  try {
    const store = new UnifiedStore(folder);
    const [p] = await store.run({ type: "create", title: "Mixed", tracks: [vk] });
    await Promise.all([store.run({ type: "add", id: p.id, tracks: [{ ...vk, source: "yandex" }, vk] }), store.run({ type: "rename", id: p.id, title: "Together" })]);
    const [saved] = await new UnifiedStore(folder).run({ type: "list" });
    assert.equal(saved.title, "Together"); assert.equal(saved.tracks.length, 2);
    assert.equal((await readFile(join(folder, "unimusic-playlists.json"), "utf8")).includes("secret"), false);
    const [removed] = await store.run({ type: "remove", id: p.id, tracks: [vk] });
    assert.equal(removed.tracks[0].source, "yandex"); assert.equal(removed.tracks.length, 1);
    await assert.rejects(store.run({ type: "rename", id: p.id, title: " " }));
    await assert.rejects(store.run({ type: "add", id: p.id, tracks: [{ id: "bad" }] }));
    assert.equal((await store.run({ type: "list" }))[0].tracks.length, 1);
    assert.deepEqual(await store.run({ type: "delete", id: p.id }), []);
    await writeFile(join(folder, "unimusic-playlists.json"), "broken-json");
    await assert.rejects(store.run({ type: "create", title: "Must not overwrite" }), /Исходный файл сохранён/);
    assert.equal(await readFile(join(folder, "unimusic-playlists.json"), "utf8"), "broken-json");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
