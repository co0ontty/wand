import assert from "node:assert/strict";
import test from "node:test";

import headless from "@xterm/headless";
import { PtyTerminalState, PTY_INITIAL_HISTORY_ROWS, type PtyTerminalSnapshot } from "../src/pty-terminal-state.js";

const { Terminal } = headless;

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

test("initial PTY screen is short; scrolling fetches bounded older ANSI rows", async (t) => {
  const source = new PtyTerminalState(40, 10);
  t.after(() => source.dispose());
  const raw = Array.from({ length: 420 }, (_, i) =>
    `${i % 3 === 0 ? "\x1b[31m" : "\x1b[0m"}history-${String(i).padStart(3, "0")}`
      + (i % 7 === 0 ? "-wrapped".repeat(7) : "") + "\x1b[0m\r\n").join("");
  source.write(raw);
  await delay(300);
  const initial = source.snapshot();
  assert.equal(initial.pending.length, 0);
  assert.ok(initial.historyBefore! > 250);
  assert.ok(initial.data.length < raw.length / 2);
  assert.ok(initial.data.includes(`history-${String(419).padStart(3, "0")}`));
  assert.ok(!initial.data.includes("history-000"));

  let before = initial.historyBefore!;
  let prefix = "";
  for (let i = 0; i < 4; i++) {
    const page = await source.historyPage(before, initial.historyRevision!);
    assert.ok(page && page.start < before);
    assert.ok(before - page.start <= 80);
    assert.ok(Buffer.byteLength(page.data) <= 192 * 1024);
    prefix = page.data + page.separator + prefix;
    before = page.start;
  }
  const expected = new Terminal({ cols: 40, rows: 10, scrollback: 5000, allowProposedApi: true });
  const actual = new Terminal({ cols: 40, rows: 10, scrollback: 5000, allowProposedApi: true });
  t.after(() => { expected.dispose(); actual.dispose(); });
  await Promise.all([
    new Promise<void>((resolve) => expected.write(raw, resolve)),
    new Promise<void>((resolve) => actual.write(prefix + initial.data, resolve)),
  ]);
  const history = 4 * 80 + PTY_INITIAL_HISTORY_ROWS;
  const tail = (term: InstanceType<typeof Terminal>) => Array.from({ length: history }, (_, i) =>
    term.buffer.normal.getLine(term.buffer.normal.length - history + i)?.translateToString(true));
  assert.deepEqual(tail(actual), tail(expected));

  source.write("more\r\n");
  assert.equal(await source.historyPage(before, initial.historyRevision!), null,
    "a stale row cursor must never concatenate unrelated live output");
});

test("dense ANSI history shrinks the first screen and every later page stays byte-bounded", async (t) => {
  const state = new PtyTerminalState(800, 8);
  t.after(() => state.dispose());
  const line = Array.from({ length: 500 }, (_, i) => `\x1b[${i % 2 ? 31 : 32}mX`).join("");
  state.write(Array.from({ length: 135 }, () => `${line}\x1b[0m\r\n`).join(""));
  await delay(500);
  const initial = state.snapshot();
  assert.ok(Buffer.byteLength(initial.data) <= 256 * 1024);
  assert.ok(initial.historyBefore! > 0);
  const page = await state.historyPage(initial.historyBefore!, initial.historyRevision!);
  assert.ok(page);
  assert.ok(page.before - page.start <= 80);
  assert.ok(Buffer.byteLength(page.data) <= 192 * 1024);
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
