import assert from "node:assert/strict";
import test from "node:test";
import { runCommand, runCommandSync } from "../src/run-command.js";

const inspectEnv = "process.stdout.write(JSON.stringify({value: process.env.WAND_COMMAND_TEST, leaked: Object.keys(process.env).some(k => k.startsWith('WAND_DECISION_'))}))";

test("sync and async one-shot commands strip decision capabilities without mutating explicit env", async () => {
  const env = { WAND_COMMAND_TEST: "kept", WAND_DECISION_TOKEN: "test-only", WAND_DECISION_FUTURE: "test-only" };
  const sync = runCommandSync(process.execPath, ["-e", inspectEnv], { env });
  assert.equal(sync.status, 0, sync.stderr);
  assert.deepEqual(JSON.parse(sync.stdout), { value: "kept", leaked: false });
  const async = await runCommand(process.execPath, ["-e", inspectEnv], { env });
  assert.equal(async.ok, true, async.stderr);
  assert.deepEqual(JSON.parse(async.stdout), { value: "kept", leaked: false });
  assert.equal(env.WAND_DECISION_TOKEN, "test-only");
});

test("command failures are explicit results in both variants", async () => {
  const args = ["-e", "process.stderr.write('failed'); process.exit(7)"];
  const sync = runCommandSync(process.execPath, args);
  assert.equal(sync.status, 7);
  assert.equal(sync.stderr, "failed");
  const async = await runCommand(process.execPath, args);
  assert.equal(async.ok, false);
  assert.equal(async.code, 7);
  assert.equal(async.stderr, "failed");
});

test("one-shot command timeout and output cap are enforced", async () => {
  const timeout = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 100 });
  assert.equal(timeout.ok, false);
  assert.ok(timeout.error);
  const capped = await runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"], { maxBuffer: 128 });
  assert.equal(capped.ok, false);
  assert.ok(capped.error);
});
