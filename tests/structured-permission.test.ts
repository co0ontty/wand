import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import express from "express";

import { defaultConfig } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { ProcessManager } from "../src/process-manager.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { inferStructuredEscalation } from "../src/structured-permission.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";
import type { SessionSnapshot } from "../src/types.js";

const PENDING_ESCALATION = {
  requestId: "request-1",
  scope: "write_file" as const,
  runner: "json" as const,
  source: "tool_permission_request" as const,
  target: "/tmp/test.txt",
  reason: "Claude wants to edit test.txt",
};

function createHarness(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-permission-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root },
  );
  const session = manager.createSession({
    cwd: root,
    mode: "default",
    provider: "claude",
    runner: "claude-cli-print",
  });
  t.after(() => {
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, storage, manager, session };
}

/** 直接把一条待授权请求挂到会话上：审批链路只剩「已有 pending → 客户端裁决」这一段。 */
function blockOnEscalation(manager: StructuredSessionManager, sessionId: string): SessionSnapshot {
  const internal = manager as unknown as { sessions: Map<string, SessionSnapshot> };
  const blocked: SessionSnapshot = {
    ...internal.sessions.get(sessionId)!,
    status: "running",
    permissionBlocked: true,
    pendingEscalation: { ...PENDING_ESCALATION },
  };
  internal.sessions.set(sessionId, blocked);
  return blocked;
}

test("inferStructuredEscalation maps tool input onto escalation scope", () => {
  assert.deepEqual(
    inferStructuredEscalation("Edit", { file_path: "/tmp/a.txt" }, { title: "Claude wants to edit a.txt" }),
    { scope: "write_file", target: "/tmp/a.txt", reason: "Claude wants to edit a.txt" },
  );
  assert.equal(inferStructuredEscalation("Bash", { command: "ls" }).scope, "run_command");
  assert.equal(inferStructuredEscalation("Bash", { command: "sudo rm -rf /" }).scope, "dangerous_shell");
  assert.equal(inferStructuredEscalation("WebFetch", { url: "https://example.com" }).scope, "network");
  assert.equal(
    inferStructuredEscalation("SomeTool", {}, { blockedPath: "/etc/passwd" }).scope,
    "outside_workspace",
  );
});

test("approve-permission resolves a pending escalation and validates the request", async (t) => {
  const { storage, manager, session } = createHarness(t);
  const root = session.cwd;
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const sessions = new SessionRegistry(processes, manager, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, processes, manager, storage, config.defaultMode, config, sessions);
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    processes.dispose?.();
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const missing = await fetch(`${baseUrl}/api/sessions/${session.id}/approve-permission`, { method: "POST" });
  assert.equal(missing.status, 400);

  const toggled = await fetch(`${baseUrl}/api/sessions/${session.id}/toggle-auto-approve`, { method: "POST" });
  assert.equal(toggled.status, 200);
  await fetch(`${baseUrl}/api/sessions/${session.id}/toggle-auto-approve`, { method: "POST" });

  blockOnEscalation(manager, session.id);

  const approved = await fetch(`${baseUrl}/api/sessions/${session.id}/approve-permission`, { method: "POST" });
  assert.equal(approved.status, 200);
  const body = await approved.json() as { pendingEscalation: null; permissionBlocked: boolean };
  assert.equal(body.pendingEscalation, null);
  assert.equal(body.permissionBlocked, false);
  assert.equal(manager.get(session.id)?.pendingEscalation, null);
  assert.equal(manager.get(session.id)?.approvalStats?.file, 1);
});

test("stop clears a pending escalation and returns the session to idle", (t) => {
  const { manager, session } = createHarness(t);
  blockOnEscalation(manager, session.id);

  const stopped = manager.stop(session.id);
  assert.equal(stopped.status, "idle");
  assert.equal(stopped.pendingEscalation, null);
  assert.equal(stopped.permissionBlocked, false);
  assert.equal(stopped.structuredState?.inFlight, false);
});
