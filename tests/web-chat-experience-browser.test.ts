import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runFocusBrowser } from "./antd-chat-browser.test.js";

test("conversation hierarchy stays readable, lazy, truthful and keyboard accessible", {
  timeout: 180_000, skip: process.env.WAND_CHAT_EXPERIENCE_BROWSER !== "1",
}, async () => {
  const output = resolve("output/web-chat-experience-20261007");
  mkdirSync(output, { recursive: true });
  const result = await runFocusBrowser({ experienceOnly: true,
    matrix: ["desktop", "390px", "320px", "native-shell", "reactUi=0", "390px-native-reduce"],
    output: `${output}/experience-browser.json` });
  assert.equal(result.ok, true);
  assert.equal(result.cases.length, 6);
});
