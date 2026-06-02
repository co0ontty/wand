/**
 * IPC 客户端：连接主进程的 wand.sock，发送 snapshot/ping，等待行内 JSON 应答。
 *
 * 极简实现：单连接、并发请求按 id 路由、断线自动重连（指数退避）。
 */
import net from "node:net";
import { EventEmitter } from "node:events";
const REQ_TIMEOUT_MS = 5_000;
const RECONNECT_INITIAL_MS = 250;
const RECONNECT_MAX_MS = 5_000;
export class IpcClient extends EventEmitter {
    socketPath;
    socket = null;
    buf = "";
    pending = new Map();
    nextId = 1;
    closed = false;
    reconnectMs = RECONNECT_INITIAL_MS;
    connected = false;
    constructor(socketPath) {
        super();
        this.socketPath = socketPath;
    }
    start() {
        this.connect();
    }
    isConnected() {
        return this.connected;
    }
    close() {
        this.closed = true;
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error("client closed"));
        }
        this.pending.clear();
        try {
            this.socket?.destroy();
        }
        catch { /* noop */ }
        this.socket = null;
    }
    async snapshot() {
        const resp = await this.request({ cmd: "snapshot" });
        if (!resp.ok)
            throw new Error(resp.error);
        return resp.data;
    }
    async ping() {
        try {
            const resp = await this.request({ cmd: "ping" });
            if (!resp.ok)
                return false;
            return resp.data.pong === true;
        }
        catch {
            return false;
        }
    }
    async shutdownDaemon() {
        try {
            const resp = await this.request({ cmd: "shutdown" });
            return resp.ok === true;
        }
        catch {
            return false;
        }
    }
    // ─── 内部 ────────────────────────────────────────────────────────────
    connect() {
        if (this.closed)
            return;
        const sock = net.createConnection({ path: this.socketPath });
        this.socket = sock;
        sock.setEncoding("utf8");
        sock.on("connect", () => {
            this.connected = true;
            this.reconnectMs = RECONNECT_INITIAL_MS;
            this.emit("connect");
        });
        sock.on("data", (chunk) => {
            this.buf += chunk;
            let idx;
            while ((idx = this.buf.indexOf("\n")) >= 0) {
                const line = this.buf.slice(0, idx).trim();
                this.buf = this.buf.slice(idx + 1);
                if (line)
                    this.handleLine(line);
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
            if (this.closed)
                return;
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
    handleLine(line) {
        let msg = null;
        try {
            msg = JSON.parse(line);
        }
        catch {
            return;
        }
        if (!msg || typeof msg.id !== "string")
            return;
        const p = this.pending.get(msg.id);
        if (!p)
            return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
    }
    request(payload) {
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
            const req = { id, cmd: payload.cmd };
            try {
                this.socket.write(JSON.stringify(req) + "\n");
            }
            catch (err) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(err);
            }
        });
    }
}
