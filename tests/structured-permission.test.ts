import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import express from "express";

import type { Options as SdkOptions, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import { defaultConfig } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { ProcessManager } from "../src/process-manager.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { inferStructuredEscalation } from "../src/structured-permission.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";

class PermissionSdkQuery {
  interruptCalls = 0;
  results: PermissionResult[] = [];
  private done = false;
  private wake: (() => void) | null = null;
  readonly options: SdkOptions;
  private readonly calls: Array<{ toolName: string; input: Record<string, unknown>; toolUseID: string }>;

  constructor(
    options: SdkOptions,
    calls: Array<{ toolName: string; input: Record<string, unknown>; toolUseID: string }>,
  ) {
    this.options = options;
    this.calls = calls;
  }

  async interrupt(): Promise<void> {
    this.interruptCalls++;
    this.finish();
  }

  finish(): void {
    this.done = true;
    this.wake?.();
    this.wake = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<never> {
    const signal = this.options.abortController?.signal;
    if (this.options.canUseTool) {
      for (const call of this.calls) {
        if (signal?.aborted) break;
        this.results.push(await this.options.canUseTool(call.toolName, call.input, {
          signal: signal ?? new AbortController().signal,
          toolUseID: call.toolUseID,
        }));
      }
    }
    while (!this.done && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function createPermissionHarness(
  t: TestContext,
  calls: Array<{ toolName: string; input: Record<string, unknown>; toolUseID: string }> = [
    { toolName: "Edit", input: { file_path: "/tmp/test.txt" }, toolUseID: "tool-edit-1" },
  ],
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-permission-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const queries: PermissionSdkQuery[] = [];
  const sdkQueryFactory = ((args: { options: SdkOptions }) => {
    const query = new PermissionSdkQuery(args.options, calls);
    queries.push(query);
    return query;
  }) as unknown as ConstructorParameters<typeof StructuredSessionManager>[3];
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" },
    null,
    sdkQueryFactory,
  );
  const session = manager.createSession({
    cwd: root,
    mode: "default",
    provider: "claude",
    runner: "claude-sdk",
  });

  t.after(() => {
    for (const query of queries) query.finish();
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { manager, queries, session };
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

test("SDK canUseTool prompts, approve_once allows the tool, and streaming does not drop pending", async (t) => {
  const { manager, queries, session } = createPermissionHarness(t);
  const events: Array<{ type: string; data?: { permissionBlocked?: boolean } }> = [];
  manager.setEventEmitter((event) => {
    events.push({ type: event.type, data: event.data as { permissionBlocked?: boolean } });
  });

  const sendPromise = manager.sendMessage(session.id, "edit the file");
  await waitFor(() => manager.get(session.id)?.pendingEscalation != null, "expected permission prompt");
  const pending = manager.get(session.id)?.pendingEscalation;
  assert.equal(pending?.scope, "write_file");
  assert.equal(pending?.target, "/tmp/test.txt");
  assert.equal(pending?.runner, "json");
  assert.equal(manager.get(session.id)?.permissionBlocked, true);
  assert.equal(manager.get(session.id)?.structuredState?.inFlight, true);
  assert.ok(events.some((event) => event.type === "status" && event.data?.permissionBlocked === true));

  const approved = manager.approvePermission(session.id);
  assert.equal(approved.pendingEscalation, null);
  assert.equal(approved.permissionBlocked, false);
  await waitFor(() => queries[0]?.results.length === 1, "canUseTool should settle");
  assert.equal(queries[0].results[0]?.behavior, "allow");

  queries[0].finish();
  await sendPromise;
  assert.equal(manager.get(session.id)?.pendingEscalation, null);
});

test("SDK canUseTool deny returns a deny result without hanging the turn", async (t) => {
  const { manager, queries, session } = createPermissionHarness(t);
  const sendPromise = manager.sendMessage(session.id, "edit the file");
  await waitFor(() => manager.get(session.id)?.pendingEscalation != null, "expected permission prompt");
  const requestId = manager.get(session.id)?.pendingEscalation?.requestId;
  assert.ok(requestId);
  manager.resolveEscalation(session.id, requestId!, "deny");
  await waitFor(() => queries[0]?.results.length === 1, "canUseTool should settle");
  assert.equal(queries[0].results[0]?.behavior, "deny");
  queries[0].finish();
  await sendPromise;
});

test("approve_turn remembers the scope for later tools in the same SDK turn", async (t) => {
  const { manager, queries, session } = createPermissionHarness(t, [
    { toolName: "Edit", input: { file_path: "/tmp/a.txt" }, toolUseID: "tool-a" },
    { toolName: "Edit", input: { file_path: "/tmp/b.txt" }, toolUseID: "tool-b" },
  ]);
  const sendPromise = manager.sendMessage(session.id, "edit both files");
  await waitFor(() => manager.get(session.id)?.pendingEscalation != null, "expected first prompt");
  const firstId = manager.get(session.id)?.pendingEscalation?.requestId;
  assert.ok(firstId);
  manager.resolveEscalation(session.id, firstId!, "approve_turn");
  await waitFor(() => queries[0]?.results.length === 2, "second tool should auto-allow");
  assert.equal(queries[0].results[0]?.behavior, "allow");
  assert.equal(queries[0].results[1]?.behavior, "allow");
  assert.equal(manager.get(session.id)?.pendingEscalation, null);
  queries[0].finish();
  await sendPromise;
});

test("stop unblocks a waiting canUseTool promise", async (t) => {
  const { manager, session } = createPermissionHarness(t);
  const sendPromise = manager.sendMessage(session.id, "edit the file");
  await waitFor(() => manager.get(session.id)?.pendingEscalation != null, "expected permission prompt");
  const stopped = manager.stop(session.id);
  assert.equal(stopped.pendingEscalation, null);
  assert.equal(stopped.permissionBlocked, false);
  await sendPromise;
  assert.equal(manager.get(session.id)?.pendingEscalation, null);
});

test("structured permission HTTP routes no longer 404 and resolve a pending SDK prompt", async (t) => {
  const { manager, queries, session } = createPermissionHarness(t);
  const root = session.cwd;
  const storage = new WandStorage(path.join(root, "wand-http.db"));
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
    storage.close();
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const missing = await fetch(`${baseUrl}/api/sessions/${session.id}/approve-permission`, { method: "POST" });
  assert.equal(missing.status, 400);

  const toggled = await fetch(`${baseUrl}/api/sessions/${session.id}/toggle-auto-approve`, { method: "POST" });
  assert.equal(toggled.status, 200);
  await fetch(`${baseUrl}/api/sessions/${session.id}/toggle-auto-approve`, { method: "POST" });

  const sendPromise = manager.sendMessage(session.id, "edit the file");
  await waitFor(() => manager.get(session.id)?.pendingEscalation != null, "expected permission prompt");
  const approved = await fetch(`${baseUrl}/api/sessions/${session.id}/approve-permission`, { method: "POST" });
  assert.equal(approved.status, 200);
  const body = await approved.json() as { pendingEscalation: null; permissionBlocked: boolean };
  assert.equal(body.pendingEscalation, null);
  assert.equal(body.permissionBlocked, false);
  await waitFor(() => queries[0]?.results[0]?.behavior === "allow", "HTTP approve should settle canUseTool");
  queries[0].finish();
  await sendPromise;
});
