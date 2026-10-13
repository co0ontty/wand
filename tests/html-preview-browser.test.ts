import assert from "node:assert/strict";
import test from "node:test";

test("HTML artifacts run inline across shared chat surfaces without Wand origin privileges", { skip: process.env.WAND_HTML_PREVIEW_BROWSER !== "1", timeout: 180_000 }, async () => {
  // @ts-ignore Browser fixture is deliberately plain JavaScript like the other CDP harnesses.
  const { runHtmlPreviewBrowser } = await import("./helpers/html-preview-browser.mjs");
  const report = await runHtmlPreviewBrowser();
  assert.equal(report.ok, true);
});
