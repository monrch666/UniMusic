import { test } from "node:test";
import assert from "node:assert/strict";
import { seekTimeAt } from "../src/seek";
test("seek preview maps pointer to the timeline and clamps both edges", () => {
  assert.equal(seekTimeAt(150, 100, 200, 240), 60);
  assert.equal(seekTimeAt(50, 100, 200, 240), 0);
  assert.equal(seekTimeAt(400, 100, 200, 240), 240);
});
test("seek preview handles unknown duration and unavailable layout", () => {
  for (const width of [0, -1, NaN]) assert.equal(seekTimeAt(150, 100, width, 240), 0);
  for (const duration of [0, NaN, Infinity]) assert.equal(seekTimeAt(150, 100, 200, duration), 0);
});
