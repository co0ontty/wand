import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import express from "express";

import { jsonErrorHandler } from "../src/express-async.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { WandStorage } from "../src/storage.js";

function tempRoot(t: TestContext, prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

interface Harness {
  url: string;
  storage: WandStorage;
  close(): Promise<void>;
}

/** 任务看板 + 项目/独立任务两套路由挂在同一个 app 上，覆盖两条建任务入口。 */
async function startHarness(storage: WandStorage): Promise<Harness> {
  const app = express();
  app.use(express.json());
  registerTaskRoutes(app, { storage });
  registerWorkspaceRoutes(app, storage);
  app.use(jsonErrorHandler);
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        storage,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function withHarness(t: TestContext, run: (ctx: Harness) => Promise<void>): Promise<void> {
  const root = tempRoot(t, "wand-milestones-");
  const storage = new WandStorage(path.join(root, "wand.db"));
  const harness = await startHarness(storage);
  try {
    await run(harness);
  } finally {
    await harness.close();
    storage.close();
  }
}

const jsonBody = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function jsonOf<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

test("milestones can be created, listed, renamed, and deleted without deleting tasks", async (t) => {
  await withHarness(t, async ({ url, storage }) => {
    const created = await fetch(`${url}/api/wand-milestones`, jsonBody({ name: "  v5.0 发布  " }))
      .then(jsonOf<{ id: string; name: string; dueDate: string | null; taskCount: number }>);
    assert.equal(created.name, "v5.0 发布");
    assert.equal(created.dueDate, null);
    assert.equal(created.taskCount, 0);

    // 同名（忽略大小写与首尾空白）不再重复建，否则下拉里会出现两个一样的选项。
    const duplicate = await fetch(`${url}/api/wand-milestones`, jsonBody({ name: "V5.0 发布" }));
    assert.equal(duplicate.status, 400);
    assert.match((await duplicate.json() as { error: string }).error, /已存在/);

    const task = await fetch(`${url}/api/wand-tasks`, jsonBody({ title: "发布准备", milestoneId: created.id }))
      .then(jsonOf<{ id: string; milestoneId: string | null; milestone: { id: string; name: string } | null }>);
    assert.equal(task.milestoneId, created.id);
    assert.deepEqual(task.milestone, { id: created.id, name: "v5.0 发布" });

    const listed = await fetch(`${url}/api/wand-milestones`)
      .then(jsonOf<{ milestones: Array<{ id: string; name: string; taskCount: number }> }>);
    assert.equal(listed.milestones.length, 1);
    assert.equal(listed.milestones[0]?.taskCount, 1);

    const renamed = await fetch(`${url}/api/wand-milestones/${created.id}`, jsonBody({ name: "v5.0 正式发布" }, "PATCH"))
      .then(jsonOf<{ name: string; taskCount: number }>);
    assert.equal(renamed.name, "v5.0 正式发布");
    assert.equal(renamed.taskCount, 1);

    // 删除里程碑只解绑：任务仍然在，只是 milestoneId 归空。
    const removed = await fetch(`${url}/api/wand-milestones/${created.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const after = await fetch(`${url}/api/wand-tasks/${task.id}`)
      .then(jsonOf<{ milestoneId: string | null; milestone: unknown }>);
    assert.equal(after.milestoneId, null);
    assert.equal(after.milestone, null);
    assert.equal(storage.listWandMilestones().length, 0);
  });
});

test("tasks reject unknown milestones and can be rebound or cleared", async (t) => {
  await withHarness(t, async ({ url, storage }) => {
    const unknown = await fetch(`${url}/api/wand-tasks`, jsonBody({ title: "坏里程碑", milestoneId: "missing" }));
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json() as { error: string }).error, /未找到该里程碑/);

    const milestone = storage.createWandMilestone({ name: "Q3" });
    const task = await fetch(`${url}/api/wand-tasks`, jsonBody({ title: "绑定里程碑" }))
      .then(jsonOf<{ id: string }>);

    const bound = await fetch(`${url}/api/wand-tasks/${task.id}`, jsonBody({ milestoneId: milestone.id }, "PATCH"))
      .then(jsonOf<{ milestoneId: string | null }>);
    assert.equal(bound.milestoneId, milestone.id);

    const cleared = await fetch(`${url}/api/wand-tasks/${task.id}`, jsonBody({ milestoneId: null }, "PATCH"))
      .then(jsonOf<{ milestoneId: string | null }>);
    assert.equal(cleared.milestoneId, null);
  });
});

test("workspace task creation carries the milestone onto the board card", async (t) => {
  await withHarness(t, async ({ url, storage }) => {
    const milestone = storage.createWandMilestone({ name: "移动端 5.0", dueDate: "2026-09-30" });
    const workspace = storage.createWorkspace({ name: "wand", cwd: "/tmp/wand-milestone-workspace" });

    const created = await fetch(`${url}/api/workspaces/${workspace.id}/tasks`, jsonBody({
      name: "任务面板里程碑",
      worktree: false,
      milestoneId: milestone.id,
    })).then(jsonOf<{ id: string; milestoneId: string | null }>);
    assert.equal(created.milestoneId, milestone.id);

    const card = storage.getWandTaskByWorkspaceTaskId(created.id);
    assert.equal(card?.milestoneId, milestone.id);

    // 独立任务（无项目）同样支持。
    const standalone = await fetch(`${url}/api/tasks`, jsonBody({
      name: "独立任务里程碑",
      milestoneId: milestone.id,
    })).then(jsonOf<{ id: string; milestoneId: string | null }>);
    assert.equal(standalone.milestoneId, milestone.id);
    assert.equal(storage.getWandTaskByWorkspaceTaskId(standalone.id)?.milestoneId, milestone.id);

    const bad = await fetch(`${url}/api/workspaces/${workspace.id}/tasks`, jsonBody({
      name: "坏里程碑",
      worktree: false,
      milestoneId: "missing",
    }));
    assert.equal(bad.status, 400);
  });
});

test("legacy databases gain the milestone columns and table on open", (t) => {
  const root = tempRoot(t, "wand-milestone-legacy-");
  const dbPath = path.join(root, "wand.db");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE wand_tasks (
      id TEXT PRIMARY KEY,
      identifier TEXT,
      workspace_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'none',
      labels_json TEXT NOT NULL DEFAULT '[]',
      due_date TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      agent_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE workspace_tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      worktree_json TEXT,
      layout_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      cwd TEXT,
      created_at TEXT NOT NULL,
      last_opened_at TEXT
    );
    INSERT INTO wand_tasks (id, identifier, title, created_at, updated_at)
    VALUES ('legacy-task', 'TASK-1', '旧任务', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const storage = new WandStorage(dbPath);
  t.after(() => storage.close());

  const milestone = storage.createWandMilestone({ name: "迁移后可用" });
  assert.equal(storage.listWandTasks()[0]?.milestoneId, null);
  storage.updateWandTask("legacy-task", { milestoneId: milestone.id });
  assert.equal(storage.listWandTasks()[0]?.milestoneId, milestone.id);

  const workspace = storage.createWorkspace({ name: "wand", cwd: "/tmp/wand-legacy-milestone" });
  const task = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "旧侧栏任务", milestoneId: milestone.id });
  assert.equal(storage.getWorkspaceTask(task.id)?.milestoneId, milestone.id);
});

test("milestone ids are trimmed and blank ids mean unassigned", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-milestone-unit-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  try {
    assert.equal(storage.getWandMilestone(""), null);
    // 读路径会 trim（脏行容错），所以写入时会带首尾空白也读回干净值。
    const milestone = storage.createWandMilestone({ name: "  空格  " });
    assert.equal(milestone.name, "空格");
    assert.deepEqual(storage.updateWandMilestone(milestone.id, {}), storage.getWandMilestone(milestone.id));
    assert.equal(storage.deleteWandMilestone(milestone.id), true);
    assert.equal(storage.deleteWandMilestone(milestone.id), false);
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
