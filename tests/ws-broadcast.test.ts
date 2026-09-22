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
  outputSeqBySession: Map<string, number>;
  pendingResyncSessions: Set<string>;
  blockBudget?: number;
  lastSeenAt: number;
  ptySubscriptions: Map<string, { supportsAck: boolean; unackedBytes: number; degraded: boolean; lastResyncNoticeAt: number }>;
}

interface ManagerInternals {
  clients: Set<TestClient>;
  port?: Record<string, unknown>;
  emitEvent(event: ProcessEvent): void;
  broadcast(event: ProcessEvent): void;
  processWsQueue(client: TestClient): void;
  handlePtyAck(client: TestClient, sessionId: string, bytes: number): void;
  queueResyncNotice(client: TestClient, sessionId: string, reason: string): void;
}

/** 新订阅的默认形状（与原实现一致：ack 配额从 0 开始、未降级）。 */
function newSubscription(options: { supportsAck: boolean } = { supportsAck: true }) {
  return { supportsAck: options.supportsAck, unackedBytes: 0, degraded: false, lastResyncNoticeAt: 0 };
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
  assert.equal(
    sentMessages.some((message) => message.sessionId === "dropped-999" && message.type !== "resync_required"),
    false,
    "dropped status payloads must not be delivered after the high-water mark",
  );
  assert.ok(sentMessages.some((message) => (
    message.type === "resync_required"
      && message.sessionId === "dropped-999"
      && message.reason === "backpressure_drop"
  )), "dropped non-output events must still request a snapshot resync");
});

test("dropped ended and status events also enqueue resync_required", async () => {
  const { manager, client, socket } = createHarness();

  manager.broadcast({ type: "status", sessionId: "in-flight" });
  for (let index = 0; index < 500; index += 1) {
    manager.broadcast({ type: "status", sessionId: `queued-${index}` });
  }
  assert.equal(client.backpressurePaused, true);

  manager.broadcast({ type: "ended", sessionId: "turn-finished" });
  manager.broadcast({ type: "status", sessionId: "turn-finished", data: { inFlight: false } });
  assert.equal(client.pendingResyncSessions.has("turn-finished"), true);
  assert.equal(client.sendQueue.length, 500, "ended/status drops must not grow the paused queue");

  socket.settleNext();
  await drainAll(client, socket);

  const sentMessages = socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
  assert.ok(sentMessages.some((message) => (
    message.type === "resync_required"
      && message.sessionId === "turn-finished"
      && message.reason === "backpressure_drop"
  )), "dropping ended/status under backpressure must still request a snapshot resync");
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

test("raw PTY output is scoped to the subscribed session", () => {
  const first = createHarness();
  const secondSocket = new ControlledSocket();
  const secondClient: TestClient = {
    ...first.client,
    ws: secondSocket as unknown as WebSocket,
    sendQueue: [],
    outputSeqBySession: new Map(),
    pendingResyncSessions: new Set(),
    ptySubscriptions: new Map([["session-b", newSubscription()]]),
  };
  first.client.ptySubscriptions.set("session-a", newSubscription());
  first.manager.clients.add(secondClient);

  const chunk = "x".repeat(4 * 1024);
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
});

// 回归：以前任何客户端停止 ack（手机切后台 / WebView 被节流 / 标签页休眠）都会让服务端
// 调用 pausePtyOutput，把「服务端读 daemon」整条暂停——整个会话对所有客户端冻结，连
// 会话日志和落库也一起停，而且只靠那个客户端回来 ack 才恢复（它不回来就永久冻住）。
// 现在改成：只对积压的这一个客户端降级（丢掉过期 TUI 帧），它追上来再用终端快照重建。
test("一个停止 ack 的客户端只降级自己，既不冻结会话也不影响健康客户端", () => {
  const healthy = createHarness();
  const zombieSocket = new ControlledSocket();
  const zombie: TestClient = {
    ...healthy.client,
    ws: zombieSocket as unknown as WebSocket,
    sendQueue: [],
    outputSeqBySession: new Map(),
    pendingResyncSessions: new Set(),
    ptySubscriptions: new Map([["session-a", newSubscription()]]),
  };
  healthy.client.ptySubscriptions.set("session-a", newSubscription());
  healthy.manager.clients.add(zombie);

  const chunk = "y".repeat(128 * 1024);
  // 健康客户端每帧都 ack（= 手机在前台正常渲染）；僵尸客户端一路不 ack。
  for (let index = 0; index < 6; index += 1) {
    healthy.manager.broadcast({ type: "output", sessionId: "session-a", data: { incremental: true, chunk } });
    healthy.manager.handlePtyAck(healthy.client, "session-a", chunk.length);
  }

  const zombieSub = zombie.ptySubscriptions.get("session-a");
  assert.ok(zombieSub);
  assert.equal(zombieSub.degraded, true, "累计超过 512KB 未确认后只把它这一个客户端标成降级");
  assert.equal(
    zombie.sendQueue.length + zombieSocket.sent.length,
    4,
    "降级后不再给积压客户端排队原始分片（前 4 个 128KB 分片已发满 512KB 高水位，第 5、6 帧被丢弃）",
  );
  assert.equal(
    healthy.client.sendQueue.length + healthy.socket.sent.length,
    6,
    "健康客户端必须继续收到每一帧：慢客户端不再拖住整个会话",
  );

  // 僵尸追上来（ack 到低水位）：只给它自己一条重建通知。
  healthy.manager.handlePtyAck(zombie, "session-a", 6 * 128 * 1024);
  assert.equal(zombieSub.degraded, false);
  const notices = zombieSocket.sent
    .concat(zombie.sendQueue)
    .map((message) => JSON.parse(message) as Record<string, unknown>)
    .filter((message) => message.type === "resync_required");
  assert.equal(notices.length, 1, "追上来后只发一次重建通知");
  assert.equal(notices[0].sessionId, "session-a");
  assert.equal(notices[0].reason, "pty_backlog_drop");

  // 紧接着再来一轮积压：限流窗口内不重复下发重建通知。
  for (let index = 0; index < 6; index += 1) {
    healthy.manager.broadcast({ type: "output", sessionId: "session-a", data: { incremental: true, chunk } });
    healthy.manager.handlePtyAck(healthy.client, "session-a", chunk.length);
  }
  healthy.manager.handlePtyAck(zombie, "session-a", 6 * 128 * 1024);
  const afterSecondRound = zombieSocket.sent
    .concat(zombie.sendQueue)
    .map((message) => JSON.parse(message) as Record<string, unknown>)
    .filter((message) => message.type === "resync_required");
  assert.equal(afterSecondRound.length, 1, "重建通知有最小间隔，避免慢性慢客户端来回重建");
});

test("one client can receive raw PTY output from multiple subscribed panes", () => {
  const { manager, client, socket } = createHarness();
  client.ptySubscriptions.set("session-a", newSubscription());
  client.ptySubscriptions.set("session-b", newSubscription());

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
  client.ptySubscriptions.set("session-a", newSubscription({ supportsAck: false }));

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
  assert.equal(client.ptySubscriptions.get("session-a")?.degraded, false);
});

test("legacy PTY subscribers do not require acknowledgements", () => {
  const { manager, client, socket } = createHarness();
  client.ptySubscriptions.set("session-a", newSubscription({ supportsAck: false }));

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
});

function waitForOutputDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

test("session topic output is not merged into raw PTY chunks", async () => {
  const { manager, client, socket } = createHarness();
  client.ptySubscriptions.set("session-a", newSubscription({ supportsAck: false }));

  manager.emitEvent({
    type: "output",
    sessionId: "session-a",
    data: { title: "修侧栏标题", description: "把命令总结写进终端标题" },
  });
  manager.emitEvent({
    type: "output",
    sessionId: "session-a",
    data: { incremental: true, chunk: "echo" },
  });
  await waitForOutputDebounce();
  await drainAll(client, socket);

  const sent = socket.sent.map((message) => JSON.parse(message) as {
    type: string;
    data?: { title?: string; chunk?: string };
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].data?.title, "修侧栏标题");
  assert.equal(sent[0].data?.chunk, undefined);
  assert.equal(sent[1].data?.chunk, "echo");
  assert.equal(sent[1].data?.title, undefined);
});

test("session topic status flushes pending PTY bytes before the new title", async () => {
  const { manager, client, socket } = createHarness();
  client.ptySubscriptions.set("session-a", newSubscription({ supportsAck: false }));

  manager.emitEvent({
    type: "output",
    sessionId: "session-a",
    data: { incremental: true, chunk: "prompt" },
  });
  manager.emitEvent({
    type: "status",
    sessionId: "session-a",
    data: { title: "修侧栏标题", description: "把命令总结写进终端标题" },
  });
  await drainAll(client, socket);

  const sent = socket.sent.map((message) => JSON.parse(message) as {
    type: string;
    data?: { title?: string; chunk?: string };
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, "output");
  assert.equal(sent[0].data?.chunk, "prompt");
  assert.equal(sent[1].type, "status");
  assert.equal(sent[1].data?.title, "修侧栏标题");
});
