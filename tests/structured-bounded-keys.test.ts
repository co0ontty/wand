import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundedKeySet } from "../src/structured-bounded-keys.ts";

test("BoundedKeySet keeps the newest half once the bound is exceeded", () => {
  const keys = new BoundedKeySet(1024);
  for (let i = 0; i < 1024; i += 1) keys.add(`k${i}`);
  assert.equal(keys.size, 1024);
  keys.add("k1024");
  // Old behavior: 1025 entries, oldest ceil(1025 / 2) = 513 dropped, 512 kept.
  assert.equal(keys.size, 512);
  assert.equal(keys.has("k512"), false);
  assert.equal(keys.has("k513"), true);
  assert.equal(keys.has("k1024"), true);
});

test("BoundedKeySet re-adding a present key does not refresh its age", () => {
  const keys = new BoundedKeySet(4);
  keys.add("a"); keys.add("b"); keys.add("c"); keys.add("d");
  keys.add("a");
  keys.add("e");
  // 5 entries -> drop ceil(5/2)=3 oldest (a, b, c); d and e remain.
  assert.equal(keys.has("a"), false);
  assert.equal(keys.has("d"), true);
  assert.equal(keys.has("e"), true);
  assert.equal(keys.size, 2);
});

test("BoundedKeySet.deleteMatching forgets one session's keys only", () => {
  const keys = new BoundedKeySet(16);
  keys.add("s1:x"); keys.add("s2:x"); keys.add("s1:y");
  keys.deleteMatching((key) => key.startsWith("s1:"));
  assert.deepEqual(Array.from({ length: 3 }, (_, i) => ["s1:x", "s2:x", "s1:y"][i]).map((k) => keys.has(k)), [false, true, false]);
});
