import test from "node:test";
import { runNodeHarness } from "./helpers/test-process.js";

test("HR recruitment previews candidates before onboarding and preserves failed/cancelled drafts", {
  skip: process.env.WAND_HR_RECRUITMENT_QA !== "1", timeout: 180_000,
}, async (t) => {
  await runNodeHarness(t, "tests/helpers/run-employee-profile-browser-harness.mjs", {
    timeoutMs: 175_000,
  });
});
