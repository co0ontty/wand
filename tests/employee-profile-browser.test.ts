import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";

const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("employee workspace preserves identity, draft, profile permissions and candidate contracts in real Chrome", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome),
  timeout: 180_000,
}, async () => {
  const child = spawn(process.execPath, ["tests/helpers/run-employee-profile-browser-harness.mjs"], {
    cwd: new URL("..", import.meta.url), env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, output);
});

test("employee delete confirmation ignores retained hidden surfaces and survives rapid reopen", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome),
  timeout: 90_000,
}, async () => {
  const child = spawn(process.execPath, ["tests/helpers/run-employee-profile-browser-harness.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, WAND_EMPLOYEE_CONFIRM_ONLY: "1", WAND_EMPLOYEE_PROFILE_OUTPUT: "output/employee-profile-browser/retained-surfaces" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, output);
});

test("dirty employee leave confirmation preserves drafts through rapid real-pointer cancellations", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome),
  timeout: 120_000,
}, async () => {
  const child = spawn(process.execPath, ["tests/helpers/run-employee-profile-browser-harness.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, WAND_EMPLOYEE_GUARD_ONLY: "1", WAND_EMPLOYEE_PROFILE_OUTPUT: "output/employee-profile-browser/dirty-leave" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, output);
});
