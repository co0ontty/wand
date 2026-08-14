import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { defaultConfig } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { registerWorkspaceRoutes, sanitizeLayout, sanitizeTaskLayout } from "../src/server-workspace-routes.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";

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

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("workspace CRUD + layout round-trip via REST", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-workspace-routes-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    // 空名 → 400
    let res = await fetch(`${baseUrl}/api/workspaces`, json({ name: "   ", cwd: root }));
    assert.equal(res.status, 400);

    // 不存在的目录 → 400
    res = await fetch(`${baseUrl}/api/workspaces`, json({ name: "p", cwd: path.join(root, "missing") }));
    assert.equal(res.status, 400);

    // 合法创建（不启动会话）→ 201
    res = await fetch(`${baseUrl}/api/workspaces`, json({ name: "Acme", cwd: root, defaultProvider: "codex" }));
    assert.equal(res.status, 201);
    const ws = await res.json() as { id: string; name: string; cwd: string; defaultProvider: string; layout: unknown; sessionCount?: number };
    assert.equal(ws.name, "Acme");
    assert.equal(ws.cwd, root);
    assert.equal(ws.defaultProvider, "codex");
    assert.equal(ws.layout, null);
    assert.equal(ws.sessionCount, 0);
    const id = ws.id;

    // 列表
    res = await fetch(`${baseUrl}/api/workspaces`);
    const list = await res.json() as Array<{ id: string }>;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, id);

    // 详情：sessions 为空，layout 为 null
    res = await fetch(`${baseUrl}/api/workspaces/${id}`);
    assert.equal(res.status, 200);
    const detail = await res.json() as { sessions: unknown[]; layout: unknown };
    assert.deepEqual(detail.sessions, []);
    assert.equal(detail.layout, null);

    // PATCH：改名 + 清空默认 IDE
    res = await fetch(`${baseUrl}/api/workspaces/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme2", defaultProvider: null }),
    });
    assert.equal(res.status, 200);
    const patched = await res.json() as { name: string; defaultProvider: unknown };
    assert.equal(patched.name, "Acme2");
    // 清空后 DB 为 NULL → Workspace.optional 表现为 undefined（JSON 丢键）
    assert.equal(patched.defaultProvider, undefined);

    // PUT 布局：ratio 在范围内、非法 tab 被丢弃、active 被钳制
    const layout = {
      type: "split",
      dir: "h",
      ratio: 0.9,
      children: [
        { type: "pane", tabs: [{ id: "t1", kind: "session", sessionId: "s1" }, { id: "bad", kind: "nope" }], active: 0 },
        { type: "pane", tabs: [{ id: "t2", kind: "editor", path: "a.ts" }], active: 5 },
      ],
    };
    res = await fetch(`${baseUrl}/api/workspaces/${id}/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layout }),
    });
    assert.equal(res.status, 200);
    const putBody = await res.json() as {
      layout: {
        ratio: number;
        children: Array<{ tabs: Array<{ id: string; sessionId?: string }>; active: number }>;
      };
    };
    assert.equal(putBody.layout.children[0].tabs.length, 1);
    assert.equal(putBody.layout.children[0].tabs[0].sessionId, "s1");
    assert.equal(putBody.layout.children[1].active, 0);

    // 详情应反映已持久化的布局
    res = await fetch(`${baseUrl}/api/workspaces/${id}`);
    const after = await res.json() as { layout: { children: Array<{ tabs: Array<{ id: string }> }> } };
    assert.equal(after.layout.children[0].tabs[0].id, "t1");

    // DELETE（默认解绑）
    res = await fetch(`${baseUrl}/api/workspaces/${id}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    res = await fetch(`${baseUrl}/api/workspaces/${id}`);
    assert.equal(res.status, 404);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sessions bind to a workspace and are listed under it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-workspace-bind-"));
  const config = { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" as const };
  const storage = new WandStorage(path.join(root, "wand.db"));
  const manager = new StructuredSessionManager(storage, config);
  const ws = storage.createWorkspace({ name: "Bind", cwd: root });

  // createSession 直接带 workspaceId（验证 storage 占位符计数 + 读写链路）
  const s1 = manager.createSession({ cwd: root, mode: config.defaultMode, workspaceId: ws.id });
  const s2 = manager.createSession({ cwd: root, mode: config.defaultMode });

  const bound = storage.listSessionsByWorkspace(ws.id);
  assert.equal(bound.length, 1);
  assert.equal(bound[0].id, s1.id);
  assert.equal(bound[0].workspaceId, ws.id);

  // 未绑定的会话没有 workspaceId
  assert.equal(storage.getSession(s2.id)?.workspaceId, undefined);

  // 显式绑定
  storage.setSessionWorkspaceId(s2.id, ws.id);
  assert.equal(storage.listSessionsByWorkspace(ws.id).length, 2);

  const task = storage.createWorkspaceTask({ workspaceId: ws.id, name: "T" });
  const taskSession = manager.createSession({
    cwd: root,
    mode: config.defaultMode,
    workspaceId: ws.id,
    workspaceTaskId: task.id,
  });

  // 删除工作空间默认解绑但保留会话；任务会级联删除，session 上不能留下悬空 taskId。
  storage.deleteWorkspace(ws.id);
  assert.equal(storage.getWorkspace(ws.id), null);
  assert.ok(storage.getSession(s1.id));
  assert.equal(storage.getSession(s1.id)?.workspaceId, undefined);
  assert.equal(storage.getSession(taskSession.id)?.workspaceId, undefined);
  assert.equal(storage.getSession(taskSession.id)?.workspaceTaskId, undefined);

  rmSync(root, { recursive: true, force: true });
});

test("listing workspaces backfills unbound sessions into directory projects", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-workspace-backfill-route-"));
  const other = mkdtempSync(path.join(os.tmpdir(), "wand-workspace-backfill-other-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" as const };
  const manager = new StructuredSessionManager(storage, config);
  const existing = storage.createWorkspace({ name: "Existing", cwd: root });
  const inExisting = manager.createSession({ cwd: root, mode: config.defaultMode });
  const needsProject = manager.createSession({ cwd: other, mode: config.defaultMode });
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const res = await fetch(`${baseUrl}/api/workspaces`);
    assert.equal(res.status, 200);
    const list = await res.json() as Array<{ id: string; cwd: string; name: string; sessionCount: number }>;
    const existingItem = list.find((item) => item.id === existing.id);
    assert.ok(existingItem);
    assert.equal(existingItem.sessionCount, 1);
    const created = list.find((item) => item.cwd === other);
    assert.ok(created);
    assert.equal(created.sessionCount, 1);
    assert.equal(storage.getSession(inExisting.id)?.workspaceId, existing.id);
    assert.equal(storage.getSession(needsProject.id)?.workspaceId, created.id);
  } finally {
    manager.dispose();
    await close();
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("creating a workspace attaches matching unbound sessions", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-workspace-absorb-route-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" as const };
  const manager = new StructuredSessionManager(storage, config);
  const session = manager.createSession({ cwd: root, mode: config.defaultMode });
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const res = await fetch(`${baseUrl}/api/workspaces`, json({ name: "Absorb", cwd: root }));
    assert.equal(res.status, 201);
    const created = await res.json() as { id: string; sessionCount: number };
    assert.equal(created.sessionCount, 1);
    assert.equal(storage.getSession(session.id)?.workspaceId, created.id);
  } finally {
    manager.dispose();
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sanitizeLayout rejects malformed input and normalizes valid trees", () => {
  assert.equal(sanitizeLayout(null), null);
  assert.equal(sanitizeLayout({}), null);
  assert.equal(sanitizeLayout({ type: "split", dir: "x", ratio: 0.5, children: [] }), null);
  // children 数量不对
  assert.equal(
    sanitizeLayout({ type: "split", dir: "h", ratio: 0.5, children: [{}] }),
    null,
  );
  // 合法空 pane
  const emptyPane = sanitizeLayout({ type: "pane", tabs: [], active: 0 });
  assert.equal(emptyPane?.type, "pane");
  assert.equal(emptyPane?.type === "pane" && emptyPane.tabs.length, 0);
  // ratio 越界被钳制
  const clamped = sanitizeLayout({
    type: "split",
    dir: "v",
    ratio: 1.5,
    children: [{ type: "pane", tabs: [], active: 0 }, { type: "pane", tabs: [], active: 0 }],
  });
  assert.equal(clamped?.type, "split");
  assert.equal(clamped?.type === "split" && clamped.ratio, 0.95);
});

test("sanitizeTaskLayout keeps work-window tabs distinct and upgrades legacy trees", () => {
  const pane = { type: "pane", tabs: [{ id: "t1", kind: "session", sessionId: "s1" }], active: 0 };
  const legacy = sanitizeTaskLayout(pane);
  assert.equal(legacy?.type, "windows");
  assert.equal(legacy?.windows.length, 1);

  const windows = sanitizeTaskLayout({
    type: "windows",
    activeWindowId: "w2",
    windows: [
      { id: "w1", layout: pane, activeTabId: "t1" },
      { id: "w2", layout: { type: "pane", tabs: [{ id: "t2", kind: "session", sessionId: "s2" }], active: 0 } },
    ],
  });
  assert.equal(windows?.windows.length, 2);
  assert.equal(windows?.activeWindowId, "w2");
});
