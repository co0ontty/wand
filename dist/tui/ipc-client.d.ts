/**
 * IPC 客户端：连接主进程的 wand.sock，发送 snapshot/ping，等待行内 JSON 应答。
 *
 * 极简实现：单连接、并发请求按 id 路由、断线自动重连（指数退避）。
 */
import { EventEmitter } from "node:events";
import { IpcSnapshotData } from "./ipc-protocol.js";
export declare class IpcClient extends EventEmitter {
    private readonly socketPath;
    private socket;
    private buf;
    private pending;
    private nextId;
    private closed;
    private reconnectMs;
    private connected;
    constructor(socketPath: string);
    start(): void;
    isConnected(): boolean;
    close(): void;
    snapshot(): Promise<IpcSnapshotData>;
    ping(): Promise<boolean>;
    shutdownDaemon(): Promise<boolean>;
    private connect;
    private handleLine;
    private request;
}
