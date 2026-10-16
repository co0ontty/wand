import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

// Explicit opt-in: requires the installed OpenCode CLI, but calls only a local
// mock provider. Never sends prompts to a real model or changes CLI config files.
test("native OpenCode auto-rejects pure-text tool requests despite inherited allows", {
  skip: process.env.WAND_TEST_NATIVE_OPENCODE !== "1",
  timeout: 45_000,
}, async () => {
  const { stdout } = await promisify(execFile)(process.execPath,
    ["--import", "tsx", "tests/helpers/verify-opencode-permissions.mjs"],
    { cwd: process.cwd(), timeout: 40_000 });
  assert.equal(JSON.parse(stdout.trim()).passed, true);
});
