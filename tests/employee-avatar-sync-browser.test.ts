import { existsSync } from "node:fs";
import test from "node:test";
import { runNodeHarness } from "./helpers/test-process.js";

const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("employee avatars synchronize across clients, reconnects and open profile editors in real Chrome", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome), timeout: 150_000,
}, async (t) => {
  await runNodeHarness(t, "tests/helpers/run-employee-avatar-sync-browser-harness.mjs", {
    timeoutMs: 145_000,
  });
});
