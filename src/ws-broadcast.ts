/**
 * WebSocket broadcast manager for process events.
 * Handles debounced output events, backpressure control, and client subscriptions.
 */

import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "node:events";
import type { CardExpandDefaults, SessionSnapshot, ProcessEvent } from "./types.js";
import { validateSession } from "./auth.js";
import { truncateMessagesForTransport } from "./message-truncator.js";

export type { ProcessEvent } from "./types.js";

// ── Constants ──

const MAX_QUEUE_SIZE = 500;
const OUTPUT_DEBOUNCE_MS = 16;

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
}

// ── Manager ──

export class WsBroadcastManager {
  private wss: WebSocketServer;
  private clients = new Set<WsClient>();
  private outputDebounceCache = new Map<string, { event: ProcessEvent; timer: NodeJS.Timeout }>();
  private eventEmitter = new EventEmitter();

  private getCardDefaults: () => CardExpandDefaults;

  constructor(wss: WebSocketServer, getCardDefaults?: () => CardExpandDefaults) {
    this.wss = wss;
    this.getCardDefaults = getCardDefaults ?? (() => ({}));
  }

  /** Set up connection handling. Should be called once during server startup. */
  setup(getSession: (id: string) => SessionSnapshot | null): void {
    this.wss.on("connection", (ws, req) => {
      const sessionToken = this.readSessionCookie(req);

      if (!sessionToken || !validateSession(sessionToken)) {
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
      };
      this.clients.add(client);

      ws.on("close", () => {
        this.clients.delete(client);
      });

      ws.on("error", () => {
        // Already closed, ignore
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "subscribe" && msg.sessionId) {
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
          }
        } catch {
          // Ignore malformed messages
        }
      });
    });
  }

  /** Emit a process event to all subscribed WebSocket clients. */
  emitEvent(event: ProcessEvent): void {
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
    const truncatedMessages = snapshot.messages
      ? truncateMessagesForTransport(snapshot.messages, this.getCardDefaults())
      : undefined;
    const seq = (client.outputSeqBySession.get(sessionId) ?? 0) + 1;
    client.outputSeqBySession.set(sessionId, seq);
    client.pendingResyncSessions.delete(sessionId);
    client.ws.send(JSON.stringify({
      type: "init",
      sessionId,
      seq,
      ...(resync ? { resync: true } : {}),
      data: { ...snapshot, messages: truncatedMessages, output: snapshot.output },
    }));
  }

  private broadcast(event: ProcessEvent): void {
    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      // Stamp output events with a per-(client, session) sequence number so
      // the client can detect a gap caused by backpressure drops.
      let outgoing: ProcessEvent = event;
      if (event.type === "output") {
        const seq = (client.outputSeqBySession.get(event.sessionId) ?? 0) + 1;
        client.outputSeqBySession.set(event.sessionId, seq);
        outgoing = { ...event, seq } as ProcessEvent;
      }

      // Apply backpressure if queue is too large. We mark the session as
      // needing a resync rather than silently discarding — the client will
      // request a fresh snapshot once it sees the resync hint.
      if (client.sendQueue.length >= MAX_QUEUE_SIZE) {
        client.backpressurePaused = true;
        if (event.type === "output") client.pendingResyncSessions.add(event.sessionId);
        continue;
      }
      if (client.backpressurePaused) {
        if (event.type === "output") client.pendingResyncSessions.add(event.sessionId);
        continue;
      }

      // If we owed this session a resync notice, prepend it now that the
      // queue has drained enough to actually deliver something.
      if (client.pendingResyncSessions.has(event.sessionId)) {
        client.pendingResyncSessions.delete(event.sessionId);
        const notice = JSON.stringify({
          type: "resync_required",
          sessionId: event.sessionId,
          reason: "backpressure_drop",
        });
        client.sendQueue.push(notice);
      }

      client.sendQueue.push(JSON.stringify(outgoing));
      this.processWsQueue(client);
    }
  }

  private processWsQueue(client: WsClient): void {
    if (client.sendInProgress || client.sendQueue.length === 0) {
      return;
    }
    if (client.backpressurePaused) {
      if (client.sendQueue.length < MAX_QUEUE_SIZE * 0.8) {
        client.backpressurePaused = false;
      } else {
        return;
      }
    }
    // Check socket state before dequeuing to avoid dropping messages
    if (client.ws.readyState !== WebSocket.OPEN) {
      // Socket closed — discard remaining queue and remove client
      client.sendQueue.length = 0;
      this.clients.delete(client);
      return;
    }
    client.sendInProgress = true;
    const batch = client.sendQueue.splice(0, Math.min(8, client.sendQueue.length));
    let pending = batch.length;
    for (const msg of batch) {
      client.ws.send(msg, (err) => {
        if (--pending === 0) {
          client.sendInProgress = false;
          if (!err && client.sendQueue.length > 0) {
            setImmediate(() => this.processWsQueue(client));
          }
        }
      });
    }
  }

  private readSessionCookie(req: { headers: { cookie?: string } }): string | undefined {
    const cookie = req.headers.cookie;
    if (!cookie) return undefined;
    const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("wand_session="));
    return match?.slice("wand_session=".length);
  }
}
