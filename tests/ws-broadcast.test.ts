import assert from "node:assert/strict";
import test from "node:test";

import { WebSocket, type WebSocketServer } from "ws";

import type { ProcessEvent } from "../src/types.js";
import { WsBroadcastManager } from "../src/ws-broadcast.js";

type SendCallback = (error?: Error) => void;

class ControlledSocket {
  readyState = WebSocket.OPEN;
  readonly sent: string[] = [];
  readonly callbacks: SendCallback[] = [];
  terminated = false;

  send(message: string, callback?: SendCallback): void {
    this.sent.push(String(message));
    if (callback) this.callbacks.push(callback);
  }

  settleNext(error?: Error): void {
    const callback = this.callbacks.shift();
    assert.ok(callback, "expected a pending WebSocket send callback");
    callback(error);
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }
}

interface TestClient {
  ws: WebSocket;
  sendQueue: string[];
  sendInProgress: boolean;
  backpressurePaused: boolean;
  lastOutputBySession: Map<string, { output: string; messages?: string; timestamp: number }>;
  outputSeqBySession: Map<string, number>;
  pendingResyncSessions: Set<string>;
  blockBudget?: number;
  lastSeenAt: number;
  ptySubscriptions: Map<string, { supportsAck: boolean; unackedBytes: number; paused: boolean }>;
}

interface ManagerInternals {
  clients: Set<TestClient>;
  port?: {
    pausePtyOutput?(id: string): void;
    resumePtyOutput?(id: string): void;
  };
  broadcast(event: ProcessEvent): void;
  processWsQueue(client: TestClient): void;
  releasePtyPause(client: TestClient, sessionId: string): void;
}

function createHarness(): {
  manager: ManagerInternals;
  client: TestClient;
  socket: ControlledSocket;
} {
  const instance = new WsBroadcastManager({} as WebSocketServer);
  const manager = instance as unknown as ManagerInternals;
  const socket = new ControlledSocket();
  const client: TestClient = {
    ws: socket as unknown as WebSocket,
    sendQueue: [],
    sendInProgress: false,
    backpressurePaused: false,
    lastOutputBySession: new Map(),
    outputSeqBySession: new Map(),
    pendingResyncSessions: new Set(),
    lastSeenAt: Date.now(),
    ptySubscriptions: new Map(),
  };
  manager.clients.add(client);
  return { manager, client, socket };
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function drainAll(client: TestClient, socket: ControlledSocket): Promise<void> {
  for (let cycle = 0; cycle < 1_000; cycle += 1) {
    while (socket.callbacks.length > 0) socket.settleNext();
    await nextImmediate();
    if (!client.sendInProgress && client.sendQueue.length === 0 && socket.callbacks.length === 0) {
      return;
    }
  }
  assert.fail("WebSocket send queue did not drain");
}

test("high-water backpressure keeps draining and proactively emits resync_required", async () => {
  const { manager, client, socket } = createHarness();

  manager.broadcast({ type: "status", sessionId: "in-flight" });
  assert.equal(socket.callbacks.length, 1);

  for (let index = 0; index < 500; index += 1) {
    manager.broadcast({ type: "status", sessionId: `queued-${index}` });
  }
  assert.equal(client.sendQueue.length, 500);
  assert.equal(client.backpressurePaused, true);

  for (let index = 0; index < 1_000; index += 1) {
    manager.broadcast({ type: "status", sessionId: `dropped-${index}` });
  }
  manager.broadcast({
    type: "output",
    sessionId: "needs-resync",
    data: { chunk: "dropped output" },
  });

  assert.equal(client.sendQueue.length, 500, "paused business traffic must not grow the queue");
  assert.equal(client.pendingResyncSessions.has("needs-resync"), true);

  socket.settleNext();
  await drainAll(client, socket);

  assert.equal(client.backpressurePaused, false);
  assert.equal(client.pendingResyncSessions.size, 0);
  const sentMessages = socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
  assert.ok(sentMessages.some((message) => (
    message.type === "resync_required"
      && message.sessionId === "needs-resync"
      && message.reason === "backpressure_drop"
  )), "low-water recovery should send a resync notice without waiting for another business event");
  assert.equal(sentMessages.some((message) => message.sessionId === "dropped-999"), false);
});

test("a send callback error clears the queue even when a later callback succeeds", () => {
  const { manager, client, socket } = createHarness();
  client.sendQueue.push(...Array.from({ length: 9 }, (_, index) => `message-${index}`));

  manager.processWsQueue(client);

  assert.equal(socket.callbacks.length, 8);
  assert.equal(client.sendQueue.length, 1);
  socket.settleNext(new Error("socket write failed"));
  while (socket.callbacks.length > 0) socket.settleNext();

  assert.equal(client.sendInProgress, false);
  assert.equal(client.sendQueue.length, 0);
  assert.equal(manager.clients.has(client), false);
  assert.equal(socket.terminated, true);
});

test("raw PTY output is scoped to the subscribed session and pauses until acknowledged", () => {
  const first = createHarness();
  const secondSocket = new ControlledSocket();
  const secondClient: TestClient = {
    ...first.client,
    ws: secondSocket as unknown as WebSocket,
    sendQueue: [],
    lastOutputBySession: new Map(),
    outputSeqBySession: new Map(),
    pendingResyncSessions: new Set(),
    ptySubscriptions: new Map([["session-b", { supportsAck: true, unackedBytes: 0, paused: false }]]),
  };
  first.client.ptySubscriptions.set("session-a", { supportsAck: true, unackedBytes: 0, paused: false });
  first.manager.clients.add(secondClient);

  const paused: string[] = [];
  const resumed: string[] = [];
  first.manager.port = {
    pausePtyOutput: (id) => paused.push(id),
    resumePtyOutput: (id) => resumed.push(id),
  };
  const chunk = "x".repeat(513 * 1024);
  first.manager.broadcast({
    type: "output",
    sessionId: "session-a",
    data: { incremental: true, chunk },
  });

  assert.equal(first.socket.sent.length, 1);
  assert.equal(secondSocket.sent.length, 0, "a client must not receive another session's raw PTY bytes");
  const sent = JSON.parse(first.socket.sent[0]) as { ptyBytes: number; data: { chunk: string } };
  assert.equal(sent.ptyBytes, Buffer.byteLength(chunk));
  assert.equal(sent.data.chunk, chunk);
  assert.deepEqual(paused, ["session-a"]);

  const firstSubscription = first.client.ptySubscriptions.get("session-a");
  assert.ok(firstSubscription);
  firstSubscription.unackedBytes = 0;
  first.manager.releasePtyPause(first.client, "session-a");
  assert.deepEqual(resumed, ["session-a"]);
});

test("one client can receive raw PTY output from multiple subscribed panes", () => {
  const { manager, client, socket } = createHarness();
  client.ptySubscriptions.set("session-a", { supportsAck: true, unackedBytes: 0, paused: false });
  client.ptySubscriptions.set("session-b", { supportsAck: true, unackedBytes: 0, paused: false });

  manager.broadcast({
    type: "output",
    sessionId: "session-a",
    data: { incremental: true, chunk: "left" },
  });
  manager.broadcast({
    type: "output",
    sessionId: "session-b",
    data: { incremental: true, chunk: "right" },
  });

  assert.equal(socket.sent.length, 1, "the first message is in flight");
  assert.equal(client.sendQueue.length, 1, "the second subscribed pane remains queued on the same socket");
  assert.equal(client.ptySubscriptions.get("session-a")?.unackedBytes, 4);
  assert.equal(client.ptySubscriptions.get("session-b")?.unackedBytes, 5);
});

test("legacy PTY subscribers keep the bounded send queue", () => {
  const { manager, client } = createHarness();
  client.ptySubscriptions.set("session-a", { supportsAck: false, unackedBytes: 0, paused: false });

  for (let index = 0; index < 700; index += 1) {
    manager.broadcast({
      type: "output",
      sessionId: "session-a",
      data: { incremental: true, chunk: `chunk-${index}` },
    });
  }

  assert.equal(client.sendQueue.length, 500);
  assert.equal(client.backpressurePaused, true);
  assert.equal(client.pendingResyncSessions.has("session-a"), true);
  assert.equal(client.ptySubscriptions.get("session-a")?.unackedBytes, 0);
  assert.equal(client.ptySubscriptions.get("session-a")?.paused, false);
});

test("legacy PTY subscribers do not require acknowledgements", () => {
  const { manager, client, socket } = createHarness();
  client.ptySubscriptions.set("session-a", { supportsAck: false, unackedBytes: 0, paused: false });

  const paused: string[] = [];
  manager.port = {
    pausePtyOutput: (id) => paused.push(id),
  };
  const chunk = "x".repeat(513 * 1024);
  manager.broadcast({
    type: "output",
    sessionId: "session-a",
    data: { incremental: true, chunk },
  });

  assert.equal(socket.sent.length, 1);
  const sent = JSON.parse(socket.sent[0]) as { ptyBytes?: number; data: { chunk: string } };
  assert.equal(sent.ptyBytes, undefined);
  assert.equal(sent.data.chunk, chunk);
  assert.equal(client.ptySubscriptions.get("session-a")?.unackedBytes, 0);
  assert.deepEqual(paused, []);
});
