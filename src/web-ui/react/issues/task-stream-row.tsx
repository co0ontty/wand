import * as React from "react";
import { Alert, Flex, Tag, Typography } from "antd";
import type { WandTaskComment } from "../../../task-types";
import { DeferredMarkdownPreview } from "../file-preview/deferred-markdown";
import { taskReferenceSegments } from "../../../task-comment-references.js";
import { TaskExecutionCard, TaskExecutionReferences } from "./task-execution-card.js";
import { WandButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import type { IssueSessionSummary, WandTaskListed } from "./task-board-repository";
import type { ConversationTurn } from "../../../types.js";
import { activityLabel } from "../chat/activity-label";
import { ChatActivityEntry } from "../chat/activity";
import { preserveDisclosurePosition } from "../chat/disclosure-position";
import { taskBoardRepository } from "./task-board-repository";
import { ChatMessage } from "../chat/message";
import { statusLabels } from "../../../task-comment-status.js";

function RowDisclosure({ id, summary, children, expanded, onExpanded, rowRef }: { id: string; summary: React.ReactNode; children: React.ReactNode; expanded?: boolean; onExpanded?(value: boolean): void; rowRef?: React.Ref<HTMLDivElement> }): React.ReactElement {
  const [localOpen, setLocalOpen] = React.useState(false);
  const open = expanded ?? localOpen;
  const toggle = (value: boolean): void => { setLocalOpen(value); onExpanded?.(value); };
  return <div ref={rowRef} className="task-stream-row" data-stream-row={id}>
    <button type="button" className="task-stream-row-summary" aria-expanded={open} aria-controls={`detail-${id}`} onClick={() => toggle(!open)}>
      <WandIcon name={open ? "chevron" : "chevronLeft"} size={12} className="task-stream-row-chevron"/>{summary}
    </button>
    {open && <div className="task-stream-row-detail" id={`detail-${id}`}>{children}</div>}
  </div>;
}

function ReadonlyCommentTool({ taskId, commentId, block, result }: { taskId: string; commentId: string; block: Extract<ConversationTurn["content"][number], { type: "tool_use" }>; result?: Extract<ConversationTurn["content"][number], { type: "tool_result" }>; }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [full, setFull] = React.useState<{ input: Record<string, unknown>; content: unknown; is_error: boolean; pending: boolean } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [retry, setRetry] = React.useState(0);
  const label = activityLabel(block);
  React.useEffect(() => {
    if (!open) return;
    let current = true;
    const controller = new AbortController();
    setLoading(true); setError(""); setFull(null);
    void taskBoardRepository.commentResultTool(taskId, commentId, block.id, { signal: controller.signal })
      .then(value => { if (current) setFull(value); }, cause => { if (current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取结果失败。"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [open, taskId, commentId, block.id, retry]);
  const status = result ? result.is_error ? "error" : "complete" : full && !full.pending ? full.is_error ? "error" : "complete" : "pending";
  const stateLabel = status === "error" ? "失败" : status === "complete" ? "完成" : full?.pending ? "未返回" : "待核对";
  const toggle = (event: React.MouseEvent<HTMLButtonElement>): void => preserveDisclosurePosition(event.currentTarget, () => setOpen(value => !value));
  return <ChatActivityEntry expanded={open} status={status} label={label.title} stateLabel={stateLabel} preview={label.detail} context={label.context}
    icon={label.icon} tool onToggle={toggle}>
    <div className="chat-activity-detail-content">
      {loading ? <Typography.Text role="status" type="secondary">正在读取固定轮次工具详情…</Typography.Text> : null}
      {error ? <Alert type="warning" title={error} action={<WandButton size="small" onClick={() => setRetry(value => value + 1)}>重试</WandButton>}/> : null}
      <div className="chat-activity-detail-section"><h4>调用输入</h4><pre tabIndex={0}>{JSON.stringify(full?.input ?? block.input, null, 2)}</pre></div>
      {result || full && !full.pending ? <div className="chat-activity-detail-section"><h4>结果</h4><pre tabIndex={0}>{JSON.stringify(full && !full.pending ? full.content : result?.content, null, 2)}</pre></div> : null}
    </div>
  </ChatActivityEntry>;
}

function ThinkingCommentEntry({ thinking }: { thinking: string }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  return <ChatActivityEntry expanded={expanded} label="思考过程" stateLabel="已结束" icon="brain" onToggle={event => preserveDisclosurePosition(event.currentTarget, () => setExpanded(value => !value))}>
    <DeferredMarkdownPreview content={thinking || "模型未提供可显示的思考正文。"} variant="inline" wrap/>
  </ChatActivityEntry>;
}

function ReadonlyCommentActivity({ turn, taskId, commentId, resultByTool }: { turn: ConversationTurn; taskId: string; commentId: string; resultByTool: Map<string, Extract<ConversationTurn["content"][number], { type: "tool_result" }>> }): React.ReactElement | null {
  const [expanded, setExpanded] = React.useState(false);
  const blocks = turn.content.flatMap((block, blockIndex) => block.type === "thinking" || block.type === "tool_use" ? [{ block, blockIndex }] : []);
  if (!blocks.length) return null;
  return <div className="chat-activity chat-activity-inline conversation-turn-activity" data-expanded={expanded ? "true" : "false"}>
    <button type="button" className="chat-disclosure-trigger chat-process-summary" aria-expanded={expanded} onClick={event => preserveDisclosurePosition(event.currentTarget, () => setExpanded(value => !value))}>
      <span className="chat-process-summary-dot" aria-hidden="true"><WandIcon name="brain" size={14}/></span>
      <span className="chat-activity-meta"><span className="chat-activity-meta-item">执行过程</span><span className="chat-activity-separator" aria-hidden="true">·</span><span className="chat-activity-meta-item">{blocks.length} 条记录</span></span>
    </button>
    {expanded && <div className="chat-activity-body">{blocks.map(({ block, blockIndex }) => {
      return <React.Fragment key={block.type === "thinking" ? `thinking-${blockIndex}` : block.id}>
        {block.type === "thinking" ? <ThinkingCommentEntry thinking={block.thinking}/> : <ReadonlyCommentTool taskId={taskId} commentId={commentId} block={block} result={resultByTool.get(block.id)}/>}
      </React.Fragment>;
    })}</div>}
  </div>;
}

function TruncatedCommentBlock({ taskId, commentId, turnOffset, blockIndex }: { taskId: string; commentId: string; turnOffset: number; blockIndex: number }): React.ReactElement {
  const [value, setValue] = React.useState<unknown>();
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const controllerRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => controllerRef.current?.abort(), []);
  const load = async (): Promise<void> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true); setFailed(false);
    try { const restored = await taskBoardRepository.commentResultBlock(taskId, commentId, turnOffset, blockIndex, { signal: controller.signal }); if (!controller.signal.aborted) setValue(restored); }
    catch { if (!controller.signal.aborted) setFailed(true); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  return <div className="task-comment-result-block"><WandButton kind="ghost" size="small" disabled={loading} onClick={() => void load()}>{loading ? "正在读取完整内容…" : failed ? "重试读取完整内容" : value === undefined ? "读取完整内容" : "重新读取完整内容"}</WandButton>
    {value !== undefined && <pre tabIndex={0}>{JSON.stringify(value, null, 2)}</pre>}</div>;
}

/** 正文里的 `#TASK-133` 渲染成可点引用 token；其余文字原样。 */
export function TaskReferenceText({ text, onOpenTask }: { text: string; onOpenTask?(identifier: string): void }): React.ReactElement {
  return <>{taskReferenceSegments(text).map((segment, index) => segment.identifier
    ? <button type="button" key={`ref#${index}`} className="task-comment-reference-token" title={`引用 ${segment.identifier}`}
      onClick={() => onOpenTask?.(segment.identifier!)}>{segment.text}</button>
    : <React.Fragment key={`plain#${index}`}>{segment.text}</React.Fragment>)}</>;
}

export const TaskCommentStreamRow = React.forwardRef<HTMLDivElement, {
  comment: WandTaskComment; sourceComment?: WandTaskComment; onReply(id: string, dispatch?: boolean): void; onViewDispatch?(): void; expanded?: boolean; onExpanded?(value: boolean): void;
  onOpenTask?(identifier: string): void;
}>(function TaskCommentStreamRow({ comment, sourceComment, onReply, onViewDispatch, expanded, onExpanded, onOpenTask }, ref): React.ReactElement {
  return <RowDisclosure id={`comment-${comment.id}`} summary={<Flex align="center" gap="small" wrap className="task-stream-row-line">
    <Typography.Text strong>{comment.authorName || "用户"}</Typography.Text>
    {comment.dispatch && <Tag color="purple">{comment.dispatch.state === "paused" ? `已暂停 · ${comment.dispatch.employeeName}` : comment.dispatch.state === "queued" ? `排队中 · 已派发给 ${comment.dispatch.employeeName}` : `已派发给 ${comment.dispatch.employeeName}`}</Tag>}
    {sourceComment && <Typography.Text type="secondary">回复 {sourceComment.authorName}：{sourceComment.body.slice(0, 100)}</Typography.Text>}
    <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>
  </Flex>} expanded={expanded} onExpanded={onExpanded} rowRef={ref}>
    <DeferredMarkdownPreview content={comment.body} variant="inline" wrap renderText={value => <TaskReferenceText text={value} onOpenTask={onOpenTask}/>}/>
    <Flex wrap gap="small" className="task-stream-row-actions">
      {comment.dispatch && <WandButton size="small" kind="ghost" onClick={() => { onExpanded?.(true); onViewDispatch?.(); }}>查看员工执行事项</WandButton>}
      <WandButton size="small" kind="ghost" onClick={() => onReply(comment.id)}>回复</WandButton>
      <WandButton size="small" kind="ghost" onClick={() => onReply(comment.id, true)}>回复并派发</WandButton>
    </Flex>
  </RowDisclosure>;
});

function CommentResultTurn({ turn, turnOffset, comment, truncatedBlocks, resultByTool }: {
  turn: ConversationTurn & { blockOffset?: number; blockTotal?: number };
  turnOffset: number; comment: WandTaskComment;
  truncatedBlocks: Array<{ turnOffset: number; blockIndex: number }>;
  resultByTool: Map<string, Extract<ConversationTurn["content"][number], { type: "tool_result" }>>;
}): React.ReactElement {
  const [window, setWindow] = React.useState<{ offset: number; content: ConversationTurn["content"]; truncated: number[] } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const request = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    setWindow(null); setLoading(false); setError("");
    return () => { request.current?.abort(); request.current = null; };
  }, [turn, comment.taskId, comment.id, turnOffset]);
  const content = window?.content ?? turn.content;
  const offset = window?.offset ?? turn.blockOffset ?? 0;
  const total = turn.blockTotal ?? turn.content.length;
  const handles = window?.truncated ?? truncatedBlocks.filter(block => block.turnOffset === turnOffset).map(block => block.blockIndex);
  const load = async (nextOffset: number): Promise<void> => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError("");
    try {
      const page = await taskBoardRepository.commentResultBlocks(comment.taskId, comment.id, turnOffset, nextOffset, { limit: 32, signal: controller.signal });
      if (controller.signal.aborted || request.current !== controller) return;
      if (page.turnOffset !== turnOffset || page.blockOffset !== nextOffset || page.blockTotal !== total || !page.blocks.length || page.blocks.length > 32 || nextOffset + page.blocks.length > total
        || page.blocks.some((entry, index) => entry.blockIndex !== nextOffset + index)) throw new Error("结果内容块分页位置无效。");
      setWindow({ offset: nextOffset, content: page.blocks.map(entry => entry.block), truncated: page.blocks.filter(entry => entry.truncated).map(entry => entry.blockIndex) });
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) setError(cause instanceof Error ? cause.message : "内容加载失败，请重试。");
    } finally {
      if (!controller.signal.aborted && request.current === controller) { setLoading(false); request.current = null; }
    }
  };
  const text = content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
  return <article className="task-comment-result-turn" data-role={turn.role}>
    <Typography.Text strong>{turn.role === "user" ? "本轮指令" : "执行记录"}</Typography.Text>
    <ReadonlyCommentActivity key={offset} turn={{ ...turn, content }} taskId={comment.taskId} commentId={comment.id} resultByTool={resultByTool}/>
    {text && <ChatMessage own={turn.role === "user"} surface="preview" content={<DeferredMarkdownPreview content={text} variant="inline" wrap/>}/>}
    {handles.map(blockIndex => <TruncatedCommentBlock key={`${offset}-${blockIndex}`} taskId={comment.taskId} commentId={comment.id} turnOffset={turnOffset} blockIndex={blockIndex}/>)}
    {error && <Alert type="warning" title={error}/>}
    {(offset > 0 || offset + content.length < total) && <Flex align="center" gap="small">
      <WandButton kind="ghost" size="small" disabled={loading || offset === 0} onClick={() => void load(Math.max(0, offset - 32))}>上一段内容</WandButton>
      <Typography.Text type="secondary">{offset + (content.length ? 1 : 0)}–{offset + content.length} / {total} 块</Typography.Text>
      <WandButton kind="ghost" size="small" disabled={loading || offset + content.length >= total} onClick={() => void load(offset + content.length)}>{loading ? "正在加载…" : "加载后续内容"}</WandButton>
    </Flex>}
  </article>;
}

export const TaskCommentDispatchStreamRow = React.forwardRef<HTMLDivElement, {
  comment: WandTaskComment; onOpenSession?: (id: string) => void; onLocateComment?(): void;
  result?: { messages: ConversationTurn[]; offset: number; total: number; outcome: string; unavailable?: string; loading: boolean; failed?: boolean; retryOffset?: number; truncatedBlocks?: Array<{ turnOffset: number; blockIndex: number }> };
  onLoadResult?(commentId: string, offset?: number): void;
  onOpenTask?(identifier: string): void;
}>(function TaskCommentDispatchStreamRow(props, ref): React.ReactElement {
  return <TaskCommentDispatchStreamRowContent {...props} rowRef={ref}/>;
});

export function TaskChildStreamRow({ task, onOpen, onOpenSession }: {
  task: WandTaskListed; onOpen(id: string): void; onOpenSession?: (id: string) => void;
}): React.ReactElement {
  return <RowDisclosure id={`child-${task.id}`} summary={<Flex align="center" gap="small" wrap className="task-stream-row-line">
    <Tag>{task.identifier}</Tag><Typography.Text strong>{task.title}</Typography.Text><Tag>{task.status}</Tag>
    {task.acceptance?.acceptedAt && <Tag color="success">已验收</Tag>}
    <Typography.Text type="secondary">正式子任务</Typography.Text>
  </Flex>}>
    {task.description && <DeferredMarkdownPreview content={task.description} variant="inline" wrap/>}
    {task.acceptance?.evidence && <Typography.Paragraph type="secondary">交付证据：{task.acceptance.evidence}</Typography.Paragraph>}
    {task.acceptance?.blocker && <Typography.Text type="warning">阻塞：{task.acceptance.blocker}</Typography.Text>}
    <Flex wrap gap="small" className="task-stream-row-actions">
      <WandButton kind="ghost" size="small" onClick={() => onOpen(task.id)}>打开子任务与验收</WandButton>
      {task.sessions.map(session => <WandButton key={session.id} kind="ghost" size="small" onClick={() => onOpenSession?.(session.id)}>打开 {session.title || "子任务会话"}</WandButton>)}
    </Flex>
  </RowDisclosure>;
}

function TaskCommentDispatchStreamRowContent({ comment, onOpenSession, onLocateComment, result, onLoadResult, rowRef, onOpenTask }: {
  comment: WandTaskComment; onOpenSession?: (id: string) => void; onLocateComment?(): void; rowRef?: React.Ref<HTMLDivElement>;
  result?: { messages: ConversationTurn[]; offset: number; total: number; outcome: string; unavailable?: string; loading: boolean; failed?: boolean; retryOffset?: number; truncatedBlocks?: Array<{ turnOffset: number; blockIndex: number }> };
  onLoadResult?(commentId: string, offset?: number): void;
  onOpenTask?(identifier: string): void;
}): React.ReactElement {
  const dispatch = comment.dispatch!;
  return <div ref={rowRef} className="task-stream-row" data-stream-row={`dispatch-${comment.id}`}>
    <TaskExecutionCard comment={comment} result={result} onOpenSession={onOpenSession} onLocateComment={onLocateComment}
      onLoadResult={onLoadResult} onOpenTask={onOpenTask}/>
    <Flex wrap gap="small" align="center" className="task-stream-row-actions">
      {result?.loading && <Typography.Text role="status">正在读取固定执行轮次…</Typography.Text>}
      {result?.failed && <Alert type="warning" title="本轮结果加载失败" action={<WandButton kind="ghost" size="small" onClick={() => onLoadResult?.(comment.id, result.retryOffset ?? result.offset)}>重试</WandButton>}/>}
      {result?.unavailable && <Typography.Text type="secondary">{result.unavailable === "still_running" ? "本轮执行仍在进行；完成后可读取固定轮次结果。" : "旧记录缺少可验证的执行轮次，无法安全展示结果。"}</Typography.Text>}
    </Flex>
    {result && !result.loading && result.messages.length > 0 && <section className="task-comment-result" aria-label="固定执行轮次结果">
      <Typography.Text strong>本轮执行结果 · {result.outcome === "done" ? "已完成" : result.outcome === "failed" ? "失败" : result.outcome === "stopped" ? "已停止" : "状态待确认"}</Typography.Text>
      <div className="task-comment-result-messages">{result.messages.map((turn, index) => <CommentResultTurn
        key={turn.messageId ?? `${turn.requestId ?? "turn"}-${index}`} turn={turn} comment={comment}
        turnOffset={result.offset - result.messages.length + index} truncatedBlocks={result.truncatedBlocks ?? []}
        resultByTool={new Map(result.messages.flatMap(loadedTurn => loadedTurn.content.flatMap(block => block.type === "tool_result" ? [[block.tool_use_id, block] as const] : [])))}/>)}</div>
      {result.offset < result.total && <WandButton kind="ghost" size="small" disabled={result.loading} onClick={() => onLoadResult?.(comment.id, result.offset)}>加载后续结果</WandButton>}
    </section>}
  </div>;
}

export function TaskLegacySessionStreamRow({ session, onOpen }: { session: IssueSessionSummary; onOpen?: (id: string) => void }): React.ReactElement {
  return <RowDisclosure id={`legacy-session-${session.id}`} summary={<Flex align="center" gap="small" wrap className="task-stream-row-line">
    <Typography.Text strong>{session.employeeName || session.title || "历史执行会话"}</Typography.Text><Tag>{statusLabels[session.status] ?? session.status}</Tag>
    <Typography.Text type="secondary">历史 / CLI / 团队会话</Typography.Text>
  </Flex>}>
    <Flex wrap gap="small" align="center" className="task-stream-row-actions"><Typography.Text>{session.provider}{session.model ? ` · ${session.model}` : ""}</Typography.Text>
      <Typography.Text type="secondary">{session.cwd}</Typography.Text><WandButton kind="ghost" size="small" onClick={() => onOpen?.(session.id)}>打开原会话</WandButton></Flex>
  </RowDisclosure>;
}
