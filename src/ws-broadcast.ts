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
              const truncatedMessages = snapshot.messages
                ? truncateMessagesForTransport(snapshot.messages, this.getCardDefaults())
                : undefined;
              ws.send(JSON.stringify({
                type: "init",
                sessionId: msg.sessionId,
                data: { ...snapshot, messages: truncatedMessages, output: snapshot.output },
              }));
            } else {
              ws.send(JSON.stringify({
                type: "error",
                sessionId: msg.sessionId,
                error: "Session not found",
              }));
            }
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
        clearTimeout(existing.timer);
        // Accumulate chunk data across debounce window so the browser can
        // write incrementally instead of doing a full terminal reset.
        const prevData = existing.event.data as Record<string, unknown> | undefined;
        const curData = event.data as Record<string, unknown> | undefined;
        const prevChunk = prevData?.chunk as string | undefined;
        const curChunk = curData?.chunk as string | undefined;
        if (prevChunk && curChunk) {
          event = { ...event, data: { ...curData, chunk: prevChunk + curChunk } };
        } else if (prevChunk && !curChunk) {
          event = { ...event, data: { ...curData, chunk: prevChunk } };
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

  private broadcast(event: ProcessEvent): void {
    const message = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      // Apply backpressure if queue is too large
      if (client.sendQueue.length >= MAX_QUEUE_SIZE) {
        client.backpressurePaused = true;
        continue;
      }
      if (client.backpressurePaused) continue;

      client.sendQueue.push(message);
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
