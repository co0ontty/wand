import { existsSync } from "node:fs";
import { test } from "node:test";
import { runNodeHarness } from "./helpers/test-process.js";

const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("real Chrome plush runtime resource recovery stays bounded and preserves mounted identity", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome), timeout: 180_000,
}, async (t) => {
  const output = await runNodeHarness(t, "tests/helpers/run-plush-avatar-loader-browser-harness.mjs", {
    timeoutMs: 175_000,
  });
  for (const line of output.split("\n").filter(line => line.startsWith('{"browserMotionFixture":'))) t.diagnostic(line);
});
