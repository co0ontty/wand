import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { type TestContext } from "node:test";

import pty, { type IPty } from "node-pty";
import { WebSocket, type WebSocketServer } from "ws";

import { defaultConfig } from "../src/config.js";
import { ProcessManager } from "../src/process-manager.js";
import { startServer } from "../src/server.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { SessionSnapshot } from "../src/types.js";
import { WsBroadcastManager } from "../src/ws-broadcast.js";

class MemoryStorage {
  readonly sessions = new Map<string, SessionSnapshot>();

  loadSessions(): SessionSnapshot[] {
    return Array.from(this.sessions.values());
  }

  getSession(id: string): SessionSnapshot | null {
    return this.sessions.get(id) ?? null;
  }

  saveSession(snapshot: SessionSnapshot): void {
    this.sessions.set(snapshot.id, structuredClone(snapshot));
  }

  saveSessionMetadata(snapshot: SessionSnapshot): void {
    this.updateSessionRuntimeMetadata(snapshot);
  }

  updateSessionRuntimeMetadata(snapshot: SessionSnapshot): void {
    const current = this.sessions.get(snapshot.id);
    this.saveSession({ ...snapshot, output: current?.output ?? snapshot.output, messages: current?.messages });
  }

  checkpointSessionOutput(id: string, output: string): void {
    const current = this.sessions.get(id);
    if (current) this.saveSession({ ...current, output });
  }

  checkpointSessionMessages(
    id: string,
    messages: NonNullable<SessionSnapshot["messages"]>,
    structuredState?: SessionSnapshot["structuredState"] | null,
    output?: string,
  ): void {
    const current = this.sessions.get(id);
    if (!current) return;
    this.saveSession({
      ...current,
      messages,
      ...(structuredState !== undefined ? { structuredState: structuredState ?? undefined } : {}),
      ...(output !== undefined ? { output } : {}),
    });
  }

  deleteSession(id: string): void {
    this.sessions.delete(id);
  }
}

class FakePty {
  readonly process = "fake";
  readonly handleFlowControl = false;
  readonly pid = 4242;
  killed = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(): void {}
  resize(): void {}
  clear(): void {}
  pause(): void {}
  resume(): void {}

  kill(): void {
    this.killed = true;
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

class DeferredSdkQuery {
  interruptCalls = 0;
  private finished = false;
  private wake: (() => void) | null = null;

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  finish(): void {
    this.finished = true;
    this.wake?.();
    this.wake = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<never> {
    while (!this.finished) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("ProcessManager dispose clears timers, kills PTYs, flushes, and rejects new work", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-process-lifecycle-"));
  const originalSpawn = (pty as unknown as { spawn: typeof pty.spawn }).spawn;
  const fakePty = new FakePty();
  (pty as unknown as { spawn: typeof pty.spawn }).spawn = () => fakePty as unknown as IPty;
  t.after(() => {
    (pty as unknown as { spawn: typeof pty.spawn }).spawn = originalSpawn;
    rmSync(root, { recursive: true, force: true });
  });

  const storage = new MemoryStorage();
  const manager = new ProcessManager(
    { ...defaultConfig(), defaultCwd: root, startupCommands: [] },
    storage as unknown as WandStorage,
    path.join(root, ".wand"),
  );
  const started = manager.start("opencode", root, "default", undefined, {
    provider: "opencode",
    reuseId: "active-pty",
  });
  fakePty.emitData("pending output");

  const internals = manager as unknown as {
    archiveTimer: NodeJS.Timeout | null;
    persistDebounceTimers: Map<string, NodeJS.Timeout>;
    sessions: Map<string, {
      initialInputTimer?: NodeJS.Timeout | null;
      claudeTaskDiscoveryTimer?: NodeJS.Timeout | null;
      codexSessionDiscoveryTimer?: NodeJS.Timeout | null;
    }>;
  };
  const record = internals.sessions.get(started.id)!;
  record.initialInputTimer = setTimeout(() => {}, 60_000);
  record.claudeTaskDiscoveryTimer = setTimeout(() => {}, 60_000);
  record.codexSessionDiscoveryTimer = setTimeout(() => {}, 60_000);
  record.initialInputTimer.unref?.();
  record.claudeTaskDiscoveryTimer.unref?.();
  record.codexSessionDiscoveryTimer.unref?.();
  assert.equal(internals.persistDebounceTimers.size, 1);

  manager.dispose();
  manager.dispose();

  assert.equal(fakePty.killed, true);
  assert.equal(manager.get(started.id)?.status, "stopped");
  assert.equal(storage.getSession(started.id)?.status, "stopped");
  assert.equal(internals.archiveTimer, null);
  assert.equal(internals.persistDebounceTimers.size, 0);
  assert.equal(record.initialInputTimer, null);
  assert.equal(record.claudeTaskDiscoveryTimer, null);
  assert.equal(record.codexSessionDiscoveryTimer, null);
  assert.throws(() => manager.start("opencode", root, "default"), /disposed/);
  assert.throws(() => manager.sendInput(started.id, "late input"), /disposed/);
});

test("StructuredSessionManager dispose aborts active SDK work and clears timers", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-lifecycle-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const queries: DeferredSdkQuery[] = [];
  const sdkFactory = (() => {
    const query = new DeferredSdkQuery();
    queries.push(query);
    return query;
  }) as unknown as ConstructorParameters<typeof StructuredSessionManager>[3];
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" },
    null,
    sdkFactory,
  );
  t.after(() => {
    for (const query of queries) query.finish();
    try { storage.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
  });

  const session = manager.createSession({
    cwd: root,
    mode: "assist",
    provider: "claude",
    runner: "claude-sdk",
  });
  manager.setSessionTopic(session.id, "Lifecycle", "Lifecycle test");
  const run = manager.sendMessage(session.id, "keep running");
  await waitFor(() => queries.length === 1, "SDK query did not start");

  const internals = manager as unknown as {
    archiveTimer: NodeJS.Timeout | null;
    streamEmitTimers: Set<NodeJS.Timeout>;
    pendingSdkQueries: Map<string, unknown>;
    pendingSdkAbort: Map<string, AbortController>;
  };
  const deferredTimer = setTimeout(() => {}, 60_000);
  deferredTimer.unref?.();
  internals.streamEmitTimers.add(deferredTimer);

  manager.dispose();
  manager.dispose();

  assert.equal(queries[0].interruptCalls, 1);
  assert.equal(internals.archiveTimer, null);
  assert.equal(internals.streamEmitTimers.size, 0);
  assert.equal(internals.pendingSdkQueries.size, 0);
  assert.equal(internals.pendingSdkAbort.size, 0);
  assert.equal(manager.get(session.id)?.status, "idle");
  assert.equal(manager.get(session.id)?.structuredState?.inFlight, false);
  assert.throws(() => manager.createSession({ cwd: root, mode: "assist" }), /disposed/);
  await assert.rejects(() => manager.sendMessage(session.id, "late"), /disposed/);

  // Match server shutdown ordering: storage closes immediately after dispose,
  // then the aborted SDK iterator is allowed to unwind its late callbacks.
  storage.close();
  queries[0].finish();
  await run;
  const reopened = new WandStorage(path.join(root, "wand.db"));
  assert.equal(reopened.getSession(session.id)?.structuredState?.inFlight, false);
  reopened.close();
});

test("WsBroadcastManager dispose clears heartbeat/output timers and terminates clients", async () => {
  const wss = new EventEmitter() as unknown as WebSocketServer;
  const manager = new WsBroadcastManager(wss);
  manager.setup(() => null);

  const socket = {
    readyState: WebSocket.OPEN,
    terminated: false,
    send(): void {},
    terminate(): void {
      this.terminated = true;
      this.readyState = WebSocket.CLOSED;
    },
  };
  const internals = manager as unknown as {
    clients: Set<Record<string, unknown>>;
    outputDebounceCache: Map<string, unknown>;
    heartbeatTimer?: NodeJS.Timeout;
  };
  internals.clients.add({
    ws: socket,
    sendQueue: [],
    sendInProgress: false,
    backpressurePaused: false,
    lastOutputBySession: new Map(),
    outputSeqBySession: new Map(),
    pendingResyncSessions: new Set(),
    lastSeenAt: Date.now(),
  });
  manager.emitEvent({ type: "output", sessionId: "deferred", data: { chunk: "never sent" } });
  assert.equal(internals.outputDebounceCache.size, 1);
  assert.ok(internals.heartbeatTimer);

  manager.dispose();
  manager.dispose();

  assert.equal(socket.terminated, true);
  assert.equal(internals.clients.size, 0);
  assert.equal(internals.outputDebounceCache.size, 0);
  assert.equal(internals.heartbeatTimer, undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(internals.outputDebounceCache.size, 0);
});

test("ServerHandle close is idempotent, disposes managers, and detaches auth storage", async (t) => {
  const previousTestMode = process.env.WAND_TEST_MODE;
  process.env.WAND_TEST_MODE = "1";
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-server-lifecycle-"));
  t.after(() => {
    if (previousTestMode === undefined) delete process.env.WAND_TEST_MODE;
    else process.env.WAND_TEST_MODE = previousTestMode;
    rmSync(root, { recursive: true, force: true });
  });

  const handle = await startServer({
    ...defaultConfig(),
    host: "127.0.0.1",
    port: 0,
    https: false,
    startupCommands: [],
  }, path.join(root, "config.json"));
  const token = handle.authService.createSession();

  const firstClose = handle.close();
  const secondClose = handle.close();
  assert.equal(firstClose, secondClose);
  await firstClose;

  assert.doesNotThrow(() => handle.authService.revokeSession(token));
  assert.equal(handle.authService.validateSession(token), false);
  assert.throws(
    () => handle.processManager.start("opencode", root, "default"),
    /disposed/,
  );
  assert.throws(
    () => handle.structuredSessions.createSession({ cwd: root, mode: "assist" }),
    /disposed/,
  );
});
