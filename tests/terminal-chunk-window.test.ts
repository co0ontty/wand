import assert from "node:assert/strict";
import test from "node:test";

import { appendTerminalChunkBatch, appendTerminalChunkWindow, type TerminalDataEvent } from "../src/terminal-host.js";

function sequential(seed: TerminalDataEvent[], events: TerminalDataEvent[]) {
  return events.reduce((chunks, event) => appendTerminalChunkWindow(chunks, event), seed);
}

test("batched replay windows equal sequential windows with original cursor boundaries", () => {
  const seed = [{ data: "older\n".repeat(2000), seq: 1 }];
  const parts = Array.from({ length: 4000 }, (_, index) => ({ seq: index + 2, data: `第${index}行\u001b[0m\n` + "x".repeat(80) }));
  assert.deepEqual(appendTerminalChunkBatch(seed, parts), sequential(seed, parts));
  assert.deepEqual(seed, [{ data: "older\n".repeat(2000), seq: 1 }], "batching never mutates a cached snapshot array");
  assert.equal(parts.length, 4000);
});

test("oversized replay entries keep their newest text and do not clip live payloads", () => {
  const oversized = { data: "z".repeat(300_000), seq: 2 };
  const parts = [oversized, { data: "tail虎\n", seq: 3 }, { data: "", seq: 4 }];
  const seed = [{ data: "first", seq: 1 }];
  assert.deepEqual(appendTerminalChunkBatch(seed, parts), sequential(seed, parts));
  assert.equal(oversized.data.length, 300_000);
  assert.deepEqual(appendTerminalChunkBatch([], [oversized]), [{ data: "z".repeat(200_000), seq: 2 }]);
});

test("an empty replay batch preserves the existing window", () => {
  const seed = [{ seq: 6, data: "complete\n" }];
  assert.deepEqual(appendTerminalChunkBatch(seed, []), seed);
  assert.deepEqual(appendTerminalChunkBatch([], []), []);
});
