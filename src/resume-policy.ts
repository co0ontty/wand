import { ConversationTurn } from "./types.js";

const REAL_CONVERSATION_MIN_MESSAGES = 2;
const RESUME_COMMAND_ID_PATTERN = /(?:^|\s)--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s|$)/i;

export function hasRealConversationMessages(messages: ConversationTurn[] | undefined): boolean {
  if (!messages || messages.length < REAL_CONVERSATION_MIN_MESSAGES) {
    return false;
  }

  const hasUser = messages.some((turn) => turn.role === "user"
    && turn.content.some((block) => block.type === "text" && block.text.trim().length > 0));
  const hasAssistant = messages.some((turn) => turn.role === "assistant"
    && turn.content.some((block) => block.type === "text" && block.text.trim().length > 0));
  return hasUser && hasAssistant;
}

export function getResumeCommandSessionId(command: string): string | null {
  const match = RESUME_COMMAND_ID_PATTERN.exec(command);
  return match?.[1] ?? null;
}
