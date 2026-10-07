import type { AiTeamMember } from "./ai-team-types.js";

type Member = Pick<AiTeamMember, "id" | "name">;
export type ConversationLeaderMention = { memberId: string; name: string; body: string } | { error: string };

/** Only a leading, explicit address selects a coordinator. Quoted/body mentions and emails are data. */
export function conversationLeaderMention(text: string, members: readonly Member[]): ConversationLeaderMention | null {
  // Upload envelopes precede the user's text on Web/Android; filenames are never mention targets.
  const input = conversationMessageBody(text).trimStart();
  if (!/^[@＠]/u.test(input)) return null;
  const addressed = input.slice(1);
  const candidates = members.flatMap(member => [member.name.trim(), member.id]
    .filter(Boolean).map(label => ({ member, label })))
    .filter(({ label }) => addressed.startsWith(label) && /^(?:$|[\s,，:：;；、!！?？。])/u.test(addressed.slice(label.length)))
    .sort((a, b) => b.label.length - a.label.length);
  const match = candidates[0];
  if (!match) return { error: "没有找到被 @ 的群成员，请用「@姓名 消息」或从成员列表选择。" };
  if (new Set(candidates.filter(c => c.label.length === match.label.length).map(c => c.member.id)).size !== 1) {
    return { error: "被 @ 的名字对应多位群成员，请从成员列表选择，或用 @成员ID 指定。" };
  }
  const body = addressed.slice(match.label.length).replace(/^[\s,，:：]+/u, "").trim();
  if (!body) return { error: "请在 @负责人 后写明本轮消息。" };
  return { memberId: match.member.id, name: match.member.name, body };
}

/** Shared upload-envelope handling: paths are never task titles or addressees. */
export function conversationMessageBody(text: string): string {
  return text.replace(/^\s*\[附件已上传，请查看以下文件:\r?\n[\s\S]*?\r?\n\]\s*/u, "");
}

/** Duplicate display names remain addressable without guessing an employee identity. */
export function conversationMentionToken(member: Member, members: readonly Member[]): string {
  const name = member.name.trim();
  const unique = name && !/\r|\n/u.test(name) && members.filter(m => m.name.trim() === name || m.id === name).length === 1;
  return `@${unique ? name : member.id}`;
}
