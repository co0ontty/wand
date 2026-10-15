import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { WandStorage } from "../src/storage.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { organizeSelectedByTitle } from "../src/task-title-organize-service.js";
import { judgeTitleOrganization, type TitleJudgeInput } from "../src/task-title-organize.js";
import { HttpWorkspacesRepository } from "../src/web-ui/react/workspaces/repository.js";

async function fixture(run: (storage: WandStorage, root: string, post: (body: object) => Promise<Response>) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-organize-scope-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const app = express(); app.use(express.json());
  registerWorkspaceRoutes(app, storage, undefined, {}, { judge: async () => ({ sessions: [], tasks: [] }) });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(storage, root, body => fetch(`${base}/api/tasks/organize-by-title`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close(); rmSync(root, { recursive: true, force: true });
  }
}

function save(storage: WandStorage, cwd: string, id: string, title: string, taskId?: string) {
  storage.saveSession({ id, title, command: "pi", sessionKind: "structured", cwd, mode: "default", status: "idle",
    exitCode: null, startedAt: "2026-10-01T00:00:00.000Z", endedAt: null, output: "", workspaceTaskId: taskId });
}

test("default auto excludes user titles as both source and destination; explicit all includes them", async () => {
  await fixture(async (storage, root, post) => {
    const workspace = storage.createWorkspace({ name: "Project", cwd: root });
    const auto = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "修复登录", board: { titleSource: "auto" } });
    const user = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "用户指定的文档" });
    save(storage, root, "auto-session", "另一个议题", auto.id);
    save(storage, root, "user-session", "另一个议题", user.id);
    save(storage, root, "loose", "用户指定的文档");
    const selection = { taskIds: [auto.id, user.id], sessionIds: ["loose", "user-session"] };
    const response = await post(selection);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.skippedTasks, 1); assert.equal(result.eligibleTasks, 1);
    assert.deepEqual(result.movedSessions, []);
    assert.equal(storage.getSession("user-session")?.workspaceTaskId, user.id);
    const all = await post({ ...selection, mode: "all" });
    assert.equal(all.status, 200);
    const moved = (await all.json()).movedSessions;
    assert.equal(moved.length, 2);
    assert.equal(storage.getSession("user-session")?.workspaceTaskId, auto.id);
    assert.equal(storage.getSession("loose")?.workspaceTaskId, user.id);
  });
});

test("directory target resolves full membership, isolates other directories and skips renamed/archived tasks", async () => {
  await fixture(async (storage, root, post) => {
    const a = storage.createWorkspace({ name: "A", cwd: root });
    const b = storage.createWorkspace({ name: "B", cwd: path.join(root, "other") });
    const task = storage.createWorkspaceTask({ workspaceId: a.id, name: "修复登录", board: { titleSource: "auto" } });
    const other = storage.createWorkspaceTask({ workspaceId: b.id, name: "更新文档", board: { titleSource: "auto" } });
    const renamed = storage.createWorkspaceTask({ workspaceId: a.id, name: "自动标题", board: { titleSource: "auto" } });
    storage.updateWorkspaceTask(renamed.id, { name: "用户已改名" });
    const archived = storage.createWorkspaceTask({ workspaceId: a.id, name: "归档任务", board: { titleSource: "auto" } });
    storage.updateWandTask(storage.getWandTaskByWorkspaceTaskId(archived.id)!.id, { status: "archived" });
    save(storage, root, "local", "修复登录");
    save(storage, path.join(root, "other"), "outside", "更新文档");
    save(storage, root, "manual", "用户已改名");
    const response = await post({ target: { kind: "directory", cwd: root } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.eligibleTasks, 1); assert.equal(result.skippedTasks, 1);
    assert.equal(storage.getSession("local")?.workspaceTaskId, task.id);
    assert.equal(storage.getSession("outside")?.workspaceTaskId, undefined);
    assert.equal(storage.getSession("manual")?.workspaceTaskId, undefined);
    const all = await post({ target: { kind: "all" }, mode: "all" });
    assert.equal(all.status, 200);
    assert.equal(storage.getSession("outside")?.workspaceTaskId, other.id);
    assert.equal(storage.getSession("manual")?.workspaceTaskId, renamed.id);
    assert.equal((await post({ target: { kind: "all" }, mode: "invalid" })).status, 400);
    assert.equal((await post({ target: { kind: "all" }, taskIds: [task.id] })).status, 400);
    assert.equal((await post({ target: { kind: "workspace", workspaceId: "missing" } })).status, 400);
  });
});

test("all-user selections are successful no-ops rather than missing tasks", async () => {
  await fixture(async (storage, root, post) => {
    const workspace = storage.createWorkspace({ name: "Project", cwd: root });
    const task = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "手写标题" });
    const response = await post({ taskIds: [task.id] });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).eligibleTasks, 0);
  });
});

test("missing legacy title provenance is protected by default and only included by explicit all", async () => {
  await fixture(async (storage, root, post) => {
    const workspace = storage.createWorkspace({ name: "Legacy", cwd: root });
    const task = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "旧用户标题" });
    const card = storage.getWandTaskByWorkspaceTaskId(task.id)!;
    const legacy = new DatabaseSync(path.join(root, "wand.db"));
    try { legacy.prepare("UPDATE wand_tasks SET title_source = NULL WHERE id = ?").run(card.id); }
    finally { legacy.close(); }
    save(storage, root, "legacy-loose", "旧用户标题");
    const body = { taskIds: [task.id], sessionIds: ["legacy-loose"] };
    const automatic = await post(body);
    assert.equal(automatic.status, 200);
    const protectedResult = await automatic.json();
    assert.equal(protectedResult.eligibleTasks, 0);
    assert.equal(protectedResult.skippedTasks, 1);
    assert.equal(storage.getSession("legacy-loose")?.workspaceTaskId, undefined);
    const all = await post({ ...body, mode: "all" });
    assert.equal(all.status, 200);
    assert.equal((await all.json()).movedSessions.length, 1);
    assert.equal(storage.getSession("legacy-loose")?.workspaceTaskId, task.id);
  });
});

test("manual rename during semantic judgment invalidates pending moves", async () => {
  await fixture(async (storage, root) => {
    const workspace = storage.createWorkspace({ name: "Project", cwd: root });
    const task = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "修复登录", board: { titleSource: "auto" } });
    save(storage, root, "near", "登录失败处理");
    const result = await organizeSelectedByTitle(storage, { taskIds: [task.id], sessionIds: ["near"] }, {
      judge: async () => {
        storage.updateWorkspaceTask(task.id, { name: "用户重新指定标题" });
        return { sessions: [{ id: "near", taskId: task.id }], tasks: [] };
      },
    });
    assert.equal(result.movedSessions.length, 0);
    assert.equal(storage.getSession("near")?.workspaceTaskId, undefined);
    assert.ok(result.refused.some(item => item.id === "changed"));
  });
});

test("large passes bound model calls without truncating late candidates, conflicting answers abstain", async () => {
  const tasks = Array.from({ length: 43 }, (_, id) => ({ id: String(id), titles: [`工作${id}`] }));
  const sessions = Array.from({ length: 205 }, (_, id) => ({ id: `s${id}`, title: `内容${id}` }));
  const calls: TitleJudgeInput[] = [];
  const result = await judgeTitleOrganization({ tasks, sessions }, async input => {
    calls.push(input);
    return {
      sessions: input.sessions.filter(item => item.id === "s204").map(item => ({ id: item.id, taskId: input.tasks.some(t => t.id === "42") ? "42" : null })),
      tasks: input.tasks.some(t => t.id === "0") && input.tasks.some(t => t.id === "42") ? [{ id: "42", parentId: "0" }] : [],
    };
  });
  assert.ok(calls.every(input => input.tasks.length <= 40 && input.sessions.length <= 200));
  assert.deepEqual(result.sessions, [{ id: "s204", taskId: "42" }]);
  assert.deepEqual(result.tasks, [{ id: "42", parentId: "0" }]);
  const conflict = await judgeTitleOrganization({ tasks, sessions: [{ id: "s", title: "不确定" }] }, async input => ({
    sessions: input.sessions.map(item => ({ id: item.id, taskId: input.tasks[0]!.id })), tasks: [],
  }));
  assert.deepEqual(conflict.sessions, [{ id: "s", taskId: null }]);
});

test("default auto protects user-titled parents while explicit all can persist a safe parent relationship", async () => {
  await fixture(async (storage, root) => {
    const workspace = storage.createWorkspace({ name: "Project", cwd: root });
    const parent = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "修复客户端" });
    const child = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "修复登录弹窗", board: { titleSource: "auto" } });
    const parentCard = storage.getWandTaskByWorkspaceTaskId(parent.id)!;
    storage.updateWandTask(parentCard.id, { status: "doing" });
    let calls = 0;
    const judge = async () => { calls++; return { sessions: [], tasks: [{ id: child.id, parentId: parent.id }] }; };
    const automatic = await organizeSelectedByTitle(storage, { taskIds: [parent.id, child.id] }, { judge });
    assert.equal(automatic.skippedTasks, 1);
    assert.equal(calls, 0);
    assert.deepEqual(automatic.categorizedTasks, []);
    assert.equal(storage.getWandTaskByWorkspaceTaskId(child.id)?.parentTaskId, null);
    const all = await organizeSelectedByTitle(storage, { taskIds: [parent.id, child.id], mode: "all" }, { judge });
    assert.equal(calls, 1);
    assert.equal(all.categorizedTasks[0]?.taskId, child.id);
    assert.equal(all.categorizedTasks[0]?.parentTaskId, parentCard.id, "归类回执和看板模型使用父卡片ID");
    assert.equal(storage.getWandTaskByWorkspaceTaskId(child.id)?.parentTaskId, parentCard.id);
    assert.ok(storage.getWorkspaceTask(child.id), "归类不删除原任务及历史容器");
  });
});

test("global tasks in different project directories cannot persist a semantic parent link", async () => {
  await fixture(async (storage, root) => {
    const global = storage.ensureGlobalWorkspace();
    const create = (name: string, cwd: string) => storage.createWorkspaceTask({ workspaceId: global.id, name, cwd, board: { titleSource: "auto" } });
    const parent = create("修复客户端", path.join(root, "a"));
    const child = create("修复登录弹窗", path.join(root, "a"));
    const unrelated = create("改进交互", path.join(root, "b"));
    for (const task of [parent, child, unrelated]) storage.updateWandTask(storage.getWandTaskByWorkspaceTaskId(task.id)!.id, { status: "doing" });
    const result = await organizeSelectedByTitle(storage, { taskIds: [parent.id, child.id, unrelated.id] }, {
      judge: async () => ({ sessions: [], tasks: [{ id: child.id, parentId: unrelated.id }] }),
    });
    assert.deepEqual(result.categorizedTasks, []);
    assert.equal(storage.getWandTaskByWorkspaceTaskId(child.id)?.parentTaskId, null);
    assert.ok(result.refused.some(item => item.id === child.id && item.reason === "不能归入该任务"));
  });
});

test("repository defaults auto for existing entry and sends explicit scope for new entries", async () => {
  const requests: object[] = [];
  const repository = new HttpWorkspacesRepository(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, foundTasks: 0, eligibleTasks: 0, skippedTasks: 0, movedSessions: [], categorizedTasks: [], refused: [] }), { headers: { "content-type": "application/json" } });
  });
  await repository.organizeByTitle(["task"]);
  await repository.organizeTarget({ kind: "directory", cwd: "/tmp/project" }, "all");
  assert.deepEqual(requests, [{ taskIds: ["task"], sessionIds: [], mode: "auto" }, { target: { kind: "directory", cwd: "/tmp/project" }, mode: "all" }]);
});
