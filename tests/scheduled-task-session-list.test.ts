import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import express from "express";

import { defaultConfig } from "../src/config.js";
import { ConversationService } from "../src/conversation-service.js";
import { jsonErrorHandler } from "../src/express-async.js";
import type { ProcessManager } from "../src/process-manager.js";
import { ScheduledTaskService } from "../src/scheduled-task-service.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import type { SessionListItemDTO } from "../src/session-transport.js";
import { WandStorage } from "../src/storage.js";
import type { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { SessionSnapshot, WandConfig } from "../src/types.js";
import { conversationHarness } from "./helpers/conversation-harness.js";

interface TaskGroup {
  workspaceId: string;
  standaloneSessions: Array<{
    id: string;
    title: string;
    cwd: string;
    employeeId?: string;
    employeeName?: string;
  }>;
  tasks: Array<{ sessions: Array<{ id: string }> }>;
}

// The conversation harness owns real SQLite and explicit execution doubles; no provider or CLI runs here.
function fixture(t: Parameters<typeof conversationHarness>[0]) {
  const h = conversationHarness(t);
  const processes = { listSlim: () => [], getOwned: () => null } as unknown as ProcessManager;
  const structured = { ...h.structured, listSlim: () => Array.from(h.sessions.values()) } as unknown as StructuredSessionManager;
  const registry = new SessionRegistry(processes, structured, h.storage);
  let clock = new Date("2030-01-01T00:00:00.000Z");
  const scheduled = new ScheduledTaskService({ storage: h.storage, conversations: h.service,
    getSession: id => registry.get(id), defaultCwd: () => h.config.defaultCwd, now: () => clock });
  return { ...h, processes, execution: h.structured, structured, registry, scheduled, now: () => clock,
    setTime: (iso: string) => { clock = new Date(iso); } };
}

async function startListApp(storage: WandStorage, registry: SessionRegistry, processes: ProcessManager,
  structured: StructuredSessionManager, config: WandConfig) {
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, { processes, structured, storage, defaultMode: config.defaultMode, config, sessions: registry });
  registerWorkspaceRoutes(app, storage, registry);
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    async read<T>(url: string): Promise<T> {
      const response = await fetch(`${baseUrl}${url}`);
      assert.equal(response.status, 200);
      return response.json() as Promise<T>;
    },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

const listedIds = (groups: TaskGroup[]): string[] => groups.flatMap(group => [
  ...group.standaloneSessions.map(session => session.id),
  ...group.tasks.flatMap(task => task.sessions.map(session => session.id)),
]).sort();

test("due schedules expose fresh independent employee sessions in the exact project HTTP lists", async t => {
  const h = fixture(t);
  const cwd = path.join(path.dirname(h.cwd), "selected-project");
  mkdirSync(cwd);
  const selected = h.storage.createWorkspace({ name: "定时工作项目", cwd });
  h.storage.createWorkspace({ name: "相同目录的另一个项目", cwd });
  const prompt = "  这是原帖内容。\n\n请保留原文并整理摘要。  ";
  const task = h.scheduled.create({ requestId: "scheduled-list-cycles", title: "定时整理帖子", employeeId: "e_test_2",
    workspaceId: selected.id, prompt, schedule: { kind: "daily", time: "01:00", timeZone: "UTC" } });
  const app = await startListApp(h.storage, h.registry, h.processes, h.structured, { ...defaultConfig(), ...h.config });
  try {
    await h.scheduled.tick();
    assert.deepEqual(await app.read<SessionListItemDTO[]>("/api/sessions"), []);
    assert.deepEqual(listedIds(await app.read<TaskGroup[]>("/api/tasks")), []);

    h.setTime("2030-01-01T01:00:00.000Z");
    await h.scheduled.tick();
    const first = h.scheduled.get(task.id).runs[0]!;
    const sessions = await app.read<SessionListItemDTO[]>("/api/sessions");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.id, first.sessionId);
    assert.equal(sessions[0]!.workspaceId, selected.id);
    assert.equal(sessions[0]!.employeeId, "e_test_2");
    assert.equal(sessions[0]!.employeeName, "员工 2");
    assert.equal(sessions[0]!.selectedModel, "explicit-test-model");
    assert.equal(sessions[0]!.sessionSource, "automation");
    assert.equal(sessions[0]!.title, "定时整理帖子");
    assert.equal(first.prompt, prompt);
    assert.equal(h.sent[0]!.text, prompt.trim(), "the plan title must not replace or prefix the submitted prompt");
    const groups = await app.read<TaskGroup[]>("/api/tasks");
    assert.deepEqual(listedIds(groups), [first.sessionId]);
    assert.deepEqual(groups.find(group => group.workspaceId === selected.id)!.standaloneSessions.map(session => ({
      id: session.id, title: session.title, cwd: session.cwd, employeeId: session.employeeId, employeeName: session.employeeName,
    })), [{ id: first.sessionId, title: "定时整理帖子", cwd, employeeId: "e_test_2", employeeName: "员工 2" }]);

    const finished = { ...h.sessions.get(first.sessionId!)!, status: "idle", endedAt: h.now().toISOString() } as SessionSnapshot;
    h.sessions.set(finished.id, finished);
    h.storage.saveSession(finished);
    h.scheduled.ingestSessionEvent({ type: "ended", sessionId: finished.id });
    h.setTime("2030-01-02T01:00:00.000Z");
    await h.scheduled.tick();
    const ids = h.scheduled.get(task.id).runs.map(run => run.sessionId!).sort();
    assert.equal(new Set(ids).size, 2);
    assert.deepEqual((await app.read<SessionListItemDTO[]>("/api/sessions")).map(session => session.id).sort(), ids);
    const laterGroups = await app.read<TaskGroup[]>("/api/tasks");
    assert.deepEqual(listedIds(laterGroups), ids);
    assert.deepEqual(laterGroups.find(group => group.workspaceId === selected.id)!.standaloneSessions.map(session => session.id).sort(), ids);
  } finally {
    await h.scheduled.dispose();
    await app.close();
  }
});

test("reopening durable schedules keeps their HTTP-listed sessions without replaying the accepted occurrence", async t => {
  const h = fixture(t);
  const task = h.scheduled.create({ requestId: "scheduled-list-restart", employeeId: "e_test_1", workspaceId: h.workspace.id,
    prompt: "重启后保留定时会话", schedule: { kind: "daily", time: "01:00", timeZone: "UTC" } });
  h.setTime("2030-01-01T01:00:00.000Z");
  await h.scheduled.tick();
  const sessionId = h.scheduled.get(task.id).runs[0]!.sessionId!;
  await h.scheduled.dispose();

  const reopened = new WandStorage(path.join(path.dirname(h.cwd), "wand.db"));
  // A restarted list reads durable membership rather than the previous in-memory registry.
  const structured = { ...h.structured, get: (id: string) => reopened.getSession(id), listSlim: () => [] } as unknown as StructuredSessionManager;
  const registry = new SessionRegistry(h.processes, structured, reopened);
  const conversations = new ConversationService({ storage: reopened, structured, runner: h.runner, config: h.config });
  const resumed = new ScheduledTaskService({ storage: reopened, conversations, getSession: id => registry.get(id),
    defaultCwd: () => h.config.defaultCwd, now: h.now });
  const app = await startListApp(reopened, registry, h.processes, structured, { ...defaultConfig(), ...h.config });
  try {
    await resumed.tick();
    await resumed.tick();
    assert.equal(h.sent.length, 1);
    assert.deepEqual((await app.read<SessionListItemDTO[]>("/api/sessions")).map(session => session.id), [sessionId]);
    assert.deepEqual(listedIds(await app.read<TaskGroup[]>("/api/tasks")), [sessionId]);
    assert.equal(resumed.get(task.id).runs[0]!.sessionId, sessionId);
  } finally {
    await resumed.dispose();
    conversations.dispose();
    await app.close();
    reopened.close();
  }
});

test("accepted startup failure preserves the scheduled session in both HTTP lists", async t => {
  const h = fixture(t);
  h.execution.sendMessage = async () => { throw new Error("明确测试启动失败"); };
  const task = h.scheduled.create({ requestId: "scheduled-list-startup-failure", employeeId: "e_test_1", workspaceId: h.workspace.id,
    prompt: "保留失败执行会话", schedule: { kind: "once", runAt: "2030-01-01T01:00:00.000Z" } });
  const app = await startListApp(h.storage, h.registry, h.processes, h.structured, { ...defaultConfig(), ...h.config });
  try {
    h.setTime("2030-01-01T01:00:00.000Z");
    await h.scheduled.tick();
    const run = h.scheduled.get(task.id).runs[0]!;
    assert.equal(h.service.receipt(run.requestId)?.state, "accepted");
    assert.equal(h.service.receipt(run.requestId)?.startup, "failed");
    assert.ok(run.sessionId);
    const sessions = await app.read<SessionListItemDTO[]>("/api/sessions");
    assert.deepEqual(sessions.map(session => session.id), [run.sessionId]);
    assert.equal(sessions[0]!.title, "保留失败执行会话");
    assert.deepEqual(listedIds(await app.read<TaskGroup[]>("/api/tasks")), [run.sessionId]);
    await h.scheduled.tick();
    assert.deepEqual((await app.read<SessionListItemDTO[]>("/api/sessions")).map(session => session.id), [run.sessionId]);
  } finally {
    await h.scheduled.dispose();
    await app.close();
  }
});
