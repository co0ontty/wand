import type { WandTaskComment } from "../../../task-types";
import { createRequestId, HttpResponseError } from "../http-adapter";
import { sha256Hex } from "../sha256";
// 任务引用（`#TASK-133`）的解析与插入规则与三端共享契约一致，Web 直接复用同一份实现。
export { commentReferenceQuery, insertCommentReference, parseTaskReferenceIds, taskReferenceSegments,
  type TaskReferenceQuery } from "../../../task-comment-references.js";

export function commentRequestRejected(error: unknown): boolean {
  return error instanceof HttpResponseError && error.status >= 400 && error.status < 500 && ![408, 409].includes(error.status);
}

/** HTTP success persists the comment, not necessarily the execution delivery. */
export function commentDeliveryUncertain(comment: Pick<WandTaskComment, "dispatch">): boolean {
  return comment.dispatch?.state === "pending" || comment.dispatch?.state === "unknown"
    || comment.dispatch?.status === "pending" || comment.dispatch?.status === "unknown";
}

export function settleCommentRequest(identity: { forget(): void }, comment: Pick<WandTaskComment, "dispatch">): void {
  if (!commentDeliveryUncertain(comment)) identity.forget();
}

export interface CommentMentionQuery { start: number; query: string }

/** @ starts a token. The caret must still be inside that token; an email or a finished word is not a mention. */
export function commentMentionQuery(body: string, caret: number): CommentMentionQuery | null {
  const index = Math.max(0, Math.min(caret, body.length));
  if (index === 0) return null;
  const at = body.lastIndexOf("@", index - 1);
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(body[at - 1] ?? "")) return null;
  const query = body.slice(at + 1, index);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** Insert the chosen display token. The stable id stays outside the text. */
export function insertCommentMention(body: string, caret: number, name: string): { body: string; caret: number } {
  const index = Math.max(0, Math.min(caret, body.length));
  const start = commentMentionQuery(body, index)?.start ?? index;
  // 末尾已经紧跟空白时不再补空格，否则正文里会多出一个空格。
  const token = `@${name}${/\s/.test(body[index] ?? "") ? "" : " "}`;
  return { body: body.slice(0, start) + token + body.slice(index), caret: start + token.length };
}

/** The selected person is still present as a whole token. This does not resolve a new name. */
export function commentMentionHeld(body: string, name: string): boolean {
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)@${escaped}(?=\\s|$)`).test(body);
}

export interface CommentDraft { body: string; employeeId: string; sourceCommentId: string | null; revision: number; }
const drafts = new Map<string, CommentDraft>();
export function commentDraft(taskId: string): CommentDraft {
  return drafts.get(taskId) ?? { body: "", employeeId: "", sourceCommentId: null, revision: 0 };
}
export function editCommentDraft(taskId: string, patch: Partial<Omit<CommentDraft, "revision">>): CommentDraft {
  const next = { ...commentDraft(taskId), ...patch, revision: commentDraft(taskId).revision + 1 };
  drafts.set(taskId, next); return next;
}
export function acceptCommentDraft(taskId: string, submitted: CommentDraft): CommentDraft {
  if (commentDraft(taskId).revision !== submitted.revision) return commentDraft(taskId);
  return editCommentDraft(taskId, { body: "", employeeId: "", sourceCommentId: null });
}
/** Store only a content digest and request ID, never the submitted instruction. Unknown delivery is safe across refresh. */
export async function commentRequestIdentity(taskId: string, draft: CommentDraft, purpose: "execution" | "review" = "execution"): Promise<{ requestId: string; purpose: "execution" | "review"; forget(): void }> {
  const digest = await sha256Hex(JSON.stringify([draft.body.trim(), draft.employeeId, draft.sourceCommentId]));
  const key = `wand:task-comment-request:${taskId}:${digest}`;
  // Fail closed if persistent identity cannot be saved: starting anyway would break restart idempotency.
  const saved = localStorage.getItem(key);
  const requestId = saved ?? createRequestId();
  const savedPurpose = localStorage.getItem(key + ":purpose");
  const intentPurpose = savedPurpose === "review" ? "review" : savedPurpose === "execution" || saved ? "execution" : purpose;
  localStorage.setItem(key, requestId); localStorage.setItem(key + ":purpose", intentPurpose);
  return { requestId, purpose: intentPurpose, forget: () => { localStorage.removeItem(key); localStorage.removeItem(key + ":purpose"); } };
}
