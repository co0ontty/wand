import assert from "node:assert/strict";
import test from "node:test";
import { snapshotArrived, waitForSnapshot } from "../src/web-ui/browser/snapshot-arrival.js";

test("WS snapshot suppresses only its own pending HTTP fallback", async () => {
  const a = waitForSnapshot("a", 30), b = waitForSnapshot("b", 30);
  snapshotArrived("a");
  assert.equal(await a, true);
  assert.equal(await b, false);
  const reentered = waitForSnapshot("a", 10);
  assert.equal(await reentered, false, "a previous visit's init cannot satisfy a new generation");
});
test("multiple readers share the arrival without stealing or retaining completed callbacks", async () => {
  const a = waitForSnapshot("same", 30), b = waitForSnapshot("same", 30);
  snapshotArrived("same");
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  snapshotArrived("same"); // cleanup leaves no stale callback to invoke
});
