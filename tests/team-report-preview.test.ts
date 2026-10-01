import assert from "node:assert/strict";
import test from "node:test";
import { teamReportPreview } from "../src/team-report-preview.js";

test("report preview uses the real title and prefers a conclusion over introductory boilerplate", () => {
  const preview = teamReportPreview("# 工具时间线验收报告\n\n这是背景说明。\n\n## 结论\n\n- **已通过**六种界面验证。\n- 长报告不会挤满群聊。\n\n## 完整记录\n\n不应进入卡片的记录。", "第2步");
  assert.deepEqual(preview, { title: "工具时间线验收报告", excerpt: "已通过六种界面验证。\n长报告不会挤满群聊。" });
});

test("preview strips Markdown syntax, not meaning, and never fetches links or images", () => {
  assert.deepEqual(teamReportPreview("报告标题\n===\n\n> [文档](https://invalid.test)完成，`api_key`保留。\n- [x] ![结果图片](https://invalid.test/x.png)\n", "内部文件名"), {
    title: "报告标题", excerpt: "文档完成，api_key保留。\n结果图片",
  });
});

test("metadata, comments and fenced code do not become a misleading report preview", () => {
  const preview = teamReportPreview("---\nsecret: 元数据不展示\n---\n<!-- 隐藏备注 -->\n```md\n# 不是报告标题\n私有代码\n```\n# 正式报告\n\n正文摘要。\n<script>脚本不展示</script>\n<style>样式不展示</style>", "fallback");
  assert.deepEqual(preview, { title: "正式报告", excerpt: "正文摘要。" });
});

test("short plain reports use the task title; empty or code-only reports do not invent an excerpt", () => {
  assert.deepEqual(teamReportPreview("已完成，测试通过。", "修复输入恢复"), { title: "修复输入恢复", excerpt: "已完成，测试通过。" });
  assert.deepEqual(teamReportPreview("", "空报告"), { title: "空报告", excerpt: "" });
  assert.deepEqual(teamReportPreview("## 结论\n\n```sh\necho code\n```", "验证报告"), { title: "验证报告", excerpt: "" });
});

test("preview has at most three logical lines and bounded Unicode-safe title/excerpt", () => {
  const title = "猫🐈报告".repeat(50);
  const preview = teamReportPreview(`# ${title}\n\n${"完整正文🐈".repeat(10_000)}`, "fallback");
  assert.equal(Array.from(preview.title).length, 100);
  assert.equal(Array.from(preview.excerpt).length, 240);
  assert.ok(preview.title.endsWith("…") && preview.excerpt.endsWith("…"));
  assert.ok(!/[\uD800-\uDBFF]…$/.test(preview.title));
  assert.equal(teamReportPreview("第一行\n第二行\n第三行\n第四行", "报告").excerpt, "第一行\n第二行\n第三行…");
});

test("English summaries and empty summary sections fall back to actual report text", () => {
  assert.deepEqual(teamReportPreview("# Release report\nIntro.\n## Summary\nAll checks passed.\n## Detail\nLong detail.", "Step"), {
    title: "Release report", excerpt: "All checks passed.",
  });
  assert.equal(teamReportPreview("# 报告\n真实内容\n## 总结\n## 后续\n更多内容", "Step").excerpt, "真实内容\n更多内容");
});
