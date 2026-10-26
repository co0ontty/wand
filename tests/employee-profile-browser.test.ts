import { existsSync } from "node:fs";
import { test } from "node:test";
import { runNodeHarness } from "./helpers/test-process.js";

const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("employee workspace preserves identity, draft, profile permissions and candidate contracts in real Chrome", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome),
  timeout: 180_000,
}, async (t) => {
  await runNodeHarness(t, "tests/helpers/run-employee-profile-browser-harness.mjs", {
    timeoutMs: 175_000,
  });
});

test("employee delete confirmation ignores retained hidden surfaces and survives rapid reopen", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome),
  timeout: 90_000,
}, async (t) => {
  await runNodeHarness(t, "tests/helpers/run-employee-profile-browser-harness.mjs", {
    timeoutMs: 85_000,
    env: { ...process.env, WAND_EMPLOYEE_CONFIRM_ONLY: "1", WAND_EMPLOYEE_PROFILE_OUTPUT: "output/employee-profile-browser/retained-surfaces" },
  });
});

test("dirty employee leave confirmation preserves drafts through rapid real-pointer cancellations", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome),
  timeout: 120_000,
}, async (t) => {
  await runNodeHarness(t, "tests/helpers/run-employee-profile-browser-harness.mjs", {
    timeoutMs: 115_000,
    env: { ...process.env, WAND_EMPLOYEE_GUARD_ONLY: "1", WAND_EMPLOYEE_PROFILE_OUTPUT: "output/employee-profile-browser/dirty-leave" },
  });
});
