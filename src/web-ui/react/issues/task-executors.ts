import type { TaskExecutionSubject, WandTaskAgent } from "../../../task-types";
import type { IssueSessionSummary } from "./task-board-repository";
import { issueAgentLabel, issueSessionRunning } from "./task-board-agent";

export interface TaskExecutor {
  key: string;
  employeeId?: string;
  name: string;
  avatar?: string;
  provider: string;
  engine?: "cli" | "sdk";
  state: "running" | "history" | "assigned";
  sessions: IssueSessionSummary[];
}

/** Identity comes from a stable employee binding, never inferred from a provider. */
export function taskExecutors(sessions: readonly IssueSessionSummary[], assigned: WandTaskAgent | null, subject?: TaskExecutionSubject | null,
  employees: readonly { id: string; name: string; avatar?: string }[] = [], assignee?: { id: string; name: string; avatar?: string } | null): TaskExecutor[] {
  const result = new Map<string, TaskExecutor>();
  for (const session of sessions) {
    const key = session.employeeId ? `employee:${session.employeeId}`
      : session.employeeName ? `legacy-employee:${session.employeeName}` : `tool:${session.provider}:${session.engine ?? "cli"}`;
    const employee = employees.find(item => item.id === session.employeeId);
    const current = result.get(key) ?? { key, employeeId: session.employeeId, name: employee?.name || session.employeeName || issueAgentLabel(session.provider, session.engine),
      avatar: employee?.avatar || session.employeeAvatar, provider: session.provider, engine: session.engine, state: "history", sessions: [] };
    current.sessions.push(session);
    if (issueSessionRunning(session.status)) current.state = "running";
    result.set(key, current);
  }
  if (subject?.type === "employee" && !result.has(`employee:${subject.id}`)) {
    const employee = employees.find(item => item.id === subject.id) ?? (assignee?.id === subject.id ? assignee : undefined);
    result.set(`employee:${subject.id}`, { key: `employee:${subject.id}`, employeeId: subject.id, name: employee?.name || "已指派员工（资料不可用）", avatar: employee?.avatar,
      provider: assigned?.provider ?? "", engine: assigned?.engine, state: "assigned", sessions: [] });
  } else if (subject?.type === "team") {
    result.set(`team:${subject.id}`, { key: `team:${subject.id}`, name: assignee?.id === subject.id ? assignee.name : "已指派团队", provider: "", state: "assigned", sessions: [] });
  } else if (!subject && !sessions.length && assigned || subject?.type === "cli" && !sessions.length && assigned) {
    result.set(`tool:${assigned!.provider}`, { key: `tool:${assigned!.provider}`, name: issueAgentLabel(assigned!.provider, assigned!.engine), provider: assigned!.provider, engine: assigned!.engine, state: "assigned", sessions: [] });
  }
  return [...result.values()];
}
