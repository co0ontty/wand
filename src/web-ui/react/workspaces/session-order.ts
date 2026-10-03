import { inferProviderIdFromCommand } from "../../provider-identity";
import { teamChatLabel, teamStepLabel } from "./team-sessions";
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
    case "gemini": return "Gemini";
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
    || session.provider === "gemini"
  ) {
    return session.provider;
  }
  return inferProviderIdFromCommand(session.command) ?? undefined;
}

/**
 * 系统自己生成的占位标题（空、占位词、裸 provider 名、`CLI N`）不是会话标题。
 * 任务名 / 工作区名重复**不算**占位：那正是会话自己的标题，显示它比「Pi 1」有意义。
 */
function isPlaceholderSessionTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return !normalized
    || normalized === "会话"
    || normalized === "wand 会话"
    || normalized === "claude"
    || normalized === "codex"
    || normalized === "opencode"
    || normalized === "grok"
    || normalized === "qoder"
    || normalized === "pi"
    || normalized === "gemini"
    || normalized === "终端"
    || /^(claude|codex|opencode|grok|qoder|pi|gemini|终端)\s+\d+$/i.test(normalized);
}

/**
 * 目录名不是会话标题：旧版终端把 cwd 末段当标题，客户端仍然要挡住。
 */
function isDirectoryFallbackTitle(session: Pick<WorkspaceSessionSummary, "title" | "cwd">): boolean {
  const title = (session.title || "").trim().toLowerCase();
  const leaf = (session.cwd || "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).at(-1)?.toLowerCase() ?? "";
  return Boolean(leaf) && title === leaf;
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

/**
 * 侧栏 / 详情共用：有会话标题就显示标题；只有占位标题 / 目录名兜底时回退「CLI 序号」。
 * 标题和任务名 / 工作区名重复也照显示——最新会话的标题常常正好等于任务首行。
 */
export function listSessionLabel(
  session: WorkspaceSessionSummary,
  index: number,
): string {
  const title = (session.title || "").trim();
  if (!isPlaceholderSessionTitle(title) && !isDirectoryFallbackTitle(session)) return title;
  return `${workspaceProviderLabel(workspaceSessionProvider(session))} ${index + 1}`;
}

/**
 * 侧栏行标题的唯一入口：团队条目用步骤标题 / 任务处理群名，
 * 其余走会话标题 + 「CLI N」兜底。
 */
export function sidebarSessionLabel(
  session: WorkspaceSessionSummary,
  index: number,
  liveTitle?: string,
): string {
  if (session.teamStep) return teamStepLabel(session.teamStep);
  if (session.teamChat) return teamChatLabel(session);
  return listSessionLabel(withLiveSessionTitle(session, liveTitle), index);
}

/** WS / 提交时带过来的实时标题：只挡占位词与目录名兜底，任务名重复的标题照用。 */
export function withLiveSessionTitle<T extends { title?: string; cwd?: string }>(
  session: T,
  liveTitle?: string,
): T {
  const title = (liveTitle || "").trim();
  if (isPlaceholderSessionTitle(title) || isDirectoryFallbackTitle({ ...session, title })) return session;
  return { ...session, title };
}
