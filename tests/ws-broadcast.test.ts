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
}

interface ManagerInternals {
  clients: Set<TestClient>;
  broadcast(event: ProcessEvent): void;
  processWsQueue(client: TestClient): void;
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
