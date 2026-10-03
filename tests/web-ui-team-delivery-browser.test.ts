import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
test("real Chrome synthetic delivery context: anchored disclosures, public preview, draft and request guards", {
  timeout: 180_000,
}, async () => {
  const { stdout } = await exec(process.execPath, ["--import", "tsx",
    new URL("./helpers/run-team-delivery-browser-harness.mjs", import.meta.url).pathname,
  ], { maxBuffer: 2 * 1024 * 1024, timeout: 170_000 });
  const report = JSON.parse(stdout.trim());
  assert.equal(report.ok, true);
  assert.equal(report.fixture, "synthetic, not live acceptance");
  assert.deepEqual(report.results.map((row: { mode: string }) => row.mode), ["desktop", "390px", "reduce-motion"]);
  for (const row of report.results) {
    for (const key of ["summaryAndTotals", "noPrefetch", "publicPreviewAndDownload", "triggerStable",
      "closeAndEscape", "lateDeliveryChoicePreserved", "latePreviewProtected", "cappedWindowProtected",
      "newerMissingDeliveryFallback", "draftPreserved", "oldServerFallback"]) {
      assert.equal(row[key], true, `${row.mode}: ${key}`);
    }
  }
  for (const key of ["taskRequestGeneration", "actionReceiptInvalidatesOldGet", "taskSwitchProtected", "oldActionProtected",
    "replyRevisionProtected", "statusDraftPreserved"]) assert.equal(report[key], true, key);
  assert.equal(report.filesRead, 3);
  assert.equal(report.knowledgeReads, 0);
  assert.equal(report.errors, 0);
});
