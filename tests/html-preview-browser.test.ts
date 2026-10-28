import assert from "node:assert/strict";
import test from "node:test";

test("HTML artifacts run inline across shared chat surfaces without Wand origin privileges", { skip: process.env.WAND_HTML_PREVIEW_BROWSER !== "1", timeout: 180_000 }, async () => {
  // @ts-ignore Browser fixture is deliberately plain JavaScript like the other CDP harnesses.
  const { runHtmlPreviewBrowser } = await import("./helpers/html-preview-browser.mjs");
  const report = await runHtmlPreviewBrowser();
  assert.equal(report.ok, true);
  assert.deepEqual(report.formSafety.map(item => item.surface), ["local-file", "local-http"]);
  assert.ok(report.formSafety.every(item => item.reactSubmitWorks && item.nativeSubmitBlocked && item.opaqueOrigin));
  assert.equal(report.nativeRequests, 0);
  assert.equal(report.nonHtmlDownload, true);
  assert.equal(report.forwardedLargeDirectory, true);
});
