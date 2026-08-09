import type { WorkspaceSessionSummary } from "./types";

/** 工作区内统一使用的 provider 展示名，保证单窗格与分屏标签一致。 */
export function workspaceProviderLabel(provider?: string): string {
  switch (provider) {
    case "claude": return "Claude";
    case "codex": return "Codex";
    case "opencode": return "OpenCode";
    case "grok": return "Grok";
    case "qoder": return "Qoder";
    case "pi": return "Pi";
    default: return "终端";
  }
}

/**
 * 服务端会话列表按最近更新时间返回，但编辑器式标签必须保持创建顺序，避免每次新增后
 * 已有标签被重新编号、位置整体跳动。时间缺失或相同时保留服务端原始相对顺序。
 */
export function orderWorkspaceSessions(
  sessions: readonly WorkspaceSessionSummary[],
): WorkspaceSessionSummary[] {
  return sessions
    .map((session, index) => ({ session, index, startedAt: Date.parse(session.startedAt || "") }))
    .sort((left, right) => {
      const leftHasTime = Number.isFinite(left.startedAt);
      const rightHasTime = Number.isFinite(right.startedAt);
      if (leftHasTime && rightHasTime && left.startedAt !== right.startedAt) {
        return left.startedAt - right.startedAt;
      }
      if (leftHasTime !== rightHasTime) return leftHasTime ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ session }) => session);
}

export function workspaceSessionLabel(session: WorkspaceSessionSummary, index: number): string {
  const title = (session.title || "").trim();
  return title || `${workspaceProviderLabel(session.provider)} ${index + 1}`;
}
