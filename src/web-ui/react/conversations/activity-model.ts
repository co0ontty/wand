import type { ConversationDetail, ConversationTarget } from "../../../conversation-types.js";
import type { ConversationTurn, SessionSnapshot, StructuredQuestion, ToolResultBlock, ToolUseBlock } from "../../../types.js";
import { computeRunningSignal } from "../../session-activity.js";

export type ActivitySession = Pick<SessionSnapshot, "id" | "status"> & Partial<SessionSnapshot>;
export type ActivityOperation = { kind: "answer"; toolId: string; input: string }
  | { kind: "permission"; requestId: string; resolution: "approve_once" | "deny" }
  | { kind: "stop"; anchor: string };
export interface ActivityAnswerDraft { selections: Record<number, string[]>; freeform: Record<number, string> }

export function activitySource(turn: ConversationTurn, communicationSessionId: string | null): string | null {
  return turn.sessionLink?.sessionId || turn.author?.sessionId || (!turn.conversationTarget ? communicationSessionId : null);
}

export function activityToolKey(sessionId: string, toolId: string): string {
  return JSON.stringify([sessionId, toolId]);
}

export function activityResults(turns: readonly ConversationTurn[], communicationSessionId: string | null,
  sessions: readonly ActivitySession[] = []): Map<string, ToolResultBlock> {
  const results = new Map<string, ToolResultBlock>();
  const collect = (turn: ConversationTurn, source: string | null): void => {
    if (!source) return;
    for (const block of turn.content) if (block.type === "tool_result") results.set(activityToolKey(source, block.tool_use_id), block);
  };
  for (const turn of turns) collect(turn, activitySource(turn, communicationSessionId));
  for (const session of sessions) for (const turn of session.messages ?? []) collect(turn, session.id);
  return results;
}

export function activityQuestions(block: ToolUseBlock): StructuredQuestion[] {
  if (block.semantic?.kind === "question_request") return block.semantic.questions;
  // Legacy Claude recordings predate the semantic projection.
  if (block.name === "AskUserQuestion" && Array.isArray(block.input.questions)) return block.input.questions as StructuredQuestion[];
  return [];
}

/** Only the latest unanswered assistant request can accept input; old cards remain read-only. */
export function pendingActivityQuestions(session: ActivitySession): ToolUseBlock[] {
  if (session.archived || ["failed", "stopped", "exited"].includes(session.status)) return [];
  const turns = session.messages ?? [];
  const results = activityResults([], null, [session]);
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    if (turn.role === "user" && turn.content.some(block => block.type === "text" && block.text.trim())) return [];
    if (turn.role !== "assistant") continue;
    return turn.content.filter((block): block is ToolUseBlock => block.type === "tool_use"
      && activityQuestions(block).length > 0 && !results.has(activityToolKey(session.id, block.id)));
  }
  return [];
}

export type ConversationActivityDetail = Pick<ConversationDetail, "id" | "kind" | "title" | "communicationSessionId" | "messages" | "runDetails" | "dissolvedAt" | "deleting">;

export function activitySessionOwners(detail: ConversationActivityDetail | null, target: ConversationTarget = null): Map<string, string> {
  const owners = new Map<string, string>();
  if (!detail || detail.dissolvedAt || detail.deleting) return owners;
  if (detail.communicationSessionId && !target) owners.set(detail.communicationSessionId, detail.kind === "dm" ? detail.title : "群聊负责人");
  if (!target) for (const turn of detail.messages) {
    if (turn.sessionLink && ["starting", "running", "waiting_user"].includes(turn.sessionPreview?.status ?? "starting")) {
      owners.set(turn.sessionLink.sessionId, turn.sessionLink.title);
    }
  }
  for (const run of detail.runDetails) {
    if (target && target.runId !== run.run.id) continue;
    if (!["running", "waiting_user", "awaiting_approval"].includes(run.run.status)) continue;
    for (const step of run.steps) if (step.sessionId && step.status === "running") {
      const member = run.run.team.members.find(member => member.id === step.memberId);
      owners.set(step.sessionId, member?.name || step.title);
    }
    // A runner can wait for a question after its step ceases streaming. Source identity
    // comes from the author, never from run.chatSessionId (the aggregate relay).
    for (const turn of detail.messages) {
      if (turn.conversationTarget?.runId !== run.run.id || !turn.author?.sessionId) continue;
      if (turn.content.some(block => block.type === "tool_use" && activityQuestions(block).length)) {
        owners.set(turn.author.sessionId, turn.author.name);
      }
    }
  }
  return owners;
}

export function activityRunning(session: ActivitySession): boolean {
  return computeRunningSignal(session).active || Boolean(session.pendingEscalation);
}

export function activityStopAnchor(session: ActivitySession): string {
  return session.structuredState?.activeRequestId || session.structuredState?.turnStartedAt || session.ptyTurnStartedAt || session.startedAt || "";
}

export function activityOperationKey(sessionId: string, operation: ActivityOperation): string {
  return activityToolKey(sessionId, operation.kind === "answer" ? `answer:${operation.toolId}`
    : operation.kind === "permission" ? `permission:${operation.requestId}` : `stop:${operation.anchor}`);
}

export function activityOperationCurrent(session: ActivitySession, operation: ActivityOperation): boolean {
  if (operation.kind === "answer") return pendingActivityQuestions(session).some(block => block.id === operation.toolId);
  if (operation.kind === "permission") return session.pendingEscalation?.requestId === operation.requestId;
  return activityRunning(session) && activityStopAnchor(session) === operation.anchor;
}

export function activityResultText(result: ToolResultBlock): string {
  if (result.preview) return result.preview;
  if (typeof result.content === "string") return result.content;
  return result.content.map(part => typeof part.text === "string" ? part.text : part.type === "image" ? "[图片结果]" : "").filter(Boolean).join("\n");
}

export function activityAnswerText(questions: readonly StructuredQuestion[], selections: Record<number, string[]>, freeform: Record<number, string>): string | null {
  const lines = questions.map((_, index) => [...(selections[index] ?? []), freeform[index]?.trim() ?? ""].filter(Boolean).join("；"));
  return lines.length && lines.every(Boolean) ? lines.join("\n") : null;
}
