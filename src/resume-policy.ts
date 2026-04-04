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

export function hasRuntimeConversationSignal(messages: ConversationTurn[] | undefined): boolean {
  if (!messages || messages.length === 0) {
    return false;
  }
  const hasUser = messages.some((turn) => turn.role === "user"
    && turn.content.some((block) => block.type === "text" && block.text.trim().length > 0));
  const hasAssistant = messages.some((turn) => turn.role === "assistant");
  return hasUser && hasAssistant;
}

export function hasStoredConversationHistory(messages: ConversationTurn[] | undefined): boolean {
  return hasRealConversationMessages(messages);
}

export function shouldBindClaudeSessionId(record: { messages: ConversationTurn[] | undefined }): boolean {
  return hasRuntimeConversationSignal(record.messages);
}

export function shouldAllowResume(record: { claudeSessionId: string | null | undefined; messages: ConversationTurn[] | undefined }): boolean {
  return Boolean(record.claudeSessionId) && hasStoredConversationHistory(record.messages);
}

export function shouldBackfillFromStoredHistory(record: { messages: ConversationTurn[] | undefined }): boolean {
  return hasStoredConversationHistory(record.messages);
}

export function shouldDisplayResumeAction(messages: ConversationTurn[] | undefined): boolean {
  return hasStoredConversationHistory(messages);
}

export function shouldAutoResumeMessages(messages: ConversationTurn[] | undefined): boolean {
  return hasStoredConversationHistory(messages);
}

export function shouldBackfillMessages(messages: ConversationTurn[] | undefined): boolean {
  return hasStoredConversationHistory(messages);
}

export function shouldPromoteProjectSessionId(record: { messages: ConversationTurn[] | undefined }): boolean {
  return shouldBindClaudeSessionId(record);
}

export function shouldPromoteStoredSessionId(record: { messages: ConversationTurn[] | undefined }): boolean {
  return shouldBackfillMessages(record.messages);
}

export function shouldPromoteUiSessionId(messages: ConversationTurn[] | undefined): boolean {
  return shouldDisplayResumeAction(messages);
}

export function shouldPromoteResumeSessionId(messages: ConversationTurn[] | undefined): boolean {
  return shouldAutoResumeMessages(messages);
}

export function hasBindableConversation(messages: ConversationTurn[] | undefined): boolean {
  return shouldBindFromRuntimeMessages({ messages: messages ?? [] });
}

export function hasBackfillableConversation(messages: ConversationTurn[] | undefined): boolean {
  return shouldBackfillMessages(messages);
}

export function hasUiConversation(messages: ConversationTurn[] | undefined): boolean {
  return shouldPromoteUiSessionId(messages);
}

export function hasResumeConversation(messages: ConversationTurn[] | undefined): boolean {
  return shouldPromoteResumeSessionId(messages);
}

export function isRuntimeConversationReady(messages: ConversationTurn[] | undefined): boolean {
  return hasBindableConversation(messages);
}

export function isStoredConversationReady(messages: ConversationTurn[] | undefined): boolean {
  return hasBackfillableConversation(messages);
}

export function isResumeConversationReady(messages: ConversationTurn[] | undefined): boolean {
  return hasResumeConversation(messages);
}

export function shouldBindFromRuntimeMessages(record: { messages: ConversationTurn[] | undefined }): boolean {
  return isRuntimeConversationReady(record.messages);
}

export function shouldAllowUiResume(messages: ConversationTurn[] | undefined): boolean {
  return hasUiConversation(messages);
}

export function shouldPromoteResumeAction(record: { claudeSessionId: string | null | undefined; messages: ConversationTurn[] | undefined }): boolean {
  return shouldAllowResume(record);
}

export function shouldBackfillClaudeSessionIdFromDisk(record: { messages: ConversationTurn[] | undefined }): boolean {
  return isStoredConversationReady(record.messages);
}

export function shouldUseProjectCandidate(record: { messages: ConversationTurn[] | undefined }): boolean {
  return shouldBindFromRuntimeMessages(record);
}

export function shouldResumeProjectCandidate(record: { claudeSessionId: string | null | undefined; messages: ConversationTurn[] | undefined }): boolean {
  return shouldPromoteResumeAction(record);
}

export function shouldBackfillProjectCandidate(record: { messages: ConversationTurn[] | undefined }): boolean {
  return shouldBackfillClaudeSessionIdFromDisk(record);
}

export function hasMinimumRuntimeConversation(messages: ConversationTurn[] | undefined): boolean {
  return shouldBindFromRuntimeMessages({ messages: messages ?? [] });
}

export function hasMinimumStoredConversation(messages: ConversationTurn[] | undefined): boolean {
  return shouldAllowUiResume(messages);
}

export function hasMinimumResumeConversation(messages: ConversationTurn[] | undefined): boolean {
  return isResumeConversationReady(messages);
}

export function hasMinimumBackfillConversation(messages: ConversationTurn[] | undefined): boolean {
  return isStoredConversationReady(messages);
}

export function hasProjectConversationSignal(messages: ConversationTurn[] | undefined): boolean {
  return hasMinimumRuntimeConversation(messages);
}

export function hasStoredProjectConversationSignal(messages: ConversationTurn[] | undefined): boolean {
  return hasMinimumBackfillConversation(messages);
}

export function hasUiProjectConversationSignal(messages: ConversationTurn[] | undefined): boolean {
  return hasMinimumStoredConversation(messages);
}

export function hasResumeProjectConversationSignal(messages: ConversationTurn[] | undefined): boolean {
  return hasMinimumResumeConversation(messages);
}

export function canBindFromProjectConversation(messages: ConversationTurn[] | undefined): boolean {
  return hasProjectConversationSignal(messages);
}

export function canBackfillFromProjectConversation(messages: ConversationTurn[] | undefined): boolean {
  return hasStoredProjectConversationSignal(messages);
}

export function canShowUiProjectConversation(messages: ConversationTurn[] | undefined): boolean {
  return hasUiProjectConversationSignal(messages);
}

export function canResumeProjectConversation(messages: ConversationTurn[] | undefined): boolean {
  return hasResumeProjectConversationSignal(messages);
}

export function shouldUseRuntimeProjectConversation(messages: ConversationTurn[] | undefined): boolean {
  return canBindFromProjectConversation(messages);
}

export function shouldUseStoredProjectConversation(messages: ConversationTurn[] | undefined): boolean {
  return canBackfillFromProjectConversation(messages);
}

export function shouldUseUiProjectConversation(messages: ConversationTurn[] | undefined): boolean {
  return canShowUiProjectConversation(messages);
}

export function shouldUseResumeProjectConversation(messages: ConversationTurn[] | undefined): boolean {
  return canResumeProjectConversation(messages);
}

export function hasProjectConversationForBinding(messages: ConversationTurn[] | undefined): boolean {
  return shouldUseRuntimeProjectConversation(messages);
}

export function hasProjectConversationForBackfill(messages: ConversationTurn[] | undefined): boolean {
  return shouldUseStoredProjectConversation(messages);
}

export function hasProjectConversationForUi(messages: ConversationTurn[] | undefined): boolean {
  return shouldUseUiProjectConversation(messages);
}

export function hasProjectConversationForResume(messages: ConversationTurn[] | undefined): boolean {
  return shouldUseResumeProjectConversation(messages);
}

export function isBindableProjectConversation(messages: ConversationTurn[] | undefined): boolean {
  return hasProjectConversationForBinding(messages);
}

export function isBackfillableProjectConversation(messages: ConversationTurn[] | undefined): boolean {
  return hasProjectConversationForBackfill(messages);
}

export function isUiProjectConversation(messages: ConversationTurn[] | undefined): boolean {
  return hasProjectConversationForUi(messages);
}

export function isResumeProjectConversation(messages: ConversationTurn[] | undefined): boolean {
  return hasProjectConversationForResume(messages);
}

export function hasLiveProjectConversation(messages: ConversationTurn[] | undefined): boolean {
  return isBindableProjectConversation(messages);
}

export function hasStoredProjectConversation(messages: ConversationTurn[] | undefined): boolean {
  return isBackfillableProjectConversation(messages);
}

export function getResumeCommandSessionId(command: string): string | null {
  const match = RESUME_COMMAND_ID_PATTERN.exec(command);
  return match?.[1] ?? null;
}
