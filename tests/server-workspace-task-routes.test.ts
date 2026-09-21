import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { jsonErrorHandler } from "../src/express-async.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { defaultConfig } from "../src/config.js";

function startWorkspaceApp(storage: WandStorage): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, storage);
  app.use(jsonErrorHandler);
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function git(args: string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

test("task revisions track individual metadata, milestone removal, and lower layout revisions", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-revisions-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const workspace = storage.createWorkspace({ name: "Project", cwd: root });
    const first = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "First" });
    const second = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "Second" });
    const milestone = storage.createWandMilestone({ name: "Release" });
    storage.saveWorkspaceTaskLayout(first.id, null);
    storage.saveWorkspaceTaskLayout(first.id, null);
    type Page = {
      unchanged: boolean;
      revision: string;
      groups: Array<{ tasks: Array<{ id: string; name: string; status: string; milestoneId: string | null; layoutRevision: number; isolated: boolean }> }>;
    };
    const load = async (revision = "probe"): Promise<Page> => {
      const res = await fetch(`${baseUrl}/api/tasks?revision=${encodeURIComponent(revision)}`);
      assert.equal(res.status, 200);
      return await res.json() as Page;
    };
    let page = await load();
    assert.equal((await load(page.revision)).unchanged, true);
    for (const patch of [{ name: "Renamed" }, { status: "done" }, { milestoneId: milestone.id }]) {
      const response = await fetch(`${baseUrl}/api/workspace-tasks/${second.id}`, json(patch, "PATCH"));
      assert.equal(response.status, 200);
      const next = await load(page.revision);
      assert.equal(next.unchanged, false);
      assert.notEqual(next.revision, page.revision);
      const task = next.groups.flatMap((group) => group.tasks).find((task) => task.id === second.id)!;
      for (const [key, value] of Object.entries(patch)) assert.equal(task[key as keyof typeof task], value);
      page = next;
    }
    const layoutResponse = await fetch(`${baseUrl}/api/workspace-tasks/${second.id}/layout`, json({
      layout: { type: "pane", tabs: [], active: 0 }, layoutRevision: 0,
    }, "PUT"));
    assert.equal(layoutResponse.status, 200);
    let next = await load(page.revision);
    assert.equal(next.unchanged, false);
    const tasks = next.groups.flatMap((group) => group.tasks);
    assert.equal(tasks.find((task) => task.id === first.id)?.layoutRevision, 2);
    assert.equal(tasks.find((task) => task.id === second.id)?.layoutRevision, 1);
    page = next;

    storage.updateWorkspaceTask(second.id, { worktree: { branch: "test", path: root } });
    next = await load(page.revision);
    assert.equal(next.unchanged, false);
    assert.equal(next.groups.flatMap((group) => group.tasks).find((task) => task.id === second.id)?.isolated, true);
    page = next;
    storage.deleteWandMilestone(milestone.id);
    next = await load(page.revision);
    assert.equal(next.unchanged, false);
    // 迭代被删后任务回到默认迭代（不再是「无迭代」）。
    const afterDelete = next.groups.flatMap((group) => group.tasks).find((task) => task.id === second.id);
    assert.equal(afterDelete?.milestoneId, storage.findDefaultWandMilestone()?.id);
    assert.equal(afterDelete?.milestone?.isDefault, true);
    assert.equal((await load(next.revision)).unchanged, true);
  } finally {
    await close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("task aggregation reuses queries without leaking truncated or filtered task sessions", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-query-reuse-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const workspace = storage.createWorkspace({ name: "Project", cwd: root });
    const other = storage.createWorkspace({ name: "Other", cwd: path.join(root, "other") });
    const first = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "First" });
    const second = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "Second" });
    const excluded = storage.createWorkspaceTask({ workspaceId: other.id, name: "Excluded" });
    for (const task of [first, second, excluded]) {
      for (const suffix of ["a", "b"]) storage.saveSession({
        id: `${task.id}-${suffix}`, command: "sh", cwd: root, mode: "managed", status: "exited",
        exitCode: 0, startedAt: "2026-07-14T00:00:00.000Z", endedAt: null, output: "transcript",
        workspaceId: workspace.id, workspaceTaskId: task.id,
      });
    }
    const taskQueries = t.mock.method(storage, "listWorkspaceTasks");
    // 侧栏只渲染会话摘要，路由走 slim 读（不解析 output/messages 大字段）。
    const sessionQueries = t.mock.method(storage, "listSessionsByWorkspaceTaskSlim");
    for (const query of ["", `?workspaceId=${workspace.id}&limit=1&maxSessions=1`]) {
      taskQueries.mock.resetCalls();
      sessionQueries.mock.resetCalls();
      const response = await fetch(`${baseUrl}/api/tasks${query}`);
      assert.equal(response.status, 200);
      const groups = await response.json() as Array<{
        workspaceId: string;
        tasks: Array<{ sessions: unknown[]; totalSessions: number }>;
        standaloneSessions: unknown[];
      }>;
      assert.ok(groups.every((group) => group.standaloneSessions.length === 0));
      assert.equal(taskQueries.mock.callCount(), 2);
      assert.equal(sessionQueries.mock.callCount(), 3);
      assert.equal(new Set(taskQueries.mock.calls.map((call) => call.arguments[0])).size, 2);
      assert.equal(new Set(sessionQueries.mock.calls.map((call) => call.arguments[0])).size, 3);
      if (query) {
        assert.equal(groups.length, 1);
        assert.equal(groups[0].workspaceId, workspace.id);
        assert.equal(groups[0].tasks.length, 1);
        assert.equal(groups[0].tasks[0].sessions.length, 1);
        assert.equal(groups[0].tasks[0].totalSessions, 2);
      }
    }
  } finally {
    await close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a task created without a name is titled from its first prompt", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-prompt-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const ws = await fetch(`${baseUrl}/api/workspaces`, json({ name: "Wand", cwd: root })).then((r) => r.json() as Promise<{ id: string }>);
    const prompt = "帮我排查登录页 Safari 上偶发的白屏问题\n补充：只在 iOS 16 复现";

    const res = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ description: prompt }));
    assert.equal(res.status, 201);
    const created = await res.json() as { id: string; name: string };
    // 不留「未命名任务」：名称直接取提示词首行，之后再交给模型总结。
    assert.equal(created.name, "帮我排查登录页 Safari 上偶发的白屏问题");
    assert.notEqual(created.name, "未命名任务");
    assert.equal(storage.getWorkspaceTask(created.id)?.name, "帮我排查登录页 Safari 上偶发的白屏问题");
    const card = storage.getWandTaskByWorkspaceTaskId(created.id);
    assert.equal(card?.titleSource, "auto");
    assert.equal(card?.description, prompt);
  } finally {
    await close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit task name always wins over the first prompt", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-name-wins-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const res = await fetch(`${baseUrl}/api/tasks`, json({ name: "我自己的任务名", description: "帮我重构会话恢复流程" }));
    assert.equal(res.status, 201);
    const created = await res.json() as { id: string; name: string };
    assert.equal(created.name, "我自己的任务名");
    const card = storage.getWandTaskByWorkspaceTaskId(created.id);
    assert.equal(card?.titleSource, "user");
    assert.equal(card?.title, "我自己的任务名");
  } finally {
    await close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("task creation makes an isolated worktree in a git workspace", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-git-"));
  // 建一个 git 仓库并提交一个文件，prepareSessionWorktree 才能工作
  git(["init", "-q", "-b", "main"], root);
  writeFileSync(path.join(root, "README.md"), "hello\n");
  git(["add", "."], root);
  git(["commit", "-q", "-m", "init"], root);

  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const ws = await fetch(`${baseUrl}/api/workspaces`, json({ name: "Wand", cwd: root })).then((r) => r.json() as Promise<{ id: string }>);

    // 空名且无提示词时用带随机数的占位名，避免同名任务挤在一起
    let res = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "  " }));
    assert.equal(res.status, 201);
    const unnamed = await res.json() as { id: string; name: string };
    assert.match(unnamed.name, /^未命名任务 \d{4}$/);

    // 合法任务 → 201 + worktree 隔离
    res = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "重构恢复流程", worktree: true }));
    assert.equal(res.status, 201);
    const task = await res.json() as {
      id: string; name: string; isolated: boolean; cwd: string;
      worktree: { branch: string; path: string; baseRef?: string; repoRoot?: string } | null;
    };
    assert.equal(task.name, "重构恢复流程");
    assert.equal(task.isolated, true);
    assert.ok(task.worktree);
    assert.ok(existsSync(task.worktree!.path), "worktree 目录应被创建");
    assert.ok(task.cwd.endsWith(task.worktree!.branch.replace(/\//g, "-")), "cwd 应指向 worktree 路径");

    // 列表
    res = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`);
    const list = await res.json() as Array<{ id: string; name: string }>;
    assert.equal(list.length, 2);
    assert.ok(list.some((item) => item.id === task.id));

    // 详情含 sessions（空）
    res = await fetch(`${baseUrl}/api/workspace-tasks/${task.id}`);
    const detail = await res.json() as { sessions: unknown[]; layout: unknown; cwd: string };
    assert.deepEqual(detail.sessions, []);
    assert.equal(detail.layout, null);
    assert.ok(detail.cwd);

    // PUT 布局（标签在任务上）
    const layout = { type: "pane", tabs: [{ id: "t1", kind: "session", sessionId: "s1" }], active: 0 };
    res = await fetch(`${baseUrl}/api/workspace-tasks/${task.id}/layout`, json({ layout }, "PUT"));
    assert.equal(res.status, 200);
    const putBody = await res.json() as { layout: { type: string; windows: Array<{ layout: { tabs: Array<{ id: string }> } }> } };
    assert.equal(putBody.layout.type, "windows");
    assert.equal(putBody.layout.windows[0].layout.tabs[0].id, "t1");

    // 改名
    res = await fetch(`${baseUrl}/api/workspace-tasks/${task.id}`, json({ name: "重构恢复流程 v2" }, "PATCH"));
    assert.equal(res.status, 200);
    const patched = await res.json() as { name: string };
    assert.equal(patched.name, "重构恢复流程 v2");

    const config = { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" as const };
    const manager = new StructuredSessionManager(storage, config);
    const boundSession = manager.createSession({
      cwd: task.cwd,
      mode: config.defaultMode,
      workspaceId: ws.id,
      workspaceTaskId: task.id,
    });

    // 删除隔离任务 → worktree 与绑定会话一起清理，不能留下 cwd 失效的会话。
    const worktreePath = task.worktree!.path;
    res = await fetch(`${baseUrl}/api/workspace-tasks/${task.id}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.ok(!existsSync(worktreePath), "删除任务后 worktree 目录应被清理");
    assert.equal(storage.getSession(boundSession.id), null);
    res = await fetch(`${baseUrl}/api/workspace-tasks/${task.id}`);
    assert.equal(res.status, 404);

    // 删除项目也必须清理其余任务的 worktree，不能只删数据库行。
    res = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "项目删除清理", worktree: true }));
    assert.equal(res.status, 201);
    const secondTask = await res.json() as { worktree: { path: string } | null };
    assert.ok(secondTask.worktree && existsSync(secondTask.worktree.path));
    res = await fetch(`${baseUrl}/api/workspaces/${ws.id}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.equal(existsSync(secondTask.worktree!.path), false);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit worktree:true fails instead of silently degrading", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-require-worktree-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const ws = await fetch(`${baseUrl}/api/workspaces`, json({ name: "Plain", cwd: root })).then((r) => r.json() as Promise<{ id: string }>);
    const res = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "必须隔离", worktree: true }));
    assert.equal(res.status, 400);
    const body = await res.json() as { error?: string };
    assert.match(body.error ?? "", /当前目录不是 Git 仓库/);
    assert.match(body.error ?? "", /关闭.*worktree 隔离/);
    assert.doesNotMatch(body.error ?? "", /Command failed|fatal:/);
    const tasks = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`).then((r) => r.json() as Promise<unknown[]>);
    assert.equal(tasks.length, 0);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("task in a non-git workspace is a logical group by default", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-nogit-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const ws = await fetch(`${baseUrl}/api/workspaces`, json({ name: "Plain", cwd: root })).then((r) => r.json() as Promise<{ id: string }>);
    const res = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "无 git" }));
    assert.equal(res.status, 201);
    const task = await res.json() as { isolated: boolean; worktree: unknown; cwd: string; worktreeError?: string };
    assert.equal(task.isolated, false);
    assert.equal(task.worktree, null);
    assert.equal(task.cwd, root);
    assert.equal(task.worktreeError, undefined);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("task creation can skip worktree isolation and /api/tasks aggregates across projects", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-flat-"));
  git(["init", "-q", "-b", "main"], root);
  writeFileSync(path.join(root, "README.md"), "hello\n");
  git(["add", "."], root);
  git(["commit", "-q", "-m", "init"], root);

  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const ws = await fetch(`${baseUrl}/api/workspaces`, json({ name: "Wand", cwd: root })).then((r) => r.json() as Promise<{ id: string }>);

    // worktree:false → 即使在 git 仓库里也不建隔离，直接跑在项目目录。
    let res = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "共享目录任务", worktree: false }));
    assert.equal(res.status, 201);
    const shared = await res.json() as { id: string; isolated: boolean; worktree: unknown; cwd: string; worktreeError?: string };
    assert.equal(shared.isolated, false);
    assert.equal(shared.worktree, null);
    assert.equal(shared.cwd, root);
    assert.equal(shared.worktreeError, undefined);

    // 隔离是显式选择；默认任务只做逻辑分组。
    res = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "隔离任务", worktree: true }));
    assert.equal(res.status, 201);
    const isolated = await res.json() as { id: string; isolated: boolean; cwd: string };
    assert.equal(isolated.isolated, true);

    // 绑定一个会话到共享任务；另建一个不绑任务的散会话，应归入同目录组的
    // standaloneSessions（未分组会话）。
    const config = { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" as const };
    const manager = new StructuredSessionManager(storage, config);
    const boundSession = manager.createSession({
      cwd: shared.cwd,
      mode: config.defaultMode,
      workspaceId: ws.id,
      workspaceTaskId: shared.id,
    });
    const looseSession = manager.createSession({ cwd: root, mode: config.defaultMode });

    res = await fetch(`${baseUrl}/api/tasks`);
    assert.equal(res.status, 200);
    const groups = await res.json() as Array<{
      workspaceId: string; workspaceName: string; workspaceCwd: string; synthetic?: boolean;
      tasks: Array<{ id: string; isolated: boolean; cwd: string; sessions: Array<{ id: string }> }>;
      standaloneSessions: Array<{ id: string }>;
    }>;
    assert.equal(groups.length, 1);
    const group = groups[0];
    assert.equal(group.workspaceId, ws.id);
    assert.equal(group.workspaceName, "Wand");
    assert.equal(realpathSync(group.workspaceCwd), realpathSync(root));
    assert.equal(group.synthetic, undefined);
    // 目录组带回全部任务（隔离 + 共享），新创建的在前。
    assert.equal(group.tasks.length, 2);
    assert.deepEqual(group.tasks.map((task) => task.id), [isolated.id, shared.id]);
    const sharedRow = group.tasks.find((task) => task.id === shared.id);
    assert.ok(sharedRow);
    assert.equal(sharedRow.isolated, false);
    assert.equal(sharedRow.cwd, root);
    assert.deepEqual(sharedRow.sessions.map((session) => session.id), [boundSession.id]);
    const isolatedRow = group.tasks.find((task) => task.id === isolated.id);
    assert.ok(isolatedRow);
    assert.equal(isolatedRow.isolated, true);
    assert.equal(isolatedRow.sessions.length, 0);
    // 散会话不出现在任何任务下，而是归入目录组的未分组合话。
    assert.deepEqual(group.standaloneSessions.map((session) => session.id), [looseSession.id]);
    assert.equal("ptyBusy" in (sharedRow.sessions[0] as { ptyBusy?: boolean }), true);

    const pageResponse = await fetch(`${baseUrl}/api/tasks?revision=probe`);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json() as {
      unchanged: boolean;
      revision: string;
      groups: Array<{ workspaceId: string }>;
    };
    assert.equal(page.unchanged, false);
    assert.ok(page.revision);
    assert.equal(page.groups[0]?.workspaceId, ws.id);
    const unchangedResponse = await fetch(
      `${baseUrl}/api/tasks?revision=${encodeURIComponent(page.revision)}`,
    );
    const unchanged = await unchangedResponse.json() as { unchanged: boolean; revision: string; groups: unknown[] };
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.revision, page.revision);
    assert.deepEqual(unchanged.groups, []);

    // 查询参数：workspaceId 过滤 + limit/maxSessions 截断。
    res = await fetch(`${baseUrl}/api/tasks?workspaceId=${ws.id}&limit=1&maxSessions=1`);
    assert.equal(res.status, 200);
    const filtered = await res.json() as Array<{
      workspaceId: string;
      tasks: Array<{ id: string; sessions: Array<unknown>; totalSessions: number }>;
    }>;
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].workspaceId, ws.id);
    assert.equal(filtered[0].tasks.length, 1);
    // limit=1 截断后保留一个任务；其会话被 maxSessions=1 截短，但
    // totalSessions 仍报告真实总数，供前端展示「还有 N 条」。
    const truncated = filtered[0].tasks[0];
    assert.ok(truncated.sessions.length <= 1);
    assert.equal(typeof truncated.totalSessions, "number");

    // 不存在的 workspaceId → 空数组而不是全量。
    res = await fetch(`${baseUrl}/api/tasks?workspaceId=nonexistent`);
    assert.deepEqual(await res.json(), []);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("project worktree review reports count, default branch, commits, and dirty state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-project-worktrees-"));
  git(["init", "-q", "-b", "main"], root);
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(["add", "."], root);
  git(["commit", "-q", "-m", "init"], root);

  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const workspace = await fetch(`${baseUrl}/api/workspaces`, json({ name: "Review", cwd: root }))
      .then((response) => response.json() as Promise<{ id: string }>);
    const committed = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, json({ name: "完成登录页", worktree: true }))
      .then((response) => response.json() as Promise<{ id: string; cwd: string }>);
    writeFileSync(path.join(committed.cwd, "login.txt"), "login\n");
    git(["add", "login.txt"], committed.cwd);
    git(["commit", "-q", "-m", "feat: add login page"], committed.cwd);

    const dirty = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, json({ name: "调整设置页", worktree: true }))
      .then((response) => response.json() as Promise<{ id: string; cwd: string }>);
    writeFileSync(path.join(dirty.cwd, "settings.txt"), "draft\n");

    const listed = await fetch(`${baseUrl}/api/workspaces`).then((response) => response.json() as Promise<Array<{ id: string; worktreeCount: number }>>);
    assert.equal(listed.find((item) => item.id === workspace.id)?.worktreeCount, 2);

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/worktrees`);
    assert.equal(response.status, 200);
    const review = await response.json() as {
      targetBranch: string;
      repoRoot: string;
      worktrees: Array<{
        taskId: string;
        state: string;
        actionable: boolean;
        aheadCount: number;
        hasUncommittedChanges: boolean;
        commits: Array<{ subject: string }>;
      }>;
    };
    assert.equal(review.targetBranch, "main");
    assert.equal(realpathSync(review.repoRoot), realpathSync(root));
    assert.equal(review.worktrees.length, 2);
    const committedReview = review.worktrees.find((item) => item.taskId === committed.id);
    assert.equal(committedReview?.state, "ready");
    assert.equal(committedReview?.aheadCount, 1);
    assert.equal(committedReview?.commits[0]?.subject, "feat: add login page");
    const dirtyReview = review.worktrees.find((item) => item.taskId === dirty.id);
    assert.equal(dirtyReview?.state, "dirty");
    assert.equal(dirtyReview?.hasUncommittedChanges, true);
    assert.equal(dirtyReview?.actionable, true);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sessions bind to a workspace task and are listed under it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-bind-"));
  // 非也能创建会话：用非 git 目录即可（structured 会话不强制 worktree）
  git(["init", "-q", "-b", "main"], root);
  writeFileSync(path.join(root, "a.txt"), "a");
  git(["add", "."], root);
  git(["commit", "-q", "-m", "init"], root);

  const config = { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" as const };
  const storage = new WandStorage(path.join(root, "wand.db"));
  const manager = new StructuredSessionManager(storage, config);

  const ws = storage.createWorkspace({ name: "Bind", cwd: root });
  const task = storage.createWorkspaceTask({ workspaceId: ws.id, name: "T1" });

  // createSession 直接带 workspaceTaskId
  const s1 = manager.createSession({ cwd: root, mode: config.defaultMode, workspaceTaskId: task.id });
  const s2 = manager.createSession({ cwd: root, mode: config.defaultMode });

  const bound = storage.listSessionsByWorkspaceTask(task.id);
  assert.equal(bound.length, 1);
  assert.equal(bound[0].id, s1.id);
  assert.equal(bound[0].workspaceTaskId, task.id);

  // 未绑定的会话没有 workspaceTaskId
  assert.equal(storage.getSession(s2.id)?.workspaceTaskId, undefined);

  // 显式绑定
  storage.setSessionWorkspaceTaskId(s2.id, task.id);
  assert.equal(storage.listSessionsByWorkspaceTask(task.id).length, 2);

  // 删除任务默认解绑但保留会话
  storage.deleteWorkspaceTask(task.id);
  assert.equal(storage.getWorkspaceTask(task.id), null);
  assert.ok(storage.getSession(s1.id));
  assert.equal(storage.getSession(s1.id)?.workspaceTaskId, undefined);

  rmSync(root, { recursive: true, force: true });
});

test("task list reassigns stale workspace bindings by the session path", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-path-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const firstWorkspace = storage.createWorkspace({ name: "第一项目", cwd: first });
    const secondWorkspace = storage.createWorkspace({ name: "第二项目", cwd: second });
    const manager = new StructuredSessionManager(storage, {
      ...defaultConfig(),
      defaultCwd: second,
      structuredRunner: "sdk",
    });
    // 模拟旧数据：workspaceId 仍指向第一项目，但会话实际 cwd 已在第二项目。
    const stale = manager.createSession({
      cwd: second,
      mode: "chat",
      workspaceId: firstWorkspace.id,
    });

    const response = await fetch(`${baseUrl}/api/tasks`);
    assert.equal(response.status, 200);
    const groups = await response.json() as Array<{
      workspaceId: string;
      standaloneSessions: Array<{ id: string }>;
    }>;
    assert.deepEqual(groups.find((group) => group.workspaceId === firstWorkspace.id)?.standaloneSessions, []);
    assert.deepEqual(
      groups.find((group) => group.workspaceId === secondWorkspace.id)?.standaloneSessions.map((session) => session.id),
      [stale.id],
    );
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("standalone tasks use the global scratch workspace and stay off the project list", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-global-"));
  const mounted = mkdtempSync(path.join(os.tmpdir(), "wand-task-mounted-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    // 独立任务无目录无提示词时也是带随机数的占位名
    let res = await fetch(`${baseUrl}/api/tasks`, json({ name: "  " }));
    assert.equal(res.status, 201);
    const unnamed = await res.json() as { id: string; name: string };
    assert.match(unnamed.name, /^未命名任务 \d{4}$/);

    res = await fetch(`${baseUrl}/api/tasks`, json({ name: "随口问问" }));
    assert.equal(res.status, 201);
    const standalone = await res.json() as {
      id: string; name: string; workspaceId: string; cwd: string; isolated: boolean;
    };
    assert.equal(standalone.name, "随口问问");
    assert.equal(standalone.isolated, false);
    assert.ok(standalone.cwd.includes("scratch"));
    assert.equal(existsSync(standalone.cwd), true);

    res = await fetch(`${baseUrl}/api/workspaces`);
    const projects = await res.json() as Array<{ id: string; kind?: string }>;
    assert.equal(projects.length, 0);
    assert.equal(projects.some((project) => project.id === standalone.workspaceId), false);

    res = await fetch(`${baseUrl}/api/tasks`, json({ name: "挂目录的独立任务", cwd: mounted, worktree: false }));
    assert.equal(res.status, 201);
    const mountedTask = await res.json() as { id: string; cwd: string; isolated: boolean };
    assert.equal(mountedTask.isolated, false);
    assert.equal(realpathSync(mountedTask.cwd), realpathSync(mounted));

    res = await fetch(`${baseUrl}/api/tasks`);
    const groups = await res.json() as Array<{
      workspaceId: string; workspaceCwd: string; workspaceName: string; global?: boolean; synthetic?: boolean;
      tasks: Array<{ id: string }>;
    }>;
    // 无项目任务按实际目录分组：临时目录仍留在全局组，挂载目录进入合成目录组。
    const globalGroup = groups.find((group) => group.global);
    assert.ok(globalGroup);
    assert.deepEqual(globalGroup.tasks.map((task) => task.id).sort(), [unnamed.id, standalone.id].sort());
    const mountedGroup = groups.find((group) => group.tasks.some((task) => task.id === mountedTask.id));
    assert.ok(mountedGroup);
    assert.equal(mountedGroup.synthetic, true);
    assert.equal(realpathSync(mountedGroup.workspaceCwd), realpathSync(mounted));
    assert.deepEqual(mountedGroup.tasks.map((task) => task.id), [mountedTask.id]);

    const project = await fetch(`${baseUrl}/api/workspaces`, json({ name: "Acme", cwd: root }))
      .then((response) => response.json() as Promise<{ id: string }>);
    res = await fetch(`${baseUrl}/api/workspaces`);
    const listed = await res.json() as Array<{ id: string }>;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, project.id);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
    rmSync(mounted, { recursive: true, force: true });
  }
});


test("task list keeps created order and puts new folders and tasks first", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-order-"));
  const olderDir = path.join(root, "older");
  const newerDir = path.join(root, "newer");
  mkdirSync(olderDir);
  mkdirSync(newerDir);
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const older = storage.createWorkspace({ name: "旧项目", cwd: olderDir });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = storage.createWorkspace({ name: "新项目", cwd: newerDir });
    const olderFirst = storage.createWorkspaceTask({ workspaceId: older.id, name: "旧任务" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const olderSecond = storage.createWorkspaceTask({ workspaceId: older.id, name: "新任务" });
    storage.touchWorkspaceTask(olderFirst.id);

    const listed = await fetch(`${baseUrl}/api/workspaces`).then((res) => res.json() as Promise<Array<{ id: string }>>);
    assert.deepEqual(listed.map((workspace) => workspace.id), [newer.id, older.id]);

    const groups = await fetch(`${baseUrl}/api/tasks`).then((res) => res.json() as Promise<Array<{
      workspaceId: string;
      createdAt?: string;
      tasks: Array<{ id: string }>;
    }>>);
    assert.deepEqual(
      groups.filter((group) => !group.workspaceId.startsWith("cwd:")).map((group) => group.workspaceId),
      [newer.id, older.id],
    );
    const olderGroup = groups.find((group) => group.workspaceId === older.id);
    assert.deepEqual(olderGroup?.tasks.map((task) => task.id), [olderSecond.id, olderFirst.id]);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cheap /api/tasks revision skips rebuilding groups when unchanged", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-tasks-revision-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const first = await fetch(`${baseUrl}/api/tasks?revision=missing`);
    assert.equal(first.status, 200);
    const body = await first.json() as { unchanged?: boolean; revision?: string; groups?: unknown[] };
    assert.equal(body.unchanged, false);
    assert.ok(typeof body.revision === "string" && body.revision.length > 0);
    const second = await fetch(`${baseUrl}/api/tasks?revision=${encodeURIComponent(body.revision)}`);
    const again = await second.json() as { unchanged?: boolean; groups?: unknown[] };
    assert.equal(again.unchanged, true);
    assert.deepEqual(again.groups, []);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("task layout PUT conflicts when the expected revision is stale", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-layout-revision-"));
  git(["init", "-q", "-b", "main"], root);
  writeFileSync(path.join(root, "README.md"), "hello\n");
  git(["add", "."], root);
  git(["commit", "-q", "-m", "init"], root);
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const ws = await fetch(`${baseUrl}/api/workspaces`, json({ name: "Wand", cwd: root })).then((r) => r.json() as Promise<{ id: string }>);
    const created = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "布局", worktree: false })).then((r) => r.json() as Promise<{ id: string }>);
    const layout = { type: "windows", windows: [], activeWindowId: null };
    const first = await fetch(`${baseUrl}/api/workspace-tasks/${created.id}/layout`, json({ layout, layoutRevision: 0 }, "PUT"));
    assert.equal(first.status, 200);
    const saved = await first.json() as { layoutRevision?: number };
    assert.equal(saved.layoutRevision, 1);
    const stale = await fetch(`${baseUrl}/api/workspace-tasks/${created.id}/layout`, json({ layout, layoutRevision: 0 }, "PUT"));
    assert.equal(stale.status, 409);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("creating a workspace task fills its own board card without merging same-title tasks", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-board-sync-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const ws = await fetch(`${baseUrl}/api/workspaces`, json({ name: "Wand", cwd: root }))
      .then((r) => r.json() as Promise<{ id: string; name: string; cwd: string }>);
    const preexisting = storage.createWandTask({
      workspaceId: ws.id,
      title: "登录页",
      description: "旧卡片",
    });

    const created = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "登录页", worktree: false }))
      .then((r) => r.json() as Promise<{ id: string; name: string }>);
    const linked = storage.getWandTaskByWorkspaceTaskId(created.id);
    assert.ok(linked);
    assert.notEqual(linked!.id, preexisting.id);
    assert.equal(linked!.workspaceTaskId, created.id);
    assert.equal(linked!.status, "todo", "an existing board task keeps its status");

    const second = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "设置页", worktree: false }))
      .then((r) => r.json() as Promise<{ id: string; name: string }>);
    const fresh = storage.getWandTaskByWorkspaceTaskId(second.id);
    assert.ok(fresh);
    assert.notEqual(fresh!.id, preexisting.id);
    assert.equal(fresh!.title, "设置页");
    assert.equal(fresh!.status, "todo");
    assert.equal(fresh!.workspaceId, ws.id);
    assert.equal(fresh!.workspaceTaskId, second.id);
    assert.equal(fresh!.description, "");

    const archived = await fetch(`${baseUrl}/api/workspace-tasks/${second.id}`, json({ status: "done" }, "PATCH"));
    assert.equal(archived.status, 200);
    assert.equal(storage.getWandTask(fresh!.id)?.status, "done");
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("archiving a sidebar task keeps its terminals and worktree, and restoring brings it back", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-archive-"));
  git(["init", "-q"], root);
  git(["commit", "-q", "--allow-empty", "-m", "init"], root);

  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" as const };
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const ws = storage.createWorkspace({ name: "Wand", cwd: root });
    const task = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "重构恢复流程", worktree: true }))
      .then((r) => r.json() as Promise<{ id: string; cwd: string; worktree: { path: string } | null }>);
    const manager = new StructuredSessionManager(storage, config);
    const session = manager.createSession({
      cwd: task.cwd,
      mode: config.defaultMode,
      workspaceId: ws.id,
      workspaceTaskId: task.id,
    });
    const card = storage.getWandTaskByWorkspaceTaskId(task.id);
    assert.ok(card);

    const archived = await fetch(`${baseUrl}/api/workspace-tasks/${task.id}/archive`, json({}, "POST"));
    assert.equal(archived.status, 200);
    // 软删除：卡片进归档、侧栏任务隐藏，终端 / worktree / 卡片绑定全部保留。
    assert.equal(storage.getWandTask(card!.id)?.status, "archived");
    assert.equal(storage.getWorkspaceTask(task.id)?.status, "done");
    assert.ok(storage.getSession(session.id), "归档不能删除终端");
    assert.equal(storage.getSession(session.id)?.workspaceTaskId, task.id);
    assert.equal(storage.getSession(session.id)?.workspaceId, ws.id);
    assert.ok(task.worktree && existsSync(task.worktree.path), "归档不能清理 worktree");
    assert.equal(storage.getWandTaskByWorkspaceTaskId(task.id)?.id, card!.id);

    // 侧栏拿到的是隐藏状态（done），会话仍挂在任务里；看板归档目录里卡片还在。
    const groups = await fetch(`${baseUrl}/api/tasks`).then((r) => r.json() as Promise<Array<{
      tasks: Array<{ id: string; status: string; sessions: Array<{ id: string }> }>;
    }>>);
    const listed = groups.flatMap((group) => group.tasks).find((item) => item.id === task.id);
    assert.equal(listed?.status, "done");
    assert.deepEqual(listed?.sessions.map((item) => item.id), [session.id]);
    assert.equal(storage.getWandTask(card!.id)?.status, "archived");

    // 恢复：卡片改回「等待认领」后，侧栏任务由反向投影重新出现，终端仍绑在原任务上。
    storage.updateWandTask(card!.id, { status: "todo" });
    assert.equal(storage.getWorkspaceTask(task.id)?.status, "active");
    assert.equal(storage.getSession(session.id)?.workspaceTaskId, task.id);

    const missing = await fetch(`${baseUrl}/api/workspace-tasks/missing/archive`, json({}, "POST"));
    assert.equal(missing.status, 404);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("archiving a board card hides its sidebar container without deleting the task row", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-card-archive-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const ws = storage.createWorkspace({ name: "Wand", cwd: root });
    const created = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "文档整理" }))
      .then((r) => r.json() as Promise<{ id: string }>);
    const card = storage.getWandTaskByWorkspaceTaskId(created.id);
    assert.ok(card);

    const archived = storage.updateWandTask(card!.id, { status: "archived" });
    assert.equal(archived?.status, "archived");
    // 侧栏不显示靠 status=done，任务行与看板绑定都还在，方便随时恢复。
    assert.equal(storage.getWorkspaceTask(created.id)?.status, "done");
    assert.equal(storage.getWandTaskByWorkspaceTaskId(created.id)?.id, card!.id);
    assert.equal(storage.listWorkspaceTasks(ws.id).length, 1);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});
