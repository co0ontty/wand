import type { ConversationTurn, SessionSnapshot, StructuredQuestion, ToolUseBlock } from "./types.js";

export function sessionToolQuestions(block: ToolUseBlock): StructuredQuestion[] {
  if (block.semantic?.kind === "question_request") return block.semantic.questions;
  // Legacy Claude recordings predate the semantic projection.
  if (block.name === "AskUserQuestion" && Array.isArray(block.input.questions)) return block.input.questions as StructuredQuestion[];
  return [];
}

/** One source session, latest assistant request only. Historical cards stay read-only. */
export function pendingSessionQuestions(session: Pick<SessionSnapshot, "status"> & { archived?: boolean; messages?: ConversationTurn[] }): ToolUseBlock[] {
  if (session.archived || ["failed", "stopped", "exited"].includes(session.status)) return [];
  const turns = session.messages ?? [];
  const results = new Set(turns.flatMap(turn => turn.content.flatMap(block => block.type === "tool_result" ? [block.tool_use_id] : [])));
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    if (turn.role === "user" && turn.content.some(block => block.type === "text" && block.text.trim())) return [];
    if (turn.role !== "assistant") continue;
    return turn.content.filter((block): block is ToolUseBlock => block.type === "tool_use"
      && sessionToolQuestions(block).length > 0 && !results.has(block.id));
  }
  return [];
}
