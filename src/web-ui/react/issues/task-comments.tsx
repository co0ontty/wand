import * as React from "react";
import { Alert, Card, Flex, List, Typography } from "antd";
import type { WandTaskComment } from "../../../task-types";
import { DeferredMarkdownPreview } from "../file-preview/deferred-markdown";
import { WandButton } from "../ui/button";
import { usePopupDismiss } from "../ui/popup-lifecycle";
import { taskBoardRepository } from "./task-board-repository";
import { TaskTextArea } from "./task-form";
import { acceptCommentDraft, commentDeliveryUncertain, commentDraft, commentMentionHeld, commentMentionQuery, commentRequestIdentity, commentRequestRejected, editCommentDraft, insertCommentMention, settleCommentRequest, type CommentDraft } from "./task-comment-composer";

const statusLabels: Record<string, string> = { pending: "等待确认", accepted: "已创建执行", running: "执行中", blocked: "等待审批", idle: "本轮已结束", exited: "会话已退出", stopped: "已停止", failed: "执行失败", unknown: "送达未知 · 不会重放", history: "历史会话", unavailable: "会话不可用" };

type MentionEmployee = { id: string; name: string; archivedAt?: string | null };

function focusCommentCaret(node: HTMLTextAreaElement | null | undefined, caret: number): void {
  if (!node) return;
  node.focus({ preventScroll: true });
  const pos = Math.max(0, Math.min(caret, node.value.length));
  node.setSelectionRange(pos, pos);
}

export function TaskComments({ taskId, updatedAt, employees = [], onOpenSession }: { taskId: string; updatedAt: string;
  employees?: MentionEmployee[]; onOpenSession?: (id: string) => void }): React.ReactElement {
  const [result, setResult] = React.useState<{ taskId: string; comments: WandTaskComment[]; failed: boolean; loading: boolean }>({ taskId, comments: [], failed: false, loading: true });
  const [attempt, retry] = React.useReducer(value => value + 1, 0);
  const [draft, setDraft] = React.useState(() => commentDraft(taskId));
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [outcome, setOutcome] = React.useState<"idle" | "saved" | "failed" | "unknown">("idle");
  const [caret, setCaret] = React.useState(0);
  const [highlight, setHighlight] = React.useState(0);
  const [dismissed, setDismissed] = React.useState("");
  const pending = React.useRef(false);
  const mounted = React.useRef(true);
  const input = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const edit = (patch: Partial<CommentDraft>): void => { setDraft(editCommentDraft(taskId, patch)); setMessage(""); setOutcome("idle"); };
  const active = employees.filter(employee => !employee.archivedAt);
  const bound = active.find(employee => employee.id === draft.employeeId);
  const mention = commentMentionQuery(draft.body, caret);
  const mentionKey = mention ? `${mention.start}:${mention.query}` : "";
  const matches = mention && dismissed !== mentionKey
    ? active.filter(employee => employee.name.toLocaleLowerCase().includes(mention.query.toLocaleLowerCase()))
    : [];
  const menuOpen = mention != null && dismissed !== mentionKey;
  React.useEffect(() => { setHighlight(0); }, [mentionKey]);
  const closeMention = React.useCallback(() => { if (mentionKey) setDismissed(mentionKey); }, [mentionKey]);
  usePopupDismiss(menuOpen, closeMention);
  const nativeInput = (): HTMLTextAreaElement | null => input.current;
  const choose = (employee: MentionEmployee): void => {
    const node = nativeInput();
    const pos = node?.selectionStart ?? caret;
    const next = insertCommentMention(draft.body, pos, employee.name);
    edit({ body: next.body, employeeId: employee.id });
    setCaret(next.caret);
    setDismissed("");
    requestAnimationFrame(() => focusCommentCaret(nativeInput(), next.caret));
  };
  const replyTo = (commentId: string): void => {
    const current = commentDraft(taskId);
    const gap = current.body && !/\s$/.test(current.body) ? " " : "";
    const body = `${current.body}${gap}@`;
    edit({ sourceCommentId: commentId, body });
    setCaret(body.length);
    setDismissed("");
    requestAnimationFrame(() => focusCommentCaret(nativeInput(), body.length));
  };
  React.useEffect(() => {
    const controller = new AbortController();
    let generation = 0;
    const load = (): void => {
      const request = ++generation;
      void taskBoardRepository.comments(taskId, controller.signal).then(comments => {
        if (!controller.signal.aborted && request === generation) setResult({ taskId, comments: comments.filter(comment => comment.taskId === taskId), failed: false, loading: false });
      }).catch(() => { if (!controller.signal.aborted && request === generation) setResult(current => ({ taskId, comments: current.taskId === taskId ? current.comments : [], failed: true, loading: false })); });
    };
    setResult(current => ({ taskId, comments: current.taskId === taskId ? current.comments : [], failed: false, loading: true }));
    load(); const timer = window.setInterval(load, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [taskId, updatedAt, attempt]);
  const comments = result.taskId === taskId ? result.comments : [];
  const failed = result.taskId === taskId && result.failed;
  const loading = result.taskId !== taskId || result.loading;
  const submit = async (): Promise<void> => {
    if (pending.current || !draft.body.trim()) return;
    pending.current = true; setBusy(true); setMessage("");
    const employeeId = bound && commentMentionHeld(draft.body, bound.name) ? bound.id : "";
    const submitted = { ...draft, employeeId };
    let identity: Awaited<ReturnType<typeof commentRequestIdentity>> | undefined;
    try {
      identity = await commentRequestIdentity(taskId, submitted);
      const response = await taskBoardRepository.postComment(taskId, { requestId: identity.requestId, body: submitted.body.trim(),
        employeeId: submitted.employeeId || null, sourceCommentId: submitted.sourceCommentId });
      settleCommentRequest(identity, response.comment);
      const uncertain = commentDeliveryUncertain(response.comment);
      const rejected = response.comment.dispatch?.state === "failed";
      const next = rejected ? commentDraft(taskId) : acceptCommentDraft(taskId, submitted);
      if (mounted.current) {
        setDraft(next); setCaret(next.body.length); setOutcome(uncertain ? "unknown" : rejected ? "failed" : "saved");
        setMessage(uncertain ? "评论已保存，执行送达未知；已保留请求身份，同一评论不会重新派发。"
          : rejected ? response.comment.dispatch?.error || "评论已保存，但执行明确未接受；原指令已保留。" : "评论已保存");
        retry();
      }
    } catch (error) {
      if (commentRequestRejected(error)) identity?.forget();
      if (mounted.current) {
        setOutcome(commentRequestRejected(error) ? "failed" : "unknown");
        setMessage(error instanceof Error ? error.message : "提交结果未知，请刷新核对；同一评论重试会复用请求标识。"); retry();
      }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const submitPhase = busy ? "sending" : outcome;
  const dispatching = Boolean(bound && commentMentionHeld(draft.body, bound.name));
  const submitLabels = { idle: dispatching ? "评论并派发" : "发表评论", sending: "正在提交…", saved: "评论已保存", failed: "提交失败", unknown: "送达待核对" };
  return <Card size="small" title={`评论${comments.length ? ` · ${comments.length}` : ""}`} role="region" aria-label="任务评论" aria-busy={loading}
    extra={<WandButton kind="ghost" size="small" disabled={loading} onClick={retry}>刷新评论</WandButton>}>
    <Flex vertical gap="small" className="task-board-detail-content">
      {failed ? <Alert type="warning" title="评论暂时加载失败" action={<WandButton kind="ghost" size="small" onClick={retry}>重试</WandButton>}/> : null}
      {!comments.length && !failed ? <Typography.Text type="secondary" role="status">{loading ? "正在加载评论…" : "暂无评论。在正文里 @员工 就会派发；不 @ 只是普通评论。"}</Typography.Text> : null}
      {comments.length > 0 && <List size="small" dataSource={comments} renderItem={comment => <List.Item key={comment.id}>
        <Flex vertical gap="small" style={{ width: "100%", minWidth: 0 }}>
          <Flex wrap gap="small" align="center"><Typography.Text strong>{comment.authorName}</Typography.Text>
            <Typography.Text type="secondary"><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time></Typography.Text>
            <WandButton kind="ghost" size="small" onClick={() => replyTo(comment.id)}>回复并 @</WandButton>
          </Flex>
          {comment.sourceCommentId && <Typography.Text type="secondary">回复评论 {comment.sourceCommentId}</Typography.Text>}
          <DeferredMarkdownPreview content={comment.body} variant="inline" wrap/>
          {comment.dispatch && <Flex wrap gap="small" align="center" aria-label="评论执行状态">
            <Typography.Text>@{comment.dispatch.employeeName} · {statusLabels[comment.dispatch.status ?? comment.dispatch.state] ?? "状态未确认"}</Typography.Text>
            {comment.dispatch.sessionId && <WandButton size="small" kind="ghost" onClick={() => onOpenSession?.(comment.dispatch!.sessionId!)}>查看执行</WandButton>}
            {comment.dispatch.error && <Typography.Text type="warning">{comment.dispatch.error}</Typography.Text>}
          </Flex>}
        </Flex>
      </List.Item>}/>}
      {draft.sourceCommentId && <WandButton kind="ghost" size="small" onClick={() => edit({ sourceCommentId: null })}>取消回复 · {draft.sourceCommentId.slice(0, 8)}</WandButton>}
      {menuOpen ? <div id="task-comment-mention" role="listbox" aria-label="提及员工" className="task-comment-mention">
        {matches.length === 0 ? <button type="button" role="option" disabled>没有匹配的员工</button> : matches.map((employee, index) => <button
          key={employee.id} type="button" role="option" title={`@${employee.name}`} aria-selected={index === highlight}
          onMouseEnter={() => setHighlight(index)}
          onMouseDown={event => { event.preventDefault(); choose(employee); }}
        >@{employee.name}</button>)}
      </div> : null}
      <TaskTextArea ref={input} value={draft.body} rows={3} maxLength={16000} aria-label="任务评论输入"
        aria-expanded={menuOpen} aria-controls={menuOpen ? "task-comment-mention" : undefined} aria-autocomplete="list"
        placeholder="写评论。输入 @ 选择员工，选中后才会派发"
        onSelect={event => setCaret(event.currentTarget.selectionStart ?? draft.body.length)}
        onChange={event => {
          const value = event.currentTarget.value;
          const pos = event.currentTarget.selectionStart ?? value.length;
          const person = active.find(employee => employee.id === commentDraft(taskId).employeeId);
          edit({ body: value, employeeId: person && commentMentionHeld(value, person.name) ? person.id : "" });
          setCaret(pos);
        }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (menuOpen && (matches.length > 0 || event.key === "Escape")) {
            if (event.key === "ArrowDown" && matches.length > 0) { event.preventDefault(); setHighlight(index => (index + 1) % matches.length); return; }
            if (event.key === "ArrowUp" && matches.length > 0) { event.preventDefault(); setHighlight(index => (index - 1 + matches.length) % matches.length); return; }
            if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && matches[highlight]) { event.preventDefault(); choose(matches[highlight]!); return; }
            if (event.key === "Escape") { event.preventDefault(); closeMention(); return; }
          }
          if (event.key === "Escape") edit({ sourceCommentId: null });
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
        }}/>
      <Flex wrap gap="small" align="center">
        <WandButton kind="primary" size="small" style={{ width: 128, height: 32, flexShrink: 0 }} data-comment-submit-phase={submitPhase} aria-label={submitLabels[submitPhase]}
          disabled={busy || !draft.body.trim()} onClick={() => void submit()}>
          <span style={{ display: "grid" }} aria-live="polite">
            {Object.entries(submitLabels).map(([phase, label]) =>
              <span key={phase} aria-hidden={phase !== submitPhase} style={{ gridArea: "1 / 1", opacity: phase === submitPhase ? 1 : 0,
                transition: "opacity var(--motion-fast) var(--ease-in-out-smooth)" }}>{label}</span>)}
          </span>
        </WandButton>
        <Typography.Text type="secondary" role="status">{message || (dispatching ? `将派发给 @${bound?.name}。只派发这一次选中的人。` : "正文里没有选中的 @员工时，不会启动执行。")}</Typography.Text>
      </Flex>
    </Flex>
  </Card>;
}
