import * as React from "react";
import type { AgentActivityState } from "../../../mission-types";
import type { AiTeamLiveStep, AiTeamRun, AiTeamRunDetail, AiTeamStep } from "../../../ai-team-types";
import type { ConversationAuthor, ConversationTurn } from "../../../types";
import { failureMessage } from "../errors";
import { HttpResponseError, jsonBody, requestJson } from "../http-adapter";
import { issueAgentEffortLabel, issueAgentProviderLabel } from "../issues/task-board-agent";
import { wandModelDisplayName, type WandModelCatalog } from "../model-catalog";
import { WandButton } from "../ui";
import { memberCoatIndex, PixelCat, TeamAvatar } from "./avatar";
import { aiTeamsRepository } from "./repository";

/**
 * 面板内嵌的群聊视图（§5.3）：只读渲染 `detail.chatTurns`，加一个往 relay 会话发话的输入框。
 * 视觉对齐 IM 群聊：公告先显示一行，成员与任务按需展开；消息流保持主位。
 * 长报告默认折叠、原位展开。不复用 legacy chat-render（那套是命令式 DOM + 会话状态机），
 * 只借它的类名对齐视觉。
 */

/** 乐观临时行：发送 resolve 后先留着，等服务端回包里出现同一条 user turn 再撤。 */
export interface LocalChatTurn {
  local: true;
  text: string;
  /** 本地发送时刻（毫秒），用来和服务端 `createdAt` 粗比。 */
  sentAt: number;
  /** 重拉失败时为真：内容留着，但标成「未确认」。 */
  unconfirmed: boolean;
}

/** 发送端点：relay 会话就是普通结构化会话，走既有的 messages 路由（S7）。 */
export function chatMessageUrl(sessionId: string): string {
  return `/api/structured-sessions/${encodeURIComponent(sessionId)}/messages`;
}

/** 请求体字段是 `input`（不是 `text`）；插话不带 `interrupt`，走排队进 chatInput。 */
export function chatMessageBody(text: string): { input: string } {
  return { input: text };
}

/** 服务端回包里没有这条 user turn，就按发送时刻判定重拉是否覆盖了它。 */
export function isConfirmedBy(turn: ConversationTurn, sentAt: number): boolean {
  if (turn.role !== "user") return false;
  const at = Date.parse(turn.createdAt ?? "");
  return !Number.isNaN(at) && at >= sentAt;
}

/**
 * 发送 resolve 之后调一次：`turns` 为 `null` 表示重拉失败，临时行留着并标「未确认」；
 * 否则把服务端已经回显的那几条撤掉，剩下的继续等下一次 ai-team-run 重拉。
 */
export function settleLocalTurns(local: LocalChatTurn[], turns: ConversationTurn[] | null): LocalChatTurn[] {
  if (!turns) return local.map((row) => ({ ...row, unconfirmed: true }));
  return local.filter((row) => !turns.some((turn) => isConfirmedBy(turn, row.sentAt)));
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
export function teamOfficeMembers(detail: AiTeamRunDetail): TeamOfficeMember[] {
  return detail.run.team.members.map((member) => {
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

/** 负责人派工那几行：`1. **@实现者** T1 类型与存储迁移（等第 1 项完成后）`。 */
const ASSIGN_LINE = /^\d+\.\s*\*\*@(.+?)\*\*\s*(.+)$/;
const ASSIGN_WAIT = /^(.+?)（(等第.+?)）$/;

export interface ChatAssignment {
  member: string;
  title: string;
  /** 「等第 1、2 项完成后」这类等待说明；没有就是空串。 */
  wait: string;
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
    const wait = ASSIGN_WAIT.exec(match[2]!);
    assignments.push({ member: match[1]!, title: wait ? wait[1]! : match[2]!, wait: wait ? wait[2]! : "" });
  }
  return { head: head.join("\n").trim(), assignments };
}

/** 报告够长才折叠，短报告原地铺开，别让展开按钮本身成为噪音。 */
const COLLAPSE_AFTER_LINES = 6;
const COLLAPSE_AFTER_CHARS = 420;

export function needsCollapse(text: string): boolean {
  return text.length > COLLAPSE_AFTER_CHARS || text.split("\n").length > COLLAPSE_AFTER_LINES;
}

function AuthorAvatar({ author }: { author: ConversationAuthor }): React.ReactElement {
  return <span className="pixel-avatar">
    <PixelCat coat={memberCoatIndex({ id: author.id, name: author.name, avatar: author.avatar })}/>
  </span>;
}

/**
 * 长正文：收起给行数截断的预览，展开在原位长高（§7 要求 7，收起是展开的倒放）。
 * 预览与展开体用同一份文本，切换时只换承载节点，不做跳转也不重排整块。
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
      <span className="team-chat-goal-meta">{run.stepsUsed}/{run.stepLimit} 步 · {run.team.name}</span>
    </header>
    <CollapsibleText
      text={run.objective}
      previewClassName="team-chat-goal-preview"
      bodyClassName="team-chat-goal-body"
    />
  </section>;
}

/** 成员的步骤发言：状态芯片 + 折起的报告，一眼能看出这是哪一步的子任务。 */
function StepTurn({
  turn,
  step,
  onOpenSession,
}: {
  turn: ConversationTurn;
  step: AiTeamStep | undefined;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement {
  const author = turn.author;
  const text = chatTurnText(turn);
  const report = parseStepReport(text);
  const clock = chatTurnClock(turn);
  const status = step?.status ?? (report?.ok === false ? "failed" : report ? "done" : undefined);
  return <div className="chat-message assistant team-chat-step" data-status={status}>
    <div className="team-chat-step-head">
      {author ? <AuthorAvatar author={author}/> : null}
      {author?.sessionId && onOpenSession
        ? <button
          type="button"
          className="avatar-name chat-author-link"
          title="查看这个成员的会话"
          onClick={() => onOpenSession(author.sessionId!)}
        >{author.name}</button>
        : <span className="avatar-name">{author?.name ?? "成员"}</span>}
      {report ? <span className="team-chat-step-chip" data-ok={report.ok || undefined}>
        {report.ok ? "✅" : "❌"} {report.title}
      </span> : null}
      {clock ? <span className="chat-message-time">{clock}</span> : null}
    </div>
    <CollapsibleText
      text={report ? report.body : text}
      previewClassName="team-chat-step-preview"
      bodyClassName="team-chat-step-body"
    />
  </div>;
}

/** 负责人的决策：主任务层的公告卡，派工清单渲染成任务条目。 */
function LeaderTurn({
  turn,
  onOpenSession,
}: {
  turn: ConversationTurn;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement {
  const author = turn.author;
  const clock = chatTurnClock(turn);
  const { head, assignments } = splitLeaderMessage(chatTurnText(turn));
  return <div className="chat-message assistant chat-message-lead team-chat-plan">
    <div className="team-chat-plan-head">
      <span className="chat-message-avatar assistant chat-message-author">
        {author ? <AuthorAvatar author={author}/> : null}
        {author?.sessionId && onOpenSession
          ? <button
            type="button"
            className="avatar-name chat-author-link"
            title="查看负责人的会话"
            onClick={() => onOpenSession(author.sessionId!)}
          >{author.name}</button>
          : <span className="avatar-name">{author?.name ?? "负责人"}</span>}
      </span>
      <span className="chat-author-badge">负责人</span>
      {clock ? <span className="chat-message-time">{clock}</span> : null}
    </div>
    {head ? <p className="team-chat-plan-text">{head}</p> : null}
    {assignments.length > 0 ? <ol className="team-chat-plan-list">
      {assignments.map((item, index) => <li key={`${item.member}#${index}`}>
        <span className="team-chat-plan-member">@{item.member}</span>
        <span className="team-chat-plan-title">{item.title}</span>
        {item.wait ? <small className="team-chat-plan-wait">{item.wait}</small> : null}
      </li>)}
    </ol> : null}
  </div>;
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
  state,
  onOpenSession,
  onRetire,
}: {
  row: LiveRow;
  title: string;
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
      <span className="pixel-avatar">
        <PixelCat coat={memberCoatIndex({ id: step.memberId, name: step.memberName })}/>
      </span>
      {onOpenSession
        ? <button
          type="button"
          className="avatar-name chat-author-link"
          title="查看这个成员的会话"
          onClick={open}
        >{step.memberName}</button>
        : <span className="avatar-name">{step.memberName}</span>}
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
      aria-label={`打开${step.memberName}正在输出的会话`}
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

export interface TeamChatViewProps {
  detail: AiTeamRunDetail;
  onChange(detail: AiTeamRunDetail): void;
  onOpenSession?: (sessionId: string) => void;
  details?: React.ReactNode;
}

export function TeamChatView({ detail, onChange, onOpenSession, details }: TeamChatViewProps): React.ReactElement {
  const { run, chatTurns, steps } = detail;
  const [local, setLocal] = React.useState<LocalChatTurn[]>([]);
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState("");
  const [pending, setPending] = React.useState<"" | "send" | "stop">("");
  const [liveRows, setLiveRows] = React.useState<LiveRow[]>([]);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const detailsId = React.useId();
  const listRef = React.useRef<HTMLDivElement>(null);
  /**
   * 外层列表的「贴尾」状态：跟 live 卡片同一套阈值（距底 ≤ LIVE_TAIL_PX）。
   * 用户上滚看历史以后，live 行插入/摘除不许把他拽回尾部。
   */
  const listPinnedRef = React.useRef(true);
  const hint = chatInputHint(run.status);
  const running = run.status === "running";
  const composerMode = teamChatComposerMode(run.status, !!draft.trim(), pending);
  const busy = pending !== "";

  // 换了一次运行，上一轮的临时行了不相干。
  React.useEffect(() => {
    setLocal([]);
    setDraft("");
    setError("");
    setPending("");
    setDetailsOpen(false);
    // 贴尾状态也按 run.id 重置：上一轮里用户上滚过，不该让这一轮的新页面一进来就不跟随。
    listPinnedRef.current = true;
  }, [run.id]);

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
  }, [chatTurns.length, local.length, liveRows.length]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    const sessionId = run.chatSessionId;
    if (!text || !sessionId || busy) return;
    const sentAt = Date.now();
    setPending("send");
    setError("");
    setDraft("");
    // 自己刚发的话一定要看见：发送算一次明确的「回到底部」意图。
    listPinnedRef.current = true;
    setLocal((current) => [...current, { local: true, text, sentAt, unconfirmed: false }]);
    try {
      await requestJson(chatMessageUrl(sessionId), jsonBody(chatMessageBody(text)));
    } catch (cause) {
      if (chatSendDefinitelyRejected(cause)) {
        setLocal((current) => current.filter((row) => row.sentAt !== sentAt));
        setDraft((current) => current ? `${text}\n${current}` : text);
      } else {
        setLocal((current) => current.map((row) => row.sentAt === sentAt ? { ...row, unconfirmed: true } : row));
      }
      setPending("");
      setError(chatSendDefinitelyRejected(cause)
        ? failureMessage(cause, "发送失败，内容已放回输入框。")
        : "送达状态未知，请先查看群聊记录，避免重复发送。");
      return;
    }
    // postTurn 不发通知，这里自己补一次重拉；失败就把临时行留在原位标未确认。
    let turns: ConversationTurn[] | null = null;
    try {
      const next = await aiTeamsRepository.detail(run.id);
      onChange(next);
      turns = next.chatTurns;
    } catch {
      turns = null;
    }
    setPending("");
    setLocal((current) => settleLocalTurns(current, turns));
  };

  const stop = async (): Promise<void> => {
    if (!teamRunIsActive(run.status) || busy) return;
    setPending("stop");
    setError("");
    try {
      onChange(await aiTeamsRepository.stop(run.id));
    } catch (cause) {
      setError(failureMessage(cause, "停止失败。"));
    } finally {
      setPending("");
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
      onScroll={(event) => {
        if (event.currentTarget === listRef.current) listPinnedRef.current = isFollowingTail(event.currentTarget);
      }}
    >
      {chatTurns.length + local.length + liveRows.length === 0
        ? <p className="task-board-team-run-detail">群聊还没有消息。</p> : null}
      {chatTurns.map((turn, index) => {
        const kind = chatTurnKind(turn);
        const key = `${turn.createdAt ?? ""}#${index}`;
        if (kind === "notice") {
          const clock = chatTurnClock(turn);
          return <div className="chat-message chat-notice" key={key}>
            <div className="chat-notice-line">
              {turn.author?.name ? <span className="chat-notice-author">{turn.author.name}</span> : null}
              <span className="chat-notice-text">{chatTurnText(turn)}</span>
              {clock ? <span className="chat-notice-time">{clock}</span> : null}
            </div>
          </div>;
        }
        if (kind === "user") {
          return <div className="chat-message user" key={key}>
            <div className="chat-message-bubble">{chatTurnText(turn)}</div>
          </div>;
        }
        if (kind === "leader") {
          return <LeaderTurn key={key} turn={turn} onOpenSession={onOpenSession}/>;
        }
        const report = parseStepReport(chatTurnText(turn));
        const step = report
          ? steps.find((item) => item.kind === "work" && item.title === report.title)
          : undefined;
        return <StepTurn key={key} turn={turn} step={step} onOpenSession={onOpenSession}/>;
      })}
      {liveRows.map((row) => <LiveStepRow
        key={row.step.stepId}
        row={row}
        title={steps.find((step) => step.id === row.step.stepId)?.title ?? ""}
        state={detail.memberStates[row.step.sessionId]}
        onOpenSession={onOpenSession}
        onRetire={(stepId) => setLiveRows((current) => dropRetiredRow(current, stepId))}
      />)}
      {local.map((row) => <div className="chat-message user" key={`local#${row.sentAt}`}>
        <div className="chat-message-bubble">{row.text}</div>
        {row.unconfirmed ? <small className="wand-team-chat-unconfirmed">未确认</small> : null}
      </div>)}
    </div>
    {run.chatSessionId ? <div className="task-board-team-chat-input">
      {hint ? <p className="task-board-team-chat-hint">{hint}</p> : null}
      <textarea
        className="resize-none task-board-detail-body"
        rows={2}
        value={draft}
        placeholder={CHAT_INPUT_PLACEHOLDER}
        aria-label="群聊消息"
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      <div className="task-board-native-editor-actions">
        {composerMode === "send-and-stop" || composerMode === "stop" ? <WandButton
          kind="danger"
          size="small"
          disabled={busy}
          aria-label="停止团队"
          onClick={() => void stop()}
        >{pending === "stop" ? "停止中…" : "停止"}</WandButton> : null}
        {composerMode === "stop" ? null : <WandButton
          kind="primary"
          size="small"
          disabled={composerMode === "blocked" || !draft.trim() || busy}
          onClick={() => void send()}
        >{pending === "send" ? "发送中…" : "发送"}</WandButton>}
      </div>
      {error ? <p className="task-board-team-error" role="alert">{error}</p> : null}
    </div> : <p className="task-board-team-run-detail">这次运行没有群聊会话，只能在时间线里看。</p>}
  </div>;
}
