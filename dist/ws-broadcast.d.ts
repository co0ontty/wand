/**
 * WebSocket broadcast manager for process events.
 * Handles debounced output events, backpressure control, and client subscriptions.
 */
import { WebSocketServer } from "ws";
import type { CardExpandDefaults, SessionSnapshot, ProcessEvent } from "./types.js";
export type { ProcessEvent } from "./types.js";
export declare class WsBroadcastManager {
    private wss;
    private clients;
    private outputDebounceCache;
    private eventEmitter;
    private heartbeatTimer?;
    private getCardDefaults;
    private useHttps;
    constructor(wss: WebSocketServer, getCardDefaults?: () => CardExpandDefaults, useHttps?: boolean);
    /** Set up connection handling. Should be called once during server startup. */
    setup(getSession: (id: string) => SessionSnapshot | null): void;
    /**
     * 心跳 tick：对每个 client 执行 stale 判定 + 主动 ping。
     *   - 超过 HEARTBEAT_STALE_MS 没消息 → 视为半开 / 死连接，直接 terminate()。
     *     terminate() 不发 Close 帧，立刻断开 socket；前端 onclose 触发后会按
     *     重连退避梯度自动重连。
     *   - 否则：应用层 send `{type:"ping", t}`（给前端拿来更新 lastWsMessageAt
     *     和测 RTT），同时 ws.ping() 发协议层 ping（浏览器/CDN 友好，保 NAT）。
     */
    private runHeartbeatTick;
    /** Emit a process event to all subscribed WebSocket clients. */
    emitEvent(event: ProcessEvent): void;
    /** Flush any pending debounced output for a session (e.g., before session close). */
    flushOutput(sessionId: string): void;
    /**
     * Send an init/resync snapshot to a single client. Bumps the per-session
     * sequence counter so the client can detect gaps between the init payload
     * and the first incremental update.
     */
    private sendInit;
    private broadcast;
    private processWsQueue;
}
