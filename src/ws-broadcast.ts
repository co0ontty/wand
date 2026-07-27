/**
 * WebSocket broadcast manager for process events.
 * Handles debounced output events, backpressure control, and client subscriptions.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { CardExpandDefaults, ConversationTurn, SessionSnapshot, ProcessEvent } from "./types.js";
import { readSessionCookie, type AuthService } from "./auth.js";
import { blockWindowMessagesForTransport, windowMessagesForTransport } from "./message-truncator.js";
import { boundSessionEventData, toSessionDetailDTO } from "./session-transport.js";
import { enrichStructuredMessages } from "./structured-client-protocol.js";

export type { ProcessEvent } from "./types.js";

// ── Constants ──

const MAX_QUEUE_SIZE = 500;
const QUEUE_RESUME_SIZE = Math.floor(MAX_QUEUE_SIZE * 0.8);
const SEND_BATCH_SIZE = 8;
const MAX_BLOCK_BUDGET = 2_000;
const OUTPUT_DEBOUNCE_MS = 16;
/**
 * 服务端心跳节奏。20s 一次，比常见 NAT/代理空闲超时（30~60s）更短，可以保活；
 * 也不至于让 idle 连接每秒都在跑 timer。前后端在心跳间窗内任何方向消息都会
 * 重置"上次见到"计时。
 */
const HEARTBEAT_INTERVAL_MS = 20_000;
/**
 * 超过这个时长没收到对端任何消息（应用层 / 协议层 pong / 任意 frame），就视为
 * 半开连接并 terminate。45s = 两个心跳周期再加 5s 容忍，可以避开偶发抖动。
 */
const HEARTBEAT_STALE_MS = 45_000;

// ── Types ──

interface WsClient {
  ws: WebSocket;
  sendQueue: string[];
  sendInProgress: boolean;
  backpressurePaused: boolean;
  lastOutputBySession: Map<string, { output: string; messages?: string; timestamp: number }>;
  /** Per-session monotonically increasing sequence number for output events. */
  outputSeqBySession: Map<string, number>;
  /** Sessions for which we owe the client a resync notice. */
  pendingResyncSessions: Set<string>;
  /**
   * 块级窗口预算：客户端在 subscribe 时带上（iOS）。设置后 init/resync/全量快照
   * 只下发最近这么多个内容块（必要时切掉最旧 turn 的头部），更早的按需翻页。
   * undefined 表示走原有 turn 级窗口（Web/Android），行为与改动前完全一致。
   */
  blockBudget?: number;
  /**
   * 上次收到该客户端任意消息（应用层 message / protocol pong / 任何 frame）的
   * 时间戳。心跳 tick 用它来判断半开连接。
   */
  lastSeenAt: number;
}

interface ClientMessageWindow {
  messages: ConversationTurn[] | undefined;
  messageOffset: number;
  messageTotal: number;
  leadingBlockOffset?: number;
  leadingBlockTotal?: number;
}

// ── Manager ──

export class WsBroadcastManager {
  private wss: WebSocketServer;
  private clients = new Set<WsClient>();
  private outputDebounceCache = new Map<string, { event: ProcessEvent; timer: NodeJS.Timeout }>();
  private heartbeatTimer?: NodeJS.Timeout;
  private disposed = false;

  private getCardDefaults: () => CardExpandDefaults;
  private useHttps: boolean;
  private authService?: Pick<AuthService, "validateSession">;

  constructor(
    wss: WebSocketServer,
    getCardDefaults?: () => CardExpandDefaults,
    useHttps = false,
    authService?: Pick<AuthService, "validateSession">,
  ) {
    this.wss = wss;
    this.getCardDefaults = getCardDefaults ?? (() => ({}));
    this.useHttps = useHttps;
    this.authService = authService;
  }

  /** Immediately disconnect all authenticated clients after global revocation. */
  disconnectAll(): void {
    for (const client of Array.from(this.clients)) {
      this.discardClient(client, true);
    }
  }

  /** Stop timers, discard deferred output, and terminate every client. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const { timer } of this.outputDebounceCache.values()) {
      clearTimeout(timer);
    }
    this.outputDebounceCache.clear();
    this.disconnectAll();
  }

  /** Set up connection handling. Should be called once during server startup. */
  setup(getSession: (id: string) => SessionSnapshot | null): void {
    if (this.disposed) return;
    this.wss.on("connection", (ws, req) => {
      if (this.disposed) {
        ws.close(1012, "Server shutting down");
        return;
      }
      const sessionToken = readSessionCookie(req, this.useHttps);

      if (!sessionToken || !this.authService?.validateSession(sessionToken)) {
        ws.close(1008, "Unauthorized");
        return;
      }

      const client: WsClient = {
        ws,
        sendQueue: [],
        sendInProgress: false,
        backpressurePaused: false,
        lastOutputBySession: new Map(),
        outputSeqBySession: new Map(),
        pendingResyncSessions: new Set(),
        lastSeenAt: Date.now(),
      };
      this.clients.add(client);

      ws.on("close", () => {
        this.clients.delete(client);
      });

      ws.on("error", () => {
        // Already closed, ignore
      });

      // 协议层 pong（浏览器对服务端 ws.ping() 的自动响应，不经过 JS）。
      // 也算"对端还活着"的信号，刷新 lastSeenAt。
      ws.on("pong", () => {
        client.lastSeenAt = Date.now();
      });

      ws.on("message", (data) => {
        // 任意应用层消息都说明对端还在，先刷新心跳计时。
        client.lastSeenAt = Date.now();
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "subscribe" && msg.sessionId) {
            // 客户端可在 subscribe 时声明块级窗口预算（iOS）；后续 init/resync/广播
            // 全量快照都按它块级窗口化。不带则保持 turn 级（Web/Android）。
            if (Number.isSafeInteger(msg.blockBudget) && msg.blockBudget > 0) {
              client.blockBudget = Math.min(msg.blockBudget, MAX_BLOCK_BUDGET);
            }
            const snapshot = getSession(msg.sessionId);
            if (snapshot) {
              this.sendInit(client, msg.sessionId, snapshot, false);
            } else {
              ws.send(JSON.stringify({
                type: "error",
                sessionId: msg.sessionId,
                error: "Session not found",
              }));
            }
          } else if (msg.type === "resync" && msg.sessionId) {
            const snapshot = getSession(msg.sessionId);
            if (snapshot) this.sendInit(client, msg.sessionId, snapshot, true);
          } else if (msg.type === "pong") {
            // 应用层 pong（对我们下发的 {type:"ping"} 的响应）。lastSeenAt
            // 已经在函数顶部刷新过了，这里不需要再做事；分支留着是为了
            // 把 pong 显式排除在"未知消息"之外。
          }
        } catch {
          // Ignore malformed messages
        }
      });
    });

    // 启动心跳轮询。每个 tick 检查所有 client：sleep 太久就 terminate，否则
    // 发应用层 ping 让前端有机会做 stale 检测。
    this.heartbeatTimer = setInterval(() => {
      this.runHeartbeatTick();
    }, HEARTBEAT_INTERVAL_MS);
    // 不要让心跳 timer 阻止 Node 进程退出（restart / 测试场景）。
    this.heartbeatTimer.unref?.();

    // 在 wss 关闭时停心跳。restart 路由会先 close 所有 client、再 server.close()，
    // wss 会跟着关，这里清掉 interval 防止泄漏。
    this.wss.on("close", () => this.dispose());
  }

  /**
   * 心跳 tick：对每个 client 执行 stale 判定 + 主动 ping。
   *   - 超过 HEARTBEAT_STALE_MS 没消息 → 视为半开 / 死连接，直接 terminate()。
   *     terminate() 不发 Close 帧，立刻断开 socket；前端 onclose 触发后会按
   *     重连退避梯度自动重连。
   *   - 否则：应用层 send `{type:"ping", t}`（给前端拿来更新 lastWsMessageAt
   *     和测 RTT），同时 ws.ping() 发协议层 ping（浏览器/CDN 友好，保 NAT）。
   */
  private runHeartbeatTick(): void {
    const now = Date.now();
    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) {
        // 已经不是 OPEN 了，close handler 通常会清理；这里兜底防止集合里
        // 留下僵尸 entry。
        this.clients.delete(client);
        continue;
      }
      if (now - client.lastSeenAt > HEARTBEAT_STALE_MS) {
        try { client.ws.terminate(); } catch { /* ignore */ }
        this.clients.delete(client);
        continue;
      }
      try {
        client.ws.send(JSON.stringify({ type: "ping", t: now }));
      } catch { /* ignore */ }
      try {
        client.ws.ping();
      } catch { /* ignore */ }
    }
  }

  /** Emit a process event to all subscribed WebSocket clients. */
  emitEvent(event: ProcessEvent): void {
    if (this.disposed) return;
    // Debounce output events to reduce flicker during rapid streaming
    if (event.type === "output") {
      const existing = this.outputDebounceCache.get(event.sessionId);
      if (existing) {
        const prevData = (existing.event.data as Record<string, unknown> | undefined) ?? {};
        const curData = (event.data as Record<string, unknown> | undefined) ?? {};

        // 跨"事件形状"不能简单 shallow-merge：
        //   - 全量事件（带 messages）+ 增量事件（带 lastMessage，不带 messages）
        //     合并后变成 { messages, incremental: true, lastMessage }。客户端
        //     reducer 看到 incremental 就只读 lastMessage，把权威的 messages 丢掉，
        //     表现是"刷新页面才出来的消失文字"。
        //   - 反过来：增量在前，全量在后，cur 覆盖 prev 后 incremental 仍为 true
        //     而 messages 来自 cur——这种顺序原本是安全的，但风险一致就一起处理。
        // 形状不一致时 flush 上一条立即广播，新事件单独开窗口。这样客户端永远
        // 不会在一条 WS 消息里同时看到 messages 和 lastMessage 两种语义。
        const prevHasMessages = "messages" in prevData && prevData.messages !== undefined;
        const prevHasLastMsg = "lastMessage" in prevData && prevData.lastMessage !== undefined;
        const curHasMessages = "messages" in curData && curData.messages !== undefined;
        const curHasLastMsg = "lastMessage" in curData && curData.lastMessage !== undefined;
        const shapeMismatch =
          (prevHasMessages && curHasLastMsg && !curHasMessages) ||
          (prevHasLastMsg && curHasMessages && !curHasLastMsg);

        if (shapeMismatch) {
          clearTimeout(existing.timer);
          this.outputDebounceCache.delete(event.sessionId);
          this.broadcast(existing.event);
          // Fall through to schedule cur on a fresh debounce window
        } else {
          clearTimeout(existing.timer);
          // Merge prev + cur. Cur takes precedence for identically-named fields,
          // but fields only present on prev (e.g. chunk while cur carries
          // messages, or messages while cur carries chunk) survive — the old
          // implementation silently dropped them.
          const merged: Record<string, unknown> = { ...prevData, ...curData };
          const prevChunk = prevData.chunk as string | undefined;
          const curChunk = curData.chunk as string | undefined;
          if (prevChunk && curChunk) {
            merged.chunk = prevChunk + curChunk;
          } else if (prevChunk && !curChunk) {
            merged.chunk = prevChunk;
          }
          event = { ...event, data: merged };
        }
      }
      const timer = setTimeout(() => {
        this.outputDebounceCache.delete(event.sessionId);
        this.broadcast(event);
      }, OUTPUT_DEBOUNCE_MS);
      this.outputDebounceCache.set(event.sessionId, { event, timer });
      return;
    }

    // Non-output events are sent immediately
    this.broadcast(event);
  }

  /** Flush any pending debounced output for a session (e.g., before session close). */
  flushOutput(sessionId: string): void {
    const existing = this.outputDebounceCache.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      this.outputDebounceCache.delete(sessionId);
      this.broadcast(existing.event);
    }
  }

  // ── Internal ──

  /**
   * Send an init/resync snapshot to a single client. Bumps the per-session
   * sequence counter so the client can detect gaps between the init payload
   * and the first incremental update.
   */
  private sendInit(client: WsClient, sessionId: string, snapshot: SessionSnapshot, resync: boolean): void {
    // 块级窗口客户端（iOS）只下发最近 blockBudget 个块；其余走 turn 级窗口。
    // 两种都附 offset/total，更早的客户端按需翻页。
    const windowed = this.windowForClient(client, snapshot.messages);
    const seq = (client.outputSeqBySession.get(sessionId) ?? 0) + 1;
    client.outputSeqBySession.set(sessionId, seq);
    client.pendingResyncSessions.delete(sessionId);
    client.ws.send(JSON.stringify({
      type: "init",
      sessionId,
      seq,
      ...(resync ? { resync: true } : {}),
      data: toSessionDetailDTO(snapshot, { output: snapshot.output, ...windowed }),
    }));
  }

  /**
   * 按客户端偏好窗口化一段完整 messages：opted-in 的块级窗口（iOS）会附带
   * leadingBlockOffset/leadingBlockTotal；否则 turn 级窗口（字段与改动前一致）。
   */
  private windowForClient(
    client: WsClient,
    messages: SessionSnapshot["messages"],
  ): ClientMessageWindow {
    if (!messages) {
      return { messages: undefined, messageOffset: 0, messageTotal: 0 };
    }
    messages = enrichStructuredMessages(messages);
    if (client.blockBudget && client.blockBudget > 0) {
      const w = blockWindowMessagesForTransport(messages, this.getCardDefaults(), client.blockBudget);
      return {
        messages: w.messages,
        messageOffset: w.messageOffset,
        messageTotal: w.messageTotal,
        leadingBlockOffset: w.leadingBlockOffset,
        leadingBlockTotal: w.leadingBlockTotal,
      };
    }
    const w = windowMessagesForTransport(messages, this.getCardDefaults());
    return { messages: w.messages, messageOffset: w.messageOffset, messageTotal: w.messageTotal };
  }

  private broadcast(event: ProcessEvent): void {
    if (this.disposed) return;
    // 非增量事件若带完整 messages（结构化 output/ended 快照、PTY 非流式 chat 快照），
    // 在这个统一出口窗口化——避免逐个 emit 点各自处理、也防止超大帧撑爆移动端 WS。
    // 增量事件只带 lastMessage，不含 messages 数组，不受影响。
    // 块级窗口客户端（iOS）需按各自预算切，所以这里改为「按客户端」窗口化；
    // turn 级（Web/Android）的结果跨客户端一致，缓存一次复用，避免重复计算。
    const boundedData = boundSessionEventData(event.data);
    const boundedEvent = boundedData === event.data ? event : { ...event, data: boundedData };
    const data = boundedData as Record<string, unknown> | undefined;
    const hasFullMessages = !!(data && !data.incremental && Array.isArray(data.messages));
    const rawMessages = hasFullMessages
      ? (data!.messages as SessionSnapshot["messages"])
      : undefined;
    let turnWindowedEvent: ProcessEvent | undefined;
    const eventForClient = (client: WsClient): ProcessEvent => {
      if (!hasFullMessages) return boundedEvent;
      if (client.blockBudget && client.blockBudget > 0) {
        return {
          ...boundedEvent,
          data: { ...data, ...this.windowForClient(client, rawMessages) },
        } as ProcessEvent;
      }
      if (!turnWindowedEvent) {
        const w = windowMessagesForTransport(rawMessages, this.getCardDefaults());
        turnWindowedEvent = {
          ...boundedEvent,
          data: {
            ...data,
            messages: w.messages,
            messageOffset: w.messageOffset,
            messageTotal: w.messageTotal,
          },
        } as ProcessEvent;
      }
      return turnWindowedEvent;
    };
    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      const clientEvent = eventForClient(client);
      // Stamp output events with a per-(client, session) sequence number so
      // the client can detect a gap caused by backpressure drops.
      let outgoing: ProcessEvent = clientEvent;
      if (event.type === "output") {
        const seq = (client.outputSeqBySession.get(event.sessionId) ?? 0) + 1;
        client.outputSeqBySession.set(event.sessionId, seq);
        outgoing = { ...clientEvent, seq } as ProcessEvent;
      }

      // Backpressure only gates new business messages. The send pump must
      // keep draining messages that were already accepted; otherwise a queue
      // at the high-water mark can never reach the low-water mark again.
      if (client.backpressurePaused || client.sendQueue.length >= MAX_QUEUE_SIZE) {
        client.backpressurePaused = true;
        if (event.type === "output") client.pendingResyncSessions.add(event.sessionId);
        this.processWsQueue(client);
        continue;
      }

      client.sendQueue.push(JSON.stringify(outgoing));
      if (client.sendQueue.length >= MAX_QUEUE_SIZE) {
        client.backpressurePaused = true;
      }
      this.processWsQueue(client);
    }
  }

  /**
   * Resume accepting business messages after the queue crosses the low-water
   * mark, then enqueue the resync notices owed for output dropped while
   * paused. Notices are themselves bounded by the same queue capacity; any
   * remainder stays in the set and is appended by a later drain cycle.
   */
  private resumeAndQueueResyncNotices(client: WsClient): void {
    if (client.backpressurePaused && client.sendQueue.length >= QUEUE_RESUME_SIZE) {
      return;
    }

    client.backpressurePaused = false;
    for (const sessionId of client.pendingResyncSessions) {
      if (client.sendQueue.length >= MAX_QUEUE_SIZE) {
        client.backpressurePaused = true;
        break;
      }
      client.pendingResyncSessions.delete(sessionId);
      client.sendQueue.push(JSON.stringify({
        type: "resync_required",
        sessionId,
        reason: "backpressure_drop",
      }));
    }
  }

  private discardClient(client: WsClient, terminate: boolean): void {
    client.sendQueue.length = 0;
    client.pendingResyncSessions.clear();
    client.sendInProgress = false;
    client.backpressurePaused = false;
    this.clients.delete(client);
    if (terminate) {
      try { client.ws.terminate(); } catch { /* ignore */ }
    }
  }

  private processWsQueue(client: WsClient): void {
    if (this.disposed) return;
    if (client.sendInProgress || client.sendQueue.length === 0) {
      return;
    }
    // Check socket state before dequeuing to avoid dropping messages
    if (client.ws.readyState !== WebSocket.OPEN) {
      // Socket closed — discard remaining queue and remove client
      this.discardClient(client, false);
      return;
    }
    client.sendInProgress = true;
    const batch = client.sendQueue.splice(0, Math.min(SEND_BATCH_SIZE, client.sendQueue.length));
    let pending = batch.length;
    let sendError: Error | undefined;
    const settleSend = (err?: Error): void => {
      if (err && !sendError) sendError = err;
      pending -= 1;
      if (pending > 0) return;

      client.sendInProgress = false;
      if (sendError) {
        // A callback error means the socket can no longer be trusted. Drop
        // the bounded application queue and force a reconnect/resubscribe.
        this.discardClient(client, true);
        return;
      }

      this.resumeAndQueueResyncNotices(client);
      if (client.sendQueue.length > 0) {
        setImmediate(() => this.processWsQueue(client));
      }
    };

    for (const msg of batch) {
      try {
        client.ws.send(msg, settleSend);
      } catch (error) {
        settleSend(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

}
