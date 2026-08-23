import { inferProviderIdFromCommand } from "../../provider-identity";
import type { WorkspaceProvider, WorkspaceSessionSummary } from "./types";

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

/** 任务列表 / 标签栏用：缺 provider 时从启动命令回推 CLI。 */
export function workspaceSessionProvider(
  session: { provider?: string; command?: string },
): WorkspaceProvider | undefined {
  if (
    session.provider === "claude"
    || session.provider === "codex"
    || session.provider === "opencode"
    || session.provider === "grok"
    || session.provider === "qoder"
    || session.provider === "pi"
  ) {
    return session.provider;
  }
  return inferProviderIdFromCommand(session.command) ?? undefined;
}

function sessionCwdLeaf(session: Pick<WorkspaceSessionSummary, "cwd">): string {
  return (session.cwd || "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).at(-1) || "";
}

function isGenericSessionTitle(
  session: Pick<WorkspaceSessionSummary, "title" | "cwd">,
  parentNames: readonly string[] = [],
): boolean {
  const title = (session.title || "").trim();
  if (!title) return true;
  const leaf = sessionCwdLeaf(session);
  if (leaf && title.toLowerCase() === leaf.toLowerCase()) return true;
  return parentNames.some((name) => name.toLowerCase() === title.toLowerCase());
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
  if (!isGenericSessionTitle(session)) return (session.title || "").trim();
  return `${workspaceProviderLabel(workspaceSessionProvider(session))} ${index + 1}`;
}

/** 侧栏列表用：目录名/路径叶子不要再当终端标题，避免三层都叫同一个文件夹名。 */
export function listSessionLabel(
  session: WorkspaceSessionSummary,
  index: number,
  parentNames: readonly string[] = [],
): string {
  if (!isGenericSessionTitle(session, parentNames)) return (session.title || "").trim();
  return `${workspaceProviderLabel(workspaceSessionProvider(session))} ${index + 1}`;
}
