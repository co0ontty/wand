import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
test("real Chrome tool timeline keeps all calls, fixed height and click-only detail requests", {
  timeout: 180_000,
}, async () => {
  const { stdout } = await exec(process.execPath, [
    new URL("./helpers/run-tool-timeline-browser-harness.mjs", import.meta.url).pathname,
  ], { maxBuffer: 2 * 1024 * 1024, timeout: 170_000 });
  const report = JSON.parse(stdout.trim());
  assert.equal(report.ok, true);
  assert.equal(report.cases.length, 6);
  assert.equal(report.errors.length, 0);
});
