import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { defaultConfig } from "../src/config.js";
import { ProcessManager } from "../src/process-manager.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { SessionCompletionTracker } from "../src/session-completion.js";
import { SessionRegistry } from "../src/session-registry.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { SessionSnapshot } from "../src/types.js";
import { filterActiveGroups } from "../src/web-ui/react/workspaces/sidebar-display-mode.js";
import type { TaskDirectoryGroup } from "../src/web-ui/react/workspaces/types.js";

test("foreground activity survives both HTTP projections and invalidates revisions without persisting a turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-pty-command-projection-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const registry = new SessionRegistry(processes, structured, storage);
  const workspace = storage.createWorkspace({ name: "Foreground fixture", cwd: root });
  const task = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "Silent command" });
  let live: SessionSnapshot = {
    id: "manual-command", sessionKind: "pty", runner: "pty", command: "/bin/zsh", title: "Manual command",
    cwd: root, mode: "default", status: "running", exitCode: null, output: "", messages: [],
    startedAt: new Date().toISOString(), endedAt: null, providerCliActive: false,
    ptyBusy: false, ptyCommandRunning: false, workspaceId: workspace.id, workspaceTaskId: task.id,
  };
  storage.saveSession(live);
  // Only the running process is a fixture: real registry, storage, DTOs, HTTP routes and client filter.
  processes.getOwned = (id) => id === live.id ? live : null;
  processes.listSlim = () => [live];
  const completions = new SessionCompletionTracker(storage, (id) => registry.getLatest(id));
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, processes, structured, storage, config.defaultMode, config, registry);
  registerWorkspaceRoutes(app, storage, registry);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (path: string) => {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      return response.json();
    };
    type TaskPage = { unchanged?: boolean; revision: string; groups: TaskDirectoryGroup[] };
    const before = await get("/api/tasks?revision=initial") as TaskPage;
    const sessionsBefore = await get("/api/session-list");
    assert.deepEqual(filterActiveGroups(before.groups), []);
    assert.equal((await get(`/api/tasks?revision=${before.revision}`)).unchanged, true);
    assert.equal((await get(`/api/session-list?revision=${sessionsBefore.revision}`)).unchanged, true);

    live = { ...live, ptyCommandRunning: true };
    completions.ingest({ type: "status", sessionId: live.id, data: { ptyCommandRunning: true } });
    const running = await get(`/api/tasks?revision=${before.revision}`) as TaskPage;
    const sessionsRunning = await get(`/api/session-list?revision=${sessionsBefore.revision}`);
    assert.equal(running.unchanged, false);
    assert.notEqual(running.revision, before.revision);
    assert.notEqual(sessionsRunning.revision, sessionsBefore.revision);
    assert.equal(sessionsRunning.entries[0].session.ptyCommandRunning, true);
    assert.deepEqual(filterActiveGroups(running.groups)[0].tasks[0].sessions.map((s) => s.id), [live.id]);
    assert.equal((await get(`/api/workspaces/${workspace.id}`)).sessions[0].ptyCommandRunning, true);
    assert.equal((await get(`/api/workspace-tasks/${task.id}`)).sessions[0].ptyCommandRunning, true);
    assert.equal((await get("/api/sessions"))[0].ptyCommandRunning, true);
    assert.equal((await get(`/api/sessions/${live.id}`)).ptyCommandRunning, true);

    storage.saveSession(live);
    assert.equal(storage.getSession(live.id)?.ptyCommandRunning, undefined, "foreground samples are runtime-only");
    assert.equal(registry.getLatest(live.id)?.ptyBusy, false);
    assert.equal(registry.getLatest(live.id)?.ptyTurnStartedAt, undefined);
    live = { ...live, ptyCommandRunning: false };
    completions.ingest({ type: "status", sessionId: live.id, data: { ptyCommandRunning: false } });
    const finished = await get(`/api/tasks?revision=${running.revision}`) as TaskPage;
    assert.equal(finished.unchanged, false);
    assert.deepEqual(filterActiveGroups(finished.groups), []);
    assert.notEqual((await get(`/api/session-list?revision=${sessionsRunning.revision}`)).revision, sessionsRunning.revision);
    assert.equal(storage.getSessionCompletion(live.id)?.completionRevision ?? 0, 0, "foreground transitions are not a successful AI turn");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    processes.dispose(); structured.dispose(); storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
