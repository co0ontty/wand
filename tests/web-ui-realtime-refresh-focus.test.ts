import assert from "node:assert/strict";
import test from "node:test";
import { runFocusBrowser } from "./helpers/realtime-refresh-focus-browser.mjs";

test("B01: exact on-demand Read result and the real summary focus/ancestor chain survive refresh and keyboard", { timeout: 120_000 }, async () => {
  const result = await runFocusBrowser({ matrix: ["desktop"], coreOnly: true,
    output: process.env.FOCUS_RESULT_PATH });
  assert.equal(result.ok, true);
});
