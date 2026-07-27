/**
 * 把主进程当前状态打包成 IPC snapshot。
 *
 * 这里同时被 IPC 服务端（远端 attach 客户端拉数据）调用。本地 TUI 仍然直接读
 * processManager / structuredSessions（避免一次额外的对象拷贝）。
 */

import { SessionSnapshot } from "../types.js";
import { IpcSnapshotData, IpcSnapshotHeader } from "./ipc-protocol.js";
import { formatSession, sortRows } from "./session-formatter.js";

export interface SnapshotInputs {
  version: string;
  url: string;
  scheme: "HTTP" | "HTTPS";
  bindAddr: string;
  configPath: string;
  dbPath: string;
  orphanRecoveredCount: number;
  startedAtMs: number;
  pid: number;
  processManager: { listSlim(): SessionSnapshot[] };
  structuredSessions: { listSlim(): SessionSnapshot[] };
}

export function buildSnapshotData(inputs: SnapshotInputs): IpcSnapshotData {
  const ptyList = inputs.processManager.listSlim();
  let structuredList: SessionSnapshot[] = [];
  try { structuredList = inputs.structuredSessions.listSlim(); } catch { /* noop */ }

  const seen = new Set<string>();
  const merged: SessionSnapshot[] = [];
  for (const s of ptyList) { seen.add(s.id); merged.push(s); }
  for (const s of structuredList) { if (!seen.has(s.id)) merged.push(s); }
  const sorted = sortRows(merged);

  let active = 0, archived = 0;
  for (const s of sorted) {
    if (s.archived) archived += 1;
    else if (s.status === "running") active += 1;
  }

  const header: IpcSnapshotHeader = {
    version: inputs.version,
    url: inputs.url,
    scheme: inputs.scheme,
    bindAddr: inputs.bindAddr,
    configPath: inputs.configPath,
    dbPath: inputs.dbPath,
    orphanRecoveredCount: inputs.orphanRecoveredCount,
    sessionCounts: { active, archived, total: sorted.length },
    startedAtMs: inputs.startedAtMs,
    rssBytes: safeRss(),
    pid: inputs.pid,
  };

  return {
    header,
    sessions: sorted.map((s) => formatSession(s)),
  };
}

function safeRss(): number {
  try { return process.memoryUsage().rss; } catch { return 0; }
}
