import assert from "node:assert/strict";
import test from "node:test";

import { structuredRunEvictionOrder, type StructuredRunRetentionEntry } from "../src/terminal-daemon-server.js";

/**
 * Retained replay logs are the daemon's largest unbounded-by-intent memory use:
 * a count-only cap of 256 runs still allows 256 x 8M chars. These cases pin the
 * aggregate budget and the age rule that close that gap.
 */

const HOUR = 60 * 60 * 1000;
const MAX_LOG_CHARS = 8 * 1024 * 1024;

function exited(runId: string, logChars: number, exitedAt: number): StructuredRunRetentionEntry {
  return { runId, status: "exited", exitedAt, logChars };
}

test("retains recent exited runs so a web restart can still adopt them", () => {
  const now = Date.now();
  const entries = [
    exited("structured:a", 1024, now - 1000),
    exited("structured:b", 1024, now - 500),
  ];
  assert.deepEqual(structuredRunEvictionOrder(entries, now), []);
});

test("never evicts a running run, even when it pushes the map over the caps", () => {
  const now = Date.now();
  const entries: StructuredRunRetentionEntry[] = [
    { runId: "structured:live", status: "running", exitedAt: null, logChars: MAX_LOG_CHARS },
  ];
  for (let i = 0; i < 200; i++) entries.push(exited(`structured:e${i}`, MAX_LOG_CHARS, now));
  const evicted = structuredRunEvictionOrder(entries, now);
  assert.ok(!evicted.includes("structured:live"));
  assert.ok(evicted.length > 0);
});

test("bounds the aggregate size of retained replay logs", () => {
  const now = Date.now();
  // 8 runs x 8M chars = 64M chars, twice the 32M budget.
  const entries = Array.from({ length: 8 }, (_, i) => exited(`structured:${i}`, MAX_LOG_CHARS, now));
  const evicted = structuredRunEvictionOrder(entries, now);
  assert.deepEqual(evicted, ["structured:0", "structured:1", "structured:2", "structured:3"]);
  const keptChars = entries
    .filter((entry) => !evicted.includes(entry.runId))
    .reduce((total, entry) => total + entry.logChars, 0);
  assert.ok(keptChars <= 32 * 1024 * 1024, `kept ${keptChars} chars`);
});

test("bounds the number of retained empty exited runs", () => {
  const now = Date.now();
  const entries = Array.from({ length: 140 }, (_, i) => exited(`structured:${i}`, 0, now));
  const evicted = structuredRunEvictionOrder(entries, now);
  assert.equal(evicted.length, 12, "oldest runs are dropped down to the count cap");
  assert.equal(evicted[0], "structured:0");
});

test("expires exited runs older than the adoption window", () => {
  const now = Date.now();
  const entries = [
    exited("structured:old", 1024, now - 3 * HOUR),
    exited("structured:fresh", 1024, now - 1000),
  ];
  assert.deepEqual(structuredRunEvictionOrder(entries, now), ["structured:old"]);
});
