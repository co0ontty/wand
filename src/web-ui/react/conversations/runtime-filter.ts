import { isSessionActive, isSessionAttention, isSessionQueued, isSessionRunning } from "../workspaces/sidebar-display-mode";
import type { WorkspaceSessionSummary } from "../workspaces/types";

export const SESSION_RUNTIME_OPTIONS = [
  { value: "confirmation", label: "需要我确认", icon: "messageWarning" },
  { value: "working", label: "运行中 / 排队中", icon: "activity" },
  { value: "all", label: "全部", icon: "layers" },
  { value: "failed", label: "运行失败", icon: "circleX" },
] as const;
// Retain older deep-link values; new selections use the four categories above.
export type SessionRuntimeFilter = typeof SESSION_RUNTIME_OPTIONS[number]["value"]
  | "active" | "running" | "attention" | "approval" | "waiting" | "queued" | "idle" | "finished";
export function normalizeSessionRuntime(value: unknown): SessionRuntimeFilter {
  if (SESSION_RUNTIME_OPTIONS.some(option => option.value === value)) return value as SessionRuntimeFilter;
  if (value === "active" || value === "running" || value === "queued") return "working";
  if (value === "attention" || value === "approval" || value === "waiting") return "confirmation";
  return "all";
}
export function sessionRuntimeLabel(value: SessionRuntimeFilter = "all"): string {
  return SESSION_RUNTIME_OPTIONS.find(option => option.value === normalizeSessionRuntime(value))?.label ?? "全部";
}
export function isSessionNeedsConfirmation(session: WorkspaceSessionSummary): boolean {
  return !session.archived && ["permission-blocked", "permission", "waiting-input", "waiting_input"].includes(session.status ?? "");
}
/** The existing activity owner decides running/attention/queued; an open CLI is not running work. */
export function matchesSessionRuntime(session: WorkspaceSessionSummary, value: SessionRuntimeFilter = "all"): boolean {
  if (value === "confirmation") return isSessionNeedsConfirmation(session);
  if (value === "working") return !session.archived && !isSessionAttention(session) && !isSessionNeedsConfirmation(session)
    && (isSessionQueued(session) || !["exited", "stopped"].includes(session.status ?? "") && isSessionRunning(session));
  if (value === "all") return true;
  if (value === "failed") return session.status === "failed";
  if (value === "finished") return session.status === "exited" || session.status === "stopped";
  if (session.archived) return false;
  if (value === "active") return isSessionActive(session);
  if (value === "running") return !isSessionAttention(session) && session.status !== "exited" && session.status !== "stopped" && isSessionRunning(session);
  if (value === "attention") return isSessionAttention(session);
  if (value === "approval") return session.status === "permission-blocked";
  if (value === "waiting") return session.status === "waiting-input" || session.status === "waiting_input";
  if (value === "queued") return isSessionQueued(session);
  return !isSessionRunning(session) && !isSessionAttention(session) && !isSessionQueued(session)
    && (session.status === "idle" || session.status === "running");
}
