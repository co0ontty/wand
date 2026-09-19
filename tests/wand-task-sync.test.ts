import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { WandStorage } from "../src/storage.js";
import type { SessionSnapshot } from "../src/types.js";
import {
  archiveBoardTask,
  boardTitleFromSession,
  ensureBoardTaskForWorkspaceTask,
  syncUngroupedSessionsToBoard,
  syncWorkspaceTaskToBoard,
  ensureWorkspaceTaskForBoardTask,
  moveSessionToWorkspaceTask,
  taskAutoNameSourceText,
  taskAutoNameSignature,
} from "../src/wand-task-sync.js";
import { refreshAutoBoardTaskTitles } from "../src/server-task-routes.js";

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

test("empty and unnamed task containers immediately get board cards", (t) => {
  const storage = tempDatabase(t);
  const workspace = storage.createWorkspace({ name: "wand", cwd: "/tmp/wand" });
  const unnamed = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "未命名任务" });
  const named = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "修登录" });

  assert.equal(ensureBoardTaskForWorkspaceTask(storage, unnamed, workspace).title, unnamed.name);
  assert.equal(storage.listWandTasks().length, 1);

  const card = ensureBoardTaskForWorkspaceTask(storage, named, workspace);
  assert.equal(card?.title, "修登录");
  assert.equal(storage.listWandTasks().length, 2);
});

test("named sidebar tasks bind sessions and fill the agent from the selected CLI", (t) => {
  const storage = tempDatabase(t);
  const workspace = storage.createWorkspace({ name: "wand", cwd: "/tmp/wand" });
  const named = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "修登录" });
  const card = ensureBoardTaskForWorkspaceTask(storage, named, workspace)!;
  storage.saveSession(snapshot({
    workspaceId: workspace.id,
    workspaceTaskId: named.id,
    provider: "codex",
    mode: "default",
    selectedModel: "gpt-5",
    thinkingEffort: "deep",
  }));

  syncUngroupedSessionsToBoard(storage);
  syncUngroupedSessionsToBoard(storage);
  assert.equal(storage.listWandTasks().length, 1);
  assert.deepEqual(storage.listWandTaskSessionIds(card.id), ["session-1"]);
  assert.deepEqual(storage.getWandTask(card.id)?.agent, {
    provider: "codex", model: "gpt-5", thinkingEffort: "deep", mode: "full-access", kind: "structured",
  });
});

test("shell sessions bind to named tasks without inventing an agent", (t) => {
  const storage = tempDatabase(t);
  const workspace = storage.createWorkspace({ name: "wand", cwd: "/tmp/wand" });
  const named = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "检查构建" });
  const card = ensureBoardTaskForWorkspaceTask(storage, named, workspace)!;
  storage.saveSession(snapshot({
    workspaceId: workspace.id,
    workspaceTaskId: named.id,
    provider: undefined,
    command: "/bin/zsh",
    sessionKind: "pty",
  }));

  syncUngroupedSessionsToBoard(storage);
  assert.deepEqual(storage.listWandTaskSessionIds(card.id), ["session-1"]);
  assert.equal(storage.getWandTask(card.id)?.agent, null);
});

test("a session landing on a sidebar task reaches its card without a board-wide reload", (t) => {
  const storage = tempDatabase(t);
  const workspace = storage.createWorkspace({ name: "mk2api", cwd: "/tmp/mk2api" });
  const task = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "按渠道配置 API" });
  const card = ensureBoardTaskForWorkspaceTask(storage, task, workspace)!;
  storage.saveSession(snapshot({
    id: "sess-sidebar",
    workspaceId: workspace.id,
    workspaceTaskId: task.id,
    provider: "pi",
    mode: "default",
    selectedModel: "mk2api/monkeycode-ultra/gpt-6-astra",
  }));

  // 侧栏「＋」建出来的会话：只同步它所属的那一个任务，不必等 /api/wand-tasks 的全量兜底。
  syncWorkspaceTaskToBoard(storage, task.id);
  assert.deepEqual(storage.listWandTaskSessionIds(card.id), ["sess-sidebar"]);
  assert.equal(storage.getWandTask(card.id)?.status, "doing");
  assert.deepEqual(storage.getWandTask(card.id)?.agent, {
    provider: "pi",
    model: "mk2api/monkeycode-ultra/gpt-6-astra",
    thinkingEffort: "off",
    mode: "default",
    kind: "structured",
  });

  // 幂等：重复同步不会重复绑定，也不会把用户手动改过的状态再改回去。
  storage.updateWandTask(card.id, { status: "todo" });
  syncWorkspaceTaskToBoard(storage, task.id);
  assert.deepEqual(storage.listWandTaskSessionIds(card.id), ["sess-sidebar"]);
  assert.equal(storage.getWandTask(card.id)?.status, "todo");

  // 任务不存在 / 没给归属时静默跳过：会话创建不能因为看板同步失败而失败。
  assert.doesNotThrow(() => syncWorkspaceTaskToBoard(storage, "missing-task"));
  assert.doesNotThrow(() => syncWorkspaceTaskToBoard(storage, null));
  assert.doesNotThrow(() => syncWorkspaceTaskToBoard(storage, undefined));
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

test("sync only binds sessions; auto naming later replaces a placeholder task title", (t) => {
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
  assert.equal(tasks[0]?.title, "未命名任务");
  assert.equal(tasks[0]?.status, "doing");
  assert.equal(tasks[0]?.description, "项目：wand\n目录：/tmp/wand");
  assert.deepEqual(storage.listWandTaskSessionIds(tasks[0]!.id), ["sess-unnamed"]);

  // 自动命名单独走一层：占位标题（含 titleSource=user 的历史卡片）会被会话内容覆盖，
  // 并回写到侧栏分组名；「项目：/ 目录：」这类同步元信息不参与命名。
  refreshAutoBoardTaskTitles(storage);
  const renamed = storage.getWandTask(tasks[0]!.id);
  assert.equal(renamed?.titleSource, "auto");
  assert.equal(renamed?.title, "修复安卓客户端连接故障");
  assert.equal(storage.getWorkspaceTask(unnamed.id)?.name, "修复安卓客户端连接故障");
  // 同一份内容不会重复处理。
  const signature = renamed?.autoTitleSignature;
  assert.ok(signature);
  refreshAutoBoardTaskTitles(storage);
  assert.equal(storage.getWandTask(tasks[0]!.id)?.autoTitleSignature, signature);
});

test("auto naming never touches a task the user named", (t) => {
  const storage = tempDatabase(t);
  const workspace = storage.createWorkspace({ name: "wand", cwd: "/tmp/wand" });
  const named = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "我自己的任务名" });
  const card = ensureBoardTaskForWorkspaceTask(storage, named, workspace);
  assert.equal(card.titleSource, "user");
  storage.saveSession(snapshot({
    id: "sess-named",
    workspaceId: workspace.id,
    workspaceTaskId: named.id,
    title: "会话里的另一个标题",
  }));

  refreshAutoBoardTaskTitles(storage);
  assert.equal(storage.getWandTask(card.id)?.title, "我自己的任务名");
  assert.equal(storage.getWandTask(card.id)?.titleSource, "user");
});

test("auto naming source only includes task content, not synced directory metadata", (t) => {
  const storage = tempDatabase(t);
  const workspace = storage.createWorkspace({ name: "wand", cwd: "/tmp/wand" });
  const task = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "未命名任务" });
  const card = ensureBoardTaskForWorkspaceTask(storage, task, workspace);
  storage.updateWandTask(card.id, { description: "项目：wand\n目录：/tmp/wand\n把登录页错误提示修好" });

  const source = taskAutoNameSourceText(storage, storage.getWandTask(card.id)!);
  assert.equal(source, "把登录页错误提示修好");
  assert.equal(taskAutoNameSignature(source), taskAutoNameSignature("把登录页错误提示修好"));
});

test("sync leaves standalone sessions unassigned rather than inventing tasks", (t) => {
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
  assert.equal(tasks.length, 0);
  assert.equal(storage.getSession("loose-1")?.workspaceTaskId, undefined);
});

test("sync does not guess session membership from matching titles", (t) => {
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
  assert.deepEqual(storage.listWandTaskSessionIds(existing.id), []);
});

test("archiveBoardTask stores archived instead of done", (t) => {
  const storage = tempDatabase(t);
  const workspace = storage.createWorkspace({ name: "wand", cwd: "/tmp/wand" });
  const work = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "侧栏任务" });
  const card = storage.createWandTask({
    workspaceId: workspace.id,
    workspaceTaskId: work.id,
    title: "要归档",
    status: "doing",
  });

  const archived = archiveBoardTask(storage, card.id);
  assert.equal(archived?.status, "archived");
  assert.equal(storage.getWandTask(card.id)?.status, "archived");
  assert.equal(storage.getWorkspaceTask(work.id)?.status, "done");
});

test("board tasks get sidebar containers and share names, milestones, and reopened status", (t) => {
  const storage = tempDatabase(t);
  const workspace = storage.createWorkspace({ name: "project", cwd: "/tmp/project" });
  const milestone = storage.createWandMilestone({ name: "v1" });
  const card = storage.createWandTask({ workspaceId: workspace.id, title: "First" });
  const group = ensureWorkspaceTaskForBoardTask(storage, card);
  assert.equal(group.worktree, null);
  assert.equal(group.workspaceId, workspace.id);
  storage.updateWandTask(card.id, { title: "Board rename", status: "done", milestoneId: milestone.id });
  assert.equal(storage.getWorkspaceTask(group.id)?.name, "Board rename");
  assert.equal(storage.getWorkspaceTask(group.id)?.status, "done");
  assert.equal(storage.getWorkspaceTask(group.id)?.milestoneId, milestone.id);
  storage.updateWandTask(card.id, { status: "doing" });
  assert.equal(storage.getWorkspaceTask(group.id)?.status, "active");
  storage.updateWorkspaceTask(group.id, { name: "Sidebar rename", milestoneId: null });
  assert.equal(storage.getWandTask(card.id)?.title, "Sidebar rename");
  assert.equal(storage.getWandTask(card.id)?.milestoneId, null);
});

test("moving a session is exclusive, preserves execution, prunes old tabs, and survives stale checkpoints", (t) => {
  const storage = tempDatabase(t);
  const workspace = storage.createWorkspace({ name: "project", cwd: "/tmp/project" });
  const source = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "Same name" });
  const target = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "Same name" });
  const old = snapshot({ workspaceId: workspace.id, workspaceTaskId: source.id, output: "history", title: "Prompt" });
  storage.saveSession(old);
  storage.saveWorkspaceTaskLayout(source.id, {
    type: "windows", activeWindowId: "window", windows: [{ id: "window", activeTabId: "session",
      layout: { type: "pane", active: 0, tabs: [
        { id: "session", kind: "session", sessionId: old.id },
        { id: "editor", kind: "editor", path: "/tmp/project/file" },
      ] },
    }],
  });
  syncUngroupedSessionsToBoard(storage);
  const sourceCard = storage.getWandTaskByWorkspaceTaskId(source.id)!;
  moveSessionToWorkspaceTask(storage, old.id, target.id);
  moveSessionToWorkspaceTask(storage, old.id, target.id);
  storage.saveSession(old);
  syncUngroupedSessionsToBoard(storage);
  assert.equal(storage.getSession(old.id)?.workspaceTaskId, target.id);
  assert.equal(storage.getSession(old.id)?.cwd, old.cwd);
  assert.equal(storage.getSession(old.id)?.output, "history");
  assert.deepEqual(storage.listWandTaskSessionIds(sourceCard.id), []);
  assert.deepEqual(storage.listWandTaskSessionIds(storage.getWandTaskByWorkspaceTaskId(target.id)!.id), [old.id]);
  const layout = storage.getWorkspaceTask(source.id)!.layout!;
  assert.equal(layout.windows[0]?.activeTabId, "editor");
  assert.equal(JSON.stringify(layout).includes('"sessionId"'), false);
  assert.equal(storage.listWandTasks().length, 2);
  const targetCard = storage.getWandTaskByWorkspaceTaskId(target.id)!;
  storage.updateWandTask(targetCard.id, { status: "todo" });
  syncUngroupedSessionsToBoard(storage);
  assert.equal(storage.getWandTask(targetCard.id)?.status, "todo", "reconciliation preserves explicit board status");
  assert.throws(() => moveSessionToWorkspaceTask(storage, old.id, "missing"));
  assert.equal(storage.getSession(old.id)?.workspaceTaskId, target.id);
  moveSessionToWorkspaceTask(storage, old.id, null);
  syncUngroupedSessionsToBoard(storage);
  assert.equal(storage.getSession(old.id)?.workspaceTaskId, undefined);
  assert.deepEqual(storage.listBoundWandTaskSessionIds(), []);
});
