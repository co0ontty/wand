import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export interface UpdatedServiceHealth {
  pid: number;
  version: string;
}

/** Reads only the immutable header from the existing local IPC protocol, including old releases. */
export async function probeUpdatedService(
  configPath: string,
  expectedVersion: string,
  previousPid?: number,
  timeoutMs = 5000,
): Promise<UpdatedServiceHealth> {
  const absoluteConfig = path.resolve(configPath);
  const info = JSON.parse(readFileSync(path.join(path.dirname(absoluteConfig), "wand.pid"), "utf8"));
  if (!Number.isSafeInteger(info.pid) || info.pid <= 1 || info.pid === previousPid
    || info.version !== expectedVersion || path.resolve(info.configPath ?? "") !== absoluteConfig) {
    return Promise.reject(new Error("目标版本的新服务实例尚未登记。"));
  }
  try { process.kill(info.pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return Promise.reject(new Error("目标服务进程尚未存活。"));
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(path.dirname(absoluteConfig), "wand.sock"));
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, health?: UpdatedServiceHealth): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(health!);
    };
    const timer = setTimeout(() => finish(new Error("新版服务响应验证超时。")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ id: "wand-update-health", cmd: "snapshot" }) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { finish(new Error("服务验证响应过大。")); return; }
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, at));
        const header = value.data?.header;
        if (value.id !== "wand-update-health" || value.ok !== true || !header
          || header.pid !== info.pid || header.version !== expectedVersion
          || path.resolve(header.configPath ?? "") !== absoluteConfig) {
          finish(new Error("服务响应与目标版本或配置不一致。")); return;
        }
        finish(undefined, { pid: header.pid, version: header.version });
      } catch { finish(new Error("服务验证响应无效。")); }
    });
    socket.once("error", error => finish(error));
    socket.once("close", () => finish(new Error("服务验证连接未完成即关闭。")));
  });
}

export async function waitForUpdatedService(
  configPath: string,
  expectedVersion: string,
  previousPid?: number,
  timeoutMs = 60_000,
): Promise<UpdatedServiceHealth> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { return await probeUpdatedService(configPath, expectedVersion, previousPid, Math.min(5000, Math.max(1, deadline - Date.now()))); }
    catch {
      if (Date.now() >= deadline) throw new Error(`新版 ${expectedVersion} 未在时限内启动并响应，更新尚未完成。`);
      await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    }
  }
}
