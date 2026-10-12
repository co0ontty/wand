import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";

const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("real Chrome plush runtime resource recovery stays bounded and preserves mounted identity", {
  skip: process.env.WAND_BROWSER_E2E !== "1" && !existsSync(chrome), timeout: 180_000,
}, async (t) => {
  const child = spawn(process.execPath, ["tests/helpers/run-plush-avatar-loader-browser-harness.mjs"], {
    cwd: new URL("..", import.meta.url), env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  for (const line of output.split("\n").filter(line => line.startsWith('{"browserMotionFixture":'))) t.diagnostic(line);
  assert.equal(code, 0, output);
});
