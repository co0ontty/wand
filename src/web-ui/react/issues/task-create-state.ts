import type { TaskExecutionSubject, WandTaskAgent, WandTaskPriority, WandTaskStatus } from "../../../task-types";

export interface TaskCreationDraft {
  workspaceId: string;
  cwd: string;
  title: string;
  status: WandTaskStatus;
  priority: WandTaskPriority;
  dueDate: string;
  labels: string;
  milestoneId: string;
  parentTaskId: string;
  agent: WandTaskAgent;
  subject: TaskExecutionSubject;
  employeeOverride: boolean;
}

/** Only explicit HTTP rejection proves that creation was not accepted. */
export function unknownTaskCreation(cause: unknown): boolean {
  const status = (cause as { status?: number })?.status;
  return !status || status < 400 || status >= 500 || status === 408 || status === 409;
}

/** The sole task-create payload; execution remains a separate explicit action. */
export function taskCreationRequest(draft: TaskCreationDraft, description: string, rememberDefaults: boolean) {
  const { agentOverride: _previousOverride, ...identity } = draft.subject;
  const executionSubject = draft.subject.type === "employee" && draft.employeeOverride
    ? { ...identity, agentOverride: draft.agent } : identity;
  return { workspaceId: draft.workspaceId || null,
    cwd: draft.cwd.trim() || undefined,
    title: draft.title.trim(), description: description.trim(), status: draft.status, priority: draft.priority,
    labels: draft.labels.split(/[,，]/).map(label => label.trim()).filter(Boolean), dueDate: draft.dueDate || null,
    milestoneId: draft.milestoneId || null, parentTaskId: draft.parentTaskId || null,
    ...(executionSubject.type === "cli" ? { agent: draft.agent } : {}), executionSubject,
    rememberAgentDefaults: executionSubject.type === "cli" && rememberDefaults,
  };
}
