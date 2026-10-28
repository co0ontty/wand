/** Temporarily hide desktop group-chat entry points; keep data and deep links intact. */
export const GROUP_CHAT_VISIBLE = false;

export function isSidebarConversationVisible(item: { kind: string }): boolean {
  return GROUP_CHAT_VISIBLE || item.kind !== "group";
}

export function isSidebarSessionVisible(session: { teamChat?: unknown; sessionSource?: string }): boolean {
  return session.sessionSource !== "quick-terminal" && (GROUP_CHAT_VISIBLE || !session.teamChat);
}
