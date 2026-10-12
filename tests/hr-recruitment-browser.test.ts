import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("HR recruitment previews candidates before onboarding and preserves failed/cancelled drafts", {
  skip: process.env.WAND_HR_RECRUITMENT_QA !== "1", timeout: 180_000,
}, async () => {
  const child = spawn(process.execPath, ["tests/helpers/run-employee-profile-browser-harness.mjs"], {
    cwd: new URL("..", import.meta.url), env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, output);
});
