import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { WandStorage } from "../src/storage.js";
import type { SessionSnapshot } from "../src/types.js";
import {
  boardTitleFromSession,
  ensureBoardTaskForWorkspaceTask,
  syncUngroupedSessionsToBoard,
} from "../src/wand-task-sync.js";

function tempDatabase(t: TestContext): WandStorage {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wand-task-sync-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = new WandStorage(path.join(directory, "wand.db"));
  t.after(() => storage.close());
  return storage;
}

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "session-1",
    sessionKind: "structured",
    provider: "pi",
    command: "pi",
    cwd: "/tmp/wand",
    mode: "managed",
    status: "idle",
    exitCode: null,
    startedAt: "2026-09-11T00:00:00.000Z",
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    ...overrides,
  };
}

test("unnamed workspace tasks do not create empty board cards at create time", (t) => {
  const storage = tempDatabase(t);
  const workspace = storage.createWorkspace({ name: "wand", cwd: "/tmp/wand" });
  const unnamed = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "未命名任务" });
  const named = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "修登录" });

  assert.equal(ensureBoardTaskForWorkspaceTask(storage, unnamed, workspace), null);
  assert.equal(storage.listWandTasks().length, 0);

  const card = ensureBoardTaskForWorkspaceTask(storage, named, workspace);
  assert.equal(card?.title, "修登录");
  assert.equal(storage.listWandTasks().length, 1);
});

test("boardTitleFromSession prefers title then description then first user message", () => {
  assert.equal(boardTitleFromSession(snapshot({ title: "修复安卓连接故障" })), "修复安卓连接故障");
  assert.equal(
    boardTitleFromSession(snapshot({
      title: "未命名任务",
      description: "把登录页的错误提示修好",
    })),
    "把登录页的错误提示修好",
  );
  assert.equal(
    boardTitleFromSession(snapshot({
      title: "",
      description: "",
      messages: [{ role: "user", content: [{ type: "text", text: "安装前端设计插件并启动 Pi" }] }],
    })),
    "安装前端设计插件并启动 Pi",
  );
  assert.equal(boardTitleFromSession(snapshot({ title: "", description: "" })), "");
});

test("sync fills unnamed tasks from their sessions and puts them in doing", (t) => {
  const storage = tempDatabase(t);
  const workspace = storage.createWorkspace({ name: "wand", cwd: "/tmp/wand" });
  const unnamed = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "未命名任务" });
  storage.saveSession(snapshot({
    id: "sess-unnamed",
    workspaceId: workspace.id,
    workspaceTaskId: unnamed.id,
    title: "修复安卓客户端连接故障",
    description: "定位并修复安卓客户端连不上本机服务的问题",
  }));
  storage.createWandTask({
    workspaceId: workspace.id,
    workspaceTaskId: unnamed.id,
    title: "未命名任务",
    description: `项目：wand\n目录：/tmp/wand`,
    status: "todo",
  });

  syncUngroupedSessionsToBoard(storage);
  syncUngroupedSessionsToBoard(storage);

  const tasks = storage.listWandTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.title, "修复安卓客户端连接故障");
  assert.equal(tasks[0]?.status, "doing");
  assert.equal(tasks[0]?.description, "定位并修复安卓客户端连不上本机服务的问题");
  assert.deepEqual(storage.listWandTaskSessionIds(tasks[0]!.id), ["sess-unnamed"]);
});

test("sync creates doing cards for standalone ungrouped sessions", (t) => {
  const storage = tempDatabase(t);
  const workspace = storage.createWorkspace({ name: "wand", cwd: "/tmp/wand" });
  storage.saveSession(snapshot({
    id: "loose-1",
    workspaceId: workspace.id,
    title: "优化消息压缩与运行状态展示",
    description: "统一各端压缩条分组与两行布局",
  }));
  storage.saveSession(snapshot({
    id: "loose-empty",
    workspaceId: workspace.id,
    title: "",
    description: "",
  }));

  syncUngroupedSessionsToBoard(storage);
  const tasks = storage.listWandTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.title, "优化消息压缩与运行状态展示");
  assert.equal(tasks[0]?.status, "doing");
  assert.deepEqual(storage.listWandTaskSessionIds(tasks[0]!.id), ["loose-1"]);
});

test("sync binds standalone sessions onto an existing same-title card instead of duplicating", (t) => {
  const storage = tempDatabase(t);
  const workspace = storage.createWorkspace({ name: "wand", cwd: "/tmp/wand" });
  const existing = storage.createWandTask({
    workspaceId: workspace.id,
    title: "任务面板参数持久化。",
    description: "记住上次选择",
    status: "done",
  });
  storage.saveSession(snapshot({
    id: "loose-persist",
    workspaceId: workspace.id,
    title: "任务面板参数持久化",
    description: "任务面板编排 Agent 时记住上次选择",
  }));

  syncUngroupedSessionsToBoard(storage);
  const tasks = storage.listWandTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, existing.id);
  assert.equal(tasks[0]?.status, "done");
  assert.deepEqual(storage.listWandTaskSessionIds(existing.id), ["loose-persist"]);
});
