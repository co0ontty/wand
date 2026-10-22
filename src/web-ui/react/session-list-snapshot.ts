import type { WorkspaceSessionSummary } from "./workspaces/types";
import { requestJson } from "./http-adapter";
import { createQuerySnapshot } from "../query-snapshot";

/**
 * The raw `GET /api/sessions` list, shared by the legacy session engine and the
 * React conversation projection. Each consumer still applies its own merge and
 * selection rules; only transport and the last server payload are shared.
 */
const snapshot = createQuerySnapshot<WorkspaceSessionSummary[]>(async () => {
  const sessions = await requestJson<WorkspaceSessionSummary[]>("/api/sessions", { credentials: "same-origin" });
  if (!Array.isArray(sessions) || sessions.some((session) => !session || typeof session.id !== "string")) {
    throw new Error("Invalid session list response");
  }
  return sessions;
});

export function peekSessionList(): WorkspaceSessionSummary[] | null {
  return snapshot.peek();
}

export function loadSessionList(options?: { force?: boolean; maxAgeMs?: number }): Promise<WorkspaceSessionSummary[]> {
  return snapshot.load(options);
}

export function publishSessionList(sessions: WorkspaceSessionSummary[]): void {
  snapshot.publish(sessions);
}

/**
 * 服务端列表 DTO 的字段白名单。引擎侧的会话对象还带着本地输出缓冲和消息窗口，
 * 投影给 React 前先裁成 DTO 形状：共享快照只承载「列表」语义，不泄漏本地缓冲。
 */
const SUMMARY_FIELDS = [
  "automationId", "engine", "provider", "sessionKind", "runner", "command", "title", "titleGenerating",
  "status", "completionRevision", "viewedCompletionRevision", "cwd", "startedAt", "workspaceTaskId",
  "ptyBusy", "ptyCommandRunning", "archived", "archivedAt", "providerCliActive", "providerCliExitCode",
  "inFlight", "executionStatus", "queuedMessageCount", "canArchive", "employeeId", "employeeName", "employeeAvatar", "teamChat", "teamStep",
] as const;

/** 把引擎侧的合并态会话投影成服务端列表 DTO（只读字段白名单）。 */
export function projectSessionSummaries(sessions: readonly unknown[]): WorkspaceSessionSummary[] {
  const projected: WorkspaceSessionSummary[] = [];
  for (const entry of sessions) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    if (typeof source.id !== "string") continue;
    const summary: Record<string, unknown> = { id: source.id };
    for (const field of SUMMARY_FIELDS) {
      if (source[field] !== undefined) summary[field] = source[field];
    }
    projected.push(summary as unknown as WorkspaceSessionSummary);
  }
  return projected;
}

export function subscribeSessionList(listener: () => void): () => void {
  return snapshot.subscribe(listener);
}

export function invalidateSessionList(): void {
  snapshot.invalidate();
}

/**
 * 标记列表已过期：保留当前值给界面，但下一次读取必须重新访问服务端。
 * 用于「服务端可能已经变了」的信号（员工改名、会话归档、跨端变更）。
 */
export function markSessionListStale(): void {
  snapshot.stale();
}
