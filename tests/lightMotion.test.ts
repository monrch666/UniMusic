import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceLightMotion, createLightMotion } from "../src/lightMotion";
import { SILENCE } from "../src/audioLevels";

function playBeats(bpm: number, seconds = 12) {
  const state = createLightMotion();
  for (let i = 0; i < seconds * 60; i++) {
    const hit = (i / 60) % (60 / bpm) < .1;
    advanceLightMotion(state, { level: hit ? .7 : .12, bass: hit ? .8 : .025, mids: .2, treble: .1 }, 1 / 60);
  }
  return state;
}

test("silence does not invent movement or beats", () => {
  const state = createLightMotion(), before = advanceLightMotion(state, SILENCE, 0);
  for (let i = 0; i < 300; i++) advanceLightMotion(state, SILENCE, 1 / 30);
  assert.deepEqual(advanceLightMotion(state, SILENCE, 0), before);
  assert.equal(state.phase, 0); assert.equal(state.interval, 0); assert.equal(state.pulse, 0);
});

test("faster real beat onsets produce faster light travel", () => {
  const slow = playBeats(80), fast = playBeats(160);
  assert.ok(Math.abs(60 / slow.interval - 80) < 5);
  assert.ok(Math.abs(60 / fast.interval - 160) < 8);
  assert.ok(fast.phase > slow.phase * 1.3);
  assert.ok(fast.pulse > slow.pulse);
});

test("a sustained tone moves the lights without pretending to detect a tempo", () => {
  const state = createLightMotion();
  const before = advanceLightMotion(state, SILENCE, 0);
  for (let i = 0; i < 300; i++) advanceLightMotion(state, { level: .5, bass: .2, mids: .1, treble: .1 }, 1 / 30);
  const after = advanceLightMotion(state, SILENCE, 0);
  assert.notDeepEqual(after, before); assert.equal(state.interval, 0);
});

test("light trajectories stay bounded and a stopped frame cannot jump", () => {
  const state = playBeats(120);
  const still = advanceLightMotion(state, SILENCE, 0);
  assert.deepEqual(advanceLightMotion(state, SILENCE, 0), still);
  for (let i = 0; i < 1000; i++) for (const p of advanceLightMotion(state, { level: 1, bass: 1, mids: 1, treble: 1 }, 1 / 30)) {
    assert.ok(Math.abs(p.x) <= 34); assert.ok(Math.abs(p.y) <= 27); assert.ok(Math.abs(p.rotate) <= 18);
  }
});

test("RGB hues change smoothly with live audio even when movement speed is zero", () => {
  const state = createLightMotion();
  const settings = { count: 8, intensity: 1, speed: 0, size: 1, sensitivity: 1, colorMode: "rgb" as const };
  const first = advanceLightMotion(state, SILENCE, 0, settings);
  let after = first;
  for (let i = 0; i < 300; i++) after = advanceLightMotion(state, { level: .7, bass: .4, mids: .2, treble: .1 }, 1 / 30, settings);
  assert.equal(state.phase, 0);
  assert.notEqual(after[0].hue, first[0].hue);
  assert.equal(new Set(after.map(p => p.hue)).size, 8);
  for (const p of after) assert.ok(p.hue >= 0 && p.hue < 360);
  const hue = after[0].hue;
  assert.equal(advanceLightMotion(state, SILENCE, 1 / 30, settings)[0].hue, hue);
});
