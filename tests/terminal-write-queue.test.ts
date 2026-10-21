import assert from "node:assert/strict";
import test from "node:test";
import { queueTerminalWrite } from "../src/web-ui/browser/terminal-write-queue.js";

test("live frames coalesce without losing ANSI, split Unicode, or ACK credit", async () => {
  const writes: string[] = [], acks: number[] = [];
  const terminal = { write(data: string, done: () => void) { writes.push(data); queueMicrotask(done); } };
  let queue: Promise<unknown> = Promise.resolve();
  const chunks = ["\x1b[", "2J\x1b[H", "中文", "\ud83d", "\udc2f", "\r\n"];
  let paints = 0;
  chunks.forEach((chunk, index) => { queue = queueTerminalWrite(terminal, chunk, queue, () => true, () => paints++, () => acks.push(index)); });
  assert.deepEqual(acks, [], "do not ACK before parser consumption");
  await queue;
  assert.deepEqual(writes, [chunks.join("")]);
  assert.deepEqual(acks, [0, 1, 2, 3, 4, 5]);
  assert.equal(paints, 1, "one scroll/layout update for a burst");
});

test("snapshot barrier invalidates only superseded live frames and preserves post-init output", async () => {
  const writes: string[] = [], acks: string[] = [];
  const terminal = { write(data: string, done: () => void) { writes.push(data); queueMicrotask(done); } };
  let generation = 0;
  let queue: Promise<unknown> = Promise.resolve();
  queue = queueTerminalWrite(terminal, "old", queue, () => generation === 0, () => {}, () => acks.push("old"));
  generation++;
  queue = queue.then(() => { writes.push("RESET+SNAPSHOT"); });
  queue = queueTerminalWrite(terminal, "new", queue, () => generation === 1, () => {}, () => acks.push("new"));
  await queue;
  assert.deepEqual(writes, ["RESET+SNAPSHOT", "new"]);
  assert.deepEqual(acks, ["old", "new"]);
});

test("batch ceiling bounds parser calls without truncating large bursts", async () => {
  const writes: string[] = [];
  const terminal = { write(data: string, done: () => void) { writes.push(data); queueMicrotask(done); } };
  let queue: Promise<unknown> = Promise.resolve();
  for (let n = 0; n < 200; n++) queue = queueTerminalWrite(terminal, "x".repeat(1024), queue, () => true, () => {}, () => {});
  await queue;
  assert.equal(writes.join("").length, 200 * 1024);
  assert.equal(writes.length, 4);
});

test("parser failure releases ACK credit and does not poison the next batch", async () => {
  let writes = 0, acks = 0;
  const terminal = { write(_data: string, done: () => void) { if (++writes === 1) throw Error("disposed"); done(); } };
  const failed = queueTerminalWrite(terminal, "old", Promise.resolve(), () => true, () => {}, () => acks++);
  await assert.rejects(failed, /disposed/);
  await queueTerminalWrite(terminal, "new", failed, () => true, () => {}, () => acks++);
  assert.equal(acks, 2);
});
