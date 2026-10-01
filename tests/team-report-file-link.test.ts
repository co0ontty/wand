import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { linkedTeamReportFile } from "../src/team-report-file-link.js";

function fixture(t: TestContext): { root: string; cwd: string; report: string; started: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-report-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo"); mkdirSync(cwd);
  const report = path.join(cwd, "报告 report.md"); writeFileSync(report, "# 报告\n\n真实正文");
  return { root, cwd, report, started: new Date(Date.now() - 2000).toISOString() };
}

test("an explicit newly delivered report link resolves to its real local file", (t) => {
  const f = fixture(t);
  const delivered = linkedTeamReportFile(f.cwd, `已写入并核对报告：[验收报告](<${f.report}>)。`, f.started)!;
  assert.equal(delivered.relativePath, "报告 report.md");
  assert.equal(linkedTeamReportFile(f.cwd, `Written report: [report](${pathToFileURL(f.report)})`, f.started)?.relativePath, delivered.relativePath);
  assert.equal(linkedTeamReportFile(f.cwd, `[报告](报告%20report.md)`, f.started)?.relativePath, delivered.relativePath);
  const sameMillisecond = new Date(f.started); utimesSync(f.report, sameMillisecond, sameMillisecond);
  assert.ok(linkedTeamReportFile(f.cwd, `[报告](<${f.report}>)`, f.started), "文件系统亚毫秒精度不能误拒同一毫秒的产物");
});

test("outside-cwd, symlink escapes, old reports, remote URLs and ordinary references are not delivered files", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside-report.md"); writeFileSync(outside, "private");
  const symlink = path.join(f.cwd, "escape-report.md"); symlinkSync(outside, symlink);
  for (const target of [outside, symlink, "https://invalid.test/report.md", "../outside-report.md", "/missing/report.md"]) {
    assert.equal(linkedTeamReportFile(f.cwd, `已写入报告：[报告](<${target}>)`, f.started), null);
  }
  assert.equal(linkedTeamReportFile(f.cwd, `参考[报告](<${f.report}>)`, f.started), null);
  assert.equal(linkedTeamReportFile(f.cwd, `已写入[报告](<${f.report}>)`, null), null);
  const old = new Date(Date.parse(f.started) - 1000); utimesSync(f.report, old, old);
  assert.equal(linkedTeamReportFile(f.cwd, `已写入[报告](<${f.report}>)`, f.started), null);
});

test("multiple different reports are ambiguous; repeated links to the same report are not", (t) => {
  const f = fixture(t);
  const second = path.join(f.cwd, "second-report.md"); writeFileSync(second, "second");
  assert.equal(linkedTeamReportFile(f.cwd, `已写入[报告](<${f.report}>)和[报告](<${second}>)`, f.started), null);
  assert.ok(linkedTeamReportFile(f.cwd, `已写入[报告](<${f.report}>)和[报告](<${f.report}>)`, f.started));
});
