import type { ConversationReceipt } from "./conversation-types.js";

export type TaskSchedule =
  | { kind: "once"; runAt: string }
  | { kind: "daily"; time: string; timeZone: string }
  | { kind: "weekly"; time: string; timeZone: string; weekday: number };

export interface ScheduledTask {
  id: string;
  creationFingerprint: string;
  title: string;
  employeeId: string;
  /** Omitted or null on legacy plans means the service default directory. */
  workspaceId?: string | null;
  prompt: string;
  schedule: TaskSchedule;
  enabled: boolean;
  nextRunAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
}

export interface ScheduledTaskInput {
  requestId: string;
  title?: string;
  employeeId: string;
  workspaceId?: string | null;
  prompt: string;
  schedule: TaskSchedule;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  requestId: string;
  scheduledAt: string;
  claimedAt: string;
  executionFinishedAt: string | null;
  executionOutcome?: "completed" | "failed" | "unknown";
  employeeId: string;
  /** Immutable execution target, captured for this occurrence before dispatch. */
  workspaceId?: string | null;
  cwd?: string | null;
  prompt: string;
  state: "claimed" | "accepted" | "rejected" | "unknown" | "skipped";
  receipt: ConversationReceipt | null;
  error: string | null;
}

export interface ScheduledTaskRunView extends ScheduledTaskRun {
  executionStatus: "pending" | "running" | "completed" | "failed" | "unknown" | "skipped";
  sessionId: string | null;
}

export interface ScheduledTaskSummary extends ScheduledTask {
  employeeName: string;
  employeeUnavailableReason: string | null;
  workspaceName: string;
  workspaceCwd: string | null;
  workspaceUnavailableReason: string | null;
  lastRun: ScheduledTaskRunView | null;
}

export interface ScheduledTaskDetail {
  task: ScheduledTaskSummary;
  runs: ScheduledTaskRunView[];
}

/** Bounded read projections deliberately exclude prompts, receipts and request IDs. */
export type ScheduledTaskRunFactView = Pick<ScheduledTaskRunView,
  "id" | "taskId" | "scheduledAt" | "claimedAt" | "executionFinishedAt" | "executionOutcome" |
  "employeeId" | "workspaceId" | "cwd" | "state" | "error" | "executionStatus" | "sessionId">;
export type ScheduledTaskRunFact = Omit<ScheduledTaskRun, "prompt">;

export interface ScheduledTaskReadRange {
  from: string;
  to: string;
  timeZone: string;
  complete: boolean;
  truncated: boolean;
  limit: number;
  invalidDates: number;
}
export type ScheduledCalendarItem = {
  key: string; taskId: string; at: string; date: string; minuteOfDay: number;
} & ({ kind: "planned"; waiting: boolean } | { kind: "execution"; waiting: false; run: ScheduledTaskRunFactView });
export interface ScheduledTaskCalendarResponse {
  tasks: ScheduledTaskSummary[];
  entries: ScheduledCalendarItem[];
  range: ScheduledTaskReadRange;
  generatedAt: string;
  issues: string[];
}
export interface ScheduledTaskActivityResponse {
  runs: ScheduledTaskRunFactView[];
  range: ScheduledTaskReadRange;
  generatedAt: string;
}
