import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ORB_SETTINGS, validOrbSettings } from "../src/orbSettings";

test("Orbs start enabled inside the cover with the existing response, speed and opacity", () => {
  assert.deepEqual(DEFAULT_ORB_SETTINGS, { enabled: true, placement: "circle", sensitivity: 1, speed: 1, opacity: 1 });
  for (const stored of [null, undefined, [], "bad", { enabled: "false", placement: "anywhere", speed: NaN }]) assert.deepEqual(validOrbSettings(stored), DEFAULT_ORB_SETTINGS);
});

test("Orbs settings retain supported changes across restart and restore clean defaults", () => {
  const customized = validOrbSettings({ enabled: false, placement: "background", sensitivity: .5, speed: 2, opacity: .6 });
  assert.deepEqual(validOrbSettings(JSON.parse(JSON.stringify(customized))), customized);
  const reset = validOrbSettings(DEFAULT_ORB_SETTINGS);
  assert.deepEqual(reset, { enabled: true, placement: "circle", sensitivity: 1, speed: 1, opacity: 1 });
  reset.enabled = false; assert.equal(DEFAULT_ORB_SETTINGS.enabled, true);
});

test("Orbs ranges stay bounded and zero speed or response is supported", () => {
  assert.deepEqual(validOrbSettings({ sensitivity: 99, speed: -1, opacity: 0, other: "ignored" }), { enabled: true, placement: "circle", sensitivity: 2, speed: 0, opacity: .1 });
  assert.equal(validOrbSettings({ sensitivity: 0 }).sensitivity, 0);
});
