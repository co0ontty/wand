import * as React from "react";
import { Typography } from "antd";
import { taskWorkflowStage } from "../../../task-types";
import type { IssueSessionSummary, WandTaskListed } from "./task-board-repository";
import { resolveTaskDelivery, taskSessionActivity } from "./task-delivery-state";
import { TaskExpandableText } from "./task-expandable-text";
import { WandButton } from "../ui/button";

const ACTIVE_ORDER = ["等待授权", "等待输入", "运行中", "排队中"];
function activeSessions(sessions: readonly IssueSessionSummary[]): Array<{ session: IssueSessionSummary; activity: string }> {
  return sessions.flatMap(session => {
    const activity = taskSessionActivity(session);
    return ACTIVE_ORDER.includes(activity) ? [{ session, activity }] : [];
  }).sort((a, b) => ACTIVE_ORDER.indexOf(a.activity) - ACTIVE_ORDER.indexOf(b.activity));
}

/** Delivery facts share one resolver; activity and existing action handlers remain separate. */
export function TaskNextStep({ task, children, displayTasks = children, onHandleBlocker, onMention, onOpenSession, onEditDelivery, onReturn }: {
  task: WandTaskListed;
  children: WandTaskListed[];
  displayTasks?: readonly WandTaskListed[];
  reviewerName?: string;
  onHandleBlocker(commentId: string | null, instruction: string): void;
  onMention(): void;
  onOpenSession?: (sessionId: string) => void;
  onEditDelivery(): void;
  onReturn(): void;
}): React.ReactElement | null {
  const stage = taskWorkflowStage(task.status);
  const delivery = resolveTaskDelivery(task, displayTasks);
  const gaps = [...(delivery.blocker ? [{ task, blocker: delivery.blocker, external: delivery.external }] : []), ...delivery.gaps];
  const evidence = (task.acceptance?.evidence || "").trim();
  const active = activeSessions(task.sessions);
  let body: React.ReactNode = null;
  const actions: React.ReactNode[] = [];
  const openButton = (session: IssueSessionSummary, primary: boolean) => onOpenSession
    ? <WandButton key={`open-${session.id}`} kind={primary ? "primary" : "secondary"} size="small" onClick={() => onOpenSession(session.id)}>打开会话</WandButton>
    : null;

  if (gaps.length) {
    body = gaps.map(gap => <div key={gap.task.id} className="task-next-step-gap">
      {gap.task.id !== task.id && <Typography.Text strong>{gap.task.identifier} · {gap.task.title}</Typography.Text>}
      <Typography.Text type="secondary">{gap.external ? "外部阻塞" : "待补齐缺口"}</Typography.Text>
      <TaskExpandableText plain lines={3}>{gap.blocker}</TaskExpandableText>
      {stage !== "archived" && <div className="task-next-step-actions">
        <WandButton kind="primary" size="small" onClick={() => onHandleBlocker(null,
          `请处理 ${gap.task.identifier} 当前阻塞：${gap.blocker}\n请先读取最新上下文，保留已有交付，回填实际证据及未解除条件。`)}>补充处理指令</WandButton>
      </div>}
    </div>);
    if (stage !== "archived") {
      if (active[0]) actions.push(openButton(active[0].session, false));
      actions.push(<WandButton key="edit" kind="ghost" size="small" onClick={onEditDelivery}>编辑交付记录</WandButton>);
    }
  } else if (stage === "archived") {
    // Archived history is visible even without a current proof; no new action is granted.
  } else if (task.status === "ready") {
    actions.push(<WandButton key="return" kind="ghost" size="small" onClick={onReturn}>不认可，退回执行</WandButton>);
    actions.push(<WandButton key="edit" kind="ghost" size="small" onClick={onEditDelivery}>编辑交付记录</WandButton>);
  } else if (stage === "review") {
    if (active[0]) actions.push(openButton(active[0].session, true));
    else actions.push(<WandButton key="mention" kind="secondary" size="small" onClick={onMention}>@员工 验收</WandButton>);
    actions.push(<WandButton key="edit" kind="ghost" size="small" onClick={onEditDelivery}>编辑交付记录</WandButton>);
  } else if (stage === "doing") {
    if (active.length) {
      body = <ul className="task-next-step-sessions">{active.slice(0, 3).map(({ session, activity }) => <li key={session.id}>
        <span className="task-next-step-session-state" data-activity={activity}>{activity}</span>
        <span className="task-next-step-session-title" title={session.title || session.id}>{session.employeeName ? `${session.employeeName} · ` : ""}{session.title || session.id}</span>
      </li>)}</ul>;
      actions.push(openButton(active[0].session, true));
    } else {
      actions.push(<WandButton key="mention" kind="primary" size="small" onClick={onMention}>补充指令</WandButton>);
      const recent = task.sessions[task.sessions.length - 1];
      if (recent) actions.push(openButton(recent, false));
    }
    actions.push(<WandButton key="edit" kind="ghost" size="small" onClick={onEditDelivery}>{evidence ? "提交 AI 验收…" : "编辑交付记录"}</WandButton>);
  } else {
    actions.push(<WandButton key="mention" kind="primary" size="small" onClick={onMention}>@员工 派发</WandButton>);
  }
  return <section className="task-next-step" data-tone={delivery.tone === "secondary" ? "neutral" : delivery.tone} aria-label="当前进展与下一步">
    <div className="task-next-step-heading">
      <Typography.Text strong className="task-next-step-title">{delivery.label}</Typography.Text>
      {Number.isInteger(task.deliveryRevision) && task.deliveryRevision! >= 0 && <span className="task-next-step-version">交付 v{task.deliveryRevision}</span>}
    </div>
    <Typography.Text type="secondary" className="task-next-step-note">{delivery.next}</Typography.Text>
    {body}
    <Typography.Text type="secondary">{delivery.source}</Typography.Text>
    {delivery.records.map((record, index) => <div key={index}><Typography.Text type="secondary">{record.label}</Typography.Text><TaskExpandableText plain lines={4} className="task-next-step-evidence">{record.evidence}</TaskExpandableText></div>)}
    {actions.filter(Boolean).length > 0 && <div className="task-next-step-actions">{actions}</div>}
  </section>;
}

const WORKFLOW_STEPS = ["待办", "实现与自测", "独立验收", "完成归档"] as const;
export function TaskWorkflowProgress({ task, displayTasks = [] }: { task: WandTaskListed; displayTasks?: readonly WandTaskListed[] }): React.ReactElement {
  const delivery = resolveTaskDelivery(task, displayTasks);
  const current = ({ backlog: 0, todo: 0, doing: 1, review: 2, ready: 2, archived: 3 } as const)[taskWorkflowStage(task.status)];
  return <ol className="task-workflow-progress" aria-label={`工作流阶段：${task.status}；${delivery.label}`}>
    {WORKFLOW_STEPS.map((label, index) => <li key={label} data-state={index < current && delivery.completed ? "done" : index === current ? "current" : "todo"}
      aria-current={index === current ? "step" : undefined}>{index === 3 && !delivery.completed ? "归档（不代表通过）" : label}</li>)}
  </ol>;
}
