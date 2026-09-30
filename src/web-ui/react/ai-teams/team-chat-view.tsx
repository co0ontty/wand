import * as React from "react";
import type { AgentActivityState } from "../../../mission-types";
import { AI_TEAM_DETAIL_CHAT_TURNS, type AiTeamLiveStep, type AiTeamRun,
  type AiTeamRunDetail, type AiTeamStep, type AiTeam } from "../../../ai-team-types";
import type { ConversationAuthor, ConversationTurn } from "../../../types";
import { failureMessage } from "../errors";
import { filePreviewController } from "../file-preview/controller";
import { HttpResponseError, jsonBody, requestJson } from "../http-adapter";
import { issueAgentEffortLabel, issueAgentProviderLabel } from "../issues/task-board-agent";
import { wandModelDisplayName, type WandModelCatalog } from "../model-catalog";
import { WandBrandMark, WandButton, WandDialogSurface, WandIcon } from "../ui";
import { ComposerAttachmentList } from "../composer-attachments/host";
import { ComposerPopoverAction } from "../composer-popover/action";
import { memberCoatIndex, PixelCat, TeamAvatar } from "./avatar";
import { teamChatComposer } from "./composer-bridge";
import { aiTeamsRepository } from "./repository";

/**
 * 面板内嵌的群聊视图（§5.3）：只读渲染 `detail.chatTurns`，加一个往 relay 会话发话的输入框。
 * 消息层按 IM 群聊做：每条发言都有头像 + 名字，短发言走气泡、文档性质内容走全宽文档卡，
 * 超长正文只显示上半部分预览，底部「点击展开」用 Portal 弹层显示全文（不跳页、触发点不位移）。
 * 不复用 legacy chat-render（那套是命令式 DOM + 会话状态机），只借它的类名对齐视觉。
 */

/** 乐观临时行：发送 resolve 后先留着，等服务端回包里出现同一条 user turn 再撤。 */
export interface LocalChatTurn {
  local: true;
  text: string;
  /** 本地发送时刻（毫秒），用来和服务端 `createdAt` 粗比。 */
  sentAt: number;
  /** 重拉失败时为真：内容留着，但标成「未确认」。 */
  unconfirmed: boolean;
  /** ACK 还没成功前，不能靠正文与时间猜测这条消息已被接收。 */
  accepted?: boolean;
  /** 发送前已看到的回合；同文旧消息不能确认本次提交。 */
  knownFingerprints?: readonly string[];
  /** 成功 ACK 唯一指认的服务端回合，优先于客户端时钟。 */
  ackFingerprint?: string;
}

/** 发送端点：relay 会话就是普通结构化会话，走既有的 messages 路由（S7）。 */
export function chatMessageUrl(sessionId: string): string {
  return `/api/structured-sessions/${encodeURIComponent(sessionId)}/messages`;
}

/** 请求体字段是 `input`（不是 `text`）；插话不带 `interrupt`，走排队进 chatInput。 */
export function chatMessageBody(text: string): { input: string } {
  return { input: text };
}

interface UploadedChatFile {
  originalName: string;
  savedPath: string;
  size: number;
  mimeType: string;
}

export function chatUploadUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/upload`;
}

export function chatAttachmentPrompt(files: readonly Pick<UploadedChatFile, "savedPath">[], text: string): string {
  if (!files.length) return text;
  return `[附件已上传，请查看以下文件:\n${files.map((file) => file.savedPath).join("\n")}\n]\n\n`
    + (text.trim() || "请查看附件。");
}

/** The relay stores the original prompt; only the view hides the path preamble. */
export function parseChatAttachments(text: string): { paths: string[]; body: string } {
  const match = /^\s*\[附件已上传，请查看以下文件:\n([\s\S]*?)\]\n*/.exec(text);
  if (!match) return { paths: [], body: text };
  const paths = match[1]!.split("\n").map((path) => path.trim()).filter(Boolean);
  return paths.length ? { paths, body: text.slice(match[0].length) } : { paths: [], body: text };
}

export function chatAttachmentIsImage(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(path);
}

function resizeChatComposerInput(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
  input.style.overflowY = input.scrollHeight > input.clientHeight + 1 ? "auto" : "hidden";
}

/** ACK 没有可用消息标识时才用的保守时间窗；两端时钟有偏差也不能无限放宽。 */
const CHAT_CONFIRM_WINDOW_MS = 5 * 60_000;

/** 成功 ACK 的新回合优先按服务端完整指纹定位，不依赖浏览器时钟。 */
export function acknowledgedChatFingerprint(
  response: unknown,
  text: string,
  knownFingerprints: readonly string[],
): string | null {
  if (!response || typeof response !== "object") return null;
  const messages = (response as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  const turns = messages.filter((value): value is ConversationTurn => Boolean(value)
    && typeof value === "object" && Array.isArray(value.content));
  const fingerprints = turns.map(chatTurnFingerprint);
  const known = new Set(knownFingerprints);
  let anchor = -1;
  for (let i = 0; i < fingerprints.length; i++) {
    const fingerprint = fingerprints[i];
    if (fingerprint !== null && fingerprint !== undefined && known.has(fingerprint)) anchor = i;
  }
  if (known.size > 0 && anchor < 0) return null;
  const candidates = turns.slice(anchor + 1)
    .map((turn) => turn.role === "user" && chatTurnText(turn) === text ? chatTurnFingerprint(turn) : null)
    .filter((fingerprint): fingerprint is string => fingerprint !== null && !known.has(fingerprint));
  return candidates.length === 1 ? candidates[0]! : null;
}

/** 正文、发送前基线及 ACK 指纹同时限制确认；无 ACK 时还必须在有界时间窗内。 */
export function isConfirmedBy(
  turn: ConversationTurn,
  sentAt: number,
  text: string,
  knownFingerprints: readonly string[] = [],
  ackFingerprint?: string,
): boolean {
  if (turn.role !== "user" || chatTurnText(turn) !== text) return false;
  const fingerprint = chatTurnFingerprint(turn);
  if (!fingerprint || knownFingerprints.includes(fingerprint)) return false;
  if (ackFingerprint) return fingerprint === ackFingerprint;
  const at = Date.parse(turn.createdAt ?? "");
  return Number.isFinite(at) && Math.abs(at - sentAt) <= CHAT_CONFIRM_WINDOW_MS;
}

/**
 * 发送 resolve 之后调一次：`turns` 为 `null` 表示重拉失败，临时行留着并标「未确认」；
 * 否则把服务端已经回显的那几条撤掉，剩下的继续等下一次 ai-team-run 重拉。
 */
export function settleLocalTurns(local: LocalChatTurn[], turns: ConversationTurn[] | null): LocalChatTurn[] {
  if (!turns) return local.map((row) => row.unconfirmed ? row : { ...row, unconfirmed: true });
  const consumed = new Set<number>();
  const remaining = local.filter((row) => {
    // 结果未知时只留未确认行，不用同文别人的发言推断送达。
    if (row.accepted === false || (row.unconfirmed && row.accepted !== true)) return true;
    const candidates = turns.flatMap((turn, i) => !consumed.has(i)
      && isConfirmedBy(turn, row.sentAt, row.text, row.knownFingerprints, row.ackFingerprint)
      ? [i] : []);
    if (candidates.length !== 1) return true;
    consumed.add(candidates[0]!);
    return false;
  });
  return remaining.length === local.length ? local : remaining;
}

/** 同一 relay 群聊跨运行连续；没有群聊会话的运行才以 run.id 隔离。 */
export function teamChatScope(run: Pick<AiTeamRun, "id" | "chatSessionId">): string {
  return JSON.stringify(run.chatSessionId ? ["chat", run.chatSessionId] : ["run", run.id]);
}

/** 408/409/5xx、网络中断与成功响应解析失败都不能证明服务端未接收。 */
export function chatSendDefinitelyRejected(error: unknown): boolean {
  return error instanceof HttpResponseError && error.status >= 400 && error.status < 500
    && error.status !== 408 && error.status !== 409;
}

export type TeamOfficeState = "working" | "attention" | "queued" | "done" | "failed" | "idle";

export interface TeamOfficeMember {
  member: AiTeamRun["team"]["members"][number];
  state: TeamOfficeState;
  label: string;
  task: string;
  sessionId: string | null;
}

/** 从真实步骤和会话状态投影工位；没有步骤时只显示待派工。 */
export function displayTeamOf(detail: AiTeamRunDetail): AiTeam {
  return detail.displayTeam ?? detail.run.team;
}

/** 仅投影可见署名/头像；原始 turn 供去重、呈现账本与历史正文使用。 */
export function displayChatTurn(turn: ConversationTurn, team: AiTeam): ConversationTurn {
  const author = turn.author;
  if (!author?.id) return turn;
  const member = team.members.find((item) => item.id === author.id);
  if (!member || (member.name === author.name && member.avatar === author.avatar)) return turn;
  return { ...turn, author: { ...author, name: member.name, avatar: member.avatar } };
}

export function teamOfficeMembers(detail: AiTeamRunDetail): TeamOfficeMember[] {
  return displayTeamOf(detail).members.map((member) => {
    const own = detail.steps.filter((step) => step.memberId === member.id);
    const step = own.find((item) => item.status === "running")
      ?? [...own].sort((a, b) => b.seq - a.seq)[0];
    const activity = step?.sessionId ? detail.memberStates[step.sessionId] : undefined;
    const state: TeamOfficeState = step?.status === "running"
      ? activity === "needs_input" || activity === "needs_permission" ? "attention" : "working"
      : step?.status === "queued" ? "queued"
        : step?.status === "done" ? "done"
          : step?.status === "failed" ? "failed" : "idle";
    const label = state === "attention" ? activity === "needs_permission" ? "待授权" : "待回答"
      : { working: "工作中", queued: "排队中", done: "已完成", failed: "失败", idle: "待派工" }[state];
    return { member, state, label, task: step?.title || member.duty || "等待负责人派工", sessionId: step?.sessionId ?? null };
  });
}

function TeamOffice({ detail, onOpenSession }: {
  detail: AiTeamRunDetail;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement {
  const members = teamOfficeMembers(detail);
  const working = members.filter((item) => item.state === "working").length;
  const attention = members.filter((item) => item.state === "attention").length;
  return <section className="team-chat-office" aria-label="团队工位">
    <header className="team-chat-office-head">
      <strong>团队工位</strong>
      <small>{attention ? `${attention} 人待处理 · ` : ""}{working} 人工作中 · {members.length} 人在组</small>
    </header>
    <div className="team-chat-office-members">
      {members.map(({ member, state, label, task, sessionId }) => {
        const content = <>
          <TeamAvatar member={member} size="sm" state={state === "working" ? "working" : state === "done" ? "done" : state === "failed" ? "failed" : "idle"}/>
          <span className="team-chat-office-copy"><strong>{member.name}</strong><small title={task}>{task}</small></span>
          <span className="team-chat-office-state" data-state={state}>{label}</span>
        </>;
        return sessionId && onOpenSession
          ? <button key={member.id} type="button" className="team-chat-office-member" onClick={() => onOpenSession(sessionId)} aria-label={`查看${member.name}的会话：${label}`}>
            {content}
          </button>
          : <div key={member.id} className="team-chat-office-member">{content}</div>;
      })}
    </div>
  </section>;
}

const CHAT_HINTS: Partial<Record<AiTeamRun["status"], string>> = {
  awaiting_approval: "回复『批准』即开工，其他内容会作为修改意见转给负责人",
  running: "将作为插话，负责人下一轮看到",
};

/** 运行已经结束（完成 / 停止 / 失败）：群里再说一句就是接着这次的进度开新一轮。 */
const CHAT_FINISHED_HINT = "发消息会接着这一轮的进度开新一轮";

/** 输入框自己的占位文案：与上面的引导语分开写，空输入框时同一句话不会显示两遍。 */
export const CHAT_INPUT_PLACEHOLDER = "输入消息…";

/** 未结束的运行：停止、插话、批准都还有效。 */
export function teamRunIsActive(status: AiTeamRun["status"]): boolean {
  return status === "running" || status === "awaiting_approval" || status === "waiting_user";
}

/**
 * 群聊输入栏发送 / 停止的形态（对齐普通会话：同一位置，发送 ⇄ 停止）。
 * 运行中且没有草稿 → 这枚按钮就是停止；有草稿 → 发送，并在左侧再放一枚停止。
 */
export type TeamChatComposerMode = "send" | "stop" | "send-and-stop" | "blocked";

export function teamChatComposerMode(
  status: AiTeamRun["status"],
  hasDraft: boolean,
  pending: "" | "send" | "stop" = "",
): TeamChatComposerMode {
  // 发送会先清掉输入框：这一拍不能把按钮收成「停止」，否则发送中的形态会闪掉。
  if (pending === "send") return teamRunIsActive(status) ? "send-and-stop" : "send";
  const active = teamRunIsActive(status);
  if (active && hasDraft) return "send-and-stop";
  if (active) return "stop";
  if (hasDraft) return "send";
  return "blocked";
}

/** 输入框上方的引导语；其他状态没有要提醒的。 */
export function chatInputHint(status: AiTeamRun["status"]): string {
  if (status === "done" || status === "stopped" || status === "failed") return CHAT_FINISHED_HINT;
  return CHAT_HINTS[status] ?? "";
}

export function chatTurnText(turn: ConversationTurn): string {
  return turn.content
    .filter((block) => block.type === "text")
    .map((block) => ("text" in block ? block.text.trim() : ""))
    .filter(Boolean)
    .join("\n");
}

/** 一行右侧的时刻；服务端没给时间就不显示。live 行只有 `updatedAt`，所以按这两个字段取。 */
export function chatTurnClock(turn: Pick<ConversationTurn, "createdAt" | "completedAt">): string {
  const at = Date.parse(turn.completedAt || turn.createdAt || "");
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A quiet time marker starts the thread and separates conversations after a long pause. */
export function chatTimeMarker(
  turn: Pick<ConversationTurn, "createdAt">,
  previous?: Pick<ConversationTurn, "createdAt">,
  now = new Date(),
): string {
  const time = new Date(turn.createdAt || "");
  if (!Number.isFinite(time.getTime())) return "";
  const before = previous ? new Date(previous.createdAt || "") : null;
  if (before && Number.isFinite(before.getTime())
    && time.toDateString() === before.toDateString()
    && time.getTime() - before.getTime() < 60 * 60_000) return "";
  const clock = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = now.toDateString() === time.toDateString();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString()
    === time.toDateString();
  const day = today ? "今天" : yesterday ? "昨天"
    : time.getFullYear() === now.getFullYear()
      ? `${time.getMonth() + 1}月${time.getDate()}日`
      : `${time.getFullYear()}年${time.getMonth() + 1}月${time.getDate()}日`;
  return `${day} ${clock}`;
}

/**
 * 署名一行能拿到的东西：群聊回合的 author 与 live 步骤都长得这个样子，
 * 服务端老数据缺哪个字段都行。
 */
export interface AgentSignature {
  provider?: string | null;
  model?: string | null;
  thinkingEffort?: string | null;
}

/**
 * 「CLI · 模型 · 思考深度」，群聊三处署名（live 卡头部、成员步骤行、负责人行）共用。
 * 文案表两端同源：provider 取 `ISSUE_AGENT_PROVIDERS`（Android `boardTaskProviderLabel`），
 * 思考深度取 `ISSUE_AGENT_EFFORTS`（Android `boardTaskEffortLabel`），
 * CLI 自己报出来的原生档位（`provider:low` 这类）走 `compactThinkingLabel`。
 * `model` 等于 `"default"`（`ISSUE_AGENT_DEFAULT_MODEL`）时是「跟随服务端默认」的哨兵值、
 * 不是模型名：传了目录就换成服务端默认模型的具体名字，拿不到名字才整段不显示。
 * 哪一段缺就少一段，所以不会出现 `undefined`、空串或多余的「 · 」。
 */
export function agentSignatureLabel(
  agent: AgentSignature,
  catalog?: WandModelCatalog | null,
): string {
  const parts: string[] = [];
  if (agent.provider) parts.push(issueAgentProviderLabel(agent.provider));
  const model = wandModelDisplayName(catalog ?? null, agent.provider, agent.model);
  if (model) parts.push(model);
  const effort = agent.thinkingEffort?.trim() ?? "";
  if (effort) parts.push(issueAgentEffortLabel(effort));
  return parts.join(" · ");
}

/** 群聊里一条发言的角色：决定它排在哪一层、长什么样。 */
export type ChatTurnKind = "notice" | "user" | "leader" | "step";

export function chatTurnKind(turn: ConversationTurn): ChatTurnKind {
  if (turn.notice) return "notice";
  if (turn.role === "user") return "user";
  return turn.author?.leader ? "leader" : "step";
}

/** 服务端给成员报告加的前缀：`✅ 完成「T1 …」` / `❌ 没完成「T1 …」`。 */
const STEP_REPORT_MARK = /^(✅ 完成|❌ 没完成)「(.+?)」\s*/;

export interface ChatStepReport {
  ok: boolean;
  title: string;
  /** 去掉前缀之后的报告正文。 */
  body: string;
}

export function parseStepReport(text: string): ChatStepReport | null {
  const match = STEP_REPORT_MARK.exec(text.trim());
  if (!match) return null;
  return { ok: match[1] === "✅ 完成", title: match[2]!, body: text.trim().slice(match[0].length) };
}

/**
 * 报告回合的类型标签（设计 v2.5-A4）：标题纯空白视同没有报告标题 → `成员发言`，与 Android 同。
 * （`parseStepReport` 的正则本身不允许空标题，实际触发条件就是纯空白标题。）
 */
export function reportTypeLabel(report: ChatStepReport | null): string {
  return report && report.title.trim() ? `成员报告 · ${report.title}` : "成员发言";
}

/** 负责人派工那几行：`1. **@实现者** T1 类型与存储迁移（依据：第 1 步「设计规格」的产物）`。 */
const ASSIGN_LINE = /^\d+\.\s*\*\*@(.+?)\*\*\s*(.+)$/;
/** 新数据（S5）：`（依据：第 N 步「标题」的产物）`。 */
const ASSIGN_BASIS = /^(.+?)（(依据：.+?)）$/;
/** 旧数据：`（等第 1 项完成后）` —— 保留解析，同一个槽位展示，旧运行仍可读。 */
const ASSIGN_WAIT = /^(.+?)（(等第.+?)）$/;

export interface ChatAssignment {
  member: string;
  title: string;
  /** 括注内容（依据 / 旧等待说明）；两者都不在就是空串。字段由 v1 的 `wait` 改名而来。 */
  note: string;
}

export interface ChatLeaderMessage {
  /** 负责人自己的那段话（去掉派工清单）。 */
  head: string;
  assignments: ChatAssignment[];
}

/** 把负责人的发言拆成「说明」+「派工清单」，好把主任务渲染成计划卡而不是一坨文字。 */
export function splitLeaderMessage(text: string): ChatLeaderMessage {
  const lines = text.trim().split("\n");
  const assignments: ChatAssignment[] = [];
  const head: string[] = [];
  for (const line of lines) {
    const match = ASSIGN_LINE.exec(line.trim());
    if (!match) {
      head.push(line);
      continue;
    }
    const note = ASSIGN_BASIS.exec(match[2]!) ?? ASSIGN_WAIT.exec(match[2]!);
    assignments.push({ member: match[1]!, title: note ? note[1]! : match[2]!, note: note ? note[2]! : "" });
  }
  return { head: head.join("\n").trim(), assignments };
}

/** 报告够长才折叠，短报告原地铺开，别让展开按钮本身成为噪音。 */
const COLLAPSE_AFTER_LINES = 6;
const COLLAPSE_AFTER_CHARS = 420;

export function needsCollapse(text: string): boolean {
  return text.length > COLLAPSE_AFTER_CHARS || text.split("\n").length > COLLAPSE_AFTER_LINES;
}

/** 「我」：用户自己的发言没有成员身份，署名固定用这个词（两端同文案）。 */
export const CHAT_SELF_NAME = "我";

/** 正文为空的发言也要占住气泡/文档卡，不能变成一个空气泡。 */
export const CHAT_EMPTY_BODY = "（这条消息没有正文）";

/** 超长正文的展开入口；它是覆盖层入口，不是原位展开，所以只有这一个状态。 */
export const CHAT_EXPAND_LABEL = "点击展开";

/**
 * 消息形态分流（设计 §2，两端同名纯函数）：系统提示行居中、自己的发言走气泡、
 * 超阈值正文或负责人派工清单走全宽文档卡。「文档性质」的可判定定义就是后两条。
 */
export type TeamChatMessageShape = "notice" | "bubble" | "document";

/** 非 notice 的发言只可能是气泡或文档卡；重载让调用点不必再窄化一次。 */
export function teamChatMessageShape(
  kind: Exclude<ChatTurnKind, "notice">,
  text: string,
  assignmentCount?: number,
): "bubble" | "document";
export function teamChatMessageShape(
  kind: ChatTurnKind,
  text: string,
  assignmentCount?: number,
): TeamChatMessageShape;
export function teamChatMessageShape(
  kind: ChatTurnKind,
  text: string,
  assignmentCount = 0,
): TeamChatMessageShape {
  if (kind === "notice") return "notice";
  if (kind === "user") return "bubble";
  if (needsCollapse(text)) return "document";
  if (assignmentCount > 0) return "document";
  return "bubble";
}

/**
 * 「上半部分」预览：前 6 行且不超过 420 字，被截断就一定以 `…` 结尾。
 * 与 Android `collapsedPreview` 同算法，所以两端收起时看到的字逐字相同；
 * 正因为行数由这里定，预览不再叠 `-webkit-line-clamp`（两套截断会互相打架）。
 */
export function collapsedPreview(text: string): string {
  const lines = text.split("\n");
  let truncated = lines.length > COLLAPSE_AFTER_LINES;
  let kept = lines.slice(0, COLLAPSE_AFTER_LINES).join("\n");
  if (kept.length > COLLAPSE_AFTER_CHARS) {
    kept = kept.slice(0, COLLAPSE_AFTER_CHARS).trimEnd();
    truncated = true;
  }
  return truncated ? `${kept}…` : kept;
}

/** 一条发言的头像来源（设计 §5.2）：上传图 > 显式毛色 > 派生毛色 > 默认 APP logo。 */
export type ChatAvatarSpec =
  | { kind: "upload"; src: string }
  | { kind: "cat"; coat: number }
  | { kind: "brand" };

export function chatAvatarSpec(
  author: Pick<ConversationAuthor, "id" | "name" | "avatar"> | null | undefined,
): ChatAvatarSpec {
  const avatar = author?.avatar ?? "";
  if (avatar.startsWith("data:image/")) return { kind: "upload", src: avatar };
  // 能定位到成员身份才给猫脸（显式 `cat:<n>` 与派生毛色都由 memberCoatIndex 裁决，
  // 与团队页/工位是同一张脸）；「我」和没有署名的发言才回落成默认 APP logo。
  if (author && (author.id || author.name)) {
    return { kind: "cat", coat: memberCoatIndex({ id: author.id, name: author.name, avatar }) };
  }
  return { kind: "brand" };
}

/**
 * @ 流转的前边界（设计 v2.2.3）：行首 / 空白 / 中文标点之一。命中不了就当普通文本。
 * 模板里 `邀请 @a、@b 加入群聊` / `依据 @成员 第 N 步…` 都保证 `@` 前面是空格。
 */
const MENTION_BOUNDARY = /[\s（(、「【《，,。；;：:！!？?]/;

export interface MentionSegment {
  text: string;
  mention?: boolean;
}

/**
 * 把正文切成「普通文本 / @成员名」段（设计 v2.2.3 的同一套匹配规则）：
 * 候选 = 当前运行 roster 的名字（非空、去重）按长度降序 ⇒ 最长优先；`@` 前必须是前边界。
 * 命中不了（名字不在 roster、被切在半截）就归入普通文本，不猜、不丢字符。
 */
const MENTION_WRAPPERS = ["**", "__", "~~", "*", "_"] as const;
const MENTION_END = /[\s（(、「【《，,。；;：:！!？?）)」】》、.\]}]/;

/** 先在完整源文中找区间，再裁到预览：切在长名中间时绝不误认其短别名。 */
export function mentionSegments(
  text: string,
  names: readonly string[],
  source: string = text,
): MentionSegment[] {
  const candidates = [...new Set(names.map((name) => name.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  if (!text || candidates.length === 0) return text ? [{ text }] : [];
  // collapsedPreview 的 … 不是源文；trimEnd 也可能删掉 cutoff 前的空白。
  const preview = source !== text && text.endsWith("…") && source.startsWith(text.slice(0, -1));
  const cutoff = preview ? text.length - 1 : text.length;
  const ranges: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < source.length) {
    const boundary = index === 0 || MENTION_BOUNDARY.test(source[index - 1]!);
    const wrapper = boundary ? MENTION_WRAPPERS.find((mark) => source.startsWith(`${mark}@`, index)) : undefined;
    const at = wrapper ? index + wrapper.length : index;
    if ((boundary || wrapper) && source[at] === "@") {
      const hit = candidates.find((name) => source.startsWith(name, at + 1));
      if (hit) {
        const end = at + 1 + hit.length;
        const closed = wrapper ? source.startsWith(wrapper, end) : false;
        const tokenEnd = closed ? end + wrapper!.length : end;
        // 未闭合的包裹不算普通前边界；完整姓名后必须是词边界或闭标记。
        if ((!wrapper || closed) && (tokenEnd === source.length || MENTION_END.test(source[tokenEnd]!))
          && tokenEnd <= cutoff) {
          ranges.push({ start: at, end });
          index = tokenEnd;
          continue;
        }
      }
    }
    index++;
  }
  const segments: MentionSegment[] = [];
  let start = 0;
  for (const range of ranges) {
    if (range.start > start) segments.push({ text: text.slice(start, range.start) });
    segments.push({ text: text.slice(range.start, range.end), mention: true });
    start = range.end;
  }
  if (start < text.length) segments.push({ text: text.slice(start) });
  return segments;
}

/** 没有 roster 的正文（自己的发言 / 本地临时行）：@ 一律不高亮。 */
const EMPTY_MENTION_NAMES: readonly string[] = [];

/** 正文里的 @成员名：命中的那一段用统一 token 渲染，其余原样（两端同一套识别）。 */
function MentionText({ text, names, source }: {
  text: string;
  names: readonly string[];
  source?: string;
}): React.ReactElement {
  return <>{mentionSegments(text, names, source).map((segment, index) => (segment.mention
    ? <span className="team-chat-mention" title={segment.text} key={`mention#${index}`}>{segment.text}</span>
    : <React.Fragment key={`plain#${index}`}>{segment.text}</React.Fragment>))}</>;
}

function ChatAttachment({ path }: { path: string }): React.ReactElement {
  const [imageFailed, setImageFailed] = React.useState(false);
  const name = path.split("/").at(-1)?.replace(/^\d{13}-[0-9a-f]{8}-/, "") || path;
  const image = chatAttachmentIsImage(path) && !imageFailed;
  return <button
    type="button"
    className="team-chat-attachment"
    data-image={image || undefined}
    title={`预览 ${name}`}
    onClick={() => { void filePreviewController.open(path); }}
  >{image ? <img
    src={`/api/file-raw?path=${encodeURIComponent(path)}`}
    alt={name}
    loading="lazy"
    onError={() => setImageFailed(true)}
  /> : <><WandIcon name="file" size={18}/><span>{name}</span></>}</button>;
}

function ChatAttachments({ paths }: { paths: readonly string[] }): React.ReactElement | null {
  if (!paths.length) return null;
  return <div className="team-chat-attachments" aria-label="消息附件">
    {paths.map((path, index) => <ChatAttachment path={path} key={`${path}#${index}`}/>)}
  </div>;
}

/** 发言头像：32px 圆角方块，成员是各自的像素猫，没有身份的发言用系统 APP logo。 */
function MessageAvatar({ spec, size = "md" }: {
  spec: ChatAvatarSpec;
  size?: "md" | "sm";
}): React.ReactElement {
  return <span className="team-chat-avatar" data-kind={spec.kind} data-size={size} aria-hidden="true">
    {spec.kind === "upload"
      ? <img className="team-chat-avatar-upload" src={spec.src} alt=""/>
      : spec.kind === "cat"
        ? <PixelCat coat={spec.coat}/>
        : <WandBrandMark className="team-chat-avatar-brand"/>}
  </span>;
}

/**
 * 全文弹层要显示的一条发言（设计 §6）。正文是**全文**，不是预览；
 * `side` / `half` 只决定它从触发点的哪个方向长出来。
 */
export interface ChatDocPayload {
  text: string;
  name: string;
  clock: string;
  /** 「我的消息」/「成员发言」/「成员报告 · <标题>」/「负责人派工」。 */
  typeLabel: string;
  chip?: string;
  avatar: ChatAvatarSpec;
  side: "start" | "end";
  /** 打开时固定来源和名单；我的消息及临时行传空名单，关闭期间不变。 */
  mentionNames: readonly string[];
}

interface ChatDocLayer extends ChatDocPayload {
  /** 与行 React key 同源的本地呈现句柄；临时行使用独立命名空间。 */
  ownerId: string;
  scope: string;
  half: "top" | "bottom";
  phase: "open" | "closing";
}

/**
 * 正文块：短发言收进气泡，文档性质内容用全宽文档卡铺开。
 * 超阈值时**只渲染预览**（不渲染第二份全文，也不靠 `inert` 藏），底部给「点击展开」。
 */
function MessageBody({
  shape,
  text,
  assignments,
  names,
  onExpand,
}: {
  shape: "bubble" | "document";
  text: string;
  assignments?: ChatAssignment[];
  /** 当前运行的 roster：正文里的 @成员名 靠它识别（设计 v2.2.3）。 */
  names: readonly string[];
  onExpand?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}): React.ReactElement {
  const parsed = parseChatAttachments(text);
  const body = parsed.paths.length && parsed.body.trim() === "请查看附件。" ? "" : parsed.body;
  const truncated = needsCollapse(body);
  const list = assignments ?? [];
  return <div
    className={shape === "document" ? "team-chat-doc" : "chat-message-bubble team-chat-bubble"}
    data-shape={shape}
  >
    <ChatAttachments paths={parsed.paths}/>
    {body.trim()
      ? truncated
        ? <p className="team-chat-preview"><MentionText text={collapsedPreview(body)} names={names} source={body}/></p>
        : <pre className={shape === "document" ? "team-chat-doc-text" : "team-chat-bubble-text"}>
          <MentionText text={body} names={names}/>
        </pre>
      : list.length === 0 && parsed.paths.length === 0
        ? <p className="team-chat-preview team-chat-msg-empty">{CHAT_EMPTY_BODY}</p>
        : null}
    {list.length > 0 ? <ol className="team-chat-plan-list">
      {list.map((item, index) => <li key={`${item.member}#${index}`}>
        <span className="team-chat-mention">@{item.member}</span>
        <span className="team-chat-plan-title">{item.title}</span>
        {item.note ? <small className="team-chat-plan-basis">{item.note}</small> : null}
      </li>)}
    </ol> : null}
    {truncated && onExpand ? <button
      type="button"
      className="team-chat-expand"
      aria-haspopup="dialog"
      onClick={onExpand}
    >{CHAT_EXPAND_LABEL}</button> : null}
  </div>;
}

/** 一条消息：头像是内容列外侧、署名行在上、正文块在下；自己的发言整行镜像靠右。 */
function TeamMessageRow({
  kind,
  side,
  shape,
  status,
  avatar,
  name,
  sessionId,
  chip,
  badge,
  clock,
  onOpenSession,
  children,
  footer,
  presentationId,
  arriving = false,
  onArrivalEnd,
}: {
  kind: "user" | "leader" | "step";
  side: "start" | "end";
  shape: "bubble" | "document";
  status?: string;
  avatar: ChatAvatarSpec;
  name: string;
  sessionId?: string | null;
  chip?: React.ReactNode;
  badge?: string;
  clock?: string;
  onOpenSession?: (sessionId: string) => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  presentationId?: string;
  arriving?: boolean;
  onArrivalEnd?: (event: React.AnimationEvent<HTMLDivElement>) => void;
}): React.ReactElement {
  return <div
    className="chat-message assistant team-chat-msg"
    data-presentation-id={presentationId}
    data-arriving={arriving || undefined}
    onAnimationEnd={onArrivalEnd}
    data-kind={kind}
    data-side={side}
    data-shape={shape}
    data-status={status}
  >
    <MessageAvatar spec={avatar}/>
    <div className="team-chat-msg-content">
      <div className="team-chat-msg-head">
        {sessionId && onOpenSession
          ? <button
            type="button"
            className="avatar-name chat-author-link"
            title="查看这个成员的会话"
            onClick={() => onOpenSession(sessionId)}
          >{name}</button>
          : <span className="avatar-name">{name}</span>}
        {chip}
        {badge ? <span className="chat-author-badge">{badge}</span> : null}
        {clock ? <span className="chat-message-time">{clock}</span> : null}
      </div>
      {children}
      {footer}
    </div>
  </div>;
}

/**
 * 主任务公告位专用的长正文：收起给行数截断的预览，展开在原位长高（§7 要求 7，收起是展开的倒放）。
 * 消息正文不走这里：报告可长达数千字，就地展开会把下面的对话整体顶走，改用全文弹层（见 MessageBody）。
 */
function CollapsibleText({
  text,
  previewClassName,
  bodyClassName,
}: {
  text: string;
  previewClassName: string;
  bodyClassName: string;
}): React.ReactElement {
  const long = needsCollapse(text);
  const [open, setOpen] = React.useState(false);
  const expanded = !long || open;
  return <>
    {long && !expanded ? <p className={previewClassName}>{text}</p> : null}
    <div className={bodyClassName} data-open={expanded || undefined} inert={!expanded}>
      <div className={`${bodyClassName}-inner`}>
        <pre className={`${bodyClassName}-text`}>{text}</pre>
      </div>
    </div>
    {long ? <button
      type="button"
      className="team-chat-expand"
      aria-expanded={expanded}
      onClick={() => setOpen((current) => !current)}
    >{expanded ? "收起" : "展开全文"}</button> : null}
  </>;
}

/** 顶部钉住的「主任务」：群公告位，永远在群聊第一屏。 */
function MainTaskCard({ detail }: { detail: AiTeamRunDetail }): React.ReactElement {
  const { run } = detail;
  return <section className="team-chat-goal">
    <header className="team-chat-goal-head">
      <span className="team-chat-goal-label">主任务</span>
      <span className="team-chat-goal-meta">{run.stepsUsed}/{run.stepLimit} 步 · {displayTeamOf(detail).name}</span>
    </header>
    <CollapsibleText
      text={run.objective}
      previewClassName="team-chat-goal-preview"
      bodyClassName="team-chat-goal-body"
    />
  </section>;
}

/** 成员的步骤发言：报告 chip + 头像/名字，正文按形态走气泡或文档卡。 */
function StepTurn({
  turn,
  step,
  names,
  onOpenSession,
  onExpandDoc,
  presentationId,
  arriving,
  onArrivalEnd,
}: {
  turn: ConversationTurn;
  step: AiTeamStep | undefined;
  names: readonly string[];
  onOpenSession?: (sessionId: string) => void;
  onExpandDoc: (target: HTMLElement, payload: ChatDocPayload) => void;
  presentationId?: string;
  arriving?: boolean;
  onArrivalEnd?: (event: React.AnimationEvent<HTMLDivElement>) => void;
}): React.ReactElement {
  const author = turn.author;
  const report = parseStepReport(chatTurnText(turn));
  const text = report ? report.body : chatTurnText(turn);
  const clock = chatTurnClock(turn);
  const status = step?.status ?? (report?.ok === false ? "failed" : report ? "done" : undefined);
  const shape = teamChatMessageShape("step", text, 0);
  const name = author?.name ?? "成员";
  const avatar = chatAvatarSpec(author);
  const chip = report ? `${report.ok ? "✅" : "❌"} ${report.title}` : "";
  return <TeamMessageRow
    kind="step"
    side="start"
    shape={shape}
    status={status}
    avatar={avatar}
    name={name}
    sessionId={author?.sessionId ?? null}
    chip={report ? <span className="team-chat-step-chip" data-ok={report.ok || undefined}>{chip}</span> : null}
    clock={clock}
    onOpenSession={onOpenSession}
    presentationId={presentationId}
    arriving={arriving}
    onArrivalEnd={onArrivalEnd}
  >
    <MessageBody
      shape={shape}
      text={text}
      names={names}
      onExpand={(event) => onExpandDoc(event.currentTarget, {
        text,
        name,
        clock,
        typeLabel: reportTypeLabel(report),
        chip,
        avatar,
        side: "start",
        mentionNames: [...names],
      })}
    />
  </TeamMessageRow>;
}

/** 负责人的决策：派工清单渲染成任务条目，说明按形态走气泡或文档卡。 */
function LeaderTurn({
  turn,
  names,
  onOpenSession,
  onExpandDoc,
  presentationId,
  arriving,
  onArrivalEnd,
}: {
  turn: ConversationTurn;
  names: readonly string[];
  onOpenSession?: (sessionId: string) => void;
  onExpandDoc: (target: HTMLElement, payload: ChatDocPayload) => void;
  presentationId?: string;
  arriving?: boolean;
  onArrivalEnd?: (event: React.AnimationEvent<HTMLDivElement>) => void;
}): React.ReactElement {
  const author = turn.author;
  const clock = chatTurnClock(turn);
  const text = chatTurnText(turn);
  const { head, assignments } = splitLeaderMessage(text);
  const shape = teamChatMessageShape("leader", head, assignments.length);
  const name = author?.name ?? "负责人";
  const avatar = chatAvatarSpec(author);
  return <TeamMessageRow
    kind="leader"
    side="start"
    shape={shape}
    avatar={avatar}
    name={name}
    sessionId={author?.sessionId ?? null}
    badge="负责人"
    clock={clock}
    onOpenSession={onOpenSession}
    presentationId={presentationId}
    arriving={arriving}
    onArrivalEnd={onArrivalEnd}
  >
    <MessageBody
      shape={shape}
      text={head}
      assignments={assignments}
      names={names}
      onExpand={(event) => onExpandDoc(event.currentTarget, {
        // 弹层给整条发言（说明 + 派工清单），一定比卡片里被截断的那 6 行多。
        text,
        name,
        clock,
        typeLabel: "负责人派工",
        avatar,
        side: "start",
        mentionNames: [...names],
      })}
    />
  </TeamMessageRow>;
}

/** live 卡片「贴尾」阈值（§9 窗口口径）：距底不超过这么多像素才跟着最新一行滚。 */
export const LIVE_TAIL_PX = 24;

/** 文本还没来时的占位，卡片不能是个空框。 */
export const LIVE_EMPTY_TEXT = "已开始，等待第一段输出…";

const LIVE_STATE_LABEL: Partial<Record<AgentActivityState, string>> = {
  working: "工作中",
  needs_input: "等待回答",
  needs_permission: "等待授权",
  done: "已完成",
  failed: "失败",
};

/** 状态芯片文案；未知状态不给芯片（步骤芯片已经说明它在哪一步）。 */
export function liveStateLabel(state: AgentActivityState | undefined): string {
  return (state && LIVE_STATE_LABEL[state]) || "";
}

/** 距底够近才算贴尾：用户上滚看历史以后不许把他拽回尾部。 */
export function shouldFollowTail(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = LIVE_TAIL_PX,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

/**
 * 一个滚动容器此刻是否贴尾：外层群聊列表与 live 卡片内滚共用这一个判定，
 * 免得两处阈值漂到不同值。
 */
export function isFollowingTail(
  container: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold: number = LIVE_TAIL_PX,
): boolean {
  return shouldFollowTail(container.scrollTop, container.scrollHeight, container.clientHeight, threshold);
}

/** 按 seq 升序、按 stepId 去重：重推或乱序都不会让同一行出现两次。 */
export function orderLiveSteps(steps: AiTeamLiveStep[]): AiTeamLiveStep[] {
  const seen = new Set<string>();
  const unique: AiTeamLiveStep[] = [];
  for (const step of steps) {
    if (seen.has(step.stepId)) continue;
    seen.add(step.stepId);
    unique.push(step);
  }
  return unique.sort((a, b) => a.seq - b.seq);
}

/** 卡片内按下与松开之间超过这个位移就不算「点开详情」（拖动滚动、框选正文）。 */
export const LIVE_CARD_DRAG_PX = 6;

/** 顶部省略提示；没截断就不显示。 */
export function liveOmittedText(omittedChars: number): string {
  return omittedChars > 0 ? `已省略前面 ${omittedChars} 字` : "";
}

/** 一行 live 输出；`leaving` 是这一步已经收工、正在原位收回。 */
interface LiveRow {
  step: AiTeamLiveStep;
  leaving: boolean;
  /** 开始退场的时刻（epoch ms）；还在输出的行为 0，可见性恢复时按它清理过期退场行。 */
  leavingSince: number;
}

/**
 * 新一批 live 来了：本次还在输出的按服务端顺序进来，上一批里消失的标成退场。
 * **排序只看 `seq`，与是否在退场无关**：退场行留在它原来的位置，不会被搬到尾部。
 * 把行搬到另一个 DOM 位置会让 CSS 动画重播一次（还会位置跳动），所以同一批内
 * 不管谁在收工，前后顺序都不会因新一轮推送而交换。
 * 退场行由组件摘除：`animationend` 或等长的定时器兜底（后台标签页不播动画）。
 */
export function mergeLiveRows(current: LiveRow[], steps: AiTeamLiveStep[], now: number = Date.now()): LiveRow[] {
  const next = orderLiveSteps(steps);
  const kept = new Set(next.map((step) => step.stepId));
  // 已经在退场的行保留它原来的起算时刻，别被新一轮推送续命；同一步又开工则取消退场。
  const leaving = current
    .filter((row) => !kept.has(row.step.stepId))
    .map((row) => ({ ...row, leaving: true, leavingSince: row.leaving ? row.leavingSince : now }));
  return [...next.map((step) => ({ step, leaving: false, leavingSince: 0 })), ...leaving]
    .sort((a, b) => a.step.seq - b.step.seq);
}

/** 摘除一行的退场态：animationend、兜底定时器、可见性恢复三处都走这里，重复调用没有副作用。 */
function dropRetiredRow(rows: LiveRow[], stepId: string): LiveRow[] {
  return rows.filter((row) => !(row.leaving && row.step.stepId === stepId));
}

/**
 * 退场动画时长从 CSS 动效 token `--motion-quick-exit` 读（兜底定时器与可见性清理共用），
 * 页面不写字面毫秒；时长改了这里跟着改。
 */
export const MOTION_QUICK_EXIT_VAR = "--motion-quick-exit";

/** 纯解析动效时长：`90ms` / `0.09s` → 90；读不出合法值返回 null，调用方就不挂兜底定时器。 */
export function parseMotionDurationMs(raw: string): number | null {
  const value = raw.trim();
  const ms = /^(\d+(?:\.\d+)?)ms$/.exec(value);
  if (ms) return Math.round(Number(ms[1]));
  const sec = /^(\d+(?:\.\d+)?)s$/.exec(value);
  if (sec) return Math.round(Number(sec[1]) * 1000);
  return null;
}

function liveExitDurationMs(): number | null {
  if (typeof window === "undefined") return null;
  return parseMotionDurationMs(getComputedStyle(document.documentElement).getPropertyValue(MOTION_QUICK_EXIT_VAR));
}

/**
 * 后台标签页里 CSS 动画不播、`animationend` 不来，退场行会攒着：回到可见时把
 * 已经超过退场时长的一次性摘掉。没到期的留在原位继续播完。
 */
export function pruneExpiredLeaving(rows: LiveRow[], now: number, retireMs: number): LiveRow[] {
  const kept = rows.filter((row) => !row.leaving || now - row.leavingSince < retireMs);
  // 没有要摘的行就返回原引用，省一次无谓重渲染。
  return kept.length === rows.length ? rows : kept;
}

/**
 * 正在输出的成员（§4.9）：卡片宽高等于收起时也一样，文字在里面滚，
 * 整卡点开该成员的会话。新文本到达不换卡片尺寸，所以不会把下面的行顶来顶去。
 */
function LiveStepRow({
  row,
  title,
  memberName,
  state,
  onOpenSession,
  onRetire,
}: {
  row: LiveRow;
  title: string;
  memberName: string;
  state: AgentActivityState | undefined;
  onOpenSession?: (sessionId: string) => void;
  onRetire(stepId: string): void;
}): React.ReactElement {
  const step = row.step;
  const bodyRef = React.useRef<HTMLPreElement>(null);
  const pinnedRef = React.useRef(true);
  const pressRef = React.useRef<{ x: number; y: number } | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const label = liveStateLabel(state ?? step.state);
  const clock = chatTurnClock({ createdAt: step.updatedAt, completedAt: step.updatedAt });
  const omitted = liveOmittedText(step.omittedChars);
  const lastLine = step.text.trim().split("\n").filter(Boolean).at(-1) || LIVE_EMPTY_TEXT;

  // 展开时才跟随最新一行；用户上滚看旧输出后不再拉回尾部。
  React.useEffect(() => {
    const body = bodyRef.current;
    if (expanded && body && pinnedRef.current) body.scrollTop = body.scrollHeight;
  }, [expanded, step.text]);

  const open = (): void => {
    if (!onOpenSession) return;
    // 选正文复制不该被当成「点开详情」。
    if (window.getSelection()?.toString()) return;
    onOpenSession(step.sessionId);
  };

  return <div
    className="team-chat-live-row"
    data-leaving={row.leaving || undefined}
    onAnimationEnd={(event) => {
      // 只认这一行自己的收工动画：头名与卡片是分两段长出的，它们的 animationend 会冒泡到这里。
      if (row.leaving && event.target === event.currentTarget) onRetire(step.stepId);
    }}
  >
    <div className="team-chat-live-head">
      {/* 署名行不再放头像：紧贴其上的开工发言已经给过同一张脸（设计 v2.2.4）；
          也不单独挂链接——整卡已可点进该成员会话，不再嵌套点击。 */}
      <span className="team-chat-live-name" title={memberName}>{memberName}</span>
      <span className="team-chat-live-chip">#{step.seq}{title ? ` ${title}` : ""}</span>
      {label ? <span className="team-chat-live-state" data-state={step.state}>{label}</span> : null}
      {clock ? <span className="chat-message-time">{clock}</span> : null}
    </div>
    <button
      type="button"
      className="team-chat-live-summary"
      aria-expanded={expanded}
      onClick={() => setExpanded((current) => !current)}
    >
      <span>{lastLine}</span>
      <small>{expanded ? "收起输出" : "展开输出"}</small>
    </button>
    <div className="team-chat-live-body" data-open={expanded || undefined} inert={!expanded}>
      <div className="team-chat-live-body-inner">
      <div
      className="team-chat-live-card"
      role="button"
      tabIndex={0}
      title="查看这个成员的会话"
      aria-label={`打开${memberName}正在输出的会话`}
      onPointerDown={(event) => { pressRef.current = { x: event.clientX, y: event.clientY }; }}
      onClick={(event) => {
        const press = pressRef.current;
        if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > LIVE_CARD_DRAG_PX) return;
        open();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      }}
    >
      {omitted ? <p className="team-chat-live-omitted">{omitted}</p> : null}
      <pre
        className="team-chat-live-text"
        ref={bodyRef}
        onScroll={(event) => {
          pinnedRef.current = isFollowingTail(event.currentTarget);
        }}
      >{step.text || LIVE_EMPTY_TEXT}</pre>
      </div>
      </div>
    </div>
  </div>;
}

/** 呈现指纹是完整载荷元组，不是消息 ID；不支持的块不猜身份，静态重绑。 */
export function chatTurnFingerprint(turn: ConversationTurn): string | null {
  const content = turn.content.map((block) => block.type === "text" ? ["text", block.text] : null);
  if (content.some((block) => block === null)) return null;
  const author = turn.author;
  return JSON.stringify([
    turn.role, turn.notice ?? null, turn.createdAt ?? null, turn.completedAt ?? null,
    author ? [author.id ?? null, author.name ?? null, author.leader ?? null,
      author.sessionId ?? null, author.provider ?? null, author.model ?? null,
      author.thinkingEffort ?? null, author.avatar ?? null] : null,
    content,
  ]);
}

function contiguousIndex(haystack: readonly string[], needle: readonly string[]): number {
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((fingerprint, index) => haystack[start + index] === fingerprint)) return start;
  }
  return -1;
}

/** 并发 GET 只能追加可证明的新尾；旧窗、无重叠和重复歧义都保留已显示内容。 */
export function mergeTeamChatTurns(
  current: readonly ConversationTurn[],
  fetched: readonly ConversationTurn[],
): ConversationTurn[] {
  if (current.length === 0) return [...fetched];
  if (fetched.length === 0) return current as ConversationTurn[];
  const before = current.map(chatTurnFingerprint);
  const after = fetched.map(chatTurnFingerprint);
  if (before.includes(null) || after.includes(null)) return current as ConversationTurn[];
  const currentIds = before as string[];
  const fetchedIds = after as string[];
  const contained = contiguousIndex(fetchedIds, currentIds);
  if (contained >= 0) return contained + current.length < fetched.length
    ? [...fetched] : current as ConversationTurn[];
  if (contiguousIndex(currentIds, fetchedIds) >= 0) return current as ConversationTurn[];
  let overlap = 0;
  for (let length = 1; length <= Math.min(current.length, fetched.length); length++) {
    if (currentIds.slice(-length).every((fingerprint, index) => fingerprint === fetchedIds[index])) {
      if (overlap > 0) return current as ConversationTurn[];
      overlap = length;
    }
  }
  return overlap > 0
    ? [...current, ...fetched.slice(overlap)].slice(-AI_TEAM_DETAIL_CHAT_TURNS)
    : current as ConversationTurn[];
}

/** 同 run 详情按更新时间与步骤进度单调合入；新 run 的状态和步骤必须独立切换。 */
export function mergeTeamChatDetail(
  current: AiTeamRunDetail | null,
  next: AiTeamRunDetail,
): AiTeamRunDetail {
  if (!current || current.run.id !== next.run.id) return next;
  const currentAt = Date.parse(current.run.updatedAt ?? "");
  const nextAt = Date.parse(next.run.updatedAt ?? "");
  const settled = (detail: AiTeamRunDetail): number => detail.steps.filter((step) =>
    step.status === "done" || step.status === "failed" || step.status === "skipped").length;
  const currentTerminal = current.run.status === "done" || current.run.status === "failed"
    || current.run.status === "stopped";
  const nextTerminal = next.run.status === "done" || next.run.status === "failed"
    || next.run.status === "stopped";
  const stale = Number.isFinite(currentAt) && Number.isFinite(nextAt) && nextAt < currentAt
    || nextAt === currentAt && (currentTerminal && !nextTerminal
      || next.steps.length < current.steps.length || settled(next) < settled(current)
      || next.run.stepsUsed < current.run.stepsUsed);
  const base = stale ? current : next;
  const displayTeam = Date.parse(current.displayTeam?.updatedAt ?? "") > Date.parse(next.displayTeam?.updatedAt ?? "")
    ? current.displayTeam : next.displayTeam;
  // 任务改名与运行推进独立：不能因 run 没变而丢掉新群名，也不能被迟到快照改回旧名。
  const titleDetail = next.chatTitle === undefined
    || Date.parse(current.chatTitleUpdatedAt ?? "") > Date.parse(next.chatTitleUpdatedAt ?? "")
    ? current : next;
  return { ...base, ...(displayTeam ? { displayTeam } : {}),
    ...(titleDetail.chatTitle !== undefined
      ? { chatTitle: titleDetail.chatTitle, chatTitleUpdatedAt: titleDetail.chatTitleUpdatedAt } : {}),
    chatTurns: mergeTeamChatTurns(current.chatTurns, next.chatTurns) };
}

export interface PresentedTurn {
  presentationId: string;
  turn: ConversationTurn;
  fingerprint: string | null;
}

export interface ChatPresentation {
  scope: string;
  rows: PresentedTurn[];
  nextId: number;
  /** 仅本批可证明的尾部追加；可见/贴尾资格稍后在页面提交时消费。 */
  candidates: readonly string[];
}

/** 全指纹连续重叠只能有一种长度；多种长度（周期/重复组）一律不猜新尾。 */
function uniqueTailOverlap(before: readonly PresentedTurn[], after: readonly (string | null)[]): number | null {
  let found: number | null = null;
  for (let length = 1; length <= Math.min(before.length, after.length); length++) {
    if (before.slice(-length).every((row, index) => row.fingerprint !== null
      && row.fingerprint === after[index])) {
      if (found !== null) return null;
      found = length;
    }
  }
  return found;
}

/** 仅保留上次/本次窗口。完全相同真实替换不可观测，句柄不等于 relay 消息 ID。 */
export function projectChatTurns(
  previous: ChatPresentation | null,
  scope: string,
  turns: readonly ConversationTurn[],
): ChatPresentation {
  const before = previous?.scope === scope ? previous.rows : [];
  const fingerprints = turns.map(chatTurnFingerprint);
  let nextId = previous?.scope === scope ? previous.nextId : 0;
  const allocate = (): string => `turn-${++nextId}`;
  const unchanged = before.length === turns.length && before.every((row, i) => row.fingerprint !== null
    && row.fingerprint === fingerprints[i]);
  if (unchanged) return {
    scope, nextId, candidates: [],
    rows: turns.map((turn, i) => ({ ...before[i]!, turn })),
  };
  const overlap = uniqueTailOverlap(before, fingerprints);
  const beforeCounts = new Map<string, number>();
  const afterCounts = new Map<string, number>();
  for (const row of before) if (row.fingerprint !== null) {
    beforeCounts.set(row.fingerprint, (beforeCounts.get(row.fingerprint) ?? 0) + 1);
  }
  for (const fingerprint of fingerprints) if (fingerprint !== null) {
    afterCounts.set(fingerprint, (afterCounts.get(fingerprint) ?? 0) + 1);
  }
  const rows: PresentedTurn[] = [];
  const candidates: string[] = [];
  const lastAt = before.length ? Date.parse(before.at(-1)!.turn.createdAt ?? "") : -Infinity;
  for (let index = 0; index < turns.length; index++) {
    const fingerprint = fingerprints[index]!;
    const anchored = overlap !== null && index < overlap
      ? before[before.length - overlap + index] : undefined;
    const unique = fingerprint !== null && (beforeCounts.get(fingerprint) ?? 0) <= 1
      && afterCounts.get(fingerprint) === 1;
    // 同文歧义组若无法整组唯一对齐，全部重绑并关闭该组 owner；不影响其它单例。
    const groupAnchored = anchored && fingerprint !== null
      && beforeCounts.get(fingerprint) === afterCounts.get(fingerprint)
      && turns.every((_, i) => fingerprints[i] !== fingerprint
        || (overlap !== null && i < overlap
          && before[before.length - overlap + i]?.fingerprint === fingerprint));
    const retained = anchored && (unique || groupAnchored)
      ? anchored : unique ? before.find((row) => row.fingerprint === fingerprint) : undefined;
    const presentationId = retained?.presentationId ?? allocate();
    rows.push({ turn: turns[index]!, fingerprint, presentationId });
    const at = Date.parse(turns[index]!.createdAt ?? "");
    if (!retained && unique && (before.length === 0 && previous?.scope === scope || overlap !== null && index >= overlap)
      && Number.isFinite(at) && (before.length === 0 || Number.isFinite(lastAt) && at >= lastAt)) {
      candidates.push(presentationId);
    }
  }
  return { scope, rows, nextId, candidates };
}

/** Portal 内容卸载是共享 Dialog 完成退场的信号；页面不另造退场计时器。 */
function ChatDocContents({ layer, onExited }: {
  layer: ChatDocLayer;
  onExited: (ownerId: string) => void;
}): React.ReactElement {
  const ownerId = layer.ownerId;
  const parsed = parseChatAttachments(layer.text);
  React.useEffect(() => () => onExited(ownerId), [ownerId, onExited]);
  return <div className="team-chat-doc-layer">
    <div className="team-chat-doc-layer-meta">
      <MessageAvatar spec={layer.avatar} size="sm"/>
      <span className="team-chat-doc-layer-name">{layer.name}</span>
      {layer.chip ? <span className="team-chat-step-chip">{layer.chip}</span> : null}
      {layer.clock ? <span className="chat-message-time">{layer.clock}</span> : null}
    </div>
    <ChatAttachments paths={parsed.paths}/>
    <pre className="team-chat-doc-layer-text" tabIndex={0} data-wand-autofocus>
      {parsed.body.trim()
        ? <MentionText text={parsed.body} names={layer.mentionNames}/>
        : CHAT_EMPTY_BODY}
    </pre>
  </div>;
}

/** 全文存活与退场归焦共用同一 scoped owner 空间；本地临时行不进入服务端账本。 */
export function chatDocOwnerPresent(
  ownerId: string,
  ownerScope: string,
  projection: ChatPresentation | null,
  local: readonly LocalChatTurn[],
): boolean {
  if (projection?.scope !== ownerScope) return false;
  return ownerId.startsWith("local#")
    ? local.some((row) => `local#${row.sentAt}` === ownerId)
    : projection.rows.some((row) => row.presentationId === ownerId);
}

export interface TeamChatViewProps {
  detail: AiTeamRunDetail;
  onChange(detail: AiTeamRunDetail): void;
  onOpenSession?: (sessionId: string) => void;
  details?: React.ReactNode;
  /** 自动跟随同一群聊的新 run 期间保留输入，但要等新详情到达后才能发送。 */
  staleRun?: boolean;
}

export function TeamChatView({ detail, onChange, onOpenSession, details, staleRun = false }: TeamChatViewProps): React.ReactElement {
  const { run, chatTurns, steps } = detail;
  const [local, setLocal] = React.useState<LocalChatTurn[]>([]);
  const [error, setError] = React.useState("");
  const [pending, setPending] = React.useState<"" | "send" | "stop">("");
  const [sendStage, setSendStage] = React.useState<"upload" | "message">("message");
  const [draggingFiles, setDraggingFiles] = React.useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = React.useState(false);
  const composerHostRef = React.useRef<HTMLDivElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const attachmentButtonRef = React.useRef<HTMLButtonElement>(null);
  const attachmentMenuRef = React.useRef<HTMLDivElement>(null);
  const composingRef = React.useRef(false);
  const compositionEpochRef = React.useRef(0);
  const [liveRows, setLiveRows] = React.useState<LiveRow[]>([]);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [docLayer, setDocLayer] = React.useState<ChatDocLayer | null>(null);
  const [arrival, setArrival] = React.useState<{ scope: string; ids: ReadonlySet<string> }>(
    { scope: "", ids: new Set() },
  );
  const scope = teamChatScope(run);
  const chatSessionId = run.chatSessionId;
  const composerRevision = React.useCallback(() => teamChatComposer.revision(chatSessionId), [chatSessionId]);
  React.useSyncExternalStore(teamChatComposer.subscribe, composerRevision, composerRevision);
  const composerDraft = teamChatComposer.read(chatSessionId);
  const draft = composerDraft.text;
  const attachments = composerDraft.attachments;
  const activeRunRef = React.useRef({ scope, runId: run.id, epoch: 0 });
  React.useLayoutEffect(() => {
    const previous = activeRunRef.current;
    activeRunRef.current = {
      scope, runId: run.id, epoch: previous.epoch + (previous.scope === scope ? 0 : 1),
    };
  }, [scope, run.id]);
  const latestDetailRef = React.useRef(detail);
  React.useLayoutEffect(() => { latestDetailRef.current = detail; }, [detail]);
  const ledgerRef = React.useRef<ChatPresentation | null>(null);
  const projection = React.useMemo(
    () => projectChatTurns(ledgerRef.current, scope, chatTurns),
    [scope, chatTurns],
  );
  // 只提交成功渲染的账本；并发/StrictMode 放弃的 render 不消耗候选入场资格。
  React.useLayoutEffect(() => { ledgerRef.current = projection; }, [projection]);
  const detailsId = React.useId();
  const attachmentMenuId = React.useId();
  const listRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const ownerSnapshotRef = React.useRef({ projection, local });
  React.useLayoutEffect(() => { ownerSnapshotRef.current = { projection, local }; }, [projection, local]);
  const settledRef = React.useRef<ChatPresentation | null>(null);
  const anchorRef = React.useRef<{ id: string; offset: number } | null>(null);
  const lastScopeRef = React.useRef(scope);
  const composerScopeRef = React.useRef(scope);
  const mountedRef = React.useRef(true);
  const triggerScopeRef = React.useRef("");
  const closingOwnerRef = React.useRef<string | null>(null);
  /**
   * 外层列表的「贴尾」状态：跟 live 卡片同一套阈值（距底 ≤ LIVE_TAIL_PX）。
   * 用户上滚看历史以后，live 行插入/摘除不许把他拽回尾部。
   */
  const listPinnedRef = React.useRef(true);
  /** 当前运行的 roster：正文里的 @成员名 靠它识别（设计 v2.2.3；空名单 → 不高亮）。 */
  const displayTeam = displayTeamOf(detail);
  const rosterNames = React.useMemo(
    () => [...new Set([...displayTeam.members.map((member) => member.name),
      ...run.team.members.map((member) => member.name),
      ...chatTurns.map((turn) => turn.author?.name).filter((name): name is string => !!name)])],
    [displayTeam, run.team, chatTurns],
  );
  const hint = staleRun ? "正在接入新一轮，加载完成后可发送" : chatInputHint(run.status);
  const running = run.status === "running";
  const composerMode = teamChatComposerMode(run.status, !!draft.trim() || attachments.length > 0, pending);
  const busy = pending !== "";
  const primaryStops = composerMode === "stop";
  const primaryDisabled = busy || staleRun || composerMode === "blocked";
  const primaryPhase = pending === "send" ? "sending" : primaryStops ? "running" : "idle";
  const primaryLabel = pending === "send" ? sendStage === "upload" ? "上传中…" : "发送中…"
    : pending === "stop" ? "停止中…" : primaryStops ? "停止团队" : "发送消息";
  const composerStatus = error ? "操作失败" : (pending === "send" ? sendStage === "upload" ? "上传中…" : "发送中…"
    : pending === "stop" ? "停止中…" : "Enter 发送 · Shift+Enter 换行");

  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    resizeChatComposerInput(input);
  }, [draft, chatSessionId]);

  React.useLayoutEffect(() => {
    const input = inputRef.current;
    const wrap = input?.parentElement;
    if (!input || !wrap) return;
    let lastWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? wrap.getBoundingClientRect().width;
      if (width <= 0 || Math.abs(width - lastWidth) < 0.5) return;
      lastWidth = width;
      resizeChatComposerInput(input);
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [chatSessionId]);

  React.useEffect(() => {
    if (!attachmentMenuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && (attachmentButtonRef.current?.contains(target)
        || attachmentMenuRef.current?.contains(target))) return;
      setAttachmentMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setAttachmentMenuOpen(false);
      attachmentButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [attachmentMenuOpen]);

  React.useLayoutEffect(() => {
    if (!attachmentMenuOpen) return;
    const host = composerHostRef.current;
    const trigger = attachmentButtonRef.current;
    const menu = attachmentMenuRef.current;
    if (!host || !trigger || !menu) return;
    const align = (): void => {
      const hostRect = host.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      menu.style.left = `${Math.max(0, triggerRect.left - hostRect.left)}px`;
      menu.style.bottom = `${Math.max(0, hostRect.bottom - triggerRect.top + 8)}px`;
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(host);
    observer.observe(trigger);
    window.addEventListener("resize", align);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", align);
    };
  }, [attachmentMenuOpen, attachments.length, chatSessionId, hint]);

  React.useEffect(() => { setAttachmentMenuOpen(false); }, [chatSessionId]);

  const closeDoc = React.useCallback((): void => {
    setDocLayer((current) => {
      if (current?.phase !== "open") return current;
      closingOwnerRef.current = `${current.scope}/${current.ownerId}`;
      return { ...current, phase: "closing" };
    });
  }, []);
  const onDocExited = React.useCallback((ownerId: string): void => {
    // StrictMode 对 effect 的模拟卸载不是退场；只有页面发起关闭后才清快照/归焦。
    if (closingOwnerRef.current !== `${triggerScopeRef.current}/${ownerId}`) return;
    closingOwnerRef.current = null;
    setDocLayer((current) => current?.ownerId === ownerId && current.phase === "closing" ? null : current);
    // Base UI 也会恢复焦点；只对本层补 preventScroll 与 owner 失效时的列表锚点。
    queueMicrotask(() => {
      if (!mountedRef.current) return;
      const latest = ownerSnapshotRef.current;
      const ownerExists = chatDocOwnerPresent(ownerId, triggerScopeRef.current, latest.projection, latest.local);
      const target = ownerExists && triggerRef.current?.isConnected ? triggerRef.current : listRef.current;
      target?.focus({ preventScroll: true });
    });
  }, []);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 草稿和待确认消息属于 relay 群聊。只有切到另一个群聊才清，接续 run 要保留它们。
  React.useEffect(() => {
    if (composerScopeRef.current === scope) return;
    composerScopeRef.current = scope;
    setLocal([]);
    setError("");
    setPending("");
    listPinnedRef.current = true;
  }, [scope]);

  // 公告详情属于这一轮；切 run 时关闭，消息列表与输入状态仍按 relay 会话连续。
  React.useEffect(() => {
    setDetailsOpen(false);
    closeDoc();
  }, [run.id, closeDoc]);

  // 服务端后续快照可能才回显已发送消息；逐条正文匹配后撤掉对应临时行。
  React.useEffect(() => {
    setLocal((current) => settleLocalTurns(current, chatTurns));
  }, [chatTurns, scope]);

  // 列表 key、全文 owner 与失效兜底共用这一次投影；失败请求不触发投影更新。
  React.useLayoutEffect(() => {
    if (docLayer?.phase !== "open") return;
    if (!chatDocOwnerPresent(docLayer.ownerId, docLayer.scope, projection, local)) closeDoc();
  }, [docLayer, scope, projection, local, closeDoc]);

  // 在播资格的撤销与新快照无关：隐藏、离页或动态开启减动效都当场归稳态。
  // live 退场有独立的 token 兜底，不得把它的时长读取失败误当作本监听的开关。
  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const consume = (): void => setArrival((current) => current.ids.size
      ? { scope: current.scope, ids: new Set() } : current);
    const onVisibility = (): void => { if (document.visibilityState !== "visible") consume(); };
    const onMotionChange = (): void => { if (media.matches) consume(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", consume);
    media.addEventListener("change", onMotionChange);
    onVisibility();
    onMotionChange();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", consume);
      media.removeEventListener("change", onMotionChange);
    };
  }, []);

  // 到达资格只在提交这一批时消费。前台、原贴尾、这批第一次可见才加条件类；
  // reduce-motion/后台/上滚/重挂载均即时静态，不留待回来时补播。
  React.useLayoutEffect(() => {
    if (settledRef.current === projection) return;
    settledRef.current = projection;
    const list = listRef.current;
    if (!list) return;
    if (lastScopeRef.current !== scope) {
      anchorRef.current = null;
      listPinnedRef.current = true;
      lastScopeRef.current = scope;
    }
    if (listPinnedRef.current) list.scrollTop = list.scrollHeight;
    else if (anchorRef.current) {
      const anchor = [...list.children].find((node) =>
        (node as HTMLElement).dataset.presentationId === anchorRef.current?.id) as HTMLElement | undefined;
      if (anchor) list.scrollTop += anchor.getBoundingClientRect().top
        - list.getBoundingClientRect().top - anchorRef.current.offset;
    }
    const visible = new Set<string>();
    if (listPinnedRef.current && document.visibilityState === "visible"
      && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const rect = list.getBoundingClientRect();
      for (const id of projection.candidates) {
        const node = [...list.children].find((item) =>
          (item as HTMLElement).dataset.presentationId === id) as HTMLElement | undefined;
        if (node && node.getBoundingClientRect().bottom > rect.top
          && node.getBoundingClientRect().top < rect.bottom) visible.add(id);
      }
    }
    setArrival((current) => ({
      scope,
      ids: new Set([
        ...(current.scope === scope ? [...current.ids] : [])
          .filter((id) => projection.rows.some((row) => row.presentationId === id)),
        ...visible,
      ]),
    }));
  }, [projection, scope]);

  /**
   * live 文本（§4.9.1）：进入时 GET 一次初值，之后只吃 `ai-team-step-live` 推送。
   * 换运行 / 换到非 running 状态就清空——收工的那一步会由 `ai-team-run` 重拉进 chatTurns。
   */
  React.useEffect(() => {
    setLiveRows([]);
    if (!running) return undefined;
    let alive = true;
    void aiTeamsRepository.live(run.id).then(
      (update) => { if (alive) setLiveRows(mergeLiveRows([], update.steps)); },
      () => undefined,
    );
    const unsubscribe = aiTeamsRepository.subscribeAiTeamStepLive((update) => {
      if (!alive || update.runId !== run.id) return;
      setLiveRows((current) => mergeLiveRows(current, update.steps));
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [run.id, running]);

  /**
   * 退场兜底：标签页在后台时 CSS 动画不播、`animationend` 永远不来，退场行会一直攒着。
   * 每行按自己的退场起算时刻挂一个等长的定时器（时长取动效 token），到点摘除；
   * 与 `animationend` 走同一个 dropRetiredRow，重复触发没有副作用。
   */
  React.useEffect(() => {
    const retireMs = liveExitDurationMs();
    if (retireMs === null) return undefined;
    const now = Date.now();
    const timers = liveRows
      .filter((row) => row.leaving)
      .map((row) => window.setTimeout(
        () => setLiveRows((current) => dropRetiredRow(current, row.step.stepId)),
        Math.max(0, row.leavingSince + retireMs - now),
      ));
    return () => { for (const timer of timers) window.clearTimeout(timer); };
  }, [liveRows]);

  // 回到可见再补一次清理：隐藏期间没播动画攒下的退场行，超过退场时长的当场摘掉。
  React.useEffect(() => {
    const retireMs = liveExitDurationMs();
    if (retireMs === null) return undefined;
    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      setLiveRows((current) => pruneExpiredLeaving(current, Date.now(), retireMs));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // 面板截尾 200 条，比全量会话短，这是预期行为；本来就贴着底才跟着新消息滚到底。
  React.useEffect(() => {
    const list = listRef.current;
    if (!list || !listPinnedRef.current) return;
    list.scrollTop = list.scrollHeight;
  }, [projection.rows.at(-1)?.presentationId, local.length, liveRows.length]);

  /**
   * 打开全文弹层：只在这里量一次触发点的矩形（进场方向 + 水平侧），之后不再测，
   * 所以弹层开着期间滚动/重排都不会移动已经开好的层。
   */
  const openDoc = (target: HTMLElement, ownerId: string, payload: ChatDocPayload): void => {
    if (docLayer) return;
    const rect = target.getBoundingClientRect();
    const half = rect.top + rect.height / 2 < window.innerHeight / 2 ? "top" : "bottom";
    triggerRef.current = target;
    triggerScopeRef.current = scope;
    setDocLayer({ ...payload, ownerId, scope, half, phase: "open" });
  };

  const addFiles = (incoming: FileList | readonly File[]): void => {
    if (!chatSessionId) return;
    const files = Array.from(incoming);
    const available = Math.max(0, 5 - teamChatComposer.read(chatSessionId).attachments.length);
    if (files.length > available) setError("一次最多添加 5 个附件。");
    for (const [index, file] of files.slice(0, available).entries()) {
      if (file.size > 10 * 1024 * 1024) {
        setError(`文件超过 10 MB：${file.name || "图片"}`);
        continue;
      }
      const isImage = file.type.startsWith("image/");
      const name = file.name && file.name !== "blob" ? file.name
        : `image-${Date.now()}-${index + 1}.${file.type.split("/")[1] || "png"}`;
      teamChatComposer.edit(chatSessionId, { addAttachment: {
        file, name, size: file.size,
        previewUrl: isImage ? URL.createObjectURL(file) : null,
      } });
    }
  };

  const send = async (): Promise<void> => {
    const text = draft.trim();
    const sessionId = run.chatSessionId;
    if ((!text && !attachments.length) || !sessionId || busy || staleRun) return;
    const sendScope = scope;
    const sendEpoch = activeRunRef.current.epoch;
    const sameChat = (): boolean => activeRunRef.current.scope === sendScope
      && activeRunRef.current.epoch === sendEpoch;
    const knownFingerprints = chatTurns.map(chatTurnFingerprint)
      .filter((fingerprint): fingerprint is string => fingerprint !== null);
    setPending("send");
    setError("");
    // 自己刚发的话一定要看见：发送算一次明确的「回到底部」意图。
    listPinnedRef.current = true;
    let stage: "upload" | "message" = attachments.length ? "upload" : "message";
    setSendStage(stage);
    try {
      await teamChatComposer.submit(sessionId, text, async (payload) => {
        let uploaded: UploadedChatFile[] = [];
        if (payload.attachments.length) {
          const form = new FormData();
          for (const item of payload.attachments) form.append("files", item.file, item.name);
          const response = await requestJson<{ files: UploadedChatFile[] }>(chatUploadUrl(sessionId), {
            method: "POST", body: form,
          });
          uploaded = response.files;
          if (!Array.isArray(uploaded) || uploaded.length !== payload.attachments.length) {
            throw new Error("附件上传结果不完整，请重试。");
          }
        }
        if (!sameChat()) throw new Error("已切换群聊，原消息已保留。");
        const message = chatAttachmentPrompt(uploaded, payload.text.trim());
        const sentAt = Date.now();
        stage = "message";
        setSendStage(stage);
        setLocal((current) => [...current, {
          local: true, text: message, sentAt, unconfirmed: false, accepted: false, knownFingerprints,
        }]);
        let acknowledgement: unknown;
        try {
          acknowledgement = await requestJson(chatMessageUrl(sessionId), {
            ...jsonBody(chatMessageBody(message)),
            headers: { "content-type": "application/json", "X-Wand-Tool-Projection": "compact" },
          });
        } catch (cause) {
          const rejected = chatSendDefinitelyRejected(cause);
          if (sameChat()) setLocal((current) => rejected
            ? current.filter((row) => row.sentAt !== sentAt)
            : current.map((row) => row.sentAt === sentAt ? { ...row, unconfirmed: true } : row));
          if (!rejected && cause && typeof cause === "object") {
            Object.assign(cause, { __wandAmbiguousDelivery: true });
          }
          throw cause;
        }
        if (!sameChat()) return;
        const ackFingerprint = acknowledgedChatFingerprint(acknowledgement, message, knownFingerprints);
        setLocal((current) => settleLocalTurns(current.map((row) => row.sentAt === sentAt
          ? { ...row, accepted: true, ackFingerprint: ackFingerprint ?? undefined } : row),
        latestDetailRef.current.chatTurns));
        let turns: ConversationTurn[] | null = null;
        try {
          const requestedRunId = activeRunRef.current.runId;
          const next = await aiTeamsRepository.detail(requestedRunId);
          if (!sameChat()) return;
          if (activeRunRef.current.runId === requestedRunId
            && latestDetailRef.current.run.id === requestedRunId) {
            const merged = mergeTeamChatDetail(latestDetailRef.current, {
              ...latestDetailRef.current, chatTurns: next.chatTurns,
            });
            onChange(merged);
            turns = merged.chatTurns;
          } else {
            turns = mergeTeamChatTurns(latestDetailRef.current.chatTurns, next.chatTurns);
          }
        } catch {
          if (!sameChat()) return;
          turns = null;
        }
        setLocal((current) => settleLocalTurns(current, turns));
      });
    } catch (cause) {
      if (!sameChat()) return;
      setError(stage === "upload"
        ? failureMessage(cause, "附件上传失败，文件和文字已保留。")
        : chatSendDefinitelyRejected(cause)
          ? failureMessage(cause, "发送失败，内容已放回输入框。")
          : "送达状态未知，请先查看群聊记录，避免重复发送。");
    } finally {
      if (sameChat()) setPending("");
    }
  };

  const stop = async (): Promise<void> => {
    if (!teamRunIsActive(run.status) || busy || staleRun) return;
    const stopScope = scope;
    const stopRunId = run.id;
    const stopEpoch = activeRunRef.current.epoch;
    setPending("stop");
    setError("");
    try {
      const next = await aiTeamsRepository.stop(stopRunId);
      if (activeRunRef.current.scope === stopScope && activeRunRef.current.epoch === stopEpoch
        && activeRunRef.current.runId === stopRunId) {
        onChange(mergeTeamChatDetail(latestDetailRef.current, next));
      }
    } catch (cause) {
      if (activeRunRef.current.scope === stopScope && activeRunRef.current.epoch === stopEpoch
        && activeRunRef.current.runId === stopRunId) {
        setError(failureMessage(cause, "停止失败。"));
      }
    } finally {
      if (activeRunRef.current.scope === stopScope && activeRunRef.current.epoch === stopEpoch) setPending("");
    }
  };

  return <div className="task-board-team-chat">
    <button
      type="button"
      className="team-chat-context"
      aria-expanded={detailsOpen}
      aria-controls={detailsId}
      onClick={() => setDetailsOpen((current) => !current)}
    >
      <span className="team-chat-context-label">群公告</span>
      <span className="team-chat-context-title" title={run.objective}>{run.objective.split("\n")[0] || "查看本次任务"}</span>
      <span className="team-chat-context-action">{detailsOpen ? "收起" : "详情"}</span>
    </button>
    <div id={detailsId} className="team-chat-details" data-open={detailsOpen || undefined} inert={!detailsOpen}>
      <div className="team-chat-details-inner">
        <MainTaskCard detail={detail}/>
        <TeamOffice detail={detail} onOpenSession={onOpenSession}/>
        {details}
      </div>
    </div>
    <div
      className="task-board-team-chat-list"
      ref={listRef}
      tabIndex={-1}
      onScroll={(event) => {
        if (event.currentTarget !== listRef.current) return;
        const list = event.currentTarget;
        listPinnedRef.current = isFollowingTail(event.currentTarget);
        if (listPinnedRef.current) { anchorRef.current = null; return; }
        const rect = list.getBoundingClientRect();
        const visible = [...list.children].find((node) =>
          (node as HTMLElement).dataset.presentationId
          && node.getBoundingClientRect().bottom > rect.top) as HTMLElement | undefined;
        if (visible?.dataset.presentationId) anchorRef.current = {
          id: visible.dataset.presentationId,
          offset: visible.getBoundingClientRect().top - rect.top,
        };
      }}
    >
      {chatTurns.length + local.length + liveRows.length === 0
        ? <p className="task-board-team-run-detail">群聊还没有消息。</p> : null}
      {projection.rows.map(({ turn: storedTurn, presentationId: key }, index) => {
        const turn = displayChatTurn(storedTurn, displayTeam);
        const kind = chatTurnKind(turn);
        const timeMarker = chatTimeMarker(turn, projection.rows[index - 1]?.turn);
        const withTimeMarker = (message: React.ReactElement): React.ReactElement =>
          <React.Fragment key={key}>
            {timeMarker ? <time className="team-chat-time-marker" dateTime={turn.createdAt}>{timeMarker}</time> : null}
            {message}
          </React.Fragment>;
        const arriving = arrival.scope === scope && arrival.ids.has(key);
        const onArrivalEnd = (event: React.AnimationEvent<HTMLDivElement>): void => {
          if (event.target === event.currentTarget && event.animationName === "wand-team-msg-in") {
            setArrival((current) => current.scope === scope && current.ids.has(key)
              ? { scope, ids: new Set([...current.ids].filter((id) => id !== key)) } : current);
          }
        };
        if (kind === "notice") {
          return withTimeMarker(<div className="chat-message chat-notice" data-presentation-id={key}
            data-arriving={arriving || undefined} onAnimationEnd={onArrivalEnd}>
            <div className="chat-notice-line"
              title={[turn.author?.name, chatTurnText(turn)].filter(Boolean).join(" ")}>
              {turn.author?.name ? <span className="chat-notice-author">{turn.author.name}</span> : null}
              <span className="chat-notice-text"><MentionText text={chatTurnText(turn)} names={rosterNames}/></span>
            </div>
          </div>);
        }
        if (kind === "user") {
          const text = chatTurnText(turn);
          const clock = chatTurnClock(turn);
          const shape = teamChatMessageShape("user", text, 0);
          return withTimeMarker(<TeamMessageRow
            presentationId={key}
            kind="user"
            side="end"
            shape={shape}
            avatar={{ kind: "brand" }}
            name={CHAT_SELF_NAME}
            clock={clock}
            arriving={arriving}
            onArrivalEnd={onArrivalEnd}
          >
            <MessageBody
              shape={shape}
              text={text}
              names={EMPTY_MENTION_NAMES}
              onExpand={(event) => openDoc(event.currentTarget, key, {
                text, name: CHAT_SELF_NAME, clock, typeLabel: "我的消息",
                avatar: { kind: "brand" }, side: "end", mentionNames: EMPTY_MENTION_NAMES,
              })}
            />
          </TeamMessageRow>);
        }
        if (kind === "leader") {
          return withTimeMarker(<LeaderTurn
            presentationId={key}
            turn={turn}
            names={rosterNames}
            arriving={arriving}
            onArrivalEnd={onArrivalEnd}
            onOpenSession={onOpenSession}
            onExpandDoc={(target, payload) => openDoc(target, key, payload)}
          />);
        }
        const report = parseStepReport(chatTurnText(turn));
        const step = report
          ? steps.find((item) => item.kind === "work" && item.title === report.title)
          : undefined;
        return withTimeMarker(<StepTurn
          presentationId={key}
          turn={turn}
          step={step}
          names={rosterNames}
          arriving={arriving}
          onArrivalEnd={onArrivalEnd}
          onOpenSession={onOpenSession}
          onExpandDoc={(target, payload) => openDoc(target, key, payload)}
        />);
      })}
      {liveRows.map((row) => <LiveStepRow
        key={row.step.stepId}
        row={row}
        title={steps.find((step) => step.id === row.step.stepId)?.title ?? ""}
        memberName={displayTeam.members.find((member) => member.id === row.step.memberId)?.name ?? row.step.memberName}
        state={detail.memberStates[row.step.sessionId]}
        onOpenSession={onOpenSession}
        onRetire={(stepId) => setLiveRows((current) => dropRetiredRow(current, stepId))}
      />)}
      {local.map((row) => {
        const shape = teamChatMessageShape("user", row.text, 0);
        return <TeamMessageRow
          key={`local#${row.sentAt}`}
          kind="user"
          side="end"
          shape={shape}
          avatar={{ kind: "brand" }}
          name={CHAT_SELF_NAME}
          footer={row.unconfirmed ? <small className="wand-team-chat-unconfirmed">未确认</small> : null}
        >
          <MessageBody
            shape={shape}
            text={row.text}
            names={EMPTY_MENTION_NAMES}
            // 临时行保持原发送身份与未确认规则；呈现句柄用独立命名空间。
            onExpand={(event) => openDoc(event.currentTarget, `local#${row.sentAt}`, {
              text: row.text, name: CHAT_SELF_NAME, clock: "", typeLabel: "我的消息",
              avatar: { kind: "brand" }, side: "end", mentionNames: EMPTY_MENTION_NAMES,
            })}
          />
        </TeamMessageRow>;
      })}
    </div>
    {run.chatSessionId ? <div
      ref={composerHostRef}
      className="task-board-team-chat-input"
      data-dragging={draggingFiles || undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDraggingFiles(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDraggingFiles(false);
        addFiles(event.dataTransfer.files);
      }}
    >
      {hint ? <p className="task-board-team-chat-hint">{hint}</p> : null}
      <div className="input-composer-row">
        <div className={`input-composer${draft.trim() ? " has-text" : ""}${pending === "send" ? " in-flight" : ""}${draggingFiles ? " drag-over" : ""}`}
          role="group" aria-label="消息编辑器">
          {attachments.length ? <ComposerAttachmentList
            items={attachments.map((item, index) => ({
              index, name: item.name, previewUrl: item.previewUrl ?? null,
              sizeLabel: item.size < 1024 ? `${item.size} B`
                : item.size < 1024 * 1024 ? `${(item.size / 1024).toFixed(1)} KB`
                  : `${(item.size / (1024 * 1024)).toFixed(1)} MB`,
            }))}
            onRemove={(index) => teamChatComposer.edit(chatSessionId, { removeAttachment: index })}
          /> : null}
          <div className="composer-main-row team-chat-compose-main">
            <div className="composer-input-wrap">
              <textarea
                ref={inputRef}
                className="input-textarea"
                rows={1}
                value={draft}
                placeholder={CHAT_INPUT_PLACEHOLDER}
                aria-label="群聊消息"
                onChange={(event) => teamChatComposer.edit(chatSessionId, { text: event.currentTarget.value })}
                onCompositionStart={() => { compositionEpochRef.current++; composingRef.current = true; }}
                onCompositionEnd={() => {
                  const epoch = compositionEpochRef.current;
                  window.setTimeout(() => {
                    if (epoch === compositionEpochRef.current) composingRef.current = false;
                  }, 0);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey
                    || event.nativeEvent.isComposing || event.keyCode === 229 || composingRef.current) return;
                  event.preventDefault();
                  void send();
                }}
                onPaste={(event) => {
                  if (!event.clipboardData.files.length) return;
                  event.preventDefault();
                  addFiles(event.clipboardData.files);
                }}
              />
            </div>
            <div className="composer-actions-left" role="group" aria-label="添加内容">
              <button ref={attachmentButtonRef} type="button"
                className="btn-circle btn-circle-action composer-attach-trigger"
                title="更多" aria-label="更多操作" aria-haspopup="dialog"
                aria-controls={attachmentMenuId} aria-expanded={attachmentMenuOpen}
                onClick={() => setAttachmentMenuOpen((open) => !open)}>
                <WandIcon name="plus" size={18} strokeWidth={2.2}/>
              </button>
              <input ref={imageInputRef} type="file" accept="image/*" multiple hidden tabIndex={-1}
                aria-label="选择图片" onChange={(event) => {
                  if (event.currentTarget.files) addFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                  inputRef.current?.focus();
                }}/>
              <input ref={fileInputRef} type="file" multiple hidden tabIndex={-1}
                aria-label="选择附件" onChange={(event) => {
                  if (event.currentTarget.files) addFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                  inputRef.current?.focus();
                }}/>
              <div className="composer-status-row">
                <span className="composer-status-line" role={error ? "alert" : "status"}
                  aria-live={error ? "assertive" : "polite"}
                  data-tone={error ? "failed" : pending ? "sending" : undefined}
                  title={composerStatus}>{composerStatus}</span>
              </div>
            </div>
            <div className="composer-actions-right" role="group" aria-label="发送与停止">
              {composerMode === "send-and-stop" ? <button type="button"
                className="btn-circle btn-circle-action team-chat-stop-action"
                disabled={busy || staleRun} title="停止团队" aria-label="停止团队"
                onClick={() => void stop()}><WandIcon name="stop" size={16}/></button> : null}
              <button type="button" className="btn-circle btn-circle-send"
                data-phase={primaryPhase} disabled={primaryDisabled}
                title={primaryLabel} aria-label={primaryLabel}
                onClick={() => void (primaryStops ? stop() : send())}>
                <span className="composer-send-glyph composer-send-glyph-arrow" aria-hidden="true">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>
                  </svg>
                </span>
                <span className="composer-send-glyph composer-send-glyph-stop" aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <rect x="3" y="3" width="10" height="10" rx="2"/>
                  </svg>
                </span>
                <span className="composer-send-glyph composer-send-glyph-sending" aria-hidden="true">
                  <span className="composer-send-spinner"/>
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div ref={attachmentMenuRef} id={attachmentMenuId} role="dialog" aria-label="更多操作"
        aria-modal="false" aria-hidden={!attachmentMenuOpen} inert={!attachmentMenuOpen}
        className={`composer-plus-popover${attachmentMenuOpen ? "" : " hidden"}`}>
        <ComposerPopoverAction icon="image" label="上传图片" onClick={() => {
          setAttachmentMenuOpen(false);
          imageInputRef.current?.click();
        }}/>
        <ComposerPopoverAction icon="paperclip" label="上传附件" onClick={() => {
          setAttachmentMenuOpen(false);
          fileInputRef.current?.click();
        }}/>
      </div>
      {error ? <p className="task-board-team-error" role="alert">{error}</p> : null}
    </div> : <p className="task-board-team-run-detail">这次运行没有群聊会话，只能在时间线里看。</p>}
    {/*
      全文弹层：Portal 到 `#overlay-root`，不换路由、不 remount 页面，所以不算跳页；
      触发点自己只有一个形态，打开/关闭都不动它的位置与尺寸。
      关闭路径齐全：头部 ✕ / Escape / 点遮罩（下面 onOpenChange），
      以及该条回合消失时由上面的 effect 自动关层。
    */}
    <WandDialogSurface
      open={docLayer?.phase === "open"}
      onOpenChange={(open) => { if (!open) closeDoc(); }}
      title={docLayer?.name ?? ""}
      description={docLayer
        ? [docLayer.clock, docLayer.typeLabel].filter(Boolean).join(" · ")
        : undefined}
      className={[
        "wand-ui-dialog-content",
        "wand-team-chat-doc-dialog",
        docLayer?.side === "end" ? "wand-doc-dx-end" : "wand-doc-dx-start",
        docLayer?.half === "top" ? "wand-doc-dy-top" : "wand-doc-dy-bottom",
      ].join(" ")}
      testId="team-chat-doc-dialog"
      closeLabel="关闭"
    >
      {docLayer ? <ChatDocContents layer={docLayer} onExited={onDocExited}/> : null}
    </WandDialogSurface>
  </div>;
}
