import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { sessionExecutionStatus, taskExecutionProjection } from "../src/execution-state.js";
import { WandStorage } from "../src/storage.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import { filterActiveGroups, isSessionActive, isSessionRunning } from "../src/web-ui/react/workspaces/sidebar-display-mode.js";
import { filterSidebarGroups } from "../src/web-ui/react/workspaces/sidebar-search.js";
import { sidebarSessionState, sidebarAggregateState } from "../src/web-ui/react/workspaces/sidebar-session-state.js";
import { filterIssues, issueTaskStatusLabel } from "../src/web-ui/react/issues/task-board-agent.js";
import type { SessionSnapshot } from "../src/types.js";
import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "../src/web-ui/react/workspaces/types.js";

const session = (patch: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  id: "session", sessionKind: "structured", command: "pi", cwd: "/tmp", mode: "default", status: "idle",
  exitCode: null, startedAt: "2026-01-01T00:00:00Z", endedAt: null, output: "", claudeSessionId: null,
  queuedMessages: [], ...patch,
});

test("execution projection distinguishes queued, running, archived and failure-paused inputs", () => {
  const queued = session({ queuedMessages: ["next"] });
  assert.equal(sessionExecutionStatus(queued), "queued");
  assert.equal(sessionExecutionStatus(session({ status: "running" })), null, "process status alone is not execution");
  assert.equal(sessionExecutionStatus({ ...queued, archived: true }), null);
  assert.equal(sessionExecutionStatus({ ...queued, status: "failed" }), null);
  assert.equal(sessionExecutionStatus({ ...queued, structuredState: { inFlight: false, lastError: "rejected" } as never }), null);
  assert.equal(sessionExecutionStatus({ ...queued, structuredState: { inFlight: true } as never }), "running");
  assert.deepEqual(taskExecutionProjection([queued], 2), { executionStatus: "queued", queuedExecutionCount: 3 });
  assert.deepEqual(taskExecutionProjection([{ ...queued, structuredState: { inFlight: true } as never }], 2), {
    executionStatus: "running", queuedExecutionCount: 3,
  });
  assert.deepEqual(taskExecutionProjection([], 1), { executionStatus: "queued", queuedExecutionCount: 1 });
  assert.deepEqual(taskExecutionProjection([], 0), { executionStatus: null, queuedExecutionCount: 0 });
  assert.deepEqual(taskExecutionProjection([{ ...queued, status: "failed" }]), { executionStatus: null, queuedExecutionCount: 0 });
  assert.deepEqual(taskExecutionProjection([{ ...queued, status: "stopped" }]), { executionStatus: null, queuedExecutionCount: 0 });
  assert.deepEqual(taskExecutionProjection([{ ...queued, structuredState: { inFlight: false, lastError: "rejected" } as never }]),
    { executionStatus: null, queuedExecutionCount: 0 });
});

test("queued sessions are active but not falsely running; running and attention retain precedence", () => {
  const queued: WorkspaceSessionSummary = { id: "queued", status: "idle", sessionKind: "structured", executionStatus: "queued" };
  assert.equal(isSessionActive(queued), true);
  assert.equal(isSessionRunning(queued), false);
  assert.equal(sidebarSessionState(queued).label, "排队中");
  assert.equal(sidebarSessionState({ ...queued, inFlight: true }).label, "运行中");
  assert.equal(sidebarSessionState({ ...queued, status: "failed" }).label, "失败");
  assert.equal(isSessionActive({ ...queued, archived: true }), false);
  assert.equal(sidebarAggregateState([queued]).label, "排队中");
  assert.equal(sidebarAggregateState([queued, { id: "running", inFlight: true }]).label, "运行中");
});

test("HTTP board, directory list and detail expose zero-session queued tasks and clear on cancellation", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-queued-projection-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const workspace = storage.createWorkspace({ name: "Queue workspace", cwd: root });
  const task = storage.createWandTask({ title: "Queued task", workspaceId: workspace.id, status: "doing" });
  const comment = storage.createTaskCommentIntent({ taskId: task.id, requestId: "queued-request", signature: "queued",
    instruction: "queued", body: "queued", sourceCommentId: null, employeeId: "employee", employeeName: "员工",
    taskVersion: task.updatedAt, queued: true });
  const app = express(); app.use(express.json());
  registerWorkspaceRoutes(app, storage);
  registerTaskRoutes(app, { storage });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); storage.close(); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = async (route: string) => { const response = await fetch(base + route); assert.equal(response.status, 200); return response.json(); };
  const board = (await get("/api/wand-tasks") as Array<Record<string, unknown>>).find(item => item.id === task.id)!;
  assert.equal(board.status, "doing", "queue is a runtime status, not a manually editable workflow stage");
  assert.equal(board.executionStatus, "queued");
  assert.equal(issueTaskStatusLabel(board as never), "排队中");
  assert.equal(filterIssues([board] as never, "", "", { statuses: ["doing"], priorities: [], labels: [] }).length, 1);
  const groups = await get("/api/tasks?maxSessions=1") as TaskDirectoryGroup[];
  const tree = filterActiveGroups(filterSidebarGroups(groups, ""));
  const entry = tree.flatMap(group => group.tasks).find(item => item.id === task.workspaceTaskId)!;
  assert.ok(entry, "zero-session queued work must survive both default tree and active filtering");
  assert.equal(entry.sessions.length, 0, "do not invent sessions to make a queued task visible");
  assert.equal(sidebarAggregateState(entry.sessions, entry).label, "排队中");
  assert.equal((await get(`/api/workspace-tasks/${task.workspaceTaskId}`)).executionStatus, "queued");
  storage.cancelQueuedTaskComment(comment.id, "cancelled");
  assert.equal((await get(`/api/wand-tasks/${task.id}`)).executionStatus, null);
  assert.equal(filterActiveGroups(filterSidebarGroups(await get("/api/tasks"), "")).length, 0);
});

test("HTTP task and directory status use all live sessions before response truncation", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-queued-running-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const task = storage.createWandTask({ title: "Mixed", status: "doing" });
  storage.saveSession(session({ id: "queued", workspaceTaskId: task.workspaceTaskId!, queuedMessages: ["next"] }));
  storage.saveSession(session({ id: "running", workspaceTaskId: task.workspaceTaskId!, structuredState: { inFlight: true } as never }));
  const app = express(); app.use(express.json()); registerWorkspaceRoutes(app, storage); registerTaskRoutes(app, { storage });
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); storage.close(); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const groups = await fetch(base + "/api/tasks?maxSessions=1").then(r => r.json()) as TaskDirectoryGroup[];
  const entry = groups.flatMap(group => group.tasks).find(item => item.id === task.workspaceTaskId)!;
  assert.equal(entry.executionStatus, "running");
  assert.equal(entry.queuedExecutionCount, 1);
  assert.equal(entry.sessions.length, 1);
  assert.equal(entry.totalSessions, 2);
  const board = await fetch(base + `/api/wand-tasks/${task.id}`).then(r => r.json());
  assert.equal(board.executionStatus, "running");
  assert.notEqual(issueTaskStatusLabel(board), "排队中");
});
