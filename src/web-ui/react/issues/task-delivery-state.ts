import type { TaskAcceptance, WandTask } from "../../../task-types";
import type { IssueSessionSummary } from "./task-board-repository";

type TaskDeliveryState = Pick<WandTask, "status" | "acceptance">;

/** Work is explicitly submitted for review; idle sessions and archival prove neither stage. */
export function taskWorkLabel(task: TaskDeliveryState): string {
  if (task.acceptance?.acceptedAt || task.status === "done") return "已完成";
  if (task.status === "doing") return "处理中";
  if (task.status === "backlog") return "待立项";
  if (task.status === "todo") return "未开始";
  return "未确认";
}

export function taskReviewLabel(task: TaskDeliveryState): string {
  if (task.acceptance?.acceptedAt) return "已通过";
  if (task.status === "done") return "等待你验收";
  return task.acceptance?.blocker.trim() ? "有待处理项" : "未验收";
}

/** Execution facts and explicit acceptance are orthogonal; never inspect model text. */
export function taskAcceptanceLabel(acceptance?: TaskAcceptance | null): string {
  if (acceptance?.acceptedAt) return "验收通过 · 已完成";
  if (acceptance?.blocker.trim()) return "待处理 · 有验收缺口";
  return acceptance?.evidence.trim() ? "交付已汇总 · 待验收" : "未验收 · 待汇总交付";
}

export function taskSessionActivity(session: IssueSessionSummary): string {
  if (session.archived) return "已归档";
  if (session.permissionBlocked) return "等待授权";
  if (["waiting-input", "waiting_input", "needs_input"].includes(session.status)) return "等待输入";
  // A live turn can also have queued follow-ups; the queue must not hide that turn.
  if (session.executionStatus === "running" || session.inFlight === true
    || session.inFlight === undefined && ["running", "thinking"].includes(session.status)) return "运行中";
  if (session.status === "failed") return "失败";
  if (["exited", "stopped"].includes(session.status)) return "已结束";
  if (session.executionStatus === "queued" || session.status === "queued") return "排队中";
  if (session.status === "idle") return "空闲";
  return "状态未确认";
}

export function taskSessionSummary(sessions: readonly IssueSessionSummary[]): string {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const state = taskSessionActivity(session);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label} ${count}`).join(" · ");
}
