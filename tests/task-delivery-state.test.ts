import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { WandStorage } from "../src/storage.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import { taskAcceptanceLabel, taskReviewLabel, taskWorkLabel, taskSessionActivity, taskSessionSummary } from "../src/web-ui/react/issues/task-delivery-state.js";
import { issueBoardStats, issueProgressSeries } from "../src/web-ui/react/issues/task-board-agent.js";
import type { IssueSessionSummary } from "../src/web-ui/react/issues/task-board-repository.js";

const session = (patch: Partial<IssueSessionSummary> = {}): IssueSessionSummary => ({
  id: "s", title: "独立交付", provider: "pi", sessionKind: "structured", cwd: "/repo", model: "", thinkingEffort: "off", status: "idle", ...patch,
});

test("parallel execution uses facts; a queued follow-up cannot hide its live turn or permission", () => {
  assert.equal(taskSessionActivity(session({ status: "running", inFlight: false })), "状态未确认");
  assert.equal(taskSessionActivity(session({ inFlight: true, executionStatus: "queued", queuedMessageCount: 2 })), "运行中");
  assert.equal(taskSessionActivity(session({ inFlight: true, permissionBlocked: true })), "等待授权");
  assert.equal(taskSessionActivity(session({ inFlight: true, status: "waiting-input" })), "等待输入");
  assert.equal(taskSessionActivity(session({ status: "failed", queuedMessageCount: 1 })), "失败");
  assert.equal(taskSessionActivity(session({ archived: true, inFlight: true })), "已归档");
  assert.equal(taskSessionSummary([session({ status: "exited" }), session({ status: "waiting-input" })]), "已结束 1 · 等待输入 1");
  assert.equal(taskAcceptanceLabel(null), "未验收 · 待汇总交付");
  assert.equal(taskAcceptanceLabel({ evidence: "会话A: output/report", blocker: "等待部署：尚未安装", acceptedAt: null }), "待处理 · 有验收缺口");
});

test("submitted work awaits user acceptance; idle sessions and archival never imply completion", () => {
  const acceptance = { evidence: "交付报告", blocker: "下载与设备验收待核对", acceptedAt: null };
  const submitted = { status: "done" as const, acceptance };
  assert.equal(taskWorkLabel(submitted), "已完成");
  assert.equal(taskReviewLabel(submitted), "等待你验收");
  assert.equal(taskReviewLabel({ ...submitted, acceptance: { ...acceptance, blocker: "", acceptedAt: "2026-01-01" } }), "已通过");
  assert.equal(taskWorkLabel({ status: "doing", acceptance: null }), "处理中");
  assert.equal(taskReviewLabel({ status: "doing", acceptance: null }), "未验收");
  assert.equal(taskWorkLabel({ status: "archived", acceptance: null }), "未确认");
  assert.equal(taskReviewLabel({ status: "archived", acceptance: null }), "未验收");
  assert.equal(taskWorkLabel({ status: "archived", acceptance: { ...acceptance, blocker: "", acceptedAt: "2026-01-01" } }), "已完成");
});

test("iteration acceptance counts tasks, never done, archival or number of sessions", () => {
  const base = { priority: "low" as const, dueDate: null, createdAt: "2000-01-01", updatedAt: "2000-01-02" };
  const tasks = [
    { ...base, status: "done" as const },
    { ...base, status: "archived" as const },
    { ...base, status: "doing" as const, acceptance: { evidence: "报告", blocker: "", acceptedAt: "2000-01-03" } },
    { ...base, status: "archived" as const, acceptance: { evidence: "报告2", blocker: "", acceptedAt: "2000-01-04" } },
  ];
  assert.equal(issueBoardStats(tasks).accepted, 2);
  assert.equal(issueProgressSeries(tasks).at(-1)?.completed, 2);
  assert.equal(issueProgressSeries(tasks).at(-1)?.scope, 4);
});

test("HTTP task keeps multi-session delivery and acceptance independent without reading transcripts", async t => {
  const root = mkdtempSync(join(tmpdir(), "wand-task-delivery-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const task = storage.createWandTask({ title: "TASK-76 fixture", description: "两个独立范围，各有可复核产物", status: "doing" });
  for (const [id, status] of [["a", "exited"], ["b", "idle"]] as const) {
    storage.saveSession({ id, status, command: "pi", description: "范围" + id, cwd: root, mode: "default",
      exitCode: status === "exited" ? 0 : null, startedAt: "2000-01-01", endedAt: null, output: "", sessionKind: "structured",
      workspaceTaskId: task.workspaceTaskId!, provider: "pi", permissionBlocked: id === "b" });
  }
  const snapshots = storage.loadSessionsSlim().map(s => ({ ...s, permissionBlocked: s.id === "b" }));
  const sessions = { listSlim: () => snapshots, getSlim: (id: string) => snapshots.find(s => s.id === id) };
  const app = express(); app.use(express.json()); registerTaskRoutes(app, { storage, sessions: sessions as never });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); storage.close(); rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/wand-tasks/${task.id}`;
  t.mock.method(storage, "getSession", () => { throw Error("must not read full transcript"); });
  const get = () => fetch(url).then(r => r.json());
  let dto = await get();
  assert.equal(dto.status, "doing");
  assert.equal(dto.acceptance, null);
  assert.equal(dto.sessions.length, 2);
  assert.equal(dto.sessions.find((s: IssueSessionSummary) => s.id === "b").permissionBlocked, true);
  assert.equal(dto.sessions.find((s: IssueSessionSummary) => s.id === "a").purpose, "范围a");
  const patch = (acceptance: unknown) => fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ acceptance }) });
  assert.equal((await patch({ evidence: "a: report; b: 待确认", blocker: "等待验收", acceptedAt: "2000-01-01" })).status, 400);
  assert.equal((await patch({ evidence: "a: report; b: 待确认", blocker: "等待部署：未安装", acceptedAt: null })).status, 200);
  dto = await get(); assert.equal(dto.acceptance.acceptedAt, null); assert.equal(dto.status, "doing");
  assert.equal((await patch({ evidence: "a: report; b: verification", blocker: "", acceptedAt: "2000-01-01" })).status, 200);
  dto = await get(); assert.ok(dto.acceptance.acceptedAt); assert.equal(dto.status, "doing", "acceptance must not archive or publish");
});
