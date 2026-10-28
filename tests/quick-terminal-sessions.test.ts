import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { defaultConfig } from "../src/config.js";
import { createApiScopeMiddleware, requiredApiScope } from "../src/middleware/api-scope.js";
import { ProcessManager } from "../src/process-manager.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { parseSessionCreationOrigin } from "../src/session-request.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { TerminalAttachResult, TerminalHost } from "../src/terminal-host.js";
import type { SessionSnapshot } from "../src/types.js";

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-quick-terminal-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const children = new Map<string, TerminalAttachResult>();
  let spawned = 0;
  let killed = 0;
  const host: TerminalHost = {
    persistent: true, attach: id => children.get(id) ?? null, forget() {}, disconnect() {},
    async createOrAttach(request) {
      spawned++;
      const child: TerminalAttachResult = {
        process: { sessionId: request.sessionId, incarnationId: request.sessionId, pid: 0,
          write() {}, resize() {}, kill() { killed++; },
          onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) },
        replay: [], isNew: true,
        state: { sessionId: request.sessionId, incarnationId: request.sessionId, pid: 0,
          status: "running", exitCode: null, cols: request.cols, rows: request.rows, seq: 0,
          output: "", chunks: [], terminalSnapshot: null, launchMarkerToken: null },
      };
      children.set(request.sessionId, child);
      return child;
    },
  };
  const processes = new ProcessManager(config, storage, root, host);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.principal = { kind: "connected-app", scopes: [req.header("x-test-scope") === "files" ? "files" : "sessions"] };
    next();
  });
  app.use("/api", createApiScopeMiddleware());
  registerSessionRoutes(app, { storage, processes, structured, sessions, config, defaultMode: config.defaultMode });
  registerWorkspaceRoutes(app, storage, sessions);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    processes.dispose(); structured.dispose(); storage.close(); rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (route: string, method = "GET", body?: unknown, scope = "sessions") => fetch(base + route, {
    method, headers: { "Content-Type": "application/json", "x-test-scope": scope },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const get = async (route: string) => {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    return response.json();
  };
  return { root, storage, config, host, processes, structured, sessions, request, get,
    spawned: () => spawned, killed: () => killed };
}

test("quick terminal creation is a bare PTY surface, never an Agent or automation disguise", async t => {
  const f = await fixture(t);
  for (const body of [
    { kind: "structured", provider: "pi" },
    { kind: "pty", command: "pi", provider: "pi" },
    { kind: "pty", shell: true, provider: "pi" },
    { kind: "pty", shell: true, automationId: "scheduled-task:fixture" },
  ]) {
    const rejected = await f.request("/api/sessions", "POST", { ...body, cwd: f.root, sessionSource: "quick-terminal" });
    assert.equal(rejected.status, 400, JSON.stringify(body));
  }
  assert.equal(f.spawned(), 0);
  assert.throws(() => parseSessionCreationOrigin({ sessionSource: "quick-terminal" }), /空白 PTY shell/,
    "provider-native resume routes cannot hide Agent work");
  const response = await f.request("/api/sessions", "POST", { kind: "pty", shell: true, cwd: f.root, sessionSource: "quick-terminal" });
  assert.equal(response.status, 201);
  const created = await response.json() as SessionSnapshot;
  assert.equal(created.sessionSource, "quick-terminal");
  assert.equal(created.provider, undefined);
  assert.equal(f.storage.getSession(created.id)?.sessionSource, "quick-terminal");
  assert.equal(f.sessions.get(created.id)?.status, "running");
  assert.ok(f.sessions.listSlim().some(s => s.id === created.id), "runtime inventory remains complete");
  assert.deepEqual(await f.get("/api/sessions"), []);
  assert.equal((await f.get(`/api/sessions/${created.id}`)).sessionSource, "quick-terminal");
  assert.equal(f.spawned(), 1);
  assert.equal(f.killed(), 0);
});

test("claiming an existing shell is idempotent, persistent, and updates the live checkpoint without restarting", async t => {
  const f = await fixture(t);
  const shell = await f.processes.startShell(f.root, "default");
  const route = `/api/sessions/${shell.id}/quick-terminal`;
  assert.equal(requiredApiScope(route), "sessions");
  assert.equal((await f.request(route, "PUT", {}, "files")).status, 403);
  assert.equal((await f.request("/api/sessions/missing/quick-terminal", "PUT")).status, 404);
  for (let index = 0; index < 2; index++) {
    const response = await f.request(route, "PUT");
    assert.equal(response.status, 200);
    const claimed = await response.json() as SessionSnapshot;
    assert.equal(claimed.id, shell.id);
    assert.equal(claimed.sessionSource, "quick-terminal");
    assert.equal(claimed.status, "running");
    assert.equal(claimed.startedAt, shell.startedAt);
  }
  assert.equal(f.processes.getOwned(shell.id)?.sessionSource, "quick-terminal");
  f.processes.setSessionTopic(shell.id, "Still the same shell", "Checkpoint after claim");
  assert.equal(f.storage.getSession(shell.id)?.sessionSource, "quick-terminal", "later live metadata must not restore interactive source");
  f.processes.dispose();
  const restored = new ProcessManager(f.config, f.storage, f.root, f.host);
  try {
    assert.equal(restored.getOwned(shell.id)?.sessionSource, "quick-terminal");
    assert.equal(restored.getOwned(shell.id)?.status, "running", "persistent terminal is reattached");
    assert.equal(f.spawned(), 1);
    assert.equal(f.killed(), 0);
  } finally { restored.dispose(); }
  for (const [id, patch] of Object.entries({
    agent: { provider: "pi", sessionKind: "structured" },
    provider: { provider: "claude" },
    automation: { automationId: "scheduled-task:fixture", sessionSource: "automation" },
    startup: { sessionSource: "startup" },
  })) {
    f.storage.saveSession({ ...shell, id, status: "exited", ...patch } as SessionSnapshot);
    assert.equal((await f.request(`/api/sessions/${id}/quick-terminal`, "PUT")).status, 400, id);
  }
});

test("all work-list projections omit quick terminals before pagination and counting, while preserving history", async t => {
  const f = await fixture(t);
  const workspace = f.storage.createWorkspace({ name: "Project", cwd: f.root });
  const task = f.storage.createWorkspaceTask({ workspaceId: workspace.id, name: "Task" });
  const base: SessionSnapshot = { id: "regular", sessionKind: "pty", command: "/bin/zsh", sessionSource: "interactive",
    cwd: f.root, workspaceId: workspace.id, mode: "default", status: "exited", exitCode: 0,
    startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T01:00:00.000Z", output: "retained shell history", archived: false };
  f.storage.saveSession(base);
  f.storage.saveSession({ ...base, id: "task-shell", workspaceTaskId: task.id, startedAt: "2026-10-27T00:00:00Z" });
  f.storage.saveSession({ ...base, id: "quick-only-dir", workspaceId: undefined, cwd: path.join(f.root, "quick-only"), sessionSource: "quick-terminal" });
  f.storage.saveSession({ ...base, id: "archived-quick", sessionSource: "quick-terminal", archived: true });
  const before = await f.get("/api/session-list");
  assert.equal((await f.request("/api/sessions/task-shell/quick-terminal", "PUT")).status, 200);
  const stored = f.storage.getSession("task-shell")!;
  assert.equal(stored.output, base.output);
  assert.equal(stored.workspaceTaskId, task.id);
  assert.equal(stored.archived, false);
  assert.equal((await f.get("/api/sessions/task-shell")).output, base.output);
  assert.deepEqual((await f.get("/api/sessions")).map((s: SessionSnapshot) => s.id), ["regular"]);
  const page = await f.get(`/api/session-list?limit=1&revision=${before.revision}`);
  assert.notEqual(page.revision, before.revision);
  assert.equal(page.total, 1);
  assert.deepEqual(page.entries.map((e: { session: SessionSnapshot }) => e.session.id), ["regular"]);
  assert.equal((await f.get("/api/session-directories")).totalSessions, 1);
  for (const query of ["", "?includeArchived=1"]) {
    const detail = await f.get(`/api/workspaces/${workspace.id}${query}`);
    assert.deepEqual(detail.sessions.map((s: SessionSnapshot) => s.id), ["regular"]);
    assert.equal(detail.sessionCount, 1);
    const projects = await f.get(`/api/workspaces${query}`);
    assert.equal(projects.find((w: { id: string }) => w.id === workspace.id).sessionCount, 1);
  }
  assert.deepEqual((await f.get(`/api/workspace-tasks/${task.id}`)).sessions, []);
  const groups = await f.get("/api/tasks?maxSessions=1&includeArchived=1");
  assert.deepEqual(groups.flatMap((g: { standaloneSessions: SessionSnapshot[] }) => g.standaloneSessions).map((s: SessionSnapshot) => s.id), ["regular"]);
  assert.equal(groups.some((g: { workspaceCwd: string }) => g.workspaceCwd.endsWith("quick-only")), false);
  const taskSummary = groups.flatMap((g: { tasks: { id: string; totalSessions: number; sessions: unknown[] }[] }) => g.tasks).find((x: { id: string }) => x.id === task.id);
  assert.equal(taskSummary.totalSessions, 0);
  assert.deepEqual(taskSummary.sessions, []);
  assert.equal(f.sessions.listSlim().length, 4, "management/runtime inventory retains hidden sessions");
  assert.equal(f.storage.countSessionsByWorkspace({ includeArchived: true }).get(workspace.id), 3);
  assert.equal(f.spawned(), 0);
  assert.equal(f.killed(), 0);
});
