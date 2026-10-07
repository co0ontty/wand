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

import { readFileSync } from "node:fs";
import { stretchIndicatorReached } from "../src/web-ui/react/ui/stretch-tabs.js";
import { readMotionTokenMs } from "../src/web-ui/react/ui/motion-tokens.js";

test("obsolete transition completions cannot settle the latest stretch target", () => {
  const latest = { left: 0, width: 170 };
  assert.equal(stretchIndicatorReached({ left: 0, width: 80 }, latest), false);
  assert.equal(stretchIndicatorReached({ left: 0, width: 170 }, latest), true);
  assert.equal(stretchIndicatorReached({ left: 0, width: 168 }, latest), false);
  const frames = stretchIndicatorFrames({ left: 40, width: 40 }, { left: 0, width: 40 }, false);
  assert.deepEqual(frames, [{ left: 0, width: 80 }, { left: 0, width: 40 }]);
});

test("shared tabs advance on completion, subscribe to reduced motion and preserve roving navigation", () => {
  const source = readFileSync(new URL("../src/web-ui/react/ui/stretch-tabs.tsx", import.meta.url), "utf8");
  assert.match(source, /onTransitionEnd=/);
  assert.match(source, /settleRef.current = frames\[1\] \?\? null/);
  assert.match(source, /useReducedMotion\(\)/);
  assert.doesNotMatch(source, /setTimeout|170/);
  assert.match(source, /event\.key !== "Home" && event\.key !== "End"/);
  assert.match(source, /<Segmented value=\{value\}/);
  assert.match(source, /stretchIndicatorFrames\(previous, next, reduced\)/);
  const css = readFileSync(new URL("../src/web-ui/react/styles/base.ts", import.meta.url), "utf8");
  assert.match(css, /left var\(--motion-indicator\) var\(--ease-in-out-smooth\)/);
  assert.match(css, /width var\(--motion-indicator\) var\(--ease-in-out-smooth\)/);
  const tokens = readFileSync(new URL("../src/web-ui/react/ui/motion-tokens.ts", import.meta.url), "utf8");
  assert.match(tokens, /media.addEventListener\("change", update\)/);
  assert.match(tokens, /media.removeEventListener\("change", update\)/);
});

test("JS intent waits read the existing CSS duration in milliseconds or seconds", () => {
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const savedComputed = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  let raw = "150ms";
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: {} } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true,
      value: () => ({ getPropertyValue: () => raw }) });
    assert.equal(readMotionTokenMs("--motion-fast"), 150);
    raw = "0.24s";
    assert.equal(readMotionTokenMs("--motion-normal"), 240);
    raw = "";
    assert.equal(readMotionTokenMs("--motion-normal"), 0);
  } finally {
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument); else Reflect.deleteProperty(globalThis, "document");
    if (savedComputed) Object.defineProperty(globalThis, "getComputedStyle", savedComputed); else Reflect.deleteProperty(globalThis, "getComputedStyle");
  }
});
