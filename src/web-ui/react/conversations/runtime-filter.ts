import { isSessionJustCompleted } from "../../../session-completion-state.js";
import { isSessionActive, isSessionAttention, isSessionQueued, isSessionRunning } from "../workspaces/sidebar-display-mode";
import type { WorkspaceSessionSummary } from "../workspaces/types";

/**
 * 胶囊里的状态项 = 侧栏会话行会显示的全部状态，一个不多一个不少：
 * 需要我确认（等你授权/回答）、运行中（含思考中与刚完成未查看）、排队中、
 * 空闲（本轮跑完等下次输入）、已结束（进程退出或被停止）、运行失败。
 * 服务端只产出 idle/running/exited/stopped/failed，其余由 pendingEscalation、
 * executionStatus 与完成回执投影出来，这里按投影后的口径分组，不另造状态。
 * 「全部」不含已归档：归档是软删除，默认退出列表，只在用户显式勾选「已归档」时回来。
 */
export const SESSION_RUNTIME_OPTIONS = [
  { value: "confirmation", label: "需要我确认", icon: "messageWarning" },
  { value: "running", label: "运行中", icon: "activity" },
  { value: "queued", label: "排队中", icon: "clock" },
  { value: "idle", label: "空闲", icon: "circle" },
  { value: "finished", label: "已结束", icon: "stop" },
  { value: "failed", label: "运行失败", icon: "circleX" },
  { value: "archived", label: "已归档", icon: "archive" },
  { value: "all", label: "全部", icon: "layers" },
] as const;
type RuntimeValue = typeof SESSION_RUNTIME_OPTIONS[number]["value"];
/** 旧链接/旧本地状态里的粗粒度别名仍然可读，读进来就归一到上面的选项。 */
export type SessionRuntimeFilter = RuntimeValue | "working" | "active" | "attention" | "approval" | "waiting" | `${RuntimeValue}|${string}`;
export function runtimeSelections(value: unknown): RuntimeValue[] {
  if (typeof value !== "string" || value === "all") return [];
  const values = value.split("|").flatMap(item => item === "working" || item === "active" ? ["running", "queued"]
    : ["attention", "approval", "waiting"].includes(item) ? ["confirmation"] : [item]);
  return SESSION_RUNTIME_OPTIONS.filter(option => option.value !== "all" && values.includes(option.value)).map(option => option.value);
}
export function normalizeSessionRuntime(value: unknown): SessionRuntimeFilter {
  return (runtimeSelections(value).join("|") || "all") as SessionRuntimeFilter;
}
export function toggleSessionRuntime(value: SessionRuntimeFilter | undefined, option: RuntimeValue): SessionRuntimeFilter {
  if (option === "all") return "all";
  const selected = runtimeSelections(value);
  return normalizeSessionRuntime((selected.includes(option) ? selected.filter(item => item !== option) : [...selected, option]).join("|"));
}
export function sessionRuntimeLabel(value: SessionRuntimeFilter = "all"): string {
  const selected = runtimeSelections(value);
  return selected.length ? SESSION_RUNTIME_OPTIONS.filter(option => selected.includes(option.value)).map(option => option.label).join("、") : "全部";
}
export function isSessionNeedsConfirmation(session: WorkspaceSessionSummary): boolean {
  return !session.archived && ["permission-blocked", "permission", "waiting-input", "waiting_input"].includes(session.status ?? "");
}
/** The existing activity owner decides running/attention/queued; an open CLI is not running work. */
export function matchesSessionRuntime(session: WorkspaceSessionSummary, value: SessionRuntimeFilter = "all"): boolean {
  if (value.includes("|")) return runtimeSelections(value).some(option => matchesSessionRuntime(session, option));
  if (value === "confirmation") return isSessionNeedsConfirmation(session);
  if (value === "working") return !session.archived && !isSessionAttention(session) && !isSessionNeedsConfirmation(session)
    && (isSessionQueued(session) || isSessionJustCompleted(session) || !["exited", "stopped"].includes(session.status ?? "") && isSessionRunning(session));
  if (value === "all") return !session.archived;
  if (value === "archived") return session.archived === true;
  if (value === "failed") return session.status === "failed";
  if (value === "finished") return session.status === "exited" || session.status === "stopped";
  if (session.archived) return false;
  if (value === "active") return isSessionActive(session);
  if (value === "running") return !isSessionQueued(session) && !isSessionAttention(session) && !isSessionNeedsConfirmation(session) && (isSessionJustCompleted(session) || session.status !== "exited" && session.status !== "stopped" && isSessionRunning(session));
  if (value === "attention") return isSessionAttention(session);
  if (value === "approval") return session.status === "permission-blocked";
  if (value === "waiting") return session.status === "waiting-input" || session.status === "waiting_input";
  if (value === "queued") return isSessionQueued(session);
  if (value === "idle") return !isSessionRunning(session) && !isSessionAttention(session) && !isSessionQueued(session)
    && !isSessionJustCompleted(session) && (session.status === "idle" || session.status === "running");
  return false;
}
