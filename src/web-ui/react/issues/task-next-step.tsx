import * as React from "react";
import { Typography } from "antd";
import { taskAiVerified, taskCompleted, taskHumanAccepted, taskWorkflowStage, type WandTaskComment } from "../../../task-types";
import { taskBoardRepository, type IssueSessionSummary, type WandTaskListed } from "./task-board-repository";
import { taskAcceptanceLabel, taskSessionActivity } from "./task-delivery-state";
import { TaskExpandableText } from "./task-expandable-text";
import { WandButton } from "../ui/button";

type Tone = "warning" | "success" | "info" | "active" | "neutral";

/** 活跃程度从高到低：需要人处理的会话排在最前，空闲/结束的不算「当前」。 */
const ACTIVE_ORDER = ["等待授权", "等待输入", "运行中", "排队中"];

function activeSessions(sessions: readonly IssueSessionSummary[]): Array<{ session: IssueSessionSummary; activity: string }> {
  return sessions.flatMap(session => {
    const activity = taskSessionActivity(session);
    return ACTIVE_ORDER.includes(activity) ? [{ session, activity }] : [];
  }).sort((a, b) => ACTIVE_ORDER.indexOf(a.activity) - ACTIVE_ORDER.indexOf(b.activity));
}

/** 只有存在阻塞时才需要定位「原执行评论」，没有阻塞就不发评论请求。 */
function useBlockerSources(taskId: string, updatedAt: string, enabled: boolean): WandTaskComment[] {
  const [latest, setLatest] = React.useState<{ taskId: string; comments: WandTaskComment[] } | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void taskBoardRepository.comments(taskId, { limit: 50, signal: controller.signal }).then(page => {
      if (!controller.signal.aborted) setLatest({ taskId, comments: page.comments });
    }).catch(() => undefined);
    return () => controller.abort();
  }, [taskId, updatedAt, enabled]);
  return latest?.taskId === taskId ? latest.comments : [];
}

/**
 * 详情首屏唯一的「现在该做什么」：按任务真实阶段给出一句结论、一段依据和本阶段的动作。
 * 阶段只读 status / acceptance / verification / 会话事实，不从模型正文推断。
 * 「确认并归档」由顶部栏持有（吸顶可达），这里不再重复同一个主按钮。
 */
export function TaskNextStep({ task, children, reviewerName, onHandleBlocker, onMention, onOpenSession, onEditDelivery, onReturn }: {
  task: WandTaskListed;
  children: WandTaskListed[];
  reviewerName?: string;
  onHandleBlocker(commentId: string | null, instruction: string): void;
  onMention(): void;
  onOpenSession?: (sessionId: string) => void;
  onEditDelivery(): void;
  onReturn(): void;
}): React.ReactElement | null {
  const stage = taskWorkflowStage(task.status);
  const gaps = [task, ...children].flatMap(item => {
    const blocker = item.acceptance?.blocker?.trim() || item.verification?.blocker?.trim();
    return blocker ? [{ task: item, blocker }] : [];
  });
  const comments = useBlockerSources(task.id, task.updatedAt, gaps.length > 0 && stage !== "archived");
  const evidence = (task.acceptance?.evidence || task.verification?.evidence || "").trim();
  const active = activeSessions(task.sessions);
  const archived = stage === "archived";

  let tone: Tone = "neutral";
  let title = "";
  let note = "";
  let body: React.ReactNode = null;
  const actions: React.ReactNode[] = [];
  const openButton = (session: IssueSessionSummary, primary: boolean) => onOpenSession
    ? <WandButton key={`open-${session.id}`} kind={primary ? "primary" : "secondary"} size="small" onClick={() => onOpenSession(session.id)}>打开会话</WandButton>
    : null;

  if (archived) {
    tone = taskCompleted(task) ? "success" : "neutral";
    title = taskHumanAccepted(task) ? "已归档 · 人工已确认" : taskCompleted(task) ? "独立验收通过 · 已自动完成" : "已归档";
    note = taskCompleted(task) ? "" : "历史归档不代表本轮验收通过。";
  } else if (gaps.length) {
    tone = "warning";
    title = gaps.length === 1 ? (gaps[0].task.id === task.id ? "有一项阻塞待处理" : `子任务 ${gaps[0].task.identifier} 有阻塞`) : `${gaps.length} 项任务有阻塞`;
    const external = gaps.some(gap => gap.task.acceptance?.blockerKind === "external");
    if (!external) { title = "执行中 · 正在补齐验收缺口"; note = "自动执行开启时由负责人继续修复、自测和复验，无需重复指派。"; }
    body = gaps.map(gap => {
      const source = [...comments].reverse().find(comment => comment.dispatch?.executionTaskId === gap.task.id || comment.taskId === gap.task.id && comment.dispatch);
      return <div key={gap.task.id} className="task-next-step-gap">
        {gap.task.id !== task.id && <Typography.Text strong>{gap.task.identifier} · {gap.task.title}</Typography.Text>}
        <TaskExpandableText plain lines={3}>{gap.blocker}</TaskExpandableText>
        <div className="task-next-step-actions">
          <WandButton kind="primary" size="small" onClick={() => onHandleBlocker(source?.id ?? null,
            `请处理 ${gap.task.identifier} 当前阻塞：${gap.blocker}\n请先读取最新上下文，保留已有交付，回填实际证据及未解除条件。`)}>补充处理指令</WandButton>
        </div>
      </div>;
    });
    if (active[0]) actions.push(openButton(active[0].session, false));
    actions.push(<WandButton key="edit" kind="ghost" size="small" onClick={onEditDelivery}>编辑交付记录</WandButton>);
  } else if (task.status === "ready") {
    tone = "success";
    title = taskAiVerified(task) ? "AI 已通过，等待你确认" : taskAcceptanceLabel(task.acceptance, task);
    note = taskAiVerified(task) ? `${reviewerName ? `${reviewerName} 已验收通过。` : ""}核对证据后点右上角「确认并归档」。` : "当前交付没有可信的 AI 通过记录，请核对后再决定。";
    actions.push(<WandButton key="return" kind="ghost" size="small" onClick={onReturn}>不认可，退回执行</WandButton>);
    actions.push(<WandButton key="edit" kind="ghost" size="small" onClick={onEditDelivery}>编辑交付记录</WandButton>);
  } else if (stage === "review") {
    tone = "info";
    title = "交付已提交 · 等待 AI 验收";
    note = reviewerName ? `验收员工：${reviewerName}` : "自动执行开启时将按配置派发独立验收，无需再次指派。";
    if (active[0]) actions.push(openButton(active[0].session, true));
    else actions.push(<WandButton key="mention" kind="secondary" size="small" onClick={onMention}>@员工 验收</WandButton>);
    actions.push(<WandButton key="edit" kind="ghost" size="small" onClick={onEditDelivery}>编辑交付记录</WandButton>);
  } else if (stage === "doing") {
    tone = "active";
    if (active.length) {
      title = active[0].activity === "运行中" ? "正在执行" : `执行${active[0].activity}`;
      body = <ul className="task-next-step-sessions">
        {active.slice(0, 3).map(({ session, activity }) => <li key={session.id}>
          <span className="task-next-step-session-state" data-activity={activity}>{activity}</span>
          <span className="task-next-step-session-title" title={session.title || session.id}>{session.employeeName ? `${session.employeeName} · ` : ""}{session.title || session.id}</span>
        </li>)}
      </ul>;
      actions.push(openButton(active[0].session, true));
    } else {
      title = "执行中 · 等待自动接续";
      note = "任务仍由负责人负责。自动执行开启时会继续实现、自测和返工；暂停或等待条件时保留当前进度。";
      actions.push(<WandButton key="mention" kind="primary" size="small" onClick={onMention}>补充指令</WandButton>);
      const recent = task.sessions[task.sessions.length - 1];
      if (recent) actions.push(openButton(recent, false));
    }
    actions.push(<WandButton key="edit" kind="ghost" size="small" onClick={onEditDelivery}>{evidence ? "提交 AI 验收…" : "编辑交付记录"}</WandButton>);
  } else {
    tone = "neutral";
    title = task.status === "backlog" ? "待立项 · 还没有指派" : "等待指派";
    note = "移入执行中即可自动处理到验收通过，也可在评论中明确指派员工。";
    actions.push(<WandButton key="mention" kind="primary" size="small" onClick={onMention}>@员工 派发</WandButton>);
  }

  const showEvidence = evidence && !gaps.length && !archived && stage !== "todo" && stage !== "backlog";
  return <section className="task-next-step" data-tone={tone} aria-label="当前进展与下一步">
    <div className="task-next-step-heading">
      <Typography.Text strong className="task-next-step-title">{title}</Typography.Text>
      {!!task.deliveryRevision && <span className="task-next-step-version">交付 v{task.deliveryRevision}</span>}
    </div>
    {note && <Typography.Text type="secondary" className="task-next-step-note">{note}</Typography.Text>}
    {body}
    {showEvidence && <TaskExpandableText plain lines={4} className="task-next-step-evidence">{evidence}</TaskExpandableText>}
    {actions.filter(Boolean).length > 0 && <div className="task-next-step-actions">{actions}</div>}
  </section>;
}

const WORKFLOW_STEPS = ["待办", "实现与自测", "独立验收", "完成归档"] as const;

/** 一行看全链路：阶段取任务真实 status，不凭证据推断；只占一行，不再用带说明的大步骤条。 */
export function TaskWorkflowProgress({ task }: { task: WandTaskListed }): React.ReactElement {
  const current = ({ backlog: 0, todo: 0, doing: 1, review: 2, ready: 2, archived: 3 } as const)[taskWorkflowStage(task.status)];
  return <ol className="task-workflow-progress" aria-label={`工作流进度：第 ${current + 1} 步，共 ${WORKFLOW_STEPS.length} 步`}>
    {WORKFLOW_STEPS.map((label, index) => <li key={label} data-state={index < current ? "done" : index === current ? "current" : "todo"}
      aria-current={index === current ? "step" : undefined}>{label}</li>)}
  </ol>;
}
