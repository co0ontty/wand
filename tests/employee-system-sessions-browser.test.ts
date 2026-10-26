import { existsSync } from "node:fs";
import test from "node:test";
import { runNodeHarness } from "./helpers/test-process.js";

const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("employee session list shows late Git audit records with read-only actions and retention refresh", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome), timeout: 90_000,
}, async t => {
  await runNodeHarness(t, "tests/helpers/run-employee-system-sessions-browser.mjs", {
    timeoutMs: 85_000,
  });
});
