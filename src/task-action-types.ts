/** Read-only navigation projection; not a task status, queue, or mutation protocol. */
export type TaskActionKind = "permission" | "question" | "plan" | "reply" | "review" | "blocker";
export interface TaskActionItem {
  key: string;
  taskId: string;
  identifier: string;
  title: string;
  workspaceId: string | null;
  kind: TaskActionKind;
  reason: string;
  source: {
    sessionId?: string;
    requestId?: string;
    toolId?: string;
    runId?: string;
  };
}
export interface TaskActionsSnapshot {
  items: TaskActionItem[];
  /** Non-zero means counts are lower bounds, never a verified empty inbox. */
  incompleteSources: number;
}
