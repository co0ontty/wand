import type { AiTeam, AiTeamMember, AiTeamStep } from "./ai-team-types.js";
import { memberAgents } from "./ai-team-types.js";

import type { WandTaskAgent } from "./task-types.js";
import type { ConversationAuthor, ConversationTurn } from "./types.js";

export function displayAiTeam(snapshot: AiTeam, current: AiTeam | null): AiTeam {
  if (!current) return snapshot;
  const byId = new Map(current.members.map((member) => [member.id, member]));
  return {
    ...snapshot,
    name: current.name,
    updatedAt: current.updatedAt,
    members: snapshot.members.map((member) => {
      const live = byId.get(member.id);
      return live && !member.employeeId && !live.employeeId
        ? { ...member, name: live.name, avatar: live.avatar } : member;
    }),
  };
}

export function chatAuthor(
  member: AiTeamMember,
  sessionId?: string | null,
  agent?: WandTaskAgent | null,
): ConversationAuthor {
  const used = agent ?? memberAgents(member)[0] ?? member.agent;
  return {
    id: member.id,
    name: member.name,
    avatar: member.avatar && !member.avatar.startsWith("data:") ? member.avatar : undefined,
    leader: member.isLeader || undefined,
    provider: used?.provider ?? member.agent.provider,
    engine: used?.engine,
    model: used?.model?.trim() || undefined,
    thinkingEffort: used?.thinkingEffort || undefined,
    sessionId: sessionId ?? undefined,
  };
}

export const chatText = (text: string): ConversationTurn["content"] => [{ type: "text", text }];


// ── 群聊开场与协作流转的文案（设计 v2.1 S1–S5）──
// 全部由服务端纯函数拼好：客户端只做 @ 高亮，不拼句子、不猜字段；也**不引任何 LLM 文本**。

/** 每行邀请名单上限（S2/S3）：`邀请 @a、@b、@c、@d 加入群聊`。 */
export const CHAT_INVITE_PER_LINE = 4;

/** 开工发言与派工行共用的步骤说法：`第 2 步「实现 Web 端」`；标题空白时只剩步数。 */
function chatStepLabel(seq: number, title: string): string {
  const label = title.trim();
  return label ? `第 ${seq} 步「${label}」` : `第 ${seq} 步`;
}

/**
 * 首次建群的入群序列（S1–S3）：负责人先入群，再按 `team.members` 原顺序邀请其余成员。
 * 每行最多 [CHAT_INVITE_PER_LINE] 人，第二行起用 `继续邀请 …`；除负责人外没人时给
 * `还没有邀请其他成员入群`（仍两条，不伪造成员）。
 */
export function chatIntroLines(team: Pick<AiTeam, "members">, chatTitle: string): string[] {
  const title = chatTitle.trim();
  const lines = [title ? `创建了团队群聊「${title}」` : "创建了团队群聊"];
  const invitees = team.members.filter((member) => !member.isLeader)
    .map((member) => member.name.trim())
    .filter(Boolean);
  if (invitees.length === 0) {
    lines.push("还没有邀请其他成员入群");
    return lines;
  }
  for (let index = 0; index < invitees.length; index += CHAT_INVITE_PER_LINE) {
    const names = invitees.slice(index, index + CHAT_INVITE_PER_LINE).map((name) => `@${name}`).join("、");
    lines.push(`${index === 0 ? "邀请" : "继续邀请"} ${names} 加入群聊`);
  }
  return lines;
}

/** 开工发言里的一条依据（来自 `step.dependsOn` 解析出的上游步骤）。 */
export interface AiTeamStepBasis {
  seq: number;
  title: string;
  memberName: string;
  reportPath: string;
}

/**
 * 开工发言正文（S4）：
 * - 第 1 行 `我正在开始工作：第 N 步「标题」`；
 * - 有依赖时第 2 行 `依据 @上游成员 第 M 步「上游标题」的产物 <reportPath>`，超过两条
 *   只列前两条并在尾上 `等 N 步`（N = 依赖总数）；
 * - 依赖解析不到（旧数据/步骤被删）→ `依据上游步骤的产物继续`。
 */
export function stepStartText(
  step: Pick<AiTeamStep, "seq" | "title">,
  upstream: ReadonlyArray<AiTeamStepBasis> = [],
  dependencyCount: number = upstream.length,
): string {
  const lines = [`我正在开始工作：${chatStepLabel(step.seq, step.title)}`];
  if (dependencyCount > 0) lines.push(stepBasisLine(upstream, dependencyCount));
  return lines.join("\n");
}

function stepBasisLine(upstream: ReadonlyArray<AiTeamStepBasis>, dependencyCount: number): string {
  const shown = upstream.slice(0, 2);
  if (shown.length === 0) return "依据上游步骤的产物继续";
  const parts = shown.map((item) => {
    const reportPath = item.reportPath.trim();
    return `@${item.memberName} ${chatStepLabel(item.seq, item.title)}的产物${reportPath ? ` ${reportPath}` : ""}`;
  });
  return `依据 ${parts.join("、")}${dependencyCount > shown.length ? ` 等 ${dependencyCount} 步` : ""}`;
}

/**
 * 派工行的依据括注（S5）：`（依据：第 1 步「设计规格」的产物）`，多个依赖用 `、` 连接。
 * 位置 `at` 是**本批 steps 内**的 0-based 下标（展示成第 at+1 步）；没有依赖就是空串（首步无依据）。
 * 它**取代**旧的 `（等第 N 项完成后）`：同一个依赖关系不写两遍。
 */
export function assignmentBasisNote(after: readonly number[], titles: readonly string[]): string {
  if (after.length === 0) return "";
  const parts = after.map((at) => {
    const label = (titles[at] ?? "").trim();
    return `第 ${at + 1} 步${label ? `「${label}」` : ""}的产物`;
  });
  return `（依据：${parts.join("、")}）`;
}

