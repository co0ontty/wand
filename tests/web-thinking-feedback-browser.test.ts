import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runFocusBrowser } from "./antd-chat-browser.test.js";

test("thinking activity displays elapsed and silence feedback in real Chrome", {
  timeout: 120_000, skip: process.env.WAND_THINKING_BROWSER !== "1",
}, async () => {
  const output = resolve(import.meta.dirname, "../output/status-feedback");
  mkdirSync(output, { recursive: true });
  const result = await runFocusBrowser({ thinkingOnly: true,
    matrix: ["desktop", "390px", "native-shell", "reactUi=0", "reduce-motion", "390px-native-reduce", "dark"],
    output: join(output, "thinking-browser.json") });
  assert.equal(result.ok, true);
});
