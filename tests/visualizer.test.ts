import { test } from "node:test";
import assert from "node:assert/strict";
import { measureAudio, SILENCE } from "../src/audioLevels";
import { deformOrbPoint, validOrbMode } from "../src/orbGeometry";

const silentFrequency = () => new Float32Array(1024).fill(-Infinity);

test("silent PCM yields zero signal in every band", () => {
  assert.deepEqual(measureAudio(silentFrequency(), new Float32Array(2048), 44100, 2048), SILENCE);
});

test("real PCM amplitude controls RMS level", () => {
  const waveform = Float32Array.from({ length: 2048 }, (_, i) => .35 * Math.sin(i * .2));
  const signal = measureAudio(silentFrequency(), waveform, 44100, 2048);
  assert.ok(signal.level > .5 && signal.level < .6);
});

test("FFT bins are separated into bass, mids and treble using sample rate", () => {
  for (const [hz, key] of [[100, "bass"], [1000, "mids"], [6000, "treble"]] as const) {
    const frequency = silentFrequency();
    frequency[Math.round(hz * 2048 / 44100)] = -15;
    const signal = measureAudio(frequency, new Float32Array(2048), 44100, 2048);
    assert.ok(signal[key] > 0);
    for (const other of ["bass", "mids", "treble"] as const) if (other !== key) assert.equal(signal[other], 0);
  }
});

test("audio measurements remain bounded and handle missing buffers", () => {
  const signal = measureAudio(new Float32Array(1024).fill(0), new Float32Array(2048).fill(1), 44100, 2048);
  for (const value of Object.values(signal)) assert.ok(value >= 0 && value <= 1);
  assert.deepEqual(measureAudio(new Float32Array(), new Float32Array(), 0, 0), SILENCE);
});

test("loud FFT values above -30 dB retain dynamics instead of clipping", () => {
  const frequency = silentFrequency();
  const levels = [-29, -20, -10].map(db => {
    frequency[4] = db;
    return measureAudio(frequency, new Float32Array(2048), 44100, 2048).bass;
  });
  assert.ok(levels[0] < levels[1] && levels[1] < levels[2]);
  assert.ok(levels[2] < 1);
});

test("audio changes rendered coordinates and silence keeps the original geometry", () => {
  const point = [350, 270] as const;
  assert.deepEqual(deformOrbPoint(...point, 480, 1.6, SILENCE), point);
  const moved = deformOrbPoint(...point, 480, 1.6, { level: .7, bass: .5, mids: .3, treble: .2 });
  assert.ok(Math.hypot(moved[0] - 240, moved[1] - 240) > Math.hypot(point[0] - 240, point[1] - 240) * 1.15);
});

test("only the three supported Orbs modes are accepted", () => {
  for (const value of ["orbits", "wave", "braid"] as const) assert.equal(validOrbMode(value), value);
  for (const value of [null, "", "unknown", {}, 42]) assert.equal(validOrbMode(value), "orbits");
});

