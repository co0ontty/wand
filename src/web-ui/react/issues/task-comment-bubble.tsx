import * as React from "react";
import type { WandTaskComment } from "../../../task-types.js";
import { DeferredMarkdownPreview } from "../file-preview/deferred-markdown";
import { WandButton } from "../ui/button";
import { TaskPersonAvatar } from "./task-person-avatar";
import { TaskReferenceText } from "./task-stream-row";
import { issueAgentLabel, issueAgentEffortLabel } from "./task-board-agent";
import { statusLabel } from "../../../task-comment-status.js";
import { preserveDisclosurePosition } from "../chat/disclosure-position";

export const TaskCommentBubble = React.forwardRef<HTMLDivElement, {
  comment: WandTaskComment; sourceComment?: WandTaskComment; expanded?: boolean;
  onExpanded(value: boolean): void; onReply(id: string, dispatch?: boolean): void;
  onOpenSession?(id: string): void; onOpenTask?(identifier: string): void;
  onOpenOriginTask?(id: string): void; onViewResult?(): void; children?: React.ReactNode;
}>(function TaskCommentBubble({ comment, sourceComment, expanded, onExpanded, onReply, onOpenSession, onOpenTask, onOpenOriginTask, onViewResult, children }, ref) {
  const own = comment.authorKind === "user";
  const agent = comment.authorAgent ?? comment.dispatch?.agent;
  const dispatch = comment.dispatch;
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = React.useState(false);
  React.useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const measure = (): void => { if (!expanded) setOverflows(node.scrollHeight > node.clientHeight + 1); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [comment.body, expanded]);
  const sessionId = dispatch?.sessionId ?? comment.sourceSessionId;
  return <div ref={ref} className={`task-comment-bubble-row${own ? " is-own" : ""}`} data-stream-row={`comment-${comment.id}`} data-author-kind={comment.authorKind}>
    <div className="task-comment-bubble-avatar"><TaskPersonAvatar kind={own ? "user" : comment.authorKind === "employee" ? "employee" : undefined} id={comment.authorId ?? undefined} name={comment.authorName} avatar={comment.authorAvatar}/></div>
    <div className="task-comment-bubble-main">
      <div className="task-comment-bubble-meta"><strong>{comment.authorName}</strong>
        {agent && <span className="task-comment-bubble-config">{comment.dispatch ? "指派：" : ""}{issueAgentLabel(agent.provider, agent.engine)} · {agent.model} · 思考：{issueAgentEffortLabel(agent.thinkingEffort)}</span>}
        <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>
      </div>
      <div className="task-comment-bubble-surface">
        {sourceComment && <div className="task-comment-bubble-quote">回复 {sourceComment.authorName}：{sourceComment.body.slice(0, 100)}</div>}
        <div ref={bodyRef} className={`task-comment-bubble-body${expanded ? " is-expanded" : ""}`}>
          <DeferredMarkdownPreview content={comment.body} variant="inline" wrap renderText={value => <TaskReferenceText text={value} onOpenTask={onOpenTask}/>}/>
        </div>
        {(overflows || expanded) && <WandButton kind="ghost" size="small" aria-expanded={Boolean(expanded)} onClick={event => preserveDisclosurePosition(event.currentTarget, () => onExpanded(!expanded))}>{expanded ? "收起全文" : "展开全文"}</WandButton>}
        {dispatch && <div className="task-comment-bubble-receipt">已指派给 {dispatch.employeeName} · {dispatch.status === "done" ? "本轮已结束" : statusLabel(dispatch.status ?? dispatch.state)}{dispatch.deliveryStatus ? ` · ${dispatch.deliveryStatus === "submitted" ? "交付已提交" : "尚未提交交付"}` : ""}{dispatch.error ? ` · ${dispatch.error}` : ""}</div>}
        {comment.reviewWritebackPending && <div role="status">验收结论待回填</div>}
      </div>
      {/* 动作与来源同一行：回复/派发/查看执行在左，来源说明收在右侧，展开时另起整行。 */}
      <div className="task-comment-bubble-footer">
        <div className="task-comment-bubble-actions">
          <WandButton kind="ghost" size="small" onClick={() => onReply(comment.id)}>回复</WandButton>
          <WandButton kind="ghost" size="small" onClick={() => onReply(comment.id, true)}>回复并派发</WandButton>
          {sessionId && <WandButton kind="ghost" size="small" onClick={() => onOpenSession?.(sessionId)}>查看执行</WandButton>}
          {dispatch?.resultAnchor && <WandButton kind="ghost" size="small" onClick={onViewResult}>查看本轮结果</WandButton>}
        </div>
        {comment.origin && <details className="task-comment-source-details"><summary>
          {comment.origin.taskIdentifier}{dispatch ? ` → ${dispatch.employeeName} · 任务派发` : ` · ${({ manual: "人工评论", task_dispatch: "任务派发", workflow: "自动回填", system: "系统记录", unknown: "来源未记录" })[comment.origin.kind]}`}
        </summary><div className="task-comment-bubble-origin">
          <span>{({ manual: "任务面板提交", task_dispatch: "任务派发记录", workflow: "工作流自动回填", system: "系统自动记录", unknown: "历史来源未记录" })[comment.origin.kind]}</span>
          <span> · {comment.origin.triggerName ? `触发者：${comment.origin.triggerName}` : "触发者未记录"}</span>
          <WandButton kind="ghost" size="small" onClick={() => onOpenOriginTask?.(comment.origin!.taskId)}>来源 {comment.origin.taskIdentifier}</WandButton>
          {comment.origin.entrySessionId ? <WandButton kind="ghost" size="small" onClick={() => onOpenSession?.(comment.origin!.entrySessionId!)}>入口会话</WandButton> : <span> · 入口会话未记录</span>}
        </div></details>}
      </div>
      {children}
    </div>
  </div>;
});
