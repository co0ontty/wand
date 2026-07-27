import assert from "node:assert/strict";
import test from "node:test";

import { parseBoundedInteger } from "../src/request-limits.js";

test("bounded integer parsing defaults invalid values and clamps extremes", () => {
  assert.equal(parseBoundedInteger(undefined, 5, 0, 8), 5);
  assert.equal(parseBoundedInteger("not-a-number", 5, 0, 8), 5);
  assert.equal(parseBoundedInteger("12px", 5, 0, 8), 5);
  assert.equal(parseBoundedInteger("-3", 5, 0, 8), 0);
  assert.equal(parseBoundedInteger("999999", 5, 0, 8), 8);
  assert.equal(parseBoundedInteger("7", 5, 0, 8), 7);
});
