import { readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { X509Certificate } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { networkInterfaces } from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

async function legacyIpc(configPath: string, cmd: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(path.dirname(configPath), "wand.sock"));
    let buffer = "";
    const timer = setTimeout(() => socket.destroy(new Error("旧服务协议检查超时。")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ id: "wand-legacy-update", cmd }) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { socket.destroy(new Error("旧服务协议响应过大。")); return; }
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, at));
        if (value.id !== "wand-legacy-update" || typeof value.ok !== "boolean") throw new Error("旧服务协议响应无效。");
        resolve(value); socket.destroy();
      } catch (error) { socket.destroy(error as Error); }
    });
    socket.once("error", reject);
    socket.once("close", () => { clearTimeout(timer); reject(new Error("旧服务协议连接已关闭。")); });
  });
}

export function countLegacyUpdateExecutions(value: unknown): number {
  if (!Array.isArray(value)) throw new Error("旧服务会话清单无效，不能确认更新安全。");
  let count = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.id !== "string") {
      throw new Error("旧服务会话身份无效，更新已取消。");
    }
    // The published legacy DTO defaults missing kind to PTY. Structured rows
    // always carry their kind/state; do not reinterpret a partial structured row.
    const kind = item.sessionKind ?? (item.structuredState === undefined && typeof item.command === "string" ? "pty" : null);
    if (!["pty", "structured"].includes(kind)) throw new Error("旧服务会话缺少执行类型，不能把未知状态当作空闲。");
    if (kind === "pty") continue;
    if (typeof item.structuredState?.inFlight !== "boolean" || !Array.isArray(item.queuedMessages)) {
      throw new Error("旧结构化执行或队列状态不完整，更新已取消。");
    }
    if (item.structuredState.inFlight || item.queuedMessages.length > 0) count++;
  }
  return count;
}

function readLocalPassword(configPath: string, config: Record<string, any>): string {
  let password = config.password;
  const dbPath = path.join(path.dirname(configPath), "wand.db");
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get("app_config")) {
        password = db.prepare("SELECT value FROM app_config WHERE key=?").get("password")?.value ?? password;
      }
    } finally { db.close(); }
  }
  if (typeof password !== "string" || !password) throw new Error("无法读取本机旧服务登录凭据，更新已取消。");
  return password;
}

function localRequest(config: Record<string, any>, configPath: string, route: string, method: string, body: unknown, cookie: string, timeoutMs: number): Promise<{ status: number; value: any; cookie: string }> {
  const port = config.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error("旧配置端口无效。"));
  const localAddresses = new Set(Object.values(networkInterfaces()).flat().filter(Boolean).map(item => item!.address));
  const bound = config.host;
  const hostname = bound === "::" || bound === "::1" ? "::1"
    : !bound || ["0.0.0.0", "localhost", "127.0.0.1"].includes(bound) ? "127.0.0.1"
      : localAddresses.has(bound) ? bound : null;
  if (!hostname) return Promise.reject(new Error("旧服务地址不是本机地址，拒绝发送本地凭据。"));
  const ca = config.https ? readFileSync(config.tls?.certPath ?? path.join(path.dirname(configPath), "server.crt")) : undefined;
  const fingerprint = ca ? new X509Certificate(ca).fingerprint256 : undefined;
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = (config.https ? httpsRequest : httpRequest)({ hostname, port, path: route, method,
      headers: { ...(encoded ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(ca ? { ca, allowPartialTrustChain: true, checkServerIdentity: (_hostname: string, cert: { fingerprint256?: string }) =>
        cert.fingerprint256 === fingerprint ? undefined : new Error("旧服务证书与本机配置不符。") } : {}) }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        data += chunk;
        if (data.length > 4 * 1024 * 1024) req.destroy(new Error("旧服务会话响应过大。"));
      });
      res.once("error", reject);
      res.once("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, value: data ? JSON.parse(data) : {},
            cookie: (res.headers["set-cookie"] ?? []).map(value => value.split(";")[0]).join("; ") });
        } catch { reject(new Error("旧服务响应不是有效 JSON。")); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("旧服务状态读取超时。")), timeoutMs);
    req.once("close", () => clearTimeout(timer));
    req.once("error", reject);
    req.end(encoded);
  });
}

/** Capability negotiation, never a guessed version cutoff or unknown-as-idle fallback. */
export async function waitForCompatibleUpdate(
  configPath: string,
  timeoutSeconds: number,
  command: string[],
  allowStopped = false,
  providedGuard?: { waitForCoreTurnsComplete(configPath: string, timeout: number, command: string[], allowStopped?: boolean): Promise<number> },
): Promise<number> {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || command.length === 0) throw new Error("更新等待参数无效。");
  const absolute = path.resolve(configPath);
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const guard = providedGuard ?? await import(pathToFileURL(path.join(dir,
    existsSync(path.join(dir, "core-status-cli.js")) ? "core-status-cli.js" : "core-status-cli.ts")).href);
  const deadline = timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : Infinity;
  const budget = (): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("等待旧执行结束超时，安装未修改。");
    return Math.min(5000, left);
  };
  const remaining = (): number => {
    if (timeoutSeconds === 0) return 0;
    budget();
    return (deadline - Date.now()) / 1000;
  };
  let capability;
  try { capability = await legacyIpc(absolute, "core-status", budget()); }
  catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return guard.waitForCoreTurnsComplete(absolute, remaining(), command, allowStopped);
  }
  if (capability.ok === true) return guard.waitForCoreTurnsComplete(absolute, remaining(), command, allowStopped);
  if (capability.error !== "unknown cmd: core-status") throw new Error("旧服务未明确报告协议不支持，更新已取消。");
  const identity = await legacyIpc(absolute, "snapshot", budget());
  const header = identity.data?.header;
  if (identity.ok !== true || !Number.isSafeInteger(header?.pid) || header.pid <= 1
    || path.resolve(header.configPath ?? "") !== absolute) throw new Error("不能确认旧服务身份，更新已取消。");
  const config = JSON.parse(readFileSync(absolute, "utf8"));
  const endpoint = new URL(header.url);
  if (Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)) !== config.port
    || endpoint.protocol !== (config.https ? "https:" : "http:")) throw new Error("旧服务监听地址与原配置不一致，拒绝发送凭据。");
  const password = readLocalPassword(absolute, config);
  const login = await localRequest(config, absolute, "/api/login", "POST", { password }, "", budget());
  if (login.status !== 200 || !login.cookie) throw new Error("旧服务本地认证失败，更新已取消。");
  console.error("[wand] 此旧服务不支持排空协议；正在等待实际结构化执行和队列结束。首次恢复期间请勿提交新任务。");
  try {
    while (true) {
      const response = await localRequest(config, absolute, "/api/sessions", "GET", undefined, login.cookie, budget());
      if (response.status !== 200) throw new Error("无法读取旧服务执行状态，更新已取消。");
      if (countLegacyUpdateExecutions(response.value) === 0) {
        const confirm = await legacyIpc(absolute, "snapshot", budget());
        if (confirm.ok !== true || confirm.data?.header?.pid !== header.pid) throw new Error("旧服务实例已变化，更新已取消。");
        const final = await localRequest(config, absolute, "/api/sessions", "GET", undefined, login.cookie, budget());
        if (final.status !== 200 || countLegacyUpdateExecutions(final.value) !== 0) continue;
        return await new Promise((resolve, reject) => {
          const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
          child.once("error", reject);
          child.once("exit", code => resolve(code === 0 ? 0 : 3));
        });
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    }
  } finally {
    // Cookies and passwords stay only in memory, never argv, generated files or logs.
    await localRequest(config, absolute, "/api/logout", "POST", undefined, login.cookie, 1000).catch(() => {});
  }
}
