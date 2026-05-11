/**
 * 单实例 pidfile + IPC 套接字路径。
 *
 * 用途：
 * 1. `wand web` 启动时先看 pidfile 是否活着，活着则进入 attach 模式（不再重复启动服务）。
 * 2. 主进程通过 wand.sock 暴露控制平面 IPC，attach 客户端通过它拉 snapshot / 发命令。
 *
 * 文件位置：均放在 configPath 的同目录（与 wand.db 一致）。
 *
 * 平台说明：
 * - Linux / macOS 使用 Unix domain socket。
 * - Windows 不支持，attach 模式直接跳过；新启的 `wand web` 仍会按老逻辑启动（端口冲突时报错）。
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export interface PidInfo {
  pid: number;
  version: string;
  /** 主进程启动时间 (ms epoch)。 */
  startedAt: number;
  url: string;
  scheme: "HTTP" | "HTTPS";
  bindAddr: string;
  configPath: string;
  dbPath: string;
  /** Unix socket 绝对路径；Windows 下为空字符串。 */
  socket: string;
}

export function pidfilePath(configPath: string): string {
  return path.resolve(path.dirname(configPath), "wand.pid");
}

export function socketPath(configPath: string): string {
  if (process.platform === "win32") return "";
  return path.resolve(path.dirname(configPath), "wand.sock");
}

/** 原子写：先写到 .tmp 再 rename。 */
export function writePidfile(configPath: string, info: PidInfo): void {
  const file = pidfilePath(configPath);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** 读取并校验。文件不存在 / 损坏 / 进程不在 → 返回 null。 */
export function readPidfile(configPath: string): PidInfo | null {
  const file = pidfilePath(configPath);
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const info = parsed as Partial<PidInfo>;
  if (
    typeof info.pid !== "number" ||
    typeof info.version !== "string" ||
    typeof info.startedAt !== "number" ||
    typeof info.url !== "string" ||
    typeof info.scheme !== "string" ||
    typeof info.bindAddr !== "string" ||
    typeof info.configPath !== "string" ||
    typeof info.dbPath !== "string" ||
    typeof info.socket !== "string"
  ) {
    return null;
  }
  return info as PidInfo;
}

/** 通过 `kill 0` 判断 PID 是否还活着（不发送信号，只检查存在性）。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process；EPERM = 存在但无权限发信号，仍然算活着
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function removePidfile(configPath: string): void {
  try {
    unlinkSync(pidfilePath(configPath));
  } catch {
    /* noop */
  }
}

export function removeSocketFile(configPath: string): void {
  const p = socketPath(configPath);
  if (!p) return;
  try {
    unlinkSync(p);
  } catch {
    /* noop */
  }
}

/** 读取 pidfile 并校验进程是否还活着。Stale 文件会自动清理。 */
export function readLiveInstance(configPath: string): PidInfo | null {
  const info = readPidfile(configPath);
  if (!info) return null;
  if (info.pid === process.pid) return null; // 自身（防御性）
  if (!isPidAlive(info.pid)) {
    // stale，顺手清理
    removePidfile(configPath);
    removeSocketFile(configPath);
    return null;
  }
  // 进程活着但 socket 不在 → 多半是异常崩溃后被某种监控拉起。视为不可用。
  if (info.socket && !existsSync(info.socket)) return null;
  return info;
}
