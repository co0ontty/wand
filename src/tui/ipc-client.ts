/**
 * IPC 客户端：连接主进程的 wand.sock，发送 snapshot/ping，等待行内 JSON 应答。
 *
 * 极简实现：单连接、并发请求按 id 路由、断线自动重连（指数退避）。
 */

import net from "node:net";
import { EventEmitter } from "node:events";
import { IpcRequest, IpcResponse, IpcSnapshotData, PingResponse, SnapshotResponse } from "./ipc-protocol.js";

const REQ_TIMEOUT_MS = 5_000;
const RECONNECT_INITIAL_MS = 250;
const RECONNECT_MAX_MS = 5_000;

interface PendingReq {
  resolve: (value: IpcResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class IpcClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buf = "";
  private pending = new Map<string, PendingReq>();
  private nextId = 1;
  private closed = false;
  private reconnectMs = RECONNECT_INITIAL_MS;
  private connected = false;

  constructor(private readonly socketPath: string) {
    super();
  }

  start(): void {
    this.connect();
  }

  isConnected(): boolean {
    return this.connected;
  }

  close(): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("client closed"));
    }
    this.pending.clear();
    try { this.socket?.destroy(); } catch { /* noop */ }
    this.socket = null;
  }

  async snapshot(): Promise<IpcSnapshotData> {
    const resp = await this.request({ cmd: "snapshot" });
    if (!resp.ok) throw new Error(resp.error);
    return (resp as SnapshotResponse).data;
  }

  async ping(): Promise<boolean> {
    try {
      const resp = await this.request({ cmd: "ping" });
      if (!resp.ok) return false;
      return (resp as PingResponse).data.pong === true;
    } catch {
      return false;
    }
  }

  async shutdownDaemon(): Promise<boolean> {
    try {
      const resp = await this.request({ cmd: "shutdown" });
      return resp.ok === true;
    } catch {
      return false;
    }
  }

  // ─── 内部 ────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.closed) return;
    const sock = net.createConnection({ path: this.socketPath });
    this.socket = sock;
    sock.setEncoding("utf8");

    sock.on("connect", () => {
      this.connected = true;
      this.reconnectMs = RECONNECT_INITIAL_MS;
      this.emit("connect");
    });
    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });
    const onClose = () => {
      this.connected = false;
      this.emit("disconnect");
      // 把还没完成的请求拒掉，避免永远卡住
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("ipc disconnected"));
      }
      this.pending.clear();
      if (this.closed) return;
      const delay = this.reconnectMs;
      this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
      const timer = setTimeout(() => this.connect(), delay);
      timer.unref?.();
    };
    sock.on("close", onClose);
    sock.on("error", (err) => {
      this.emit("error", err);
    });
  }

  private handleLine(line: string): void {
    let msg: IpcResponse | null = null;
    try { msg = JSON.parse(line) as IpcResponse; } catch { return; }
    if (!msg || typeof msg.id !== "string") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  private request(payload: Omit<IpcRequest, "id">): Promise<IpcResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error("ipc not connected"));
        return;
      }
      const id = String(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ipc request timeout"));
      }, REQ_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const req: IpcRequest = { id, cmd: payload.cmd };
      try {
        this.socket.write(JSON.stringify(req) + "\n");
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }
}
