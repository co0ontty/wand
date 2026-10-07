import type { ConversationSessionPreview, SessionSnapshot } from "./types.js";

export const CONVERSATION_SESSION_PREFIX = "conversation-message:";
export const CONVERSATION_PREVIEW_LIMIT = 4000;
export const conversationSessionPreviewLabels: Record<ConversationSessionPreview["status"], string> = {
  starting: "正在启动", running: "正在回复", waiting_user: "等待你确认", done: "已完成",
  failed: "执行失败", stopped: "已停止", unavailable: "会话不可用",
};

/** The session owns the transcript. IM only reads a bounded tail; never copies it into message history. */
export function conversationSessionPreview(session: SessionSnapshot | null,
  startup?: { startup?: "pending" | "started" | "failed"; error?: string }): ConversationSessionPreview {
  if (!session) return { status: "unavailable", text: "会话已不可用，原消息保留。" };
  const state = session.structuredState;
  const turns = session.messages ?? [];
  const last = turns.at(-1);
  const question = last?.role === "assistant" && last.content.some(block => block.type === "tool_use"
    && (block.semantic?.kind === "question_request" || block.name === "AskUserQuestion")
    && !last.content.some(result => result.type === "tool_result" && result.tool_use_id === block.id));
  const active = state?.inFlight || session.status === "running";
  let userInputs = 0;
  const continued = startup?.startup === "failed" && turns.some(turn =>
    turn.role === "user" && turn.content.some(block => block.type === "text" && block.text.trim()) && ++userInputs > 1);
  // A failed initial delivery receipt remains immutable evidence, but must not mask an explicit later turn.
  const startupFailed = startup?.startup === "failed" && !active && !continued && !last?.completedAt;
  const status: ConversationSessionPreview["status"] = session.status === "stopped" ? "stopped"
    : session.status === "failed" || !!state?.lastError || startupFailed ? "failed"
    : session.pendingEscalation || question ? "waiting_user"
    : active ? "running" : startup?.startup === "pending" ? "starting" : "done";
  // Walk backwards and stop as soon as the viewport budget is filled. Large sessions stay bounded.
  let text = "";
  for (let index = turns.length - 1; index >= 0 && text.length < CONVERSATION_PREVIEW_LIMIT; index--) {
    const turn = turns[index]!;
    if (turn.role === "user") break; // Explicit follow-ups belong to the same session, not the next IM message.
    for (let blockIndex = turn.content.length - 1; blockIndex >= 0 && text.length < CONVERSATION_PREVIEW_LIMIT; blockIndex--) {
      const block = turn.content[blockIndex]!;
      if (block.type === "text" && block.text.trim()) text = `${block.text.slice(-CONVERSATION_PREVIEW_LIMIT)}${text ? `\n\n${text}` : ""}`;
    }
  }
  if (status === "failed") text = [text, state?.lastError || (startupFailed ? startup?.error : undefined) || "执行失败，请打开会话核对；不会自动重发。"].filter(Boolean).join("\n\n");
  if (!text) {
    const tool = last?.content.slice().reverse().find(block => block.type === "tool_use");
    text = session.pendingEscalation?.reason || (active && tool?.type === "tool_use" ? `正在调用 ${tool.name}` : "")
      || (status === "starting" ? "消息已接收，正在启动独立会话。" : status === "running" ? "正在思考…"
        : status === "stopped" ? "本轮已停止。" : "本轮已结束，打开会话查看完整过程。");
  }
  return { status, text: text.slice(-CONVERSATION_PREVIEW_LIMIT) };
}
