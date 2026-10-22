import { test } from "node:test";
import assert from "node:assert/strict";
import { nextAfterFailure, trackKey } from "../src/playbackQueue";
import type { Track } from "../src/shared";
const queue = [1, 2, 3].map(id => ({ id, ownerId: 1, title: String(id), artist: "Artist", duration: 60, url: "", restricted: false } satisfies Track));

test("a failed track advances past restricted and already failed entries", () => {
  const failed = new Set([trackKey(queue[0])]);
  assert.equal(nextAfterFailure(queue, queue[0], failed, false, false)?.id, 2);
  assert.equal(nextAfterFailure([queue[0], {...queue[1], restricted: true}, queue[2]], queue[0], failed, false, false)?.id, 3);
  failed.add(trackKey(queue[1]));
  assert.equal(nextAfterFailure(queue, queue[0], failed, false, false)?.id, 3);
});
test("the end stops unless repeat-all or shuffle allows earlier entries", () => {
  const failed = new Set([trackKey(queue[2])]);
  assert.equal(nextAfterFailure(queue, queue[2], failed, false, false), undefined);
  assert.equal(nextAfterFailure(queue, queue[2], failed, true, false)?.id, 1);
  assert.ok([1,2].includes(nextAfterFailure(queue, queue[2], failed, false, true)!.id));
});
test("a completely failed queue cannot loop even with repeat-all and shuffle", () => {
  const failed = new Set(queue.map(trackKey));
  for (const track of queue) assert.equal(nextAfterFailure(queue, track, failed, true, true), undefined);
});
test("an empty or changed queue is handled safely", () => {
  assert.equal(nextAfterFailure([], queue[0], new Set(), true, false), undefined);
  assert.equal(nextAfterFailure(queue, {...queue[0], id: 99}, new Set(), true, false)?.id, 1);
});
