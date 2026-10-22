import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppUpdates, newerVersion, releaseAsset, UPDATE_REPOSITORY } from "../electron/updates";
import { defaultPreferences, validatePreferences } from "../electron/state";

const payload = Buffer.from("fixture update, never executed");
const sha256 = createHash("sha256").update(payload).digest("hex");
const name = "UniMusic-Portable-0.9.0-x64.exe";
function release() {
  return { tag_name: "v0.9.0", draft: false, prerelease: false, assets: [{ name, state: "uploaded",
    browser_download_url: `${UPDATE_REPOSITORY}/releases/download/v0.9.0/${name}`, size: payload.length, digest: `sha256:${sha256}` }] };
}

test("updates compare numeric versions and ignore prereleases, equal versions and downgrades", () => {
  assert.equal(newerVersion("0.10.0", "0.9.9"), true);
  for (const v of ["0.8.0", "0.7.6", "0.9.0-beta.1", "00.9.0", "1.2", "99999999999999999999.0.0"])
    assert.equal(newerVersion(v, "0.8.0"), false);
  assert.equal(releaseAsset({ ...release(), prerelease: true }, "0.8.0", "Portable", "x64"), null);
  assert.equal(releaseAsset(release(), "0.9.0", "Portable", "x64"), null);
});

test("only complete assets from the UniMusic release, correct architecture and digest are accepted", () => {
  assert.equal(releaseAsset(release(), "0.8.0", "Portable", "x64")?.sha256, sha256);
  for (const patch of [{ browser_download_url: "https://example.com/update.exe" }, { digest: null }, { size: 2 ** 40 }, { state: "new" }]) {
    const value = release(); Object.assign(value.assets[0], patch);
    assert.throws(() => releaseAsset(value, "0.8.0", "Portable", "x64"));
  }
  assert.throws(() => releaseAsset(release(), "0.8.0", "Portable", "arm64"));
  const setup = release();
  setup.assets[0].name = setup.assets[0].name.replace("Portable", "Setup");
  setup.assets[0].browser_download_url = setup.assets[0].browser_download_url.replace("Portable", "Setup");
  assert.throws(() => releaseAsset(setup, "0.8.0", "Setup", "x64"), /latest.yml/);
});

test("Portable stages a verified update without changing the running executable; disabling disarms it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "unimusic-updates-"));
  try {
    const target = join(directory, "UniMusic.exe"); await writeFile(target, "running version");
    let calls = 0;
    const options = { version: "0.8.0", arch: "x64", enabled: true, directory, portablePath: target,
      fetcher: (async (url: unknown) => { calls++; return String(url).includes("api.github.com")
        ? Response.json(release()) : new Response(payload); }) as typeof fetch, onChange: () => {} };
    const updates = new AppUpdates(options);
    const first = updates.check(); assert.equal(updates.check(), first);
    assert.equal((await first).status, "ready"); assert.equal(calls, 2);
    assert.equal(await readFile(target, "utf8"), "running version");
    const restarted = new AppUpdates({ ...options });
    assert.equal(await restarted.resumePortable(), true);
    await restarted.setEnabled(false);
    assert.equal(restarted.hasPendingPortable, false);
    assert.equal(restarted.state.status, "disabled");
    assert.equal(await new AppUpdates({ ...options }).resumePortable(), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("bad downloads never become pending; disabled updates make no requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "unimusic-updates-"));
  try {
    let calls = 0;
    const options = { version: "0.8.0", arch: "x64", enabled: false, directory, portablePath: join(directory, "UniMusic.exe"),
      fetcher: (async (url: unknown) => { calls++; return String(url).includes("api.github.com")
        ? Response.json(release()) : new Response(Buffer.alloc(payload.length)); }) as typeof fetch, onChange: () => {} };
    const off = new AppUpdates(options);
    assert.equal((await off.check()).status, "disabled"); assert.equal(calls, 0);
    const updates = new AppUpdates({ ...options, enabled: true });
    assert.equal((await updates.check()).status, "error");
    assert.equal(updates.hasPendingPortable, false);
    await assert.rejects(readFile(updates.manifest));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("auto-updates default on, migrate old preferences, and reject invalid values", () => {
  const defaults = defaultPreferences("music");
  assert.equal(validatePreferences({}, defaults).autoUpdates, true);
  assert.equal(validatePreferences({ autoUpdates: false }, defaults).autoUpdates, false);
  assert.throws(() => validatePreferences({ autoUpdates: "false" }, defaults));
});
