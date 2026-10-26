import { existsSync } from "node:fs";
import { test } from "node:test";
import { runNodeHarness } from "./helpers/test-process.js";

const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("real Chrome plush avatar editing, animation, accessibility and render budgets", {
  // The shared CI browser lane sets WAND_BROWSER_E2E and CHROME_BIN. Locally,
  // run automatically when Chrome is installed rather than hiding behind opt-in.
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome),
  timeout: 180_000,
}, async (t) => {
  const output = await runNodeHarness(t, "tests/helpers/run-plush-avatar-browser-harness.mjs", {
    timeoutMs: 175_000,
  });
  for (const line of output.split("\n").filter(line => line.startsWith('{"browserMotionFixture":'))) t.diagnostic(line);
});
