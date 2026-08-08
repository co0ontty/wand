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
