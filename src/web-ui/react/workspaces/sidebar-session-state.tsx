import * as React from "react";
import { isSessionJustCompleted } from "../../../session-completion-state.js";
import { WandIcon, type WandIconName } from "../ui";
import { isSessionAttention, isSessionRunning } from "./sidebar-display-mode";
import type { WorkspaceSessionSummary } from "./types";

export interface SidebarSessionState {
  label: string;
  icon: WandIconName;
  tone: "warning" | "accent" | "success" | "muted";
  spinning?: boolean;
}

export type GlowStatus =
  | "running"
  | "thinking"
  | "permission"
  | "waiting-input"
  | "reconnecting"
  | "failed"
  | "just-completed"
  | "none";

/** Shared Ant Badge colors for the existing activity projection. */
export function sidebarGlowColor(status: GlowStatus): string | undefined {
  if (status === "none") return undefined;
  if (status === "failed") return "var(--danger, #b24f45)";
  if (status === "permission" || status === "waiting-input" || status === "reconnecting") return "var(--warning, #a96a2f)";
  if (status === "thinking") return "var(--info, #4a6fa5)";
  return "var(--success, #4f7a58)";
}

/** 计算左侧 Logo 的呼吸灯状态 */
export function sessionGlowStatus(session: {
  status?: string;
  permissionBlocked?: boolean;
  inFlight?: boolean;
  turnActive?: boolean;
  ptyBusy?: boolean;
  ptyCommandRunning?: boolean;
  sessionKind?: string;
  runner?: string;
  provider?: string;
  providerCliActive?: boolean;
  completionRevision?: number;
  viewedCompletionRevision?: number;
}): GlowStatus {
  if (session.permissionBlocked || session.status === "permission-blocked") {
    return "permission";
  }
  if (session.status === "waiting-input" || session.status === "waiting_input") {
    return "waiting-input";
  }
  if (session.status === "reconnecting") {
    return "reconnecting";
  }
  if (session.status === "failed") {
    return "failed";
  }
  if (isSessionRunning(session as WorkspaceSessionSummary)) {
    return session.status === "thinking" ? "thinking" : "running";
  }
  if (isSessionJustCompleted(session as WorkspaceSessionSummary)) {
    return "just-completed";
  }
  return "none";
}

/** Read-only sidebar projection; CLI liveness is not turn activity. */
export function sidebarSessionState(session: WorkspaceSessionSummary): SidebarSessionState {
  switch (session.status) {
    case "failed": return { label: "失败", icon: "warning", tone: "warning" };
    case "permission-blocked": return { label: "等待授权", icon: "shield", tone: "warning" };
    case "waiting-input":
    case "waiting_input": return { label: "等待回答", icon: "question", tone: "warning" };
    case "reconnecting": return { label: "重连中", icon: "refresh", tone: "warning" };
  }
  if (isSessionRunning(session)) {
    return session.status === "thinking"
      ? { label: "思考中", icon: "brain", tone: "accent" }
      : { label: "运行中", icon: "refresh", tone: "accent", spinning: true };
  }
  if (isSessionJustCompleted(session)) return { label: "刚完成", icon: "check", tone: "success" };
  switch (session.status) {
    case "exited": return { label: "已结束", icon: "stop", tone: "muted" };
    case "stopped": return { label: "已停止", icon: "stop", tone: "muted" };
    case "idle":
    case "running": return { label: "空闲", icon: "circle", tone: "muted" };
    default: return { label: "状态未知", icon: "question", tone: "muted" };
  }
}

export function sidebarAggregateState(sessions: readonly WorkspaceSessionSummary[]): {
  label: string;
  description: string;
  tone: SidebarSessionState["tone"];
} {
  const attention = sessions.filter(isSessionAttention).length;
  const running = sessions.filter(isSessionRunning).length;
  const completed = sessions.filter((session) => !isSessionAttention(session)
    && !isSessionRunning(session) && isSessionJustCompleted(session)).length;
  return {
    label: attention ? "待处理" : running ? "运行中" : completed ? "刚完成" : "",
    tone: attention ? "warning" : running ? "accent" : completed ? "success" : "muted",
    description: `当前匹配 ${sessions.length} 个会话，${attention} 个待处理，${running} 个运行中，${completed} 个刚完成`,
  };
}

export function SidebarSessionGlyph({ state }: { state: SidebarSessionState }): React.ReactElement {
  return <span className={`sidebar-session-state tone-${state.tone}`} role="img"
    aria-label={state.label} title={state.label}>
    <WandIcon name={state.icon} size={14} className={state.spinning ? "is-spinning" : undefined}/>
  </span>;
}
