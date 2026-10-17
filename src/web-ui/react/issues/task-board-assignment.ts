import { DEFAULT_EMPLOYEE_ID } from "../../../employee-types";
import { isTaskExecutionSubject, type TaskExecutionSubject, type WandTaskAgent } from "../../../task-types";
import { createDefaultIssueAgent, isDispatchableIssueAgent, isIssueAgentProvider, resolveIssueAgent } from "./task-board-agent";

export interface IssueAssignment {
  agent: WandTaskAgent;
  subject: TaskExecutionSubject;
}

const STORAGE_KEY = "wand.task-board.last-assignment";

/** Recent UI choice is device-local; it never changes the server's new-task defaults. */
export function parseIssueAssignment(value: unknown): IssueAssignment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<IssueAssignment>;
  if (!isDispatchableIssueAgent(item.agent) || !isTaskExecutionSubject(item.subject)) return null;
  const agent = resolveIssueAgent(null, item.agent);
  const subject = { type: item.subject.type, id: item.subject.id.trim() };
  if (!subject.id || (subject.type === "cli" && subject.id !== agent.provider)) return null;
  return { agent, subject };
}

export function readIssueAssignment(): IssueAssignment | null {
  try {
    return parseIssueAssignment(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return null;
  }
}

export function writeIssueAssignment(assignment: IssueAssignment): void {
  const next = parseIssueAssignment(assignment);
  if (!next) return;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
  catch { /* The host keeps the current choice in memory when storage is unavailable. */ }
}

/** Task configuration wins; otherwise use the last assignment, then explicit server defaults. */
export function resolveIssueAssignment(
  task: { agent?: WandTaskAgent | null; executionSubject?: TaskExecutionSubject | null },
  recent: IssueAssignment | null,
  defaults: WandTaskAgent,
  available: {
    employees: readonly { id: string; archivedAt?: string | null }[] | null;
    teams: readonly { id: string }[] | null;
  },
): IssueAssignment {
  const configuredAgent = isDispatchableIssueAgent(task.agent) ? task.agent : null;
  const configuredSubject = isTaskExecutionSubject(task.executionSubject)
    && (task.executionSubject.type !== "cli" || isIssueAgentProvider(task.executionSubject.id))
    ? task.executionSubject : null;
  const agent = configuredAgent ? resolveIssueAgent(configuredAgent)
    : configuredSubject?.type === "cli" && isIssueAgentProvider(configuredSubject.id)
      ? createDefaultIssueAgent(configuredSubject.id)
      : resolveIssueAgent(null, recent?.agent ?? defaults);
  const subject = configuredSubject ?? (configuredAgent
    ? { type: "cli" as const, id: agent.provider }
    : recent?.subject ?? (available.employees?.some(item => item.id === DEFAULT_EMPLOYEE_ID && !item.archivedAt)
      ? { type: "employee" as const, id: DEFAULT_EMPLOYEE_ID } : { type: "cli" as const, id: agent.provider }));
  // null means still loading/failed: don't discard a stable ID before its catalog arrives.
  const unavailable = subject.type === "employee"
    ? available.employees !== null && !available.employees.some((item) => item.id === subject.id && !item.archivedAt)
    : subject.type === "team"
      && available.teams !== null && !available.teams.some((item) => item.id === subject.id);
  if (unavailable && configuredSubject) return { agent, subject };
  if (unavailable) {
    const fallback = resolveIssueAgent(configuredAgent, defaults);
    return { agent: fallback, subject: { type: "cli", id: fallback.provider } };
  }
  return { agent, subject };
}
