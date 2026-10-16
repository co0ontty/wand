import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

test("real Chrome feedback preserves raw diagnostics and task comments without cross-task writes", { timeout: 120_000, skip: process.env.WAND_FEEDBACK_BROWSER !== "1" }, async () => {
  const child = spawn(process.execPath, ["tests/helpers/feedback-web-browser.mjs"], { cwd: new URL("..", import.meta.url), env: process.env });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, output);
  assert.match(output, /"lateTaskIsolation":true/);
});
