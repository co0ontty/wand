import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";
import pty, { type IPty } from "node-pty";

import { defaultConfig } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { ProcessManager } from "../src/process-manager.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";

test("sessions archive and restore through the HTTP routes and report their state to the sidebar", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-session-archive-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, processes, structured, storage, config.defaultMode, config, sessions);
  registerWorkspaceRoutes(app, storage, sessions, { config });
  app.use(jsonErrorHandler);
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const created = await (await fetch(`${base}/api/structured-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: root, provider: "opencode", mode: "assist" }),
    })).json() as { id: string };
    const id = created.id;

    const archived = await fetch(`${base}/api/sessions/${id}/archive`, { method: "POST" });
    assert.equal(archived.status, 200);
    const archivedBody = await archived.json() as { archived: boolean; archivedAt: string | null };
    assert.equal(archivedBody.archived, true);
    assert.ok(archivedBody.archivedAt, "归档会写下时间戳，保留期清理以它起算");
    assert.equal(structured.get(id)?.archived, true);

    // 默认工作区列表不能混入归档会话；显式归档查询仍保留原 ID。
    const groups = await (await fetch(`${base}/api/tasks`)).json() as Array<{
      standaloneSessions: Array<{ id: string; archived?: boolean }>;
      tasks: Array<{ sessions: Array<{ id: string; archived?: boolean }> }>;
    }>;
    const listed = groups.flatMap((group) => [
      ...group.standaloneSessions,
      ...group.tasks.flatMap((task) => task.sessions),
    ]).find((session) => session.id === id);
    assert.equal(listed, undefined);
    const archives = await (await fetch(`${base}/api/tasks?includeArchived=1`)).json() as typeof groups;
    const archivedListed = archives.flatMap((group) => [
      ...group.standaloneSessions, ...group.tasks.flatMap((task) => task.sessions),
    ]).find((session) => session.id === id);
    assert.equal(archivedListed?.archived, true);

    // 归档会改变 /api/tasks 的 revision：否则客户端拿着旧 revision 轮询会被回「unchanged」，
    // 归档会话永远挪不进归档区。
    const revisionPage = await (await fetch(`${base}/api/tasks?revision=stale-revision`)).json() as {
      unchanged: boolean;
      revision: string;
    };
    assert.equal(revisionPage.unchanged, false);
    const unchangedPage = await (await fetch(`${base}/api/tasks?revision=${encodeURIComponent(revisionPage.revision)}`)).json() as {
      unchanged: boolean;
    };
    assert.equal(unchangedPage.unchanged, true);

    const restored = await fetch(`${base}/api/sessions/${id}/unarchive`, { method: "POST" });
    assert.equal(restored.status, 200);
    const restoredBody = await restored.json() as { archived: boolean; archivedAt: string | null };
    assert.equal(restoredBody.archived, false);
    assert.equal(restoredBody.archivedAt, null);
    const restoredGroups = await (await fetch(`${base}/api/tasks`)).json() as typeof groups;
    assert.equal(restoredGroups.flatMap((group) => [
      ...group.standaloneSessions, ...group.tasks.flatMap((task) => task.sessions),
    ]).some((session) => session.id === id), true);

    assert.equal((await fetch(`${base}/api/sessions/missing/archive`, { method: "POST" })).status, 404);

    const batch = await fetch(`${base}/api/sessions/batch-archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionIds: [id, "missing"], archived: true }),
    });
    assert.equal(batch.status, 200);
    const batchBody = await batch.json() as { archived: number; failed?: string[] };
    assert.equal(batchBody.archived, 1);
    assert.deepEqual(batchBody.failed, ["missing"]);
    assert.equal(structured.get(id)?.archived, true);

    const empty = await fetch(`${base}/api/sessions/batch-archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionIds: [] }),
    });
    assert.equal(empty.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { processes.dispose(); } catch { /* ignore */ }
    try { structured.dispose(); } catch { /* ignore */ }
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

class FakePty extends EventEmitter {
  readonly pid = 4242;
  killed = false;
  onData(listener: (data: string) => void) {
    this.on("data", listener);
    return { dispose: () => this.off("data", listener) };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.on("exit", listener);
    return { dispose: () => this.off("exit", listener) };
  }
  write(): void {}
  resize(): void {}
  kill(): void { this.killed = true; this.emit("exit", { exitCode: 0 }); }
}

test("archiving a live PTY stops it and restoring relaunches the same session id", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pty-archive-"));
  const originalSpawn = (pty as unknown as { spawn: typeof pty.spawn }).spawn;
  const spawned: FakePty[] = [];
  (pty as unknown as { spawn: typeof pty.spawn }).spawn = () => {
    const next = new FakePty();
    spawned.push(next);
    return next as unknown as IPty;
  };
  t.after(() => {
    (pty as unknown as { spawn: typeof pty.spawn }).spawn = originalSpawn;
    rmSync(root, { recursive: true, force: true });
  });
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, processes, structured, storage, config.defaultMode, config, sessions);
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  try {
    const started = await processes.start("/bin/zsh", root, "default", undefined, { reuseId: "pty-1" });
    const record = (processes as unknown as { sessions: Map<string, { claudeSessionId: string | null; provider?: string; command: string }> }).sessions.get(started.id)!;
    record.provider = "pi";
    record.command = "pi";
    record.claudeSessionId = "11111111-1111-4111-8111-111111111111";
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const archived = await fetch(`${base}/api/sessions/${started.id}/archive`, { method: "POST" });
    assert.equal(archived.status, 200);
    const archivedBody = await archived.json() as { archived: boolean; status: string; id: string; claudeSessionId: string | null };
    assert.equal(archivedBody.archived, true);
    assert.equal(archivedBody.status, "stopped");
    assert.equal(archivedBody.id, "pty-1");
    assert.equal(archivedBody.claudeSessionId, "11111111-1111-4111-8111-111111111111");
    assert.equal(spawned[0]?.killed, true);

    const restored = await fetch(`${base}/api/sessions/${started.id}/unarchive`, { method: "POST" });
    assert.equal(restored.status, 200, await restored.clone().text());
    const restoredBody = await restored.json() as { id: string; archived: boolean; command: string; status: string };
    assert.equal(restoredBody.id, "pty-1");
    assert.equal(restoredBody.archived, false);
    assert.match(restoredBody.command, /11111111-1111-4111-8111-111111111111/);
    assert.equal(restoredBody.status, "running");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { processes.dispose(); } catch { /* ignore */ }
    try { structured.dispose(); } catch { /* ignore */ }
    storage.close();
  }
});
