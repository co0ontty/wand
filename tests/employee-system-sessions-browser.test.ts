import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";

const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("employee session list shows late Git audit records with read-only actions and retention refresh", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome), timeout: 90_000,
}, async t => {
  const child = spawn(process.execPath, ["tests/helpers/run-employee-system-sessions-browser.mjs"], {
    cwd: new URL("..", import.meta.url), env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, output);
});
