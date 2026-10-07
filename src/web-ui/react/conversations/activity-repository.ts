import { HttpResponseError, jsonBody, requestJson } from "../http-adapter.js";
import { activityOperationCurrent, activityOperationKey, type ActivityAnswerDraft, type ActivityOperation, type ActivitySession } from "./activity-model.js";

export interface ActivitySubmission { phase: "sending" | "sent" | "failed" | "unknown"; message: string }
const submissions = new Map<string, ActivitySubmission>();
const operations = new Map<string, { sessionId: string; operation: ActivityOperation }>();
const completed = new Set<string>();
const drafts = new Map<string, { schema: string; draft: ActivityAnswerDraft }>();
const listeners = new Set<() => void>();
let revision = 0;
const publish = (): void => {
  // Retain unanswered drafts and uncertain writes. Only server-observed, accepted
  // requests that can no longer be acted on are eligible for bounded cleanup.
  if (submissions.size > 256) for (const key of completed) {
    if (submissions.size <= 256) break;
    if (submissions.get(key)?.phase !== "sent") continue;
    submissions.delete(key); operations.delete(key); completed.delete(key); drafts.delete(key);
  }
  revision++; for (const listener of listeners) listener();
};
const endpoint = (id: string): string => `/api/sessions/${encodeURIComponent(id)}`;

export const conversationActivityRepository = {
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
  revision: () => revision,
  submission(id: string, operation: ActivityOperation): ActivitySubmission | undefined { return submissions.get(activityOperationKey(id, operation)); },
  answerDraft(id: string, toolId: string, schema = ""): ActivityAnswerDraft {
    const entry = drafts.get(activityOperationKey(id, { kind: "answer", toolId, input: "" }));
    return entry?.schema === schema ? entry.draft : { selections: {}, freeform: {} };
  },
  editAnswer(id: string, toolId: string, update: (draft: ActivityAnswerDraft) => ActivityAnswerDraft, schema = ""): void {
    drafts.set(activityOperationKey(id, { kind: "answer", toolId, input: "" }), { schema, draft: update(this.answerDraft(id, toolId, schema)) }); publish();
  },
  observe(session: ActivitySession): void {
    for (const [key, owner] of operations) {
      if (owner.sessionId === session.id && submissions.get(key)?.phase === "sent" && !activityOperationCurrent(session, owner.operation)) completed.add(key);
    }
  },
  session(id: string): Promise<ActivitySession> {
    return requestJson(`${endpoint(id)}?format=chat&blockBudget=120`, { headers: { "X-Wand-Tool-Projection": "compact" } });
  },
  tool(id: string, toolId: string): Promise<{ input: Record<string, unknown>; content: unknown; is_error: boolean; pending: boolean }> {
    return requestJson(`${endpoint(id)}/tool-content/${encodeURIComponent(toolId)}`);
  },
  async submit(id: string, operation: ActivityOperation, isCurrent: () => boolean): Promise<void> {
    const key = activityOperationKey(id, operation);
    const prior = submissions.get(key);
    if (prior && prior.phase !== "failed") return;
    operations.set(key, { sessionId: id, operation });
    const put = (value: ActivitySubmission): void => { submissions.set(key, value); publish(); };
    put({ phase: "sending", message: "正在提交…" });
    let transmitted = false;
    let acceptedPart = false;
    try {
      const session = await this.session(id);
      if (session.id !== id || !isCurrent()) { submissions.delete(key); publish(); return; }
      if (!activityOperationCurrent(session, operation)) {
        put({ phase: "sent", message: "此请求已结束，已保留记录。" }); return;
      }
      const post = async (path: string, body: unknown): Promise<void> => {
        transmitted = true;
        const receipt = await requestJson<{ deliveryConfirmed?: boolean }>(`${endpoint(id)}${path}`, jsonBody(body));
        acceptedPart = true;
        if (receipt.deliveryConfirmed === false) throw new HttpResponseError("送达尚未确认。", 202);
      };
      if (operation.kind === "permission") {
        await post(`/escalations/${encodeURIComponent(operation.requestId)}/resolve`, { resolution: operation.resolution });
      } else if (operation.kind === "stop") {
        if (session.sessionKind === "structured" || session.structuredState) await post("/stop", {});
        else await post("/input", { input: "\u001b", view: "chat", shortcutKey: "esc", responseMode: "accepted" });
      } else if (session.sessionKind === "structured" || session.structuredState) {
        await post("/input", { input: operation.input, view: "chat", respondImmediately: true });
      } else {
        // Even if navigation changes after the first packet, finish the captured
        // source session's Enter packet. Never redirect it to the new selection.
        await post("/input", { input: operation.input, view: "chat", responseMode: "accepted" });
        await post("/input", { input: "\r", view: "chat", shortcutKey: "enter_text", responseMode: "accepted" });
      }
      put({ phase: "sent", message: "已接受，等待当前对话更新。" });
    } catch (cause) {
      const status = cause instanceof HttpResponseError ? cause.status : 0;
      const rejected = !acceptedPart && status >= 400 && status < 500 && status !== 408 && status !== 409;
      const unknown = transmitted && !rejected;
      put({ phase: unknown ? "unknown" : "failed", message: unknown
        ? "送达尚未确认；请刷新状态核对，不要重复提交。"
        : cause instanceof Error ? cause.message : "未能提交，输入已保留。" });
    }
  },
};
