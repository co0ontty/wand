import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

    // 空名 → 400
    let res = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "  " }));
    assert.equal(res.status, 400);

    // 合法任务 → 201 + worktree 隔离
    res = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "重构恢复流程" }));
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
    assert.equal(list.length, 1);
    assert.equal(list[0].id, task.id);

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
    res = await fetch(`${baseUrl}/api/workspaces/${ws.id}/tasks`, json({ name: "项目删除清理" }));
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

test("task in a non-git workspace degrades to no isolation", async () => {
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
    assert.ok(task.worktreeError, "非 git 目录应给出降级提示");
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
    const committed = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, json({ name: "完成登录页" }))
      .then((response) => response.json() as Promise<{ id: string; cwd: string }>);
    writeFileSync(path.join(committed.cwd, "login.txt"), "login\n");
    git(["add", "login.txt"], committed.cwd);
    git(["commit", "-q", "-m", "feat: add login page"], committed.cwd);

    const dirty = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, json({ name: "调整设置页" }))
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
