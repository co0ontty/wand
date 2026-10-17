import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTaskDispatchPrompt, taskDispatchConfiguration } from "../src/web-ui/react/issues/task-dispatch-preview.js";

test("approved dispatch contains the deliverable, acceptance gap, exact parent constraints and current instruction", () => {
  const task = { identifier: "TASK-2", title: "独立交付", description: "仅修复本模块；验收用隔离测试", updatedAt: "2026-10-17T00:00:00Z", acceptance: { evidence: "output/report.txt", blocker: "待运行环境验收", acceptedAt: null } };
  const prompt = buildTaskDispatchPrompt(task, { ...task, identifier: "TASK-1", title: "主目标", description: "不发布，不重跑其他已完成工作" }, "开始本轮实现");
  for (const text of ["TASK-2", "仅修复本模块", "output/report.txt", "待运行环境验收", "TASK-1", "不发布", "开始本轮实现", "不重跑其他子任务", task.updatedAt]) assert.ok(prompt.includes(text), text);
  assert.ok(prompt.endsWith("开始本轮实现"));
});

test("dispatch preview lists the employee's existing ordered candidates without altering them", () => {
  const agents = [{ provider: "pi" as const, engine: "sdk" as const, model: "configured/free", thinkingEffort: "off" as const, mode: "default" as const, kind: "structured" as const }, { provider: "pi" as const, model: "configured/second", thinkingEffort: "deep" as const, mode: "default" as const, kind: "structured" as const }];
  const before = structuredClone(agents);
  const preview = taskDispatchConfiguration(agents[0]!, { name: "具体员工", agents });
  for (const text of ["具体员工", "Wand Agent", "Pi", "configured/free", "configured/second"]) assert.ok(preview.includes(text), text);
  assert.ok(preview.indexOf("configured/free") < preview.indexOf("configured/second"));
  assert.deepEqual(agents, before);
});
