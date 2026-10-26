import { test } from "node:test";
import { runNodeHarness } from "./helpers/test-process.js";

test("employee directory, creation and editor adapt to their real container without losing drafts", {
  skip: process.env.WAND_EMPLOYEE_LAYOUT_QA !== "1",
  timeout: 240_000,
}, async (t) => {
  await runNodeHarness(t, "tests/helpers/run-employee-profile-browser-harness.mjs", {
    timeoutMs: 235_000,
  });
});
