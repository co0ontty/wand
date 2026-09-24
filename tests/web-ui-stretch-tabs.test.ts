import assert from "node:assert/strict";
import test from "node:test";
import { stretchIndicatorFrames } from "../src/web-ui/react/ui/stretch-indicator.ts";

test("tab indicator stretches across the gap, then settles on the new tab", () => {
  assert.deepEqual(
    stretchIndicatorFrames({ left: 0, width: 40 }, { left: 80, width: 50 }, false),
    [
      { left: 0, width: 130 },
      { left: 80, width: 50 },
    ],
  );
});

test("tab indicator covers both tabs when moving left", () => {
  const frames = stretchIndicatorFrames({ left: 80, width: 50 }, { left: 0, width: 40 }, false);
  assert.deepEqual(frames[0], { left: 0, width: 130 });
  assert.deepEqual(frames[1], { left: 0, width: 40 });
});

test("reduced motion and the first paint jump straight to the target", () => {
  const next = { left: 10, width: 20 };
  assert.deepEqual(stretchIndicatorFrames(null, next, false), [next]);
  assert.deepEqual(stretchIndicatorFrames({ left: 0, width: 10 }, next, true), [next]);
});

test("an unchanged tab does not insert a stretch frame", () => {
  const next = { left: 4, width: 20 };
  assert.deepEqual(stretchIndicatorFrames(next, next, false), [next]);
});
