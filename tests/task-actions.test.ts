import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { WandStorage } from "../src/storage.js";
import { readTaskActions } from "../src/task-actions.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import type { SessionRegistry } from "../src/session-registry.js";
import type { SessionSnapshot } from "../src/types.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "wand-task-actions-"));
  const storage = new WandStorage(join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const task = storage.createWandTask({ title: "行动来源", status: "doing", description: "" });
  const snapshots: SessionSnapshot[] = [];
  const registry = { listSlim: () => snapshots.map(({ messages: _m, ...s }) => s), getRuntimeSnapshot: (id: string) => snapshots.find(s => s.id === id) ?? null } as SessionRegistry;
  function session(id: string, patch: Partial<SessionSnapshot> = {}) {
    const value = { id, status: "running", command: "pi", cwd: root, mode: "default", exitCode: null, startedAt: "2026-01-01", endedAt: null,
      output: "", archived: false, archivedAt: null, claudeSessionId: null, sessionKind: "structured", provider: "pi", workspaceTaskId: task.workspaceTaskId!, ...patch } as SessionSnapshot;
    snapshots.push(value); return value;
  }
  // Action discovery must never load stored message bodies or change acceptance.
  t.mock.method(storage, "getSession", () => { throw Error("full transcript hydration forbidden"); });
  return { storage, task, registry, session, snapshots };
}

test("task actions bind current permission and unanswered tool to their exact source; reads never accept", t => {
  const f = fixture(t);
  f.session("permission", { pendingEscalation: { requestId: "request-a", reason: "写入文件需确认", target: "/tmp/a" } as never });
  const question = f.session("question", { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "请选择测试范围", options: [] }] } }] }] });
  const before = f.storage.getWandTask(f.task.id);
  let result = readTaskActions(f.storage, f.registry);
  assert.equal(result.incompleteSources, 0);
  assert.deepEqual(result.items.map(x => [x.kind, x.source]), [["permission", { sessionId: "permission", requestId: "request-a" }], ["question", { sessionId: "question", toolId: "q1" }]]);
  assert.deepEqual(f.storage.getWandTask(f.task.id), before);
  question.messages!.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "q1", content: "范围A" }] });
  result = readTaskActions(f.storage, f.registry);
  assert.equal(result.items.filter(x => x.kind === "question").length, 0);
});

test("review and blocker reuse explicit acceptance; idle, failure, archive and evidence alone aren't actions", t => {
  const f = fixture(t);
  f.session("idle", { status: "idle" }); f.session("failed", { status: "failed" });
  const review = f.storage.createWandTask({ title: "待验收", description: "", status: "done" });
  const blocker = f.storage.createWandTask({ title: "阻塞", description: "", status: "done" });
  f.storage.updateWandTask(blocker.id, { acceptance: { evidence: "报告", blocker: "需补证据，未明确处理人", acceptedAt: null } });
  f.storage.updateWandTask(f.task.id, { acceptance: { evidence: "仅有证据", blocker: "", acceptedAt: null } });
  f.storage.createWandTask({ title: "已归档", description: "", status: "archived" });
  const result = readTaskActions(f.storage, f.registry);
  assert.deepEqual(new Set(result.items.map(x => x.kind)), new Set(["review", "blocker"]));
  assert.equal(result.items.find(x => x.kind === "blocker")!.reason, "需补证据，未明确处理人");
  f.storage.updateWandTask(review.id, { acceptance: { evidence: "报告", blocker: "", acceptedAt: "2026-01-01" } });
  assert.equal(readTaskActions(f.storage, f.registry).items.filter(x => x.kind === "review").length, 0);
});

test("one missing runtime keeps known facts and reports incomplete rather than false zero; budgets are bounded", t => {
  const f = fixture(t);
  for (let n = 0; n < 260; n++) f.session("s-" + n, { permissionBlocked: true });
  f.registry.getRuntimeSnapshot = () => { throw Error("runtime unavailable"); };
  const result = readTaskActions(f.storage, f.registry);
  assert.equal(result.items.length, 0);
  assert.equal(result.incompleteSources, 260);
  f.registry.getRuntimeSnapshot = () => null;
  assert.ok(readTaskActions(f.storage, f.registry).items.length <= 256);
});

test("team waits use the actual run and canonical task/container mapping", t => {
  const f = fixture(t);
  const runs = [
    { id: "plan", taskId: f.task.id, status: "awaiting_approval", statusDetail: "计划需你确认" },
    { id: "reply", taskId: f.task.workspaceTaskId, status: "waiting_user", statusDetail: "负责人等待补充" },
    { id: "other", taskId: "other-task", status: "waiting_user", statusDetail: "不属于此范围" },
  ];
  t.mock.method(f.storage, "listAiTeamRuns", () => runs as never);
  const result = readTaskActions(f.storage, f.registry);
  assert.deepEqual(result.items.map(x => [x.kind, x.source.runId]), [["plan", "plan"], ["reply", "reply"]]);
  assert.ok(result.items.every(x => x.taskId === f.task.id));
});

test("HTTP actions are read-only and independently scoped; existing task-list protocol is unchanged", async t => {
  const f = fixture(t);
  f.session("s1", { permissionBlocked: true });
  const app = express(); app.use(express.json()); registerTaskRoutes(app, { storage: f.storage, sessions: f.registry });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const response = await fetch(origin + "/api/wand-task-actions");
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).items.length, 1);
  assert.deepEqual(await (await fetch(origin + "/api/wand-task-actions?workspaceId=missing")).json(), { items: [], incompleteSources: 0 });
  const tasks = await (await fetch(origin + "/api/wand-tasks")).json();
  assert.ok(Array.isArray(tasks)); assert.equal(tasks[0].actionFacts, undefined);
  assert.equal(f.storage.getWandTask(f.task.id)!.acceptance, null);
});
