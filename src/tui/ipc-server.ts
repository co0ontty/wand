/**
 * IPC 服务端：监听 Unix socket，处理 attach 客户端发来的 snapshot/ping 请求。
 *
 * Windows 不支持（socketPath 返回空字符串），调用方应跳过 startIpcServer。
 */

import net from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { IpcRequest, IpcResponseErr, IpcResponseOk, IpcSnapshotData } from "./ipc-protocol.js";

export interface IpcServerDeps {
  socketPath: string;
  /** 由 TUI 上层组装。同步函数，避免在 socket callback 里做异步阻塞。 */
  snapshotProvider: () => IpcSnapshotData;
  /** attach 客户端发起 shutdown 时调用；返回 promise，resolve 后服务端退出。 */
  onShutdown?: () => void | Promise<void>;
}

export interface IpcServerHandle {
  close(): Promise<void>;
}

export function startIpcServer(deps: IpcServerDeps): IpcServerHandle | null {
  if (!deps.socketPath) return null;
  // 残留 socket 文件可能让 net.listen 直接报 EADDRINUSE。先尝试清理。
  if (existsSync(deps.socketPath)) {
    try { unlinkSync(deps.socketPath); } catch { /* noop */ }
  }

  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        handleLine(line, conn);
      }
    });
    conn.on("error", () => { /* swallow — peer 走开就走开 */ });
  });

  function handleLine(line: string, conn: net.Socket): void {
    let req: IpcRequest | null = null;
    try {
      req = JSON.parse(line) as IpcRequest;
    } catch {
      return; // 直接丢弃损坏帧
    }
    if (!req || typeof req.id !== "string" || typeof req.cmd !== "string") return;

    try {
      switch (req.cmd) {
        case "ping": {
          const resp: IpcResponseOk<{ pong: true }> = { id: req.id, ok: true, data: { pong: true } };
          conn.write(JSON.stringify(resp) + "\n");
          return;
        }
        case "snapshot": {
          const data = deps.snapshotProvider();
          const resp: IpcResponseOk<IpcSnapshotData> = { id: req.id, ok: true, data };
          conn.write(JSON.stringify(resp) + "\n");
          return;
        }
        case "shutdown": {
          const ack: IpcResponseOk<{ accepted: true }> = { id: req.id, ok: true, data: { accepted: true } };
          conn.write(JSON.stringify(ack) + "\n");
          // 给客户端一个 tick 把 ack 拿到再触发 shutdown
          setImmediate(() => { void deps.onShutdown?.(); });
          return;
        }
        default: {
          const err: IpcResponseErr = { id: req.id, ok: false, error: `unknown cmd: ${(req as IpcRequest).cmd}` };
          conn.write(JSON.stringify(err) + "\n");
        }
      }
    } catch (e) {
      const err: IpcResponseErr = {
        id: req.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
      try { conn.write(JSON.stringify(err) + "\n"); } catch { /* peer 走了 */ }
    }
  }

  server.on("error", (err) => {
    // 不要崩进程；attach 模式不可用也不影响主功能。
    process.stderr.write(`[wand] IPC server error: ${err.message}\n`);
  });

  server.listen(deps.socketPath);

  return {
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 兜底：1s 内强制 resolve
        setTimeout(() => resolve(), 1000).unref?.();
      });
      try { if (existsSync(deps.socketPath)) unlinkSync(deps.socketPath); } catch { /* noop */ }
    },
  };
}
