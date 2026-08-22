import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeTerminalTouchPage,
  consumeTerminalWheelPage,
  TERMINAL_TOUCH_PAGE_THRESHOLD_PX,
  terminalWheelPageSequence,
  type TerminalTouchPagingState,
  type TerminalWheelPagingState,
} from "../src/web-ui/browser/terminal-wheel.ts";

function pagingState(): TerminalWheelPagingState {
  return {
    direction: 0,
    accumulatedPixels: 0,
    lastEventAt: 0,
    lastPageAt: 0,
  };
}

function touchState(): TerminalTouchPagingState {
  return {
    accumulatedPixels: 0,
    lastPageAt: 0,
  };
}

test("terminal wheel paging accumulates trackpad pixels before paging", () => {
  const state = pagingState();

  assert.equal(consumeTerminalWheelPage({ deltaY: -30, deltaMode: 0 }, state, 600, 1_000), 0);
  assert.equal(consumeTerminalWheelPage({ deltaY: -30, deltaMode: 0 }, state, 600, 1_030), 0);
  assert.equal(consumeTerminalWheelPage({ deltaY: -30, deltaMode: 0 }, state, 600, 1_060), -1);
  assert.equal(terminalWheelPageSequence(-1), "\u001b[5~");
});

test("terminal wheel paging converts a common mouse notch into one page", () => {
  const state = pagingState();

  assert.equal(consumeTerminalWheelPage({ deltaY: 100, deltaMode: 0 }, state, 600, 1_000), 1);
  assert.equal(terminalWheelPageSequence(1), "\u001b[6~");
});

test("terminal wheel paging resets accumulated movement when direction changes", () => {
  const state = pagingState();

  assert.equal(consumeTerminalWheelPage({ deltaY: 60, deltaMode: 0 }, state, 600, 1_000), 0);
  assert.equal(consumeTerminalWheelPage({ deltaY: -30, deltaMode: 0 }, state, 600, 1_020), 0);
  assert.equal(consumeTerminalWheelPage({ deltaY: -50, deltaMode: 0 }, state, 600, 1_100), -1);
});

test("terminal wheel paging normalizes line and page delta modes", () => {
  const lineState = pagingState();
  const pageState = pagingState();

  assert.equal(consumeTerminalWheelPage({ deltaY: 5, deltaMode: 1 }, lineState, 600, 1_000), 1);
  assert.equal(consumeTerminalWheelPage({ deltaY: -1, deltaMode: 2 }, pageState, 600, 1_000), -1);
  assert.equal(terminalWheelPageSequence(0), "");
});

test("terminal touch paging accumulates a swipe into one page and keeps the remainder", () => {
  const state = touchState();

  assert.equal(consumeTerminalTouchPage(20, state, 1_000), 0);
  assert.equal(consumeTerminalTouchPage(20, state, 1_020), 0);
  assert.equal(consumeTerminalTouchPage(20, state, 1_040), 1);
  // 60px consumed, 0px carried; the next swipe needs the full threshold again.
  assert.equal(consumeTerminalTouchPage(TERMINAL_TOUCH_PAGE_THRESHOLD_PX - 1, state, 1_200), 0);
  assert.equal(consumeTerminalTouchPage(1, state, 1_220), 1);
});

test("terminal touch paging ignores sub-pixel jitter between events", () => {
  const state = touchState();

  // The wheel helper resets on direction flips; touch must not, or a slow
  // careful swipe with ±1px jitter never reaches the threshold.
  for (let i = 0; i < 100; i++) {
    assert.equal(consumeTerminalTouchPage(i % 2 === 0 ? 5 : -4, state, 1_000 + i), 0);
  }
  assert.equal(state.accumulatedPixels, 50);
});

test("terminal touch paging reverses only after overcoming the carried distance", () => {
  const state = touchState();

  assert.equal(consumeTerminalTouchPage(50, state, 1_000), 0);
  // Reversal burns through the carry before paging the other way.
  assert.equal(consumeTerminalTouchPage(-60, state, 1_050), 0);
  assert.equal(consumeTerminalTouchPage(-55, state, 1_100), -1);
});

test("terminal touch paging rate-limits pages during a fling", () => {
  const state = touchState();

  assert.equal(consumeTerminalTouchPage(60, state, 1_000), 1);
  // A fling keeps accumulating fast; pages fire at most every 80ms.
  assert.equal(consumeTerminalTouchPage(60, state, 1_010), 0);
  assert.equal(consumeTerminalTouchPage(60, state, 1_090), 1);
  // 180px of travel produced 2 pages; 60px of carry remains for the gesture.
  assert.equal(state.accumulatedPixels, 60);
});
