import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeTerminalWheelPage,
  terminalWheelPageSequence,
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
