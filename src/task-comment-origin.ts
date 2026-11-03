import type { TaskCommentOrigin } from "./task-types.js";

export function parseTaskCommentOrigin(value: unknown): TaskCommentOrigin | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (!["manual", "task_dispatch", "workflow", "system", "unknown"].includes(String(item.kind))
    || typeof item.taskId !== "string" || typeof item.taskIdentifier !== "string" || typeof item.commentId !== "string"
    || item.triggerName !== null && typeof item.triggerName !== "string"
    || item.entrySessionId != null && typeof item.entrySessionId !== "string") return undefined;
  return { kind: item.kind as TaskCommentOrigin["kind"], taskId: item.taskId, taskIdentifier: item.taskIdentifier,
    commentId: item.commentId, triggerName: item.triggerName as string | null, entrySessionId: item.entrySessionId as string | null | undefined };
}
