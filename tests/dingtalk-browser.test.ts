import { existsSync } from "node:fs";
import test from "node:test";
import { runNodeHarness } from "./helpers/test-process.js";
const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("production DingTalk settings select multiple groups/employees, require fresh plans and preserve Portal ownership", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome), timeout: 120_000,
}, async (t) => {
  await runNodeHarness(t, "tests/helpers/run-dingtalk-browser-harness.mjs", { timeoutMs: 115_000 });
});
