import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { WandStorage } from "../src/storage.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { SYSTEM_AI_PURPOSES } from "../src/system-ai-call.js";
import { systemAiSessions } from "../src/system-ai-session-recorder.js";
import type { SessionSnapshot } from "../src/types.js";

interface Group {
  workspaceId: string;
  workspaceCwd: string;
  tasks: { id: string; sessions: { id: string }[]; totalSessions: number }[];
  standaloneSessions: { id: string }[];
}

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-workspace-system-calls-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const workspace = storage.createWorkspace({ name: "Workspace", cwd: root });
  const task = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "Agent work" });
  const employee = storage.ensureSystemSiliconEmployee();
  const recorder = systemAiSessions(storage);
  const call = recorder.forEmployee(employee).start("session-title", { system: "fixture", prompt: "fixture" }, root);
  call.complete();
  const template = storage.getSession(call.sessionId)!;
  storage.setSessionWorkspaceId(call.sessionId, workspace.id);
  const save = (id: string, automationId?: string, patch: Partial<SessionSnapshot> = {}) => {
    storage.saveSession({ ...template, id, automationId, workspaceId: workspace.id,
      sessionSource: automationId ? "automation" : "interactive", title: "系统调用 · deliberately same display name", ...patch });
  };
  const app = express(); app.use(express.json());
  registerWorkspaceRoutes(app, storage);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close(); rmSync(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (route: string) => {
    const response = await fetch(url + route);
    assert.equal(response.status, 200, route);
    return response.json();
  };
  return { root, storage, workspace, task, employee, template, call, save, get };
}

const ids = (groups: Group[]) => groups.flatMap(g => [
  ...g.standaloneSessions.map(s => s.id), ...g.tasks.flatMap(t => t.sessions.map(s => s.id)),
]).sort();

test("workspace hides every system feature purpose, including decisions, but preserves concrete Agent work", async t => {
  const f = await fixture(t);
  const work = [undefined, "wand-task:work", "wand-task-comment:work", "ai-team:work", "ai-team-chat:work",
    "conversation:work", "conversation-talk:work", "conversation-message:work", "scheduled-task:work", "mission-id"];
  const expected: string[] = [];
  for (const [index, automationId] of work.entries()) {
    const id = `work-${index}`;
    f.save(id, automationId, index % 2 ? { workspaceTaskId: f.task.id } : {});
    expected.push(id);
  }
  // Even startup/recovered work and manual sessions of the SAME builtin employee remain visible.
  f.save("startup-work", undefined, { sessionSource: "startup" }); expected.push("startup-work");
  const decisionExpert = f.storage.ensureDecisionExpertEmployee();
  f.save("expert-dispatch", "wand-task:expert-work", { employeeId: decisionExpert.id, employeeName: decisionExpert.name });
  expected.push("expert-dispatch");
  for (const [index, purpose] of Object.keys(SYSTEM_AI_PURPOSES).entries()) {
    f.save(`feature-${purpose}`, `system-ai:${purpose}:fixture`, { workspaceTaskId: index % 2 ? f.task.id : undefined,
      status: index % 3 === 0 ? "running" : index % 3 === 1 ? "failed" : "exited" });
  }
  f.save("future-feature", "system-ai:future-feature:fixture");
  const groups = await f.get("/api/tasks") as Group[];
  assert.deepEqual(ids(groups), expected.sort());
  assert.deepEqual(ids(await f.get(`/api/tasks?workspaceId=${f.workspace.id}`)), expected);
  const detail = await f.get(`/api/workspaces/${f.workspace.id}`);
  assert.deepEqual(detail.sessions.map((s: { id: string }) => s.id).sort(), expected);
  assert.equal(detail.sessionCount, expected.length);
  const listed = await f.get("/api/workspaces");
  assert.equal(listed.find((w: { id: string }) => w.id === f.workspace.id).sessionCount, expected.length);
  const taskDetail = await f.get(`/api/workspace-tasks/${f.task.id}`);
  assert.deepEqual(taskDetail.sessions.map((s: { id: string }) => s.id).sort(), expected.filter(id => /^work-\d+$/.test(id) && Number(id.slice(5)) % 2));
  // Filtering is projection-only: do not change retention classification or erase employee audit logs.
  assert.ok(f.storage.getSession(f.call.sessionId));
  assert.ok(f.storage.employeeConversationForSession(f.call.sessionId));
  assert.ok(f.storage.getSession("feature-decision"));
  assert.equal(f.storage.countSessionsByWorkspace().get(f.workspace.id)! > expected.length, true);
});

test("filter before limits/counts; archived and synthetic paths cannot leak feature logs", async t => {
  const f = await fixture(t);
  f.save("bound-work", "wand-task:work", { workspaceTaskId: f.task.id, startedAt: "2000-01-01T00:00:00Z" });
  f.save("bound-feature", "system-ai:decision:fixture", { workspaceTaskId: f.task.id, startedAt: "2099-01-01T00:00:00Z" });
  f.save("archived-work", "scheduled-task:work", { archived: true });
  f.save("archived-feature", "system-ai:session-title:fixture", { archived: true });
  f.save("feature-only-directory", "system-ai:decision:fixture", { workspaceId: undefined, cwd: path.join(f.root, "feature-only") });
  const limited = await f.get("/api/tasks?maxSessions=1") as Group[];
  assert.deepEqual(ids(limited), ["bound-work"]);
  const task = limited.flatMap(g => g.tasks).find(t => t.id === f.task.id)!;
  assert.equal(task.totalSessions, 1);
  assert.equal(limited.some(g => g.workspaceCwd.endsWith("feature-only")), false);
  assert.deepEqual(ids(await f.get("/api/tasks?includeArchived=1")), ["archived-work", "bound-work"]);
  for (const route of ["/api/workspaces?includeArchived=1", `/api/workspaces/${f.workspace.id}?includeArchived=1`]) {
    const payload = await f.get(route);
    const workspace = Array.isArray(payload) ? payload.find(w => w.id === f.workspace.id) : payload;
    assert.equal(workspace.sessionCount, 2);
  }
  const first = await f.get("/api/tasks?revision=");
  assert.equal(first.unchanged, false);
  assert.deepEqual(ids(first.groups), ["bound-work"]);
  const same = await f.get(`/api/tasks?revision=${first.revision}`);
  assert.equal(same.unchanged, true);
  f.save("new-work", "wand-task-comment:new");
  const changed = await f.get(`/api/tasks?revision=${first.revision}`);
  assert.equal(changed.unchanged, false);
  assert.deepEqual(ids(changed.groups), ["bound-work", "new-work"]);
});

test("Web, macOS, Android and iOS consume the same server-filtered workspace projection", () => {
  const sources = ["src/web-ui/react/workspaces/repository.ts", "macos/Wand/WorkspaceAPI.swift",
    "android/app/src/main/java/com/wand/app/data/WandApi.kt", "ios/Wand/WorkspaceAPI.swift"];
  for (const source of sources) {
    const content = readFileSync(new URL(`../${source}`, import.meta.url), "utf8");
    assert.match(content, /\/api\/tasks/, source);
    assert.match(content, /\/api\/workspace-tasks\//, source);
    assert.match(content, /revision/, source);
  }
});
