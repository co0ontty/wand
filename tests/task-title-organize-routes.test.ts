import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { jsonErrorHandler } from "../src/express-async.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { WandStorage } from "../src/storage.js";
import type { TitleJudge } from "../src/task-title-organize.js";

function start(storage: WandStorage, judge?: TitleJudge): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, storage, undefined, {}, judge ? { judge } : {});
  app.use(jsonErrorHandler);
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const { port } = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

test("multi-selected tasks organize sessions by title without ticking each session", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-title-organize-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await start(storage, async (input) => {
    const login = input.tasks.find((item) => item.titles.some((title) => title.includes("登录")));
    return {
      sessions: input.sessions.filter((item) => item.id === "near").map((item) => ({ id: item.id, taskId: login?.id ?? null })),
      tasks: [],
    };
  });
  try {
    const workspace = storage.createWorkspace({ name: "Project", cwd: root });
    const login = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "修复登录" });
    const docs = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "更新文档" });
    const untouched = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "修复登录页样式" });
    const loginCard = storage.getWandTaskByWorkspaceTaskId(login.id)!;
    storage.updateWandTask(loginCard.id, { status: "doing" });
    const save = (id: string, title: string, taskId?: string, cwd = root) => storage.saveSession({
      id, title, command: "pi", sessionKind: "structured", cwd, mode: "default", status: "idle",
      exitCode: null, startedAt: "2026-10-02T00:00:00.000Z", endedAt: null, output: "",
      workspaceId: workspace.id, workspaceTaskId: taskId,
    });
    save("on-docs", "修复登录", docs.id);
    save("on-login", "别的工作", login.id);
    save("loose", "更新文档");
    save("near", "登录页报错");
    save("other-dir", "修复登录", undefined, path.join(root, "other"));
    save("untouched-session", "修复登录", untouched.id);
    const first = await fetch(`${baseUrl}/api/tasks/organize-by-title`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskIds: [login.id, docs.id], sessionIds: ["loose", "near", "other-dir"], mode: "all" }),
    });
    assert.equal(first.status, 200);
    const body = await first.json() as {
      movedSessions: Array<{ sessionId: string; taskId: string }>;
      refused: Array<{ id: string; reason: string }>;
    };
    assert.deepEqual(body.movedSessions.map((item) => item.sessionId).sort(), ["loose", "near", "on-docs"]);
    assert.equal(storage.getSession("on-docs")?.workspaceTaskId, login.id);
    assert.equal(storage.getSession("loose")?.workspaceTaskId, docs.id);
    assert.equal(storage.getSession("on-login")?.workspaceTaskId, login.id, "unrelated session stays");
    assert.equal(storage.getSession("other-dir")?.workspaceTaskId, undefined);
    assert.equal(storage.getSession("untouched-session")?.workspaceTaskId, untouched.id, "未选中的任务及其会话不被归类");
    assert.equal(body.refused.some((item) => item.id === "other-dir"), true);
    const again = await fetch(`${baseUrl}/api/tasks/organize-by-title`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskIds: [login.id, docs.id], sessionIds: ["loose", "near"], mode: "all" }),
    });
    const second = await again.json() as { movedSessions: unknown[] };
    assert.equal(second.movedSessions.length, 0);
    const missing = await fetch(`${baseUrl}/api/tasks/organize-by-title`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskIds: ["missing"] }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
