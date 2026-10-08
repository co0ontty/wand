import * as React from "react";
import { Alert, Checkbox, Flex, Input, Radio, Typography } from "antd";
import type { ConversationDetail, ConversationTarget } from "../../../conversation-types.js";
import type { ConversationTurn, ToolResultBlock, ToolUseBlock } from "../../../types.js";
import { installChatSurfaceStyles } from "../chat/presentation.js";
import { RunningStatusBar } from "../chat/running-status-bar.js";
import { WandButton } from "../ui/index.js";
import { computeRunningSignal } from "../../session-activity.js";
import { conversationActivityRepository as repository } from "./activity-repository.js";
import { activityAnswerText, activityQuestions, activityResultText, activityResults, activityRunning, activitySessionOwners,
  activitySource, activityStopAnchor, activityToolKey, pendingActivityQuestions, type ActivityOperation, type ActivitySession } from "./activity-model.js";

const detailStyle: React.CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 240, overflow: "auto", margin: 0 };
function readable(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
  return text.length > 60_000 ? `${text.slice(0, 60_000)}\n…内容较长，更多内容可在执行窗口查看。` : text;
}

/** 会话页现在这套行语言：时间线行的状态点、箭头、时钟都在这里复用同一批 class。 */
function ActivityMark({ running }: { running: boolean }): React.ReactElement {
  return <span className="chat-process-summary-dot" data-running={running ? "" : undefined} aria-hidden="true">
    {Array.from({ length: 9 }, (_, index) => <i key={index}/>)}
  </span>;
}

function DisclosureChevron({ expanded }: { expanded: boolean }): React.ReactElement {
  return <span className="chat-disclosure-chevron" data-expanded={expanded} aria-hidden="true">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
  </span>;
}

/** 事件时间：与会话详情同一档紧凑时钟（HH:MM:SS）。 */
export function activityRowClock(iso?: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  // 只传空 locale：时刻跟随浏览器/系统语言，源码里不写死区域。
  return at.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function QuestionCard({ block, session, canAnswer, submit }: {
  block: ToolUseBlock; session: ActivitySession; canAnswer: boolean; submit(operation: ActivityOperation): void;
}): React.ReactElement {
  const questions = activityQuestions(block);
  const schema = JSON.stringify(questions);
  const { selections, freeform } = repository.answerDraft(session.id, block.id, schema);
  const select = (index: number, values: string[]): void => repository.editAnswer(session.id, block.id, draft => ({ ...draft, selections: { ...draft.selections, [index]: values } }), schema);
  const write = (index: number, value: string): void => repository.editAnswer(session.id, block.id, draft => ({ ...draft, freeform: { ...draft.freeform, [index]: value } }), schema);
  const input = activityAnswerText(questions, selections, freeform);
  const operation: ActivityOperation = { kind: "answer", toolId: block.id, input: input ?? "" };
  const submission = repository.submission(session.id, operation);
  const locked = !canAnswer || !!submission && submission.phase !== "failed";
  return <Flex vertical gap={12} className="conversation-question" data-question-id={block.id}>
    <Typography.Text strong>需要补充信息</Typography.Text>
    {questions.map((question, index) => <Flex vertical gap={8} key={index} role="group" aria-label={question.question}>
      <Typography.Text>{question.question}</Typography.Text>
      {question.options?.length ? question.multiSelect
        ? <Checkbox.Group value={selections[index] ?? []} disabled={locked}
            onChange={values => select(index, values.map(String))}
            options={question.options.map(option => ({ value: option.label, label: <span>{option.label}{option.description ? <Typography.Text type="secondary"> · {option.description}</Typography.Text> : null}</span> }))}/>
        : <Radio.Group value={selections[index]?.[0]} disabled={locked} onChange={event => select(index, [event.target.value])}>
            <Flex vertical gap={8}>{question.options.map(option => <Radio key={option.label} value={option.label}>{option.label}{option.description ? <Typography.Text type="secondary"> · {option.description}</Typography.Text> : null}</Radio>)}</Flex>
          </Radio.Group> : null}
      <Input.TextArea value={freeform[index] ?? ""} disabled={locked} aria-label={`${question.question}：补充回答`} placeholder="也可以输入自己的回答"
        autoSize={{ minRows: 1, maxRows: 4 }} onChange={event => write(index, event.target.value)}/>
    </Flex>)}
    {submission ? <Typography.Text role="status" type={submission.phase === "failed" || submission.phase === "unknown" ? "danger" : "secondary"}>{submission.message}</Typography.Text> : null}
    <WandButton kind="primary" disabled={locked || !input} onClick={() => { if (input) submit({ ...operation, input }); }}>
      {submission?.phase === "sending" ? "提交中…" : submission?.phase === "sent" ? "已提交" : submission?.phase === "unknown" ? "等待核对" : "提交并继续"}
    </WandButton>
  </Flex>;
}

function ActivityTool({ block, result, source, session, canAnswer, submit }: {
  block: ToolUseBlock; result?: ToolResultBlock; source: string | null; session?: ActivitySession;
  canAnswer: boolean; submit(operation: ActivityOperation): void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [full, setFull] = React.useState<Awaited<ReturnType<typeof repository.tool>> | null>(null);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    if (!open || !source) return;
    let valid = true;
    setLoading(true); setError("");
    void repository.tool(source, block.id).then(value => { if (valid) setFull(value); }, cause => {
      if (valid) setError(cause instanceof Error ? cause.message : "读取工具详情失败。");
    }).finally(() => { if (valid) setLoading(false); });
    return () => { valid = false; };
  }, [open, source, block.id, result, retry]);
  const questions = activityQuestions(block);
  const status = result ? result.is_error ? "error" : "complete" : "pending";
  // 状态词表只有一套：失败 / 运行中 / 完成 / 未返回，和会话详情一致，读的是颜色不是文字。
  const statusLabel = status === "error" ? "失败" : status === "complete" ? "完成" : "未返回";
  const label = questions.length ? "补充信息" : block.activity?.label || block.description || block.name;
  const inputExcerpt = block.preview || "";
  const resultExcerpt = result?.preview || (result ? activityResultText(result) : "");
  return <div className="chat-call chat-call-inline conversation-tool-activity" data-status={status} data-expanded={open ? "true" : "false"}
    data-tool-source={source ?? undefined} data-tool-id={block.id}>
    <span className="chat-call-mark" data-status={status} aria-hidden="true"/>
    <button type="button" className="chat-call-button chat-call-button-plain" aria-expanded={open} aria-label={`${label}，${statusLabel}`}
      onClick={() => setOpen(current => !current)}>
      <span className="chat-call-copy">
        <span className="chat-call-line">
          <time className="chat-call-time" dateTime={block.activity?.occurredAt || undefined}>{activityRowClock(block.activity?.occurredAt)}</time>
          <span className="chat-call-label" title={label}>{label}</span>
        </span>
        <span className="chat-call-preview" title={inputExcerpt || undefined}>{inputExcerpt}</span>
        <span className="chat-call-result" data-error={status === "error" ? "" : undefined} title={resultExcerpt || undefined}>{resultExcerpt}</span>
      </span>
      <DisclosureChevron expanded={open}/>
    </button>
    <div className="chat-disclosure-body" data-expanded={open} inert={!open} aria-hidden={!open}>{open ? <div className="chat-activity-detail-content">
      {loading ? <Typography.Text type="secondary" role="status">正在读取详情…</Typography.Text> : null}
      {error ? <Typography.Text type="danger" role="alert">{error}<WandButton size="small" onClick={() => setRetry(value => value + 1)}>重新读取</WandButton></Typography.Text> : null}
      <div className="chat-activity-detail-section"><h4>调用输入</h4><pre tabIndex={0}>{readable(full?.input ?? block.input)}</pre></div>
      {result || full && !full.pending ? <div className="chat-activity-detail-section"><h4>结果</h4><pre tabIndex={0}>{readable(full && !full.pending ? full.content : result ? activityResultText(result) : "")}</pre></div> : null}
      {questions.length && !canAnswer ? <Typography.Text type="secondary">{result ? "此问题已有回答。" : "历史问题记录；只有当前等待回答的请求可以提交。"}</Typography.Text> : null}
    </div> : null}</div>
    {canAnswer && session ? <QuestionCard key={`${session.id}:${block.id}:${JSON.stringify(questions)}`} block={block} session={session} canAnswer={canAnswer} submit={submit}/> : null}
  </div>;
}

function TurnActivity({ turn, source, results, session, live, submit }: {
  turn: ConversationTurn; source: string | null; results: Map<string, ToolResultBlock>; session?: ActivitySession;
  live: boolean; submit(operation: ActivityOperation): void;
}): React.ReactElement | null {
  const [expanded, setExpanded] = React.useState<boolean | null>(null);
  const blocks = turn.content.filter(block => block.type === "thinking" || block.type === "tool_use");
  if (!blocks.length) return null;
  const pending = new Set(session ? pendingActivityQuestions(session).map(block => block.id) : []);
  const duration = turn.completedAt && turn.createdAt ? Date.parse(turn.completedAt) - Date.parse(turn.createdAt) : 0;
  const open = expanded ?? live;
  const questionBlocks = blocks.filter((block): block is ToolUseBlock => block.type === "tool_use" && pending.has(block.id));
  const runningCall = live && blocks.some((block, index) => index === blocks.length - 1 && block.type === "tool_use" && !(source && results.get(activityToolKey(source, block.id))));
  const runningThinking = live && blocks.some((block, index) => index === blocks.length - 1 && block.type === "thinking");
  return <div className={`chat-activity chat-activity-inline conversation-turn-activity${runningCall ? " is-command-running" : ""}${runningThinking ? " is-thinking-running" : ""}`} data-expanded={open ? "true" : "false"}>
    <button type="button" className="chat-process-summary chat-process-summary-plain" aria-expanded={open}
      onClick={() => setExpanded(current => !(current ?? live))}>
      {live ? <ActivityMark running/> : null}
      <span className="chat-activity-meta">
        <span className="chat-activity-meta-item">{turn.completedAt ? "处理结束" : "执行过程"}</span>
        <span className="chat-activity-separator" aria-hidden="true">·</span>
        <span className="chat-activity-meta-item">{blocks.length} 条记录</span>
        {duration > 0 ? <><span className="chat-activity-separator" aria-hidden="true">·</span><span className="chat-activity-meta-item">{Math.ceil(duration / 1000)} 秒</span></> : null}
      </span>
      <DisclosureChevron expanded={open}/>
    </button>
    {open ? <div className="chat-activity-rows">
      {blocks.map((block, index) => block.type === "thinking"
        ? <ActivityThinkingRow key={`thinking:${index}`} thinking={block.thinking} clock={activityRowClock(block.occurredAt)}
            running={!!runningThinking && index === blocks.length - 1}/>
        : block.type === "tool_use" ? <ActivityTool key={`${source}:${block.id}`} block={block} source={source} session={session}
            result={source ? results.get(activityToolKey(source, block.id)) : undefined} canAnswer={false} submit={submit}/> : null)}
    </div> : null}
    {questionBlocks.map(block => session ? <QuestionCard key={`${source}:${block.id}:${JSON.stringify(activityQuestions(block))}`} block={block} session={session} canAnswer submit={submit}/> : null)}
  </div>;
}

/** 思考轮次的行：单行紧凑，展开只有一个正文（和会话详情同一套行骨架）。 */
function ActivityThinkingRow({ thinking, clock, running }: { thinking: string; clock: string; running: boolean }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const excerpt = thinking.replace(/\s+/g, " ").trim().slice(0, 180);
  return <div className="chat-call chat-call-inline" data-status={running ? "running" : "complete"} data-thinking-entry="true" data-expanded={open ? "true" : "false"}>
    <span className="chat-call-mark" data-status={running ? "running" : "complete"} aria-hidden="true"/>
    <button type="button" className="chat-call-button chat-call-button-plain" aria-expanded={open} aria-label={`思考过程，${running ? "运行中" : "已结束"}`}
      onClick={() => setOpen(current => !current)}>
      <span className="chat-call-copy">
        <span className="chat-call-line">
          <time className="chat-call-time" dateTime={clock || undefined}>{clock}</time>
          <span className="chat-call-label">思考过程</span>
        </span>
        <span className="chat-call-preview" title={excerpt || undefined}>{excerpt}</span>
      </span>
      <DisclosureChevron expanded={open}/>
    </button>
    <div className="chat-disclosure-body" data-expanded={open} inert={!open} aria-hidden={!open}>{open ? <div className="chat-activity-detail-content">
      <div className="chat-activity-detail-section"><h4>思考</h4><pre tabIndex={0}>{thinking || "模型未提供可显示的思考正文。"}</pre></div>
    </div> : null}</div>
  </div>;
}

export function useConversationActivity({ detail, active, target = null, onRefresh }: {
  detail: ConversationDetail | null; active: boolean; target?: ConversationTarget; onRefresh?(): void;
}): { renderActivity(turn: ConversationTurn, index: number): React.ReactNode; controls: React.ReactNode } {
  React.useSyncExternalStore(repository.subscribe, repository.revision, repository.revision);
  const owners = activitySessionOwners(detail, target);
  const ownerKey = JSON.stringify([...owners]);
  const scope = `${detail?.id ?? ""}:${target?.runId ?? ""}:${active}`;
  const current = React.useRef({ scope, ownerKey, generation: 0, owners, active, onRefresh });
  current.current = { scope, ownerKey, generation: current.current.generation + (current.current.scope !== scope || current.current.ownerKey !== ownerKey ? 1 : 0), owners, active, onRefresh };
  const [sessions, setSessions] = React.useState<Record<string, ActivitySession>>({});
  const [loadError, setLoadError] = React.useState("");
  const epoch = React.useRef(0);
  const load = React.useCallback(async (): Promise<void> => {
    if (!active || !owners.size) return;
    const captured = ++epoch.current;
    const ids = [...owners.keys()];
    const reads = await Promise.allSettled(ids.map(id => repository.session(id)));
    if (captured !== epoch.current || current.current.scope !== scope) return;
    const next: Record<string, ActivitySession> = {};
    let failures = 0;
    reads.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value.id === ids[index]) { next[ids[index]!] = result.value; repository.observe(result.value); }
      else failures++;
    });
    setSessions(next); setLoadError(failures ? "部分执行状态暂时无法读取，重新读取后可操作。" : "");
  }, [ownerKey, active, scope]);
  React.useEffect(() => { installChatSurfaceStyles(); }, []);
  React.useEffect(() => {
    setSessions({}); setLoadError("");
    void load();
    const timer = active && owners.size ? setInterval(() => { if (!document.hidden) void load(); }, 3000) : undefined;
    return () => { ++epoch.current; if (timer) clearInterval(timer); };
  }, [load]);
  const available = active ? Object.values(sessions).filter(session => owners.has(session.id)) : [];
  const results = activityResults(detail?.messages ?? [], detail?.communicationSessionId ?? null, available);
  const submit = (source: string, operation: ActivityOperation): void => {
    const generation = current.current.generation;
    void repository.submit(source, operation, () => current.current.generation === generation && current.current.active && current.current.owners.has(source))
      .then(() => { if (current.current.scope === scope) { void load(); current.current.onRefresh?.(); } });
  };
  const ongoing = available.filter(session => activityRunning(session) || (() => {
    const status = repository.submission(session.id, { kind: "stop", anchor: activityStopAnchor(session) });
    return status?.phase === "unknown" || status?.phase === "failed";
  })());
  const showControls = active && (ongoing.length > 0 || !!loadError || available.some(session => {
    const status = repository.submission(session.id, { kind: "stop", anchor: activityStopAnchor(session) });
    return status?.phase === "unknown" || status?.phase === "failed";
  }));
  const controls = showControls ? <Flex vertical gap={8} className="conversation-session-activity" style={{ flexShrink: 0, maxHeight: "min(35dvh, 280px)", overflow: "auto", padding: "8px 16px" }}>
    {loadError ? <Alert type="warning" title={loadError} action={<WandButton onClick={() => void load()}>重新读取</WandButton>}/> : null}
    {ongoing.map(session => {
      const escalation = session.pendingEscalation;
      const signal = computeRunningSignal(session);
      const stop: ActivityOperation = { kind: "stop", anchor: activityStopAnchor(session) };
      const operation: ActivityOperation = escalation ? { kind: "permission", requestId: escalation.requestId, resolution: "approve_once" } : stop;
      const status = repository.submission(session.id, operation);
      const locked = !!status && status.phase !== "failed";
      return <Flex vertical gap={6} key={session.id} data-activity-session={session.id}>
        <Flex align="center" justify="space-between" gap={8}><Typography.Text strong>{owners.get(session.id)}</Typography.Text>
          {!escalation && activityRunning(session) ? <WandButton size="small" disabled={locked} onClick={() => submit(session.id, stop)}>停止本轮</WandButton> : null}</Flex>
        {escalation ? <Alert type="warning" title="等待你确认操作" description={<Flex vertical gap={8}>
          <Typography.Text>{escalation.reason}</Typography.Text>{escalation.target ? <pre style={detailStyle}>{escalation.target}</pre> : null}
          <Flex gap={8}><WandButton disabled={locked} onClick={() => submit(session.id, { ...operation as Extract<ActivityOperation, { kind: "permission" }>, resolution: "deny" })}>拒绝</WandButton>
            <WandButton kind="primary" disabled={locked} onClick={() => submit(session.id, operation)}>批准本次</WandButton></Flex>
        </Flex>}/> : <RunningStatusBar activity={{ ...session, ptyRunning: signal.ptyRunning, turnStartedAt: session.ptyTurnStartedAt, lastActivityAt: session.ptyLastActivityAt }}/>}
        {status ? <Typography.Text role="status" type={status.phase === "unknown" || status.phase === "failed" ? "danger" : "secondary"}>{status.message}</Typography.Text> : null}
        {status?.phase === "unknown" ? <WandButton size="small" onClick={() => { void load(); current.current.onRefresh?.(); }}>刷新状态核对</WandButton> : null}
      </Flex>;
    })}
  </Flex> : null;
  return { controls, renderActivity: (turn, index) => {
    const source = activitySource(turn, detail?.communicationSessionId ?? null);
    const session = source && active && owners.has(source) ? sessions[source] : undefined;
    if (turn.sessionLink) return session ? <React.Fragment key={session.id}>{pendingActivityQuestions(session).map(block =>
      <QuestionCard key={block.id} block={block} session={session} canAnswer submit={operation => submit(session.id, operation)}/>)}</React.Fragment> : null;
    const last = source ? detail?.messages.slice().reverse().find(item => item.role === "assistant" && activitySource(item, detail?.communicationSessionId ?? null) === source) : undefined;
    return <TurnActivity key={`${source}:${turn.messageId ?? index}`} turn={turn} source={source} results={results} session={session}
      live={!!session && activityRunning(session) && last === turn && !turn.completedAt}
      submit={operation => { if (source) submit(source, operation); }}/>;
  } };
}
