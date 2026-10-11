import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("Garfield and silver shaded render with unclipped breed-specific 3D and static fallbacks", {
  skip: process.env.WAND_CAT_BREED_QA !== "1", timeout: 120_000,
}, async () => {
  const child = spawn(process.execPath, ["tests/helpers/cat-breed-browser.mjs"], {
    cwd: new URL("..", import.meta.url), env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, output);
});
