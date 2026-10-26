import { existsSync } from "node:fs";
import { test } from "node:test";
import { runNodeHarness } from "./helpers/test-process.js";

const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("ambient 3D identities stay deferred until the first-screen phase ends", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome), timeout: 240_000,
}, async (t) => {
  await runNodeHarness(t, "tests/helpers/run-plush-avatar-deferral-browser-harness.mjs", {
    timeoutMs: 235_000,
  });
});
