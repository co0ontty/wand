import { usePageSearch } from "../use-page-route.js";
import * as React from "react";
import { Alert, Flex, Typography, theme } from "antd";
import type { WandTaskComment } from "../../../task-types";
import { TaskCommentDispatchStreamRow, TaskCommentStreamRow, TaskLegacySessionStreamRow } from "./task-stream-row";
import type { IssueSessionSummary, WandTaskListed } from "./task-board-repository";
import { WandButton } from "../ui/button";
import { isWandPopupOwnedBy, usePopupDismiss } from "../ui/popup-lifecycle";
import { usePortalContainer } from "../ui/portal-context";
import { createPortal } from "react-dom";
import { taskBoardRepository } from "./task-board-repository";
import { TaskCommentEditor, type TaskCommentEditorHandle } from "./task-comment-editor";
import { TaskExecutionCard } from "./task-execution-card";
import type { WandTaskAgent } from "../../../task-types";
import { installChatComposerStyles } from "../chat-composer-styles";
import { acceptCommentDraft, commentDeliveryUncertain, commentDraft, commentMentionHeld, commentMentionQuery, commentReferenceQuery, commentRequestIdentity, commentRequestRejected, editCommentDraft, insertCommentMention, insertCommentReference, parseTaskReferenceIds, settleCommentRequest, type CommentDraft } from "./task-comment-composer";

type MentionEmployee = { id: string; name: string; archivedAt?: string | null; agents?: WandTaskAgent[] };
/** 可被 `#TASK-133` 引用的子任务；编号是引用句柄，标题与状态只用于展示。 */
type ReferenceTask = { id: string; identifier: string; title: string; status?: string };

function focusCommentCaret(node: TaskCommentEditorHandle | null | undefined, caret: number): void {
  if (!node) return;
  node.focus({ preventScroll: true });
  const pos = Math.max(0, Math.min(caret, node.value.length));
  node.setSelectionRange(pos, pos);
}

export function TaskComments({ taskId, updatedAt, replyRequest, dispatchPurpose = "execution", employees = [], childTasks = [], sessions = [], onOpenSession, onOpenTask }: { taskId: string; updatedAt: string; replyRequest?: { commentId: string | null; body: string; revision: number } | null; dispatchPurpose?: "execution" | "review";
  employees?: MentionEmployee[]; childTasks?: WandTaskListed[]; sessions?: IssueSessionSummary[]; onOpenSession?: (id: string) => void; onOpenTask?: (id: string) => void }): React.ReactElement {
  React.useLayoutEffect(() => { installChatComposerStyles(); }, []);
  const referenceTarget = new URLSearchParams(usePageSearch()).get("comment");
  const locatedReference = React.useRef("");
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
  // 可引用任务 = 本任务的直接子任务；编号是 `#TASK-xxx` 的唯一句柄。
  const referenceTasks: ReferenceTask[] = React.useMemo(() => childTasks.map(child => ({
    id: child.id, identifier: child.identifier, title: child.title, status: child.status,
  })), [childTasks]);
  // 正文里已经写入的引用编号，按出现顺序展示；合法性由服务端最终判定。
  const referencedIdentifiers = React.useMemo(() => parseTaskReferenceIds(draft.body), [draft.body]);
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
  const { token } = theme.useToken();
  const popupOwner = `task-comment-${taskId}`;
  const pending = React.useRef(false);
  const mounted = React.useRef(true);
  const input = React.useRef<TaskCommentEditorHandle>(null);
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
  // `#` 唤起任务引用选择器；与 `@` 互斥，同一时刻只开一个浮层。
  const reference = commentReferenceQuery(draft.body, caret);
  const referenceKey = reference ? `${reference.start}:${reference.query}` : "";
  const referenceMatches = reference && dismissed !== referenceKey
    ? referenceTasks.filter(task => task.identifier.toLocaleLowerCase().includes(reference.query.toLocaleLowerCase())
      || task.title.toLocaleLowerCase().includes(reference.query.toLocaleLowerCase()))
    : [];
  const referenceMenuOpen = reference != null && dismissed !== referenceKey;
  const [referenceHighlight, setReferenceHighlight] = React.useState(0);
  React.useEffect(() => { setHighlight(0); }, [mentionKey]);
  React.useEffect(() => { setReferenceHighlight(0); }, [referenceKey]);
  const closeMention = React.useCallback(() => { if (mentionKey) setDismissed(mentionKey); }, [mentionKey]);
  usePopupDismiss(menuOpen, closeMention);
  usePopupDismiss(referenceMenuOpen, closeMention);
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
    // @ 员工与 # 引用两个浮层共用同一个输入框锚点，任一浮层打开时都要量位置。
    if (!menuOpen && !referenceMenuOpen) return;
    if (!input.current) return;
    const update = (): void => setMentionRect(input.current?.getBoundingClientRect() ?? null);
    update(); window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [menuOpen, mentionKey, referenceMenuOpen, referenceKey]);
  const nativeInput = (): TaskCommentEditorHandle | null => input.current;
  /** 引用编号 → 子任务 ID；只在本任务的直接子任务里找。 */
  const openReferencedTask = (identifier: string): void => {
    const target = referenceTasks.find(task => task.identifier === identifier);
    if (target) onOpenTask?.(target.id);
  };
  const choose = (employee: MentionEmployee): void => {
    const node = nativeInput();
    const pos = node?.selectionStart ?? caret;
    const next = insertCommentMention(draft.body, pos, employee.name);
    edit({ body: next.body, employeeId: employee.id, agent: null });
    setCaret(next.caret);
    setDismissed("");
    requestAnimationFrame(() => focusCommentCaret(nativeInput(), next.caret));
  };
  const chooseReference = (task: ReferenceTask): void => {
    const node = nativeInput();
    const pos = node?.selectionStart ?? caret;
    const next = insertCommentReference(draft.body, pos, task.identifier);
    edit({ body: next.body });
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
    if (!replyRequest) return;
    const current = commentDraft(taskId);
    const body = `${current.body}${current.body ? "\n" : ""}${replyRequest.body}\n@`;
    edit({ body, employeeId: "", sourceCommentId: replyRequest.commentId, agent: null });
    setReplyLabel(replyRequest.commentId ? "当前阻塞的原执行记录" : ""); setCaret(body.length); setDismissed("");
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(body.length, body.length); });
  }, [replyRequest?.revision]);
  React.useEffect(() => {
    const controller = new AbortController();
    let generation = 0;
    const load = (): void => {
      const request = ++generation;
      void taskBoardRepository.comments(taskId, { limit: 50, signal: controller.signal }).then(async rawPage => {
        const page = Array.isArray(rawPage) ? { comments: rawPage, totalCount: rawPage.length, nextCursor: null } : rawPage;
        if (controller.signal.aborted || request !== generation) return;
        if (referenceTarget && !page.comments.some(comment => comment.id === referenceTarget)) {
          const located = await taskBoardRepository.commentSource(taskId, referenceTarget, { signal: controller.signal });
          if (located.comment) page.comments.push(located.comment);
        }
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
          const existingWithStatus = existing.map(comment => exactById.has(comment.id) ? { ...comment, dispatch: exactById.get(comment.id)?.dispatch ?? null, reviewWritebackPending: exactById.get(comment.id)?.reviewWritebackPending ?? comment.reviewWritebackPending } : comment);
          const refreshedPage = page.comments.filter(comment => comment.activityTaskId === taskId || comment.taskId === taskId || comment.dispatch?.executionTaskId === taskId || referenceTasks.some(child => child.id === comment.taskId)).map(comment => freshDispatches.has(comment.id) && exactById.has(comment.id)
            ? { ...comment, dispatch: exactById.get(comment.id)?.dispatch ?? comment.dispatch, reviewWritebackPending: exactById.get(comment.id)?.reviewWritebackPending ?? comment.reviewWritebackPending } : comment);
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
  }, [taskId, updatedAt, attempt, referenceTasks, referenceTarget]);
  const comments = result.taskId === taskId ? result.comments : [];
  React.useEffect(() => {
    const key = `${taskId}:${referenceTarget}`;
    if (!referenceTarget || locatedReference.current === key || !comments.some(comment => comment.id === referenceTarget)) return;
    const node = rowRefs.current.get(`comment-${referenceTarget}`); if (!node) return;
    locatedReference.current = key;
    setStreamExpanded(current => ({ ...current, [referenceTarget]: true }));
    const frame = requestAnimationFrame(() => { node.scrollIntoView({ block: "center" }); node.tabIndex = -1; node.focus({ preventScroll: true }); node.classList.add("task-reference-target"); });
    return () => cancelAnimationFrame(frame);
  }, [taskId, referenceTarget, comments]);
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
      identity = await commentRequestIdentity(taskId, submitted, submitted.employeeId ? dispatchPurpose : "execution");
      const response = await taskBoardRepository.postComment(taskId, { requestId: identity.requestId, body: submitted.body.trim(),
        employeeId: submitted.employeeId || null, ...(submitted.employeeId && submitted.agent ? { agent: submitted.agent } : {}), sourceCommentId: submitted.sourceCommentId, ...(submitted.employeeId ? { purpose: identity.purpose } : {}) });
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
  // 浮层高度按当前打开的选择器算：@ 员工与 # 引用两个列表的行数不同。
  const mentionHeight = Math.min(240, Math.max(38, (referenceMenuOpen ? referenceMatches.length : matches.length) * 34 + 8));
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
    <section className="task-board-comment-stream" role="region" aria-label="任务评论" aria-busy={loading} data-testid="task-comments-stream">
      <Flex align="center" justify="space-between" gap="small" className="task-stream-heading">
        <Typography.Title level={4} style={{ margin: 0 }}>评论 <Typography.Text type="secondary">{totalCount}</Typography.Text></Typography.Title>
        <WandButton kind="ghost" size="small" disabled={loading} onClick={retry}>刷新</WandButton>
      </Flex>
      <Flex vertical gap="small" className="task-board-detail-content">
      {failed ? <Alert type="warning" title="评论暂时加载失败" action={<WandButton kind="ghost" size="small" onClick={retry}>重试</WandButton>}/> : null}
      {!ordinaryComments.length && !failed ? <Typography.Text type="secondary" role="status">{loading ? "正在加载评论…" : "还没有评论。在正文里 @员工 并提交即可派发；不 @ 只是普通评论。"}</Typography.Text> : null}
      {ordinaryComments.map(comment => comment.dispatch ? <div key={comment.id} ref={node => { if (node) rowRefs.current.set(`comment-${comment.id}`, node); }}>
        {comment.dispatch?.executionTaskId && childTasks.find(child => child.id === comment.dispatch?.executionTaskId) ? <WandButton size="small" kind="ghost" onClick={() => onOpenTask?.(comment.dispatch!.executionTaskId!)}>{childTasks.find(child => child.id === comment.dispatch?.executionTaskId)!.identifier} · 查看子任务</WandButton> : null}
        <TaskExecutionCard comment={comment} result={resultPages[comment.id]?.taskId === taskId ? resultPages[comment.id] : undefined}
          onOpenSession={onOpenSession} onLoadResult={loadResult} onOpenTask={openReferencedTask}/>
        <WandButton size="small" kind="ghost" onClick={() => replyTo(comment.id, true)}>继续此子任务 / 处理阻塞</WandButton>
      </div> : <TaskCommentStreamRow ref={(node: HTMLDivElement | null) => { if (node) rowRefs.current.set(`comment-${comment.id}`, node); }} key={comment.id} comment={comment}
        sourceComment={comment.sourceCommentId ? commentById.get(comment.sourceCommentId) ?? sourceComments[comment.sourceCommentId]?.comment ?? undefined : undefined}
        expanded={streamExpanded[comment.id]} onExpanded={value => setStreamExpanded(current => ({ ...current, [comment.id]: value }))}
        onOpenTask={openReferencedTask} onReply={replyTo}/>)}
      {legacySessions.length > 0 && <details><summary>历史关联会话 · {legacySessions.length}</summary>{legacySessions.map(session => <TaskLegacySessionStreamRow key={session.id} session={session} onOpen={onOpenSession}/>)}</details>}
      {nextCursor && <WandButton kind="ghost" size="small" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "正在加载更早评论…" : "加载更早评论"}</WandButton>}
      {draft.sourceCommentId && <Flex align="center" gap="small" className="task-comment-reply-context"><Typography.Text type="secondary">回复「{replyLabel || draft.sourceCommentId.slice(0, 8)}」</Typography.Text><WandButton kind="ghost" size="small" onClick={() => { edit({ sourceCommentId: null }); setReplyLabel(""); }}>取消回复</WandButton></Flex>}
      {menuOpen && portal && mentionRect ? createPortal(<div id="task-comment-mention" role="listbox" aria-label="提及员工" className="task-comment-mention" data-wand-popup-owner={`task-comment-${taskId}`}
        style={{ position: "fixed", zIndex: token.zIndexPopupBase + 100, left: Math.max(8, Math.min(mentionRect.left, window.innerWidth - 280)), top: mentionTop, width: Math.min(280, window.innerWidth - 16), maxHeight: mentionHeight, pointerEvents: "auto" }}>
        {matches.length === 0 ? <button type="button" role="option" disabled>没有匹配的员工</button> : matches.map((employee, index) => <button
          key={employee.id} id={`task-comment-mention-option-${employee.id}`} type="button" role="option" title={`@${employee.name}`} aria-selected={index === highlight}
          onMouseEnter={() => setHighlight(index)}
          onMouseDown={event => event.preventDefault()}
          onClick={() => choose(employee)}
        >@{employee.name}</button>)}
      </div>, portal) : null}
      {referenceMenuOpen && portal && mentionRect ? createPortal(<div id="task-comment-reference" role="listbox" aria-label="引用任务" className="task-comment-mention" data-wand-popup-owner={`task-comment-${taskId}`}
        style={{ position: "fixed", zIndex: token.zIndexPopupBase + 100, left: Math.max(8, Math.min(mentionRect.left, window.innerWidth - 320)), top: mentionTop, width: Math.min(320, window.innerWidth - 16), maxHeight: mentionHeight, pointerEvents: "auto" }}>
        {referenceMatches.length === 0 ? <button type="button" role="option" disabled>没有匹配的任务</button> : referenceMatches.map((task, index) => <button
          key={task.id} id={`task-comment-reference-option-${task.id}`} type="button" role="option" className="task-comment-reference-option" title={`#${task.identifier}`} aria-selected={index === referenceHighlight}
          onMouseEnter={() => setReferenceHighlight(index)}
          onMouseDown={event => event.preventDefault()}
          onClick={() => chooseReference(task)}
        ><span className="task-comment-reference-id">#{task.identifier}</span><span className="task-comment-reference-title">{task.title}</span></button>)}
      </div>, portal) : null}
      <div className="wand-composer-surface task-comment-input-surface">
      <TaskCommentEditor popupOwner={popupOwner} ref={input} value={draft.body} employee={bound} agent={draft.agent} onAgent={agent => edit({ agent })} disabled={busy}
        aria-expanded={menuOpen || referenceMenuOpen} aria-controls={menuOpen ? "task-comment-mention" : referenceMenuOpen ? "task-comment-reference" : undefined}
        aria-activedescendant={menuOpen && matches[highlight] ? `task-comment-mention-option-${matches[highlight]!.id}`
          : referenceMenuOpen && referenceMatches[referenceHighlight] ? `task-comment-reference-option-${referenceMatches[referenceHighlight]!.id}` : undefined}

        onSelect={event => setCaret(event.currentTarget.selectionStart ?? draft.body.length)}
        onChange={event => {
          const value = event.currentTarget.value;
          const pos = event.currentTarget.selectionStart ?? value.length;
          const person = active.find(employee => employee.id === commentDraft(taskId).employeeId);
          edit({ body: value, employeeId: person && commentMentionHeld(value, person.name) ? person.id : "" });
          setCaret(pos);
        }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (referenceMenuOpen && (referenceMatches.length > 0 || event.key === "Escape")) {
            if (event.key === "ArrowDown" && referenceMatches.length > 0) { event.preventDefault(); setReferenceHighlight(index => (index + 1) % referenceMatches.length); return; }
            if (event.key === "ArrowUp" && referenceMatches.length > 0) { event.preventDefault(); setReferenceHighlight(index => (index - 1 + referenceMatches.length) % referenceMatches.length); return; }
            if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && referenceMatches[referenceHighlight]) { event.preventDefault(); chooseReference(referenceMatches[referenceHighlight]!); return; }
            if (event.key === "Escape") { event.preventDefault(); closeMention(); return; }
          }
          if (menuOpen && (matches.length > 0 || event.key === "Escape")) {
            if (event.key === "ArrowDown" && matches.length > 0) { event.preventDefault(); setHighlight(index => (index + 1) % matches.length); return; }
            if (event.key === "ArrowUp" && matches.length > 0) { event.preventDefault(); setHighlight(index => (index - 1 + matches.length) % matches.length); return; }
            if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && matches[highlight]) { event.preventDefault(); choose(matches[highlight]!); return; }
            if (event.key === "Escape") { event.preventDefault(); closeMention(); return; }
          }
          if (event.key === "Escape") { edit({ sourceCommentId: null }); setReplyLabel(""); }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
        }}/>
      <Flex gap="small" align="center" className="task-comment-toolbar">
        <Typography.Text type="secondary" className="task-comment-toolbar-hint">⌘ / Ctrl + Enter</Typography.Text>
        <WandButton ref={submitButton} kind="primary" size="small" style={{ width: 128, height: 32, flexShrink: 0 }} data-comment-submit-phase={submitPhase} aria-label={submitLabels[submitPhase]}
          disabled={busy || !draft.body.trim()} onClick={() => void submit()}>
          <span style={{ display: "grid" }} aria-live="polite">
            {Object.entries(submitLabels).map(([phase, label]) =>
              <span key={phase} aria-hidden={phase !== submitPhase} style={{ gridArea: "1 / 1", opacity: phase === submitPhase ? 1 : 0,
                transition: "opacity var(--motion-fast) var(--ease-in-out-smooth)" }}>{label}</span>)}
          </span>
        </WandButton>
      </Flex>
      </div>
      <Flex gap="small" align="center">
        <Typography.Text type="secondary" role="status">{message || (dispatching
          ? `将派发给 @${bound?.name}${referencedIdentifiers.length ? `，目标 ${referencedIdentifiers.map(id => `#${id}`).join("、")}` : ""}。只派发这一次选中的人。`
          : referencedIdentifiers.length ? `本轮引用 ${referencedIdentifiers.map(id => `#${id}`).join("、")}；正文里没有选中的 @员工时，不会启动执行。`
            : "正文里没有选中的 @员工时，不会启动执行。")}</Typography.Text>
      </Flex>
      </Flex>
    </section>
  </div>;
}
