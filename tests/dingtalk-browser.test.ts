import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("production DingTalk settings select multiple groups/employees, require fresh plans and preserve Portal ownership", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome), timeout: 120_000,
}, async () => {
  const child = spawn(process.execPath, ["tests/helpers/run-dingtalk-browser-harness.mjs"], { cwd: new URL("..", import.meta.url), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", b => { output = (output + b).slice(-128_000); });
  child.stderr.on("data", b => { output = (output + b).slice(-128_000); });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, output);
});
