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
  assert.equal(report.cases.length, 8);
  assert.ok(report.cases.filter((entry: any) => !["collapsed-summary-time", "compact-preview"].includes(entry.mode))
    .every((entry: any) => entry.decisionIndependent && entry.decisionPendingErrorAndOrphan && entry.decisionFeedbackStable
      && entry.decisionDefaultCollapsed && entry.decisionHeaderStable));
  const summaryCase = report.cases.find((entry: any) => entry.mode === "collapsed-summary-time");
  assert.match(summaryCase?.clock ?? "", /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(summaryCase?.first, "深度思考");
  const previewCase = report.cases.find((entry: any) => entry.mode === "compact-preview");
  assert.ok(previewCase?.inputVisible && previewCase?.resultVisible && previewCase?.noDetailFetch);
  assert.equal(report.errors.length, 0);
});
