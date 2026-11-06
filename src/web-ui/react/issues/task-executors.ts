import type { TaskExecutionSubject, WandTaskAgent } from "../../../task-types";
import type { IssueSessionSummary } from "./task-board-repository";
import { taskSessionActivity, taskSessionIsRunning } from "./task-delivery-state";
import { issueAgentLabel } from "./task-board-agent";

export interface TaskExecutor {
  key: string;
  employeeId?: string;
  name: string;
  avatar?: string;
  provider: string;
  engine?: "cli" | "sdk";
  state: "running" | "current" | "history" | "assigned";
  activity?: string;
  configured?: boolean;
  sessions: IssueSessionSummary[];
}

/** Identity comes from a stable employee binding, never inferred from a provider. */
export function taskExecutors(sessions: readonly IssueSessionSummary[], assigned: WandTaskAgent | null, subject?: TaskExecutionSubject | null,
  employees: readonly { id: string; name: string; avatar?: string }[] = [], assignee?: { id: string; name: string; avatar?: string } | null): TaskExecutor[] {
  const result = new Map<string, TaskExecutor>();
  const snapshots = new Map<string, { name?: string; avatar?: string }>();
  for (const session of sessions) {
    if (!session.employeeId) continue;
    const previous = snapshots.get(session.employeeId);
    snapshots.set(session.employeeId, { name: session.employeeName || previous?.name, avatar: session.employeeAvatar || previous?.avatar });
  }
  for (const session of sessions) {
    const key = session.employeeId ? `employee:${session.employeeId}`
      : session.employeeName ? `legacy-employee:${session.employeeName}` : `tool:${session.provider}:${session.engine ?? "cli"}`;
    const employee = employees.find(item => item.id === session.employeeId);
    const boundAssignee = assignee?.id === session.employeeId ? assignee : undefined;
    const snapshot = session.employeeId ? snapshots.get(session.employeeId) : undefined;
    const current = result.get(key) ?? { key, employeeId: session.employeeId,
      name: employee?.name || boundAssignee?.name || snapshot?.name || session.employeeName
        || (session.employeeId ? "员工（资料不可用）" : issueAgentLabel(session.provider, session.engine)),
      avatar: employee?.avatar || boundAssignee?.avatar || snapshot?.avatar || session.employeeAvatar,
      provider: session.provider, engine: session.engine, state: "history", sessions: [] };
    current.sessions.push(session);
    current.configured = subject?.type === "employee" && subject.id === session.employeeId
      || (!subject || subject.type === "cli") && !session.employeeId && !session.employeeName
        && (subject?.id ?? assigned?.provider) === session.provider
        && (assigned?.engine ?? "cli") === (session.engine ?? "cli");
    result.set(key, current);
  }
  // Aggregate after grouping: array order must not let an idle session hide work or approval.
  const activityOrder = ["运行中", "等待授权", "等待输入", "失败", "排队中", "空闲", "已停止", "已结束", "状态未确认"];
  for (const executor of result.values()) {
    const live = executor.sessions.filter(session => !session.archived && (session.source === "structured" || session.source === "pty"));
    executor.state = live.some(taskSessionIsRunning) ? "running" : live.length || executor.configured ? "current" : "history";
    executor.activity = live.length ? [...new Set(live.map(taskSessionActivity))]
      .sort((a, b) => activityOrder.indexOf(a) - activityOrder.indexOf(b)).join(" / ") : "当前活动未确认";
  }
  if (subject?.type === "employee" && !result.has(`employee:${subject.id}`)) {
    const employee = employees.find(item => item.id === subject.id) ?? (assignee?.id === subject.id ? assignee : undefined);
    result.set(`employee:${subject.id}`, { key: `employee:${subject.id}`, employeeId: subject.id, name: employee?.name || "已指派员工（资料不可用）", avatar: employee?.avatar,
      provider: assigned?.provider ?? "", engine: assigned?.engine, state: "assigned", sessions: [] });
  } else if (subject?.type === "team") {
    result.set(`team:${subject.id}`, { key: `team:${subject.id}`, name: assignee?.id === subject.id ? assignee.name : "已指派团队", provider: "", state: "assigned", sessions: [] });
  } else if ((!subject || subject.type === "cli") && (assigned || subject?.id)) {
    const provider = subject?.id ?? assigned!.provider;
    const key = `tool:${provider}:${assigned?.engine ?? "cli"}`;
    if (!result.has(key)) result.set(key, { key, name: issueAgentLabel(provider, assigned?.engine), provider,
      engine: assigned?.engine, state: "assigned", sessions: [] });
  }
  // The current assignee must remain visible even when three historical executors fill the card.
  const currentKey = subject?.type === "cli" || !subject && assigned
    ? `tool:${subject?.id ?? assigned!.provider}:${assigned?.engine ?? "cli"}` : subject ? `${subject.type}:${subject.id}` : null;
  return [...result.values()].sort((a, b) => Number(b.key === currentKey) - Number(a.key === currentKey));
}

/** Tools are execution metadata, not the employee's identity (including SDK vs CLI). */
export function taskExecutorToolLabels(executor: TaskExecutor): string[] {
  return [...new Set((executor.sessions.length ? executor.sessions : [executor])
    .filter(item => item.provider).map(item => issueAgentLabel(item.provider, item.engine)))];
}
