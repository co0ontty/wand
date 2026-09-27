import * as React from "react";
import type { AiTeamRun, AiTeamRunDetail, AiTeamStep } from "../../../ai-team-types";
import type { ConversationAuthor, ConversationTurn } from "../../../types";
import { failureMessage } from "../errors";
import { jsonBody, requestJson } from "../http-adapter";
import { issueAgentProviderLabel } from "../issues/task-board-agent";
import { WandButton } from "../ui";
import { memberCoatIndex, PixelCat } from "./avatar";
import { aiTeamsRepository } from "./repository";

/**
 * 面板内嵌的群聊视图（§5.3）：只读渲染 `detail.chatTurns`，加一个往 relay 会话发话的输入框。
 * 视觉对齐 IM 群聊：顶部钉住「主任务」，负责人的决策是公告卡，成员干活是带状态芯片的步骤块，
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

const CHAT_HINTS: Partial<Record<AiTeamRun["status"], string>> = {
  awaiting_approval: "回复『批准』即开工，其他内容会作为修改意见转给负责人",
  running: "将作为插话，负责人下一轮看到",
};

/** 运行已经结束（完成 / 停止 / 失败）：群里再说一句就是接着这次的进度开新一轮。 */
const CHAT_FINISHED_HINT = "发消息会接着这一轮的进度开新一轮";

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

/** 一行右侧的时刻；服务端没给时间就不显示。 */
export function chatTurnClock(turn: ConversationTurn): string {
  const at = Date.parse(turn.completedAt || turn.createdAt || "");
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  const provider = author?.provider ? issueAgentProviderLabel(author.provider) : "";
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
      {provider ? <span className="wand-team-chat-provider">{provider}</span> : null}
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
  const provider = author?.provider ? issueAgentProviderLabel(author.provider) : "";
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
      {provider ? <span className="wand-team-chat-provider">{provider}</span> : null}
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

export interface TeamChatViewProps {
  detail: AiTeamRunDetail;
  onChange(detail: AiTeamRunDetail): void;
  onOpenSession?: (sessionId: string) => void;
}

export function TeamChatView({ detail, onChange, onOpenSession }: TeamChatViewProps): React.ReactElement {
  const { run, chatTurns, steps } = detail;
  const [local, setLocal] = React.useState<LocalChatTurn[]>([]);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const listRef = React.useRef<HTMLDivElement>(null);
  const hint = chatInputHint(run.status);

  // 换了一次运行，上一轮的临时行了不相干。
  React.useEffect(() => {
    setLocal([]);
    setDraft("");
    setError("");
  }, [run.id]);

  // 面板截尾 200 条，比全量会话短，这是预期行为；新消息来了贴到底。
  React.useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [chatTurns.length, local.length]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    const sessionId = run.chatSessionId;
    if (!text || !sessionId || busy) return;
    const sentAt = Date.now();
    setBusy(true);
    setError("");
    setDraft("");
    setLocal((current) => [...current, { local: true, text, sentAt, unconfirmed: false }]);
    try {
      await requestJson(chatMessageUrl(sessionId), jsonBody(chatMessageBody(text)));
    } catch (cause) {
      setLocal((current) => current.filter((row) => row.sentAt !== sentAt));
      setBusy(false);
      setError(failureMessage(cause, "发送失败。"));
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
    setBusy(false);
    setLocal((current) => settleLocalTurns(current, turns));
  };

  return <div className="task-board-team-chat">
    <MainTaskCard detail={detail}/>
    <div className="task-board-team-chat-list" ref={listRef}>
      {chatTurns.length + local.length === 0
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
        placeholder={hint || "发消息给团队"}
        aria-label="群聊消息"
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      <div className="task-board-native-editor-actions">
        <WandButton kind="primary" size="small" disabled={!draft.trim() || busy} onClick={() => void send()}>
          {busy ? "发送中…" : "发送"}
        </WandButton>
      </div>
      {error ? <p className="task-board-team-error" role="alert">{error}</p> : null}
    </div> : <p className="task-board-team-run-detail">这次运行没有群聊会话，只能在时间线里看。</p>}
  </div>;
}
