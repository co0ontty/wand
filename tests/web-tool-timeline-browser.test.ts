import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
test("real Chrome tool timeline auto-expands, follows new calls and preserves manual reading", {
  timeout: 180_000,
}, async (t) => {
  // 浏览器回归默认关闭：本地 npm test 只跑单测；CI（和需要时手动）用 WAND_BROWSER_E2E=1 打开。
  if (process.env.WAND_BROWSER_E2E !== "1") {
    t.skip("set WAND_BROWSER_E2E=1 to run the Chrome CDP tool timeline regression");
    return;
  }
  const { stdout } = await exec(process.execPath, [
    new URL("./helpers/run-tool-timeline-browser-harness.mjs", import.meta.url).pathname,
  ], { maxBuffer: 2 * 1024 * 1024, timeout: 170_000 });
  const report = JSON.parse(stdout.trim());
  assert.equal(report.ok, true);
  assert.equal(report.cases.length, 24);
  assert.equal(report.cases.filter((entry: any) => entry.case === "live-auto-expand" && entry.ok).length, 6);
  assert.equal(report.cases.filter((entry: any) => entry.case === "automatic-resource-notice" && entry.ok).length, 6);
  // 面板高度按会话视口派生（120–240 之间），不是某个固定像素值。
  assert.equal(report.cases.filter((entry: any) => entry.rows === 40
    && entry.panelHeight === Math.round(Math.max(120, Math.min(240, entry.viewportHeight / 3)))).length, 6);
  assert.ok(report.cases.filter((entry: any) => entry.rows === 40)
    .every((entry: any) => entry.decisionIndependent && entry.decisionPendingErrorAndOrphan && entry.decisionFeedbackStable
      && entry.decisionDefaultCollapsed && entry.decisionHeaderStable));
  const summaryCase = report.cases.find((entry: any) => entry.mode === "collapsed-summary-time");
  assert.match(summaryCase?.clock ?? "", /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(summaryCase?.first, "深度思考");
  const previewCase = report.cases.find((entry: any) => entry.mode === "compact-preview");
  assert.ok(previewCase?.inputVisible && previewCase?.resultVisible && previewCase?.noDetailFetch);
  for (const mode of ["pending-command", "retry-command", "late-command"]) {
    assert.equal(report.cases.find((entry: any) => entry.mode === mode)?.ok, true);
  }
  const file = report.cases.find((entry: any) => entry.mode === "file-action");
  assert.ok(file?.lazy && file?.currentFile && file?.innerEscape);
  assert.equal(report.errors.length, 0);
});
