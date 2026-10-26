import assert from "node:assert/strict";
import { test } from "node:test";
import { runNodeHarness } from "./helpers/test-process.js";

test("real Chrome feedback preserves raw diagnostics and task comments without cross-task writes", { timeout: 120_000, skip: process.env.WAND_FEEDBACK_BROWSER !== "1" }, async (t) => {
  const output = await runNodeHarness(t, "tests/helpers/feedback-web-browser.mjs", { timeoutMs: 115_000 });
  assert.match(output, /"lateTaskIsolation":true/);
});
