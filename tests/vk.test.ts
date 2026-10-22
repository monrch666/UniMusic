import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTransport,
  mapPlaylist,
  mapTrack,
  offset,
  validCredential,
  VkClient,
  type Credential,
} from "../electron/vk";

const credential: Credential = {
  accessToken: "vk1.a.test-token-only-for-tests",
  userId: 12,
  expiresAt: null,
};

test("audio API uses Fenrir's Bearer header, device ID and bounded POST", async () => {
  let url = "";
  let init: RequestInit | undefined;
  const transport = createTransport(async (input, options) => {
    url = String(input);
    init = options;
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  }, "0123456789abcdef");
  await transport("audio.get", {
    access_token: credential.accessToken,
    count: 100,
  });
  assert.equal(url, "https://api.vk.com/method/audio.get");
  assert.equal(init?.method, "POST");
  assert.equal(
    (init?.body as URLSearchParams).get("access_token"),
    null,
  );
  assert.equal(new Headers(init?.headers).get("x-vk-android-client"), "new");
  assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${credential.accessToken}`);
  assert.equal((init?.body as URLSearchParams).get("device_id"), "0123456789abcdef");
  assert.ok(init?.signal);
  assert.equal(init?.redirect, "error");
});

test("track mapping keeps HLS URLs and rejects unsafe URLs", () => {
  const track = mapTrack({
    id: 1,
    owner_id: 12,
    artist: "Артист",
    title: "Трек",
    duration: 123,
    url: "https://cdn.vk.com/index.m3u8?a=b",
    album: {
      title: "Альбом",
      thumb: { photo_600: "https://img.vk.com/cover.jpg" },
    },
  });
  assert.equal(track.duration, 123);
  assert.match(track.url, /m3u8/);
  assert.equal(track.album, "Альбом");
  assert.equal(track.cover, "https://img.vk.com/cover.jpg");
  assert.equal(mapTrack({ url: "javascript:alert(1)" }).url, "");
  assert.equal(mapTrack({ url: "file:///C:/secret" }).url, "");
  assert.equal(mapTrack({ duration: -1 }).duration, 0);
  assert.equal(mapTrack({ is_licensed: false }).restricted, false);
});

test("playlist covers support both photo and thumbs fields", () => {
  assert.equal(
    mapPlaylist({ photo: { photo_300: "https://img.vk.com/one.jpg" } }).cover,
    "https://img.vk.com/one.jpg",
  );
  assert.equal(
    mapPlaylist({ thumbs: [{ photo_600: "https://img.vk.com/two.jpg" }] })
      .cover,
    "https://img.vk.com/two.jpg",
  );
});

test("pagination and stored credentials validate trust boundaries", () => {
  assert.equal(offset(undefined), 0);
  assert.equal(offset(100), 100);
  for (const value of [-1, 1.5, "1", NaN, 1_000_001])
    assert.throws(() => offset(value));
  assert.ok(validCredential(credential));
  assert.equal(
    validCredential({ ...credential, expiresAt: Date.now() - 1 }),
    false,
  );
  assert.equal(validCredential({ ...credential, expiresAt: Infinity }), false);
  assert.equal(
    validCredential({ ...credential, accessToken: "invalid" }),
    false,
  );
});

test("API error 5 is recognizable and cannot disclose server request details", async () => {
  const client = new VkClient(
    async () => ({
      error: { error_code: 5, error_msg: "sensitive token here" },
    }),
    credential,
  );
  await assert.rejects(client.tracks(), {
    message: "Сессия VK истекла. Войдите снова.",
    code: 5,
  });
});

test("playlist requests preserve owner, playlist ID, access key and pagination", async () => {
  const client = new VkClient(async (method, params) => {
    assert.equal(method, "audio.get");
    assert.equal(params.owner_id, -34);
    assert.equal(params.playlist_id, 45);
    assert.equal(params.access_key, "abc-123");
    assert.equal(params.offset, 100);
    return { response: { count: 1, items: [{ id: 1, owner_id: -34 }] } };
  }, credential);
  assert.equal(
    (await client.tracks(100, { id: 45, ownerId: -34, accessKey: "abc-123" }))
      .items.length,
    1,
  );
});

test("search rejects empty input and keeps UTF-8 query", async () => {
  const client = new VkClient(async (_method, params) => {
    assert.equal(params.q, "Моя музыка");
    return { response: { count: 0, items: [] } };
  }, credential);
  await assert.rejects(client.search("  "));
  await assert.rejects(client.search("x".repeat(201)));
  assert.equal((await client.search("  Моя музыка  ")).count, 0);
});

test("resolveTrack rejects missing media URL and malformed IDs", async () => {
  let calls = 0;
  const client = new VkClient(async () => {
    calls++;
    return { response: [{ id: 1, owner_id: 12, url: "" }] };
  }, credential);
  await assert.rejects(client.resolveTrack({ id: 0, ownerId: 12 }));
  assert.equal(calls, 0);
  await assert.rejects(client.resolveTrack({ id: 1, ownerId: 12 }), /ссылку/);
});

test("resolveTrack prefers 5.90 even when the modern API advertises an HLS URL", async () => {
  const versions: unknown[] = [];
  const client = new VkClient(
    async (_method, params) => {
      versions.push(params.v);
      return {
        response: [{
          id: 1,
          owner_id: 12,
          url: params.v === "5.90" ? "https://cdn.vk.com/track.mp3" : "https://cdn.vk.com/five-second-stub.m3u8",
        }],
      };
    },
    credential,
  );
  assert.equal(
    (await client.resolveTrack({ id: 1, ownerId: 12 })).url,
    "https://cdn.vk.com/track.mp3",
  );
  assert.deepEqual(versions, ["5.90"]);
});

test("a failed HLS stream can request the legacy URL once without reusing the current API", async () => {
  let calls = 0;
  const client = new VkClient(async (_method, params) => {
    calls++;
    assert.equal(params.v, "5.90");
    return { response: [{ id: 1, owner_id: 12, url: "https://cdn.vk.com/track.mp3" }] };
  }, credential);
  assert.match((await client.resolveTrack({ id: 1, ownerId: 12 }, true)).url, /\.mp3$/);
  assert.equal(calls, 1);
});

test("VK's audio_api_unavailable stub is rejected and triggers the secondary API", async () => {
  assert.equal(mapTrack({ url: "https://vk.com/audio_api_unavailable.mp3" }).url, "");
  const versions: unknown[] = [];
  const client = new VkClient(async (_method, params) => {
    versions.push(params.v);
    return { response: [{ id: 1, owner_id: 12, url: params.v === "5.90" ? "https://vk.com/audio_api_unavailable.mp3" : "https://cdn.vk.com/full.mp3" }] };
  }, credential);
  assert.equal((await client.resolveTrack({ id: 1, ownerId: 12 })).url, "https://cdn.vk.com/full.mp3");
  assert.deepEqual(versions, ["5.90", "5.186"]);
});
