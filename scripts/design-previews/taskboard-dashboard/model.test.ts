import assert from "node:assert/strict";
import test from "node:test";
import { advance, emptyFilters, fixtures, projectGoals, summary } from "./model.ts";
test("主目标统计不重复计算子任务，AI 通过不计人工完成", () => {
  const stats = summary(fixtures.filter(task => !task.parentId));
  assert.equal(stats.total, 20); assert.equal(stats.accepted, 4); assert.equal(stats.percent, 20);
  assert.equal(stats.active, 16); assert.equal(stats.counts.review, 3); assert.equal(stats.counts.ready, 3);
  assert.equal(stats.aiPassed, 7);
});
test("子任务搜索保留真实主目标上下文，不改父任务状态", () => {
  const result = projectGoals(fixtures, { ...emptyFilters, query: "Mac 状态语义对齐", stages: ["review"] });
  assert.equal(result.length, 1); assert.equal(result[0].id, "DEMO-07"); assert.equal(result[0].stage, "doing");
  assert.equal(projectGoals(fixtures, { ...emptyFilters, query: "不存在的例子" }).length, 0);
});
test("归档与主看板分离，搜索筛选使用同一投影", () => {
  assert.equal(projectGoals(fixtures, emptyFilters).length, 16);
  assert.equal(projectGoals(fixtures, emptyFilters, true).length, 4);
  const ready = projectGoals(fixtures, { ...emptyFilters, stages: ["ready"] });
  assert.equal(ready.length, 3); assert.ok(ready.every(task => task.stage === "ready"));
});
test("AI 通过仅推进待归档，人工确认才提升完成度并移入归档", () => {
  const ready = advance(fixtures, "DEMO-12", "pass", "示例核验通过", "");
  assert.equal(ready.find(task => task.id === "DEMO-12")!.stage, "ready");
  assert.equal(summary(ready.filter(task => !task.parentId)).percent, 20);
  const archived = advance(ready, "DEMO-12", "archive", "示例核验通过", "");
  assert.equal(summary(archived.filter(task => !task.parentId)).percent, 25);
  assert.equal(projectGoals(archived, emptyFilters, true).length, 5);
});
test("AI/人工退回保留原因，仍有执行和未验收子任务阻止推进", () => {
  const failed = advance(fixtures, "DEMO-12", "fail", "复现记录", "触控缺口");
  assert.equal(failed.find(task => task.id === "DEMO-12")!.stage, "doing");
  assert.equal(failed.find(task => task.id === "DEMO-12")!.gap, "触控缺口");
  const returned = advance(fixtures, "DEMO-14", "return", "记录", "人工不认可");
  assert.equal(returned.find(task => task.id === "DEMO-14")!.aiPassed, false);
  assert.throws(() => advance(fixtures, "DEMO-11", "pass", "记录", ""), /仍有运行/);
  const parent = fixtures.map(task => task.id === "DEMO-07" ? { ...task, runtime: "idle" as const, stage: "review" as const } : task);
  assert.throws(() => advance(parent, "DEMO-07", "pass", "记录", ""), /子任务/);
});
