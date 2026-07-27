/**
 * 主进程 ↔ attach 客户端的控制平面 IPC 协议。
 *
 * 帧格式：单行 JSON，以 `\n` 分割。客户端按行读，服务端按行解析。
 * 不做长度前缀，因为单条 message 受 snapshot 大小限制，远低于 socket 缓冲区。
 */

import { SessionRow } from "./session-formatter.js";

export interface IpcSnapshotHeader {
  version: string;
  url: string;
  scheme: "HTTP" | "HTTPS";
  bindAddr: string;
  configPath: string;
  dbPath: string;
  orphanRecoveredCount: number;
  sessionCounts: { active: number; archived: number; total: number };
  /** 主进程启动时间 (ms epoch)。 */
  startedAtMs: number;
  /** 主进程 RSS。 */
  rssBytes: number;
  /** 主进程 PID。 */
  pid: number;
}

export interface IpcSnapshotData {
  header: IpcSnapshotHeader;
  sessions: SessionRow[];
}

export interface IpcRequest {
  id: string;
  cmd: "snapshot" | "ping" | "shutdown";
}

export interface IpcResponseOk<T = unknown> {
  id: string;
  ok: true;
  data: T;
}

export interface IpcResponseErr {
  id: string;
  ok: false;
  error: string;
}

export type IpcResponse<T = unknown> = IpcResponseOk<T> | IpcResponseErr;

export type SnapshotResponse = IpcResponseOk<IpcSnapshotData>;
export type PingResponse = IpcResponseOk<{ pong: true }>;
