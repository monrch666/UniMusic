import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaProxy } from "../electron/media";
import { MUSIC_USER_AGENT } from "../electron/vk";

test("media URLs are opaque, can be revoked and never accept unregistered renderer URLs", async () => {
  let calls = 0;
  const proxy = new MediaProxy(async () => { calls++; return new Response("audio"); });
  const url = proxy.register("https://cdn.example.test/song.mp3?secret=signed-url");
  assert.match(url, /^unimusic-media:\/\/stream\/[\w-]+\/audio\.mp3$/);
  assert.equal(url.includes("secret"), false);
  assert.equal((await proxy.handle(new Request("unimusic-media://stream/missing/audio.mp3"))).status, 404);
  proxy.clear();
  assert.equal((await proxy.handle(new Request(url))).status, 404);
  assert.equal(calls, 0);
  for (const bad of ["http://cdn.test/x", "file:///secret", "https://name:pass@cdn.test/x", "https://cdn.test:8443/x"])
    assert.throws(() => proxy.register(bad));
});

test("media uses Android UA, preserves byte ranges and supplies audio CORS without browser cookies", async () => {
  const proxy = new MediaProxy(async (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("user-agent"), MUSIC_USER_AGENT);
    assert.equal(headers.get("range"), "bytes=10-19");
    for (const key of ["origin", "referer", "cookie", "authorization"]) assert.equal(headers.has(key), false);
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal);
    return new Response(new Uint8Array(10), { status: 206, headers: { "Content-Range": "bytes 10-19/100", "Content-Length": "10", "Content-Type": "audio/mpeg" } });
  });
  const response = await proxy.handle(new Request(proxy.register("https://cdn.test/song.mp3"), { headers: { Range: "bytes=10-19", Cookie: "not-forwarded" } }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 10-19/100");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal((await response.arrayBuffer()).byteLength, 10);
});

test("HLS rewrites playlists, AES keys, init maps and segments using the final redirect base", async () => {
  const requested: string[] = [];
  const proxy = new MediaProxy(async (value) => {
    const url = String(value); requested.push(url);
    if (url.startsWith("https://entry.test/")) return new Response(null, { status: 302, headers: { Location: "https://psv.vkuseraudio.net/album/index.m3u8" } });
    if (url.endsWith("index.m3u8")) return new Response('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/list.m3u8"\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.vk.com/key.bin?signature=private"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5,\nparts/one.ts?signature=private\n', { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
    if (url.endsWith("list.m3u8")) return new Response("#EXTM3U\n#EXT-X-ENDLIST\n");
    return new Response("bytes");
  });
  const response = await proxy.handle(new Request(proxy.register("https://entry.test/start.m3u8")));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(text.includes("signature"), false);
  assert.equal(text.includes("https://"), false);
  const links = [...text.matchAll(/URI="([^"]+)"/g)].map(m => m[1]);
  links.push(text.split("\n").find(line => line.startsWith("unimusic-media:"))!);
  assert.equal(links.length, 4);
  for (const link of links) assert.equal((await proxy.handle(new Request(link))).status, 200);
  assert.ok(requested.includes("https://psv.vkuseraudio.net/album/audio/list.m3u8"));
  assert.ok(requested.includes("https://keys.vk.com/key.bin?signature=private"));
  assert.ok(requested.includes("https://psv.vkuseraudio.net/album/parts/one.ts?signature=private"));
});

test("HLS refuses foreign keys and foreign or non-HTTPS redirects", async () => {
  for (const target of ["https://vk.com.attacker.test/key", "https://localhost/key", "http://vk.com/key"]) {
    for (const redirect of [false, true]) {
      let calls = 0;
      const proxy = new MediaProxy(async () => {
        calls++;
        return redirect ? new Response(null, { status: 302, headers: { Location: target } })
          : new Response(`#EXTM3U\n#EXT-X-KEY:URI="${target}"\n`);
      });
      const result = await proxy.handle(new Request(proxy.register("https://cdn.test/index.m3u8")));
      assert.equal(result.status, 502);
      assert.equal(calls, 1);
    }
  }
});

test("media errors preserve HTTP status and diagnostics omit URLs and response details", async () => {
  const failures: string[] = [];
  const proxy = new MediaProxy(async () => new Response("private upstream body", { status: 403 }), code => failures.push(code));
  const result = await proxy.handle(new Request(proxy.register("https://cdn.test/track.mp3?secret=private")));
  assert.equal(result.status, 403);
  assert.equal(await result.text(), "");
  assert.deepEqual(failures, ["HTTP_403"]);
});

test("media redirect loops are bounded", async () => {
  let calls = 0;
  const proxy = new MediaProxy(async () => { calls++; return new Response(null, { status: 302, headers: { Location: "/again.m3u8" } }); });
  assert.equal((await proxy.handle(new Request(proxy.register("https://cdn.test/index.m3u8")))).status, 502);
  assert.equal(calls, 5);
});


test("a progressing response survives beyond the old total request deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
  });
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  let signal!: AbortSignal;
  const proxy = new MediaProxy(async (_url, init) => {
    signal = init!.signal!;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      upstream = controller;
      signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
    } }));
  });
  const response = await proxy.handle(new Request(proxy.register("https://cdn.test/long.mp3")));
  const reader = response.body!.getReader();
  for (let chunk = 0; chunk < 4; chunk++) {
    const read = reader.read();
    await Promise.resolve();
    t.mock.timers.tick(30_000);
    assert.equal(signal.aborted, false, "ongoing reads are not capped by total elapsed time");
    upstream.enqueue(new Uint8Array([chunk]));
    assert.equal((await read).value![0], chunk);
  }
  upstream.close(); await reader.read();
  t.mock.timers.tick(60_001);
  assert.equal(signal.aborted, false, "completed reads leave no timer behind");
});

test("a response that stops delivering bytes aborts after the idle limit", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const failures: string[] = [];
  const proxy = new MediaProxy(async (_url, init) => new Response(new ReadableStream({ start(controller) {
    init!.signal!.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
  } })), code => failures.push(code));
  const response = await proxy.handle(new Request(proxy.register("https://cdn.test/stalled.mp3")));
  const read = response.arrayBuffer();
  const rejection = assert.rejects(read, /aborted/);
  t.mock.timers.tick(60_001);
  await rejection;
  assert.deepEqual(failures, ["NETWORK_READ_ERROR"]);
});

test("cancelled playback closes the upstream reader and clears its idle timer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  let signal!: AbortSignal;
  const proxy = new MediaProxy(async (_url, init) => {
    signal = init!.signal!;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  });
  const response = await proxy.handle(new Request(proxy.register("https://cdn.test/song.mp3")));
  await response.body!.cancel();
  assert.equal(cancelled, true);
  assert.equal(signal.aborted, true);
});
