import * as React from "react";
import { Alert, Flex, Typography } from "antd";
import type { WandTaskComment } from "../../../task-types";
import { TaskChildStreamRow, TaskCommentDispatchStreamRow, TaskCommentStreamRow, TaskLegacySessionStreamRow } from "./task-stream-row";
import type { IssueSessionSummary, WandTaskListed } from "./task-board-repository";
import { WandButton } from "../ui/button";
import { isWandPopupOwnedBy, usePopupDismiss } from "../ui/popup-lifecycle";
import { usePortalContainer } from "../ui/portal-context";
import { createPortal } from "react-dom";
import { taskBoardRepository } from "./task-board-repository";
import { TaskTextArea } from "./task-form";
import { acceptCommentDraft, commentDeliveryUncertain, commentDraft, commentMentionHeld, commentMentionQuery, commentRequestIdentity, commentRequestRejected, editCommentDraft, insertCommentMention, settleCommentRequest, type CommentDraft } from "./task-comment-composer";

type MentionEmployee = { id: string; name: string; archivedAt?: string | null };

function focusCommentCaret(node: HTMLTextAreaElement | null | undefined, caret: number): void {
  if (!node) return;
  node.focus({ preventScroll: true });
  const pos = Math.max(0, Math.min(caret, node.value.length));
  node.setSelectionRange(pos, pos);
}

export function TaskComments({ taskId, updatedAt, employees = [], childTasks = [], sessions = [], onOpenSession, onOpenTask }: { taskId: string; updatedAt: string;
  employees?: MentionEmployee[]; childTasks?: WandTaskListed[]; sessions?: IssueSessionSummary[]; onOpenSession?: (id: string) => void; onOpenTask?: (id: string) => void }): React.ReactElement {
  const [result, setResult] = React.useState<{ taskId: string; comments: WandTaskComment[]; totalCount: number; nextCursor: string | null; failed: boolean; loading: boolean }>({ taskId, comments: [], totalCount: 0, nextCursor: null, failed: false, loading: true });
  const [attempt, retry] = React.useReducer(value => value + 1, 0);
  const [draft, setDraft] = React.useState(() => commentDraft(taskId));
  const [replyLabel, setReplyLabel] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [outcome, setOutcome] = React.useState<"idle" | "saved" | "failed" | "unknown">("idle");
  const [caret, setCaret] = React.useState(0);
  const [highlight, setHighlight] = React.useState(0);
  const [dismissed, setDismissed] = React.useState("");
  const [streamExpanded, setStreamExpanded] = React.useState<Record<string, boolean>>({});
  const [resultPages, setResultPages] = React.useState<Record<string, { taskId: string; messages: import("../../../types.js").ConversationTurn[]; offset: number; total: number; outcome: string; unavailable?: string; loading: boolean; failed?: boolean; retryOffset?: number; truncatedBlocks?: Array<{ turnOffset: number; blockIndex: number }> }>>({});
  const resultRequests = React.useRef(new Map<string, { id: number; controller: AbortController }>());
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [sourceComments, setSourceComments] = React.useState<Record<string, { taskId: string; comment: Pick<WandTaskComment, "id" | "taskId" | "authorName" | "body" | "createdAt" | "sourceCommentId"> | null }>>({});
  const sourceCommentsRef = React.useRef(sourceComments);
  sourceCommentsRef.current = sourceComments;
  const commentsRef = React.useRef(result);
  commentsRef.current = result;
  const olderRequest = React.useRef<AbortController | null>(null);
  const activeTaskId = React.useRef(taskId);
  activeTaskId.current = taskId;
  const [mentionRect, setMentionRect] = React.useState<DOMRect | null>(null);
  const portal = usePortalContainer();
  const popupOwner = `task-comment-${taskId}`;
  const pending = React.useRef(false);
  const mounted = React.useRef(true);
  const input = React.useRef<HTMLTextAreaElement>(null);
  const submitButton = React.useRef<HTMLButtonElement>(null);
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>());
  const taskGeneration = React.useRef(0);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => { taskGeneration.current += 1; olderRequest.current?.abort(); olderRequest.current = null; for (const request of resultRequests.current.values()) request.controller.abort(); resultRequests.current.clear(); setLoadingOlder(false); setSourceComments({}); }, [taskId]);
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
  React.useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent): void => {
      const target = event.target;
      if (input.current?.contains(target as Node) || isWandPopupOwnedBy(target, popupOwner)) return;
      closeMention();
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [closeMention, menuOpen, popupOwner]);
  React.useLayoutEffect(() => {
    if (!menuOpen || !input.current) return;
    const update = (): void => setMentionRect(input.current?.getBoundingClientRect() ?? null);
    update(); window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [menuOpen, mentionKey]);
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
  const replyTo = (commentId: string, dispatch = false): void => {
    const current = commentDraft(taskId);
    const gap = current.body && !/\s$/.test(current.body) ? " " : "";
    const body = `${current.body}${gap}${dispatch ? "@" : ""}`;
    edit({ sourceCommentId: commentId, body, employeeId: "" });
    const source = comments.find(comment => comment.id === commentId) ?? sourceComments[commentId]?.comment;
    setReplyLabel(source ? `${source.authorName}：${source.body.slice(0, 100)}` : `来源评论 ${commentId.slice(0, 8)}（正在核对）`);
    setStreamExpanded(current => ({ ...current, [commentId]: true }));
    setCaret(body.length);
    setDismissed("");
    requestAnimationFrame(() => focusCommentCaret(nativeInput(), body.length));
  };
  React.useEffect(() => {
    const controller = new AbortController();
    let generation = 0;
    const load = (): void => {
      const request = ++generation;
      void taskBoardRepository.comments(taskId, { limit: 50, signal: controller.signal }).then(async rawPage => {
        const page = Array.isArray(rawPage) ? { comments: rawPage, totalCount: rawPage.length, nextCursor: null } : rawPage;
        if (controller.signal.aborted || request !== generation) return;
        const latest = commentsRef.current;
        const existing = latest.taskId === taskId ? latest.comments : [];
        const loadedIds = new Set([...existing, ...page.comments].map(comment => comment.id));
        const sourceIds = [...new Set([...existing, ...page.comments].flatMap(comment => {
          const id = comment.sourceCommentId;
          return id && !loadedIds.has(id) && sourceCommentsRef.current[id]?.taskId !== taskId ? [id] : [];
        }))];
        const statusIds = [...new Set(existing.filter(comment => comment.dispatch).map(comment => comment.id))];
        const [statusPages, sourcePages] = await Promise.all([
          Promise.all(Array.from({ length: Math.ceil(statusIds.length / 100) }, (_, index) =>
            taskBoardRepository.commentStatuses(taskId, statusIds.slice(index * 100, index * 100 + 100), { signal: controller.signal }))),
          Promise.all(sourceIds.map(async id => ({ id, result: await taskBoardRepository.commentSource(taskId, id, { signal: controller.signal }) }))),
        ]);
        if (!controller.signal.aborted && request === generation) setResult(current => {
          const exactById = new Map(statusPages.flatMap(statusPage => statusPage.comments.map(comment => [comment.id, comment] as const)));
          const freshDispatches = new Map(page.comments.filter(comment => comment.taskId === taskId && comment.dispatch).map(comment => [comment.id, comment.dispatch] as const));
          const existingWithStatus = existing.map(comment => exactById.has(comment.id) ? { ...comment, dispatch: exactById.get(comment.id)?.dispatch ?? null } : comment);
          const refreshedPage = page.comments.filter(comment => comment.taskId === taskId).map(comment => freshDispatches.has(comment.id) && exactById.has(comment.id)
            ? { ...comment, dispatch: exactById.get(comment.id)?.dispatch ?? comment.dispatch } : comment);
          const merged = new Map([...existingWithStatus, ...refreshedPage].map(comment => [comment.id, comment]));
          setSourceComments(currentSources => {
            const next = { ...currentSources };
            for (const { id, result: sourceResult } of sourcePages) next[id] = { taskId, comment: sourceResult.comment ?? null };
            return next;
          });
          const comments = [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
          const loadedOlderPages = existing.length > 0 && current.nextCursor !== null;
          const nextCursor = comments.length >= page.totalCount ? null : loadedOlderPages ? current.nextCursor : page.nextCursor;
          return { taskId, comments, totalCount: page.totalCount, nextCursor, failed: false, loading: false };
        });
      }).catch(() => { if (!controller.signal.aborted && request === generation) setResult(current => ({ taskId, comments: current.taskId === taskId ? current.comments : [], totalCount: current.taskId === taskId ? current.totalCount : 0, nextCursor: current.taskId === taskId ? current.nextCursor : null, failed: true, loading: false })); });
    };
    setResult(current => ({ taskId, comments: current.taskId === taskId ? current.comments : [], totalCount: current.taskId === taskId ? current.totalCount : 0, nextCursor: current.taskId === taskId ? current.nextCursor : null, failed: false, loading: true }));
    load(); const timer = window.setInterval(load, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [taskId, updatedAt, attempt]);
  const comments = result.taskId === taskId ? result.comments : [];
  const totalCount = result.taskId === taskId ? result.totalCount : 0;
  const nextCursor = result.taskId === taskId ? result.nextCursor : null;
  const loadResult = async (commentId: string, offset = 0): Promise<void> => {
    const requestKey = `${taskId}:${commentId}`;
    const existingRequest = resultRequests.current.get(requestKey);
    if (existingRequest && offset !== 0) return;
    existingRequest?.controller.abort();
    const controller = new AbortController();
    const requestId = (existingRequest?.id ?? 0) + 1;
    const generation = taskGeneration.current;
    resultRequests.current.set(requestKey, { id: requestId, controller });
    setResultPages(current => ({ ...current, [commentId]: { ...(current[commentId] ?? { taskId, messages: [], offset: 0, total: 0, outcome: "", loading: false }), taskId, loading: true, failed: false } }));
    try {
      const page = await taskBoardRepository.commentResult(taskId, commentId, { offset, limit: 40, signal: controller.signal });
      if (!mounted.current || controller.signal.aborted || taskGeneration.current !== generation || activeTaskId.current !== taskId || resultRequests.current.get(requestKey)?.id !== requestId) return;
      const fetchedMessages = page.messages ?? [];
      if (!page.available) {
        setResultPages(current => ({ ...current, [commentId]: { taskId, messages: [], offset: 0, total: 0, outcome: "", unavailable: page.reason ?? "unavailable", loading: false } }));
        return;
      }
      if (!mounted.current || controller.signal.aborted || taskGeneration.current !== generation || activeTaskId.current !== taskId || resultRequests.current.get(requestKey)?.id !== requestId) return;
      setResultPages(current => {
        const previous = current[commentId];
        if (!page.available) return { ...current, [commentId]: { taskId, messages: [], offset: 0, total: 0, outcome: "", unavailable: page.reason ?? "unavailable", loading: false } };
        const messages = offset > 0 && previous ? [...previous.messages, ...fetchedMessages] : fetchedMessages;
        const resultOffset = offset > 0 && previous ? previous.offset : offset;
        const pageBlockHandles = page.truncatedBlocks ?? [];
        const truncatedBlocks = offset > 0 && previous
          ? [...(previous.truncatedBlocks ?? []), ...pageBlockHandles]
          : pageBlockHandles;
        return { ...current, [commentId]: { taskId, messages, offset: resultOffset + fetchedMessages.length, total: page.total ?? 0, outcome: page.outcome ?? "", loading: false, retryOffset: undefined, truncatedBlocks } };
      });
    } catch {
      if (mounted.current && !controller.signal.aborted && taskGeneration.current === generation && activeTaskId.current === taskId && resultRequests.current.get(requestKey)?.id === requestId) setResultPages(current => ({ ...current, [commentId]: { ...(current[commentId] ?? { taskId, messages: [], offset: 0, total: 0, outcome: "", loading: false }), taskId, loading: false, failed: true, retryOffset: offset } }));
    } finally {
      if (resultRequests.current.get(requestKey)?.id === requestId) resultRequests.current.delete(requestKey);
    }
  };
  const failed = result.taskId === taskId && result.failed;
  const loadOlder = async (): Promise<void> => {
    if (!nextCursor || loadingOlder || olderRequest.current) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    const generation = taskGeneration.current;
    const requestTaskId = taskId;
    setLoadingOlder(true);
    try {
      const rawPage = await taskBoardRepository.comments(requestTaskId, { before: nextCursor, limit: 50, signal: controller.signal });
      const page = Array.isArray(rawPage) ? { comments: rawPage, totalCount: rawPage.length, nextCursor: null } : rawPage;
      if (!mounted.current || controller.signal.aborted || taskGeneration.current !== generation || activeTaskId.current !== requestTaskId) return;
      setResult(current => {
        if (current.taskId !== requestTaskId) return current;
        const merged = new Map([...current.comments, ...page.comments.filter(comment => comment.taskId === requestTaskId)].map(comment => [comment.id, comment]));
        return { ...current, comments: [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), totalCount: page.totalCount, nextCursor: page.nextCursor };
      });
    } catch { if (mounted.current && !controller.signal.aborted && taskGeneration.current === generation && activeTaskId.current === requestTaskId) setMessage("更早的事项加载失败，请重试。"); }
    finally {
      if (olderRequest.current === controller) olderRequest.current = null;
      if (mounted.current && taskGeneration.current === generation) setLoadingOlder(false);
    }
  };
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
      if (mounted.current) setStreamExpanded(current => ({ ...current, [response.comment.id]: true }));
      const uncertain = commentDeliveryUncertain(response.comment);
      const rejected = response.comment.dispatch?.state === "failed";
      const next = rejected ? commentDraft(taskId) : acceptCommentDraft(taskId, submitted);
      if (mounted.current) {
        setDraft(next); setCaret(next.body.length); setOutcome(uncertain ? "unknown" : rejected ? "failed" : "saved");
        if (!rejected) setReplyLabel("");
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
  const dispatchingReply = Boolean(draft.sourceCommentId) && dispatching;
  const submitLabels = { idle: dispatching ? (dispatchingReply ? "回复并派发" : "评论并派发") : draft.sourceCommentId ? "回复" : "发表评论", sending: "正在提交…", saved: "评论已保存", failed: "提交失败", unknown: "送达待核对" };
  const commentById = new Map(comments.map(comment => [comment.id, comment]));
  const mentionHeight = Math.min(240, Math.max(38, matches.length * 34 + 8));
  const mentionBelow = mentionRect ? mentionRect.bottom + 6 : 0;
  const submitRect = submitButton.current?.getBoundingClientRect() ?? null;
  const overlapsComposerActions = Boolean(submitRect && mentionRect && mentionBelow < submitRect.bottom && mentionBelow + mentionHeight > submitRect.top);
  const mentionTop = mentionRect ? Math.max(8, Math.min(overlapsComposerActions || mentionBelow + mentionHeight > window.innerHeight - 8 ? mentionRect.top - mentionHeight - 6 : mentionBelow, window.innerHeight - mentionHeight - 8)) : 0;
  const dispatchComments = comments.filter(comment => Boolean(comment.dispatch));
  const ordinaryComments = comments;
  const dispatchedSessionIds = new Set(dispatchComments.map(comment => comment.dispatch?.sessionId).filter((id): id is string => Boolean(id)));
  // These sessions have a server-owned comment dispatch correlation, independent of comment pagination.
  const dispatchCommentBySessionId = new Map(dispatchComments.map(comment => [comment.dispatch?.sessionId, comment.id]));
  const legacySessions = sessions.filter(session => !session.taskCommentId && !dispatchedSessionIds.has(session.id) && !dispatchCommentBySessionId.has(session.id));
  return <div className="task-board-detail-streams" data-testid="task-detail-streams">
    <section className="task-board-child-stream" role="region" aria-label="子任务与员工执行">
      <Flex align="center" justify="space-between" gap="small" className="task-stream-heading">
        <Typography.Title level={4} style={{ margin: 0 }}>子任务与员工执行</Typography.Title>
        <Typography.Text type="secondary">{childTasks.length} 个子任务 · 已加载 {dispatchComments.length + legacySessions.length} 项执行</Typography.Text>
      </Flex>
      <Flex vertical gap="small" className="task-board-detail-content" data-testid="task-child-stream">
        {!childTasks.length && !dispatchComments.length && !legacySessions.length && <Typography.Text type="secondary">暂无子任务或执行事项。</Typography.Text>}
        {childTasks.map(child => <TaskChildStreamRow key={`child-${child.id}`} task={child} onOpen={id => onOpenTask?.(id)} onOpenSession={onOpenSession}/>)}
        {dispatchComments.map(comment => <TaskCommentDispatchStreamRow ref={(node: HTMLDivElement | null) => { const key = `dispatch-${comment.id}`; if (node) rowRefs.current.set(key, node); else rowRefs.current.delete(key); }} key={`dispatch-${comment.id}`} comment={comment}
          result={resultPages[comment.id]?.taskId === taskId ? resultPages[comment.id] : undefined} onLoadResult={loadResult} onOpenSession={onOpenSession}
          onLocateComment={() => { setStreamExpanded(current => ({ ...current, [comment.id]: true })); requestAnimationFrame(() => rowRefs.current.get(`comment-${comment.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })); }}/>) }
        {legacySessions.map(session => <TaskLegacySessionStreamRow key={`session-${session.id}`} session={session} onOpen={onOpenSession}/>)}
      </Flex>
    </section>
    <section className="task-board-comment-stream" role="region" aria-label="任务评论" aria-busy={loading} data-testid="task-comments-stream">
      <Flex align="center" justify="space-between" gap="small" className="task-stream-heading">
        <Typography.Title level={4} style={{ margin: 0 }}>评论 <Typography.Text type="secondary">{totalCount}</Typography.Text></Typography.Title>
        <WandButton kind="ghost" size="small" disabled={loading} onClick={retry}>刷新</WandButton>
      </Flex>
      <Flex vertical gap="small" className="task-board-detail-content">
      {failed ? <Alert type="warning" title="评论暂时加载失败" action={<WandButton kind="ghost" size="small" onClick={retry}>重试</WandButton>}/> : null}
      {!ordinaryComments.length && !failed ? <Typography.Text type="secondary" role="status">{loading ? "正在加载评论…" : "还没有评论。在正文里 @员工 并提交即可派发；不 @ 只是普通评论。"}</Typography.Text> : null}
      {ordinaryComments.map(comment => <TaskCommentStreamRow ref={(node: HTMLDivElement | null) => { const key = `comment-${comment.id}`; if (node) rowRefs.current.set(key, node); else rowRefs.current.delete(key); }} key={comment.id} comment={comment}
        sourceComment={comment.sourceCommentId ? commentById.get(comment.sourceCommentId) ?? sourceComments[comment.sourceCommentId]?.comment ?? undefined : undefined}
        expanded={streamExpanded[comment.id]} onExpanded={value => setStreamExpanded(current => ({ ...current, [comment.id]: value }))}
        onViewDispatch={() => rowRefs.current.get(`dispatch-${comment.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })}
        onReply={replyTo}/ >)}
      {nextCursor && <WandButton kind="ghost" size="small" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "正在加载更早评论…" : "加载更早评论"}</WandButton>}
      {draft.sourceCommentId && <Flex align="center" gap="small" className="task-comment-reply-context"><Typography.Text type="secondary">回复「{replyLabel || draft.sourceCommentId.slice(0, 8)}」</Typography.Text><WandButton kind="ghost" size="small" onClick={() => { edit({ sourceCommentId: null }); setReplyLabel(""); }}>取消回复</WandButton></Flex>}
      {menuOpen && portal && mentionRect ? createPortal(<div id="task-comment-mention" role="listbox" aria-label="提及员工" className="task-comment-mention" data-wand-popup-owner={`task-comment-${taskId}`}
        style={{ position: "fixed", zIndex: 1200, left: Math.max(8, Math.min(mentionRect.left, window.innerWidth - 280)), top: mentionTop, width: Math.min(280, window.innerWidth - 16), maxHeight: mentionHeight, pointerEvents: "auto" }}>
        {matches.length === 0 ? <button type="button" role="option" disabled>没有匹配的员工</button> : matches.map((employee, index) => <button
          key={employee.id} id={`task-comment-mention-option-${employee.id}`} type="button" role="option" title={`@${employee.name}`} aria-selected={index === highlight}
          onMouseEnter={() => setHighlight(index)}
          onMouseDown={event => event.preventDefault()}
          onClick={() => choose(employee)}
        >@{employee.name}</button>)}
      </div>, portal) : null}
      <TaskTextArea ref={input} value={draft.body} rows={3} maxLength={16000} aria-label="任务评论输入"
        aria-expanded={menuOpen} aria-controls={menuOpen ? "task-comment-mention" : undefined} aria-activedescendant={menuOpen && matches[highlight] ? `task-comment-mention-option-${matches[highlight]!.id}` : undefined} aria-autocomplete="list"
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
          if (event.key === "Escape") { edit({ sourceCommentId: null }); setReplyLabel(""); }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
        }}/>
      <Flex wrap gap="small" align="center">
        <WandButton ref={submitButton} kind="primary" size="small" style={{ width: 128, height: 32, flexShrink: 0 }} data-comment-submit-phase={submitPhase} aria-label={submitLabels[submitPhase]}
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
    </section>
  </div>;
}
