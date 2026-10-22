import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIGHT_SETTINGS, validLightSettings } from "../src/lightSettings";
import { advanceLightMotion, createLightMotion } from "../src/lightMotion";

test("light defaults preserve the existing four-light appearance and can be restored", () => {
  assert.deepEqual(DEFAULT_LIGHT_SETTINGS, { count: 4, intensity: 1, speed: 1, size: 1, sensitivity: 1, colorMode: "accent" });
  const customized = validLightSettings({ count: 7, intensity: .6, speed: 2, size: 1.5, sensitivity: .5 });
  assert.deepEqual(validLightSettings(JSON.parse(JSON.stringify(customized))), customized);
  const reset = validLightSettings(DEFAULT_LIGHT_SETTINGS);
  assert.deepEqual(reset, { count: 4, intensity: 1, speed: 1, size: 1, sensitivity: 1, colorMode: "accent" });
  reset.count = 8;
  assert.equal(DEFAULT_LIGHT_SETTINGS.count, 4);
});

test("stored light settings reject invalid values, strip unknown fields and bound GPU load", () => {
  for (const value of [undefined, null, [], "bad", { count: "8", speed: Infinity, size: NaN }]) assert.deepEqual(validLightSettings(value), DEFAULT_LIGHT_SETTINGS);
  assert.deepEqual(validLightSettings({ count: 999, intensity: -1, speed: 99, size: 0, sensitivity: 100, secret: "ignored" }), { count: 8, intensity: 0, speed: 3, size: .5, sensitivity: 2, colorMode: "accent" });
  assert.equal(validLightSettings({ count: 2.8 }).count, 3);
});

test("count, speed and response settings affect only the light motion", () => {
  const normal = createLightMotion(), fast = createLightMotion(), unresponsive = createLightMotion();
  const audio = { level: .5, bass: .3, mids: .1, treble: .05 };
  for (let i = 0; i < 90; i++) {
    advanceLightMotion(normal, audio, 1 / 30);
    assert.equal(advanceLightMotion(fast, audio, 1 / 30, { ...DEFAULT_LIGHT_SETTINGS, count: 8, speed: 2 }).length, 8);
    advanceLightMotion(unresponsive, audio, 1 / 30, { ...DEFAULT_LIGHT_SETTINGS, sensitivity: 0 });
  }
  assert.ok(Math.abs(fast.phase - normal.phase * 2) < 1e-9);
  assert.equal(unresponsive.phase, 0); assert.equal(unresponsive.interval, 0);
  assert.deepEqual(audio, { level: .5, bass: .3, mids: .1, treble: .05 });
});

test("RGB selection persists and old saved preferences retain Accent as the default", () => {
  assert.equal(validLightSettings({ colorMode: "rgb" }).colorMode, "rgb");
  assert.equal(validLightSettings(JSON.parse('{"count":6}')).colorMode, "accent");
  assert.equal(validLightSettings({ colorMode: "invalid" }).colorMode, "accent");
});
