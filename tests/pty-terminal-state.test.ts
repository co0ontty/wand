import assert from "node:assert/strict";
import test from "node:test";

import { PtyTerminalState, type PtyTerminalSnapshot } from "../src/pty-terminal-state.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function restore(snapshot: PtyTerminalSnapshot): PtyTerminalState {
  const restored = new PtyTerminalState(snapshot.cols, snapshot.rows, snapshot.data);
  for (const operation of snapshot.pending) {
    if (operation.type === "data") restored.write(operation.data);
    else restored.resize(operation.cols, operation.rows);
  }
  return restored;
}

test("terminal snapshots reproduce ANSI, CJK, resize, and pending PTY operations", async (t) => {
  const source = new PtyTerminalState(24, 5);
  t.after(() => source.dispose());

  source.write("\x1b[31m中文🙂\x1b[0m\r\nline two");
  source.write("\x1b[1A\r\x1b[2Kupdated");
  source.resize(32, 7);

  const inFlight = source.snapshot();
  assert.ok(inFlight.pending.length > 0, "an immediate snapshot should retain uncommitted operations");
  const restored = restore(inFlight);
  t.after(() => restored.dispose());

  await delay(250);
  assert.equal(source.snapshot().pending.length, 0);
  assert.equal(restored.snapshot().pending.length, 0);
  assert.equal(restored.snapshot().cols, source.snapshot().cols);
  assert.equal(restored.snapshot().rows, source.snapshot().rows);
  assert.equal(restored.snapshot().data, source.snapshot().data);
});

test("mirror writes are coalesced instead of one xterm write per chunk", async (t) => {
  const state = new PtyTerminalState(80, 24);
  t.after(() => state.dispose());

  // 40 chunks of 4KB: the batch bound (64KB) must fold them into three queued
  // operations, and a snapshot must expose them as a single replay step.
  const chunk = "x".repeat(4096);
  for (let i = 0; i < 40; i++) state.write(chunk);

  const snapshot = state.snapshot();
  assert.equal(snapshot.pending.length, 1, "adjacent data operations should reach the client merged");
  const chars = snapshot.pending.reduce(
    (total, operation) => total + (operation.type === "data" ? operation.data.length : 0),
    0,
  );
  assert.equal(chars, 40 * chunk.length);
});

test("batched bytes keep their order relative to a resize", async (t) => {
  const source = new PtyTerminalState(20, 4);
  t.after(() => source.dispose());

  source.write("AAAA");
  source.resize(30, 6);
  source.write("BBBB");

  const restored = restore(source.snapshot());
  t.after(() => restored.dispose());

  await delay(250);
  assert.equal(restored.snapshot().cols, source.snapshot().cols);
  assert.equal(restored.snapshot().rows, source.snapshot().rows);
  assert.equal(restored.snapshot().data, source.snapshot().data);
});

test("a writer that never pauses stays bounded and still checkpoints", async (t) => {
  const state = new PtyTerminalState(200, 50);
  t.after(() => state.dispose());

  const chunk = "y".repeat(4096);
  for (let i = 0; i < 100; i++) state.write(chunk); // 400KB, well past the pending bound
  assert.ok(state.snapshot().pending.length > 0, "uncommitted operations are still replayable");

  await delay(400);
  const drained = state.snapshot();
  assert.equal(drained.pending.length, 0, "a quiet writer must converge to a committed baseline");
  assert.ok(drained.data.length > 0);
});
