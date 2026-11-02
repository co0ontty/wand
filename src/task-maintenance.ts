import { HttpError } from "./http-error.js";

/** Owner-requested cancellation is separate from delivery acceptance. */
export interface TaskMaintenanceInput {
  action: "cancel" | "close";
  requestId: string;
  expectedUpdatedAt: string;
  reason: string;
  kind?: "obsolete" | "duplicate";
  duplicateTaskId?: string;
  commentId?: string;
  expectedQueuedCommentIds?: string[];
}

export function parseTaskMaintenanceInput(value: unknown): TaskMaintenanceInput {
  const invalid = (): never => { throw new HttpError(400, "bad_request", "需要取消/关闭动作、唯一请求标识、当前任务版本和明确原因；重复关闭须指定保留任务。"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["action", "requestId", "expectedUpdatedAt", "reason", "kind", "duplicateTaskId", "commentId", "expectedQueuedCommentIds"].includes(key))) return invalid();
  if ((body.action !== "cancel" && body.action !== "close") || typeof body.requestId !== "string"
    || !/^[a-zA-Z0-9:_-]{8,80}$/.test(body.requestId) || typeof body.expectedUpdatedAt !== "string"
    || !Number.isFinite(Date.parse(body.expectedUpdatedAt)) || typeof body.reason !== "string"
    || !body.reason.trim() || body.reason.length > 4000) return invalid();
  if (body.action === "cancel") {
    if (typeof body.commentId !== "string" || !body.commentId.trim() || body.kind !== undefined || body.duplicateTaskId !== undefined || body.expectedQueuedCommentIds !== undefined) return invalid();
  } else if (body.commentId !== undefined || (body.kind !== "obsolete" && body.kind !== "duplicate")
    || (body.kind === "duplicate" ? typeof body.duplicateTaskId !== "string" || !body.duplicateTaskId.trim() : body.duplicateTaskId !== undefined)) return invalid();
  if (body.action === "close" && (!Array.isArray(body.expectedQueuedCommentIds) || body.expectedQueuedCommentIds.length > 1000
    || body.expectedQueuedCommentIds.some(id => typeof id !== "string" || !id.trim())
    || new Set(body.expectedQueuedCommentIds).size !== body.expectedQueuedCommentIds.length)) return invalid();
  return { ...body, reason: body.reason.trim(), ...(Array.isArray(body.expectedQueuedCommentIds) ? { expectedQueuedCommentIds: [...body.expectedQueuedCommentIds].sort() } : {}) } as TaskMaintenanceInput;
}
