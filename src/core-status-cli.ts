#!/usr/bin/env node
/**
 * Query the running web process, never the CLI process's in-memory tracker.
 * Kept dependency-free so start.sh can run this source with Node's TS support
 * before replacing an older global package (including --restart/--no-build).
 */
import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface CoreStatus {
  hasActiveTurns: boolean;
  activeTurnCount: number;
  activeTurnIds?: string[];
}

function parseStatus(value: unknown): CoreStatus {
  const status = value as Partial<CoreStatus> | null;
  if (!status || typeof status.hasActiveTurns !== "boolean"
    || typeof status.activeTurnCount !== "number" || !Number.isSafeInteger(status.activeTurnCount)
    || status.activeTurnCount < 0 || status.hasActiveTurns !== (status.activeTurnCount > 0)) {
    throw new Error("Core 状态响应无效，不能确认重启安全。");
  }
  return status as CoreStatus;
}

class CoreControl {
  private socket: net.Socket | null = null;
  private buffer = "";
  private nextId = 0;
  private pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
  private disconnected = false;

  private readonly configPath: string;

  constructor(configPath: string) { this.configPath = configPath; }

  async connect(timeoutMs = 5000): Promise<void> {
    const socket = net.createConnection(path.join(path.dirname(this.configPath), "wand.sock"));
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 64 * 1024) { socket.destroy(new Error("Core IPC 响应过大。")); return; }
      let at: number;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        let response: { id?: string; ok?: boolean; data?: unknown; error?: string };
        try { response = JSON.parse(line); } catch { socket.destroy(new Error("Core IPC 响应无效。")); return; }
        const pending = response && this.pending.get(response.id ?? "");
        if (!pending) continue;
        this.pending.delete(response.id!);
        if (response.ok === true) pending.resolve(response.data);
        else pending.reject(new Error(response.error ?? "Core IPC 请求失败。"));
      }
    });
    const fail = (error: Error): void => {
      this.disconnected = true;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("Core 控制连接已断开，已取消重启。")));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("连接 Core 控制端超时。")); }, timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
  }

  request(cmd: "core-status" | "core-drain", timeoutMs = 5000): Promise<CoreStatus> {
    if (this.disconnected || !this.socket) return Promise.reject(new Error("Core 控制连接不可用。"));
    const id = String(++this.nextId);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("读取 Core 状态超时，已取消重启。"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (data) => { clearTimeout(timer); resolve(data); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket!.write(JSON.stringify({ id, cmd }) + "\n");
    }).then(parseStatus);
  }

  assertConnected(): void {
    if (this.disconnected) throw new Error("Core 控制连接已断开，已取消重启。");
  }

  close(): void { this.socket?.destroy(); }
}

/** Compatibility with the first core-enabled server, which has no core IPC commands. */
async function readLegacyStatus(configPath: string, timeoutMs = 5000): Promise<CoreStatus> {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("配置端口无效，不能读取运行中 Core 状态。");
  }
  // Trust the configured local certificate, not arbitrary self-signed peers.
  // Pinning also works with a user certificate whose SAN is not 127.0.0.1.
  const ca = config.https ? readFileSync(config.tls?.certPath ?? path.join(path.dirname(configPath), "server.crt")) : undefined;
  const fingerprint = ca ? new X509Certificate(ca).fingerprint256 : undefined;
  const request = config.https ? httpsRequest : httpRequest;
  const result = await new Promise<unknown>((resolve, reject) => {
    const req = request({ hostname: config.host === "::1" ? "::1" : "127.0.0.1",
      port: config.port, path: "/api/core-status", method: "GET",
      ...(ca ? { ca, allowPartialTrustChain: true,
        checkServerIdentity: (_hostname: string, cert: { fingerprint256?: string }) =>
          cert.fingerprint256 === fingerprint ? undefined : new Error("Core 服务证书与本机配置不一致。") } : {}) }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy(new Error("Core 状态响应过大。"));
      });
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode !== 200) { reject(new Error(`读取运行中 Core 状态失败 (HTTP ${res.statusCode})。`)); return; }
        try { resolve(JSON.parse(body)); } catch { reject(new Error("Core 状态不是 JSON，已取消重启。")); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("读取运行中 Core 状态超时。")), timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
  return parseStatus(result);
}

async function openControl(configPath: string, deadline = Infinity): Promise<CoreControl | null> {
  const control = new CoreControl(configPath);
  const budget = (): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("等待 Core 回合超时，服务未停止，已取消重启。");
    return Math.min(5000, remaining);
  };
  try {
    await control.connect(budget());
    await control.request("core-status", budget());
    return control;
  } catch (error) {
    control.close();
    // Older protocols and missing/stale sockets can use the real loopback probe.
    // Permission errors and malformed responses must fail closed.
    if (error instanceof Error && /^unknown cmd: core-status$/.test(error.message)) return null;
    if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException)?.code ?? "")) return null;
    throw error;
  }
}

export async function checkCoreStatus(configPath: string): Promise<void> {
  const control = await openControl(configPath);
  try {
    const status = control ? await control.request("core-status") : await readLegacyStatus(configPath);
    console.log(JSON.stringify({ status: status.hasActiveTurns ? "busy" : "idle", ...status }));
    process.exitCode = status.hasActiveTurns ? 1 : 0;
  } finally { control?.close(); }
}

/** Zero means wait indefinitely. A timeout/error NEVER runs the stop command. */
export async function waitForCoreTurnsComplete(
  configPath: string,
  timeoutSeconds = 0,
  stopCommand?: string[],
  allowStopped = false,
): Promise<number> {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) throw new Error("--timeout 必须是非负秒数（0 表示一直等待）。");
  if (stopCommand && !stopCommand.length) throw new Error("缺少等待完成后要执行的停止命令。");
  const deadline = timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : Infinity;
  const budget = (): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("等待 Core 回合超时，服务未停止，已取消重启。");
    return Math.min(5000, remaining);
  };
  const control = await openControl(configPath, deadline);
  try {
    const readStatus = async (budget = 5000): Promise<CoreStatus> => {
      if (control) return control.request("core-status", budget);
      try { return await readLegacyStatus(configPath, budget); } catch (error) {
        // Only the service manager's confirmed stopped state plus no live PID
        // AND a refused local listener may treat an absent service as idle.
        if (!allowStopped || (error as NodeJS.ErrnoException)?.code !== "ECONNREFUSED") throw error;
        try {
          const info = JSON.parse(readFileSync(path.join(path.dirname(configPath), "wand.pid"), "utf8"));
          if (!Number.isInteger(info.pid) || info.pid <= 0) throw new Error("Core pidfile 无效。");
          try { process.kill(info.pid, 0); throw new Error("Core 主进程仍在运行，不能跳过检查。"); }
          catch (pidError) { if ((pidError as NodeJS.ErrnoException)?.code !== "ESRCH") throw pidError; }
        } catch (pidError) { if ((pidError as NodeJS.ErrnoException)?.code !== "ENOENT") throw pidError; }
        return { hasActiveTurns: false, activeTurnCount: 0 };
      }
    };
    let status = control && stopCommand ? await control.request("core-drain", budget()) : await readStatus(budget());
    if (!control && stopCommand) console.error("[wand] 旧服务尚不支持重启排空；正在读取真实服务状态。首次升级等待期间请勿启动新任务。");
    let lastCount = -1;
    while (status.hasActiveTurns) {
      if (status.activeTurnCount !== lastCount) {
        console.log(`[wand] ${status.activeTurnCount} 个原生 Core 回合仍在运行，等待完成后再停止服务…`);
        lastCount = status.activeTurnCount;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("等待 Core 回合超时，服务未停止，已取消重启。");
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1000, remaining)));
      status = await readStatus(budget());
    }
    // The draining connection stays open until the stop command finishes.
    // New Pi inputs are persisted in the queue, not started in the check/stop gap.
    control?.assertConnected();
    console.log("[wand] 原生 Core 回合已全部完成，可以停止服务。");
    if (!stopCommand) return 0;
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(stopCommand[0], stopCommand.slice(1), { stdio: "inherit" });
      child.once("error", reject);
      // A dedicated code distinguishes action failure from a broken/missing
      // guard executable (which may itself exit 1 before our catch can run).
      child.once("exit", (code, signal) => resolve(code === 0 && !signal ? 0 : 3));
    });
  } finally { control?.close(); }
}

// start.sh uses the current source rather than the possibly broken installed CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  const flag = (name: string): string | undefined => {
    const index = options.indexOf(name);
    return index < 0 ? undefined : options[index + 1];
  };
  const config = flag("-c") ?? flag("--config");
  try {
    if (!config) throw new Error("缺少 -c 配置路径。");
    if (options.includes("--status")) await checkCoreStatus(path.resolve(config));
    else process.exitCode = await waitForCoreTurnsComplete(path.resolve(config), Number(flag("--timeout") ?? 0),
      separator < 0 ? undefined : args.slice(separator + 1), options.includes("--allow-stopped"));
  } catch (error) {
    console.error(`[wand] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
