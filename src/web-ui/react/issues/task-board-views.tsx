import { TaskPersonAvatar } from "./task-person-avatar";
import { TaskSummaryRow } from "./task-inline-summary.js";
import { taskExecutors } from "./task-executors";
import { TaskBoardAgentChips } from "./task-executor-chips";
export { TaskBoardAgentChips } from "./task-executor-chips";
import { useSiliconEmployees } from "../agents/employee-repository";
import { taskHasOpenDescendant } from "../../../task-hierarchy";
import { TaskGoalChildren } from "./task-goal-children";
import { canArchiveBoardTask } from "./task-board-repository";
import { WandButton } from "../ui";
import { Alert, Avatar, Badge, Checkbox, Card, Collapse, Descriptions, Empty, Flex, List, Tag, Progress, Dropdown, Typography } from "antd";
import * as React from "react";
import { resolveTaskDelivery, taskSessionActivity, taskSessionIsRunning, taskSessionSummary } from "./task-delivery-state";
import { taskWorkflowStage, type TaskExecutionSubject, type WandTaskAgent, type WandTaskPriority, type WandTaskStatus } from "../../../task-types";
import { DEFAULT_ITERATION_NAME } from "../../../task-types";
import { ProviderLogo } from "../provider-logo";
import { WandIcon, WandIconButton, WandPopover, WandStretchTabs, WandSwitch } from "../ui";
import { isWandPopupOwnedBy, usePopupDismiss } from "../ui/popup-lifecycle";
import { classNames } from "../ui/class-names";
import {
  addIsoDays,
  collectIssueLabels,
  EMPTY_ISSUE_FILTERS,
  formatIssueStamp,
  groupIssueSessionsByAgent,
  ISSUE_ARCHIVE_COLUMN,
  ISSUE_COLUMNS,
  ISSUE_GANTT_ZOOMS,
  ISSUE_PRIORITIES,
  ISSUE_STATUS_FILTERS,
  issueAgentEffortLabel,
  issueAgentLabel,
  issueAgentModeLabel,
  issueAgentProviderModelLine,
  type IssueModelCatalog,
  issueBoardStats,
  issueProgressSeries,
  issueDueStamp,
  issueFilterCount,
  issueGanttRange,
  issueGanttSpan,
  issueTaskAge,
  isoDate,
  issueHideStatusFilterLabel,
  issueIsOverdue,
  issueLabelColor,
  issueLabelName,
  issueLabelTone,
  issuePriorityLabel,
  issueStatusLabel,
  issueTaskStatusLabel,
  listIssueAgents,
  type IssueBoardDisplay,
  type IssueBoardFilters,
  type IssueGanttZoom,
} from "./task-board-agent";
import {
  TaskBoardConversationIcon,
  TaskBoardDueIcon,
  TaskBoardFilterIcon,
  TaskBoardFolderIcon,
  TaskBoardPriorityIcon,
  TaskBoardProcessingGlyph,
  TaskBoardStatusIcon,
} from "./task-board-icons";
import type { IssueSessionSummary, WandTaskListed } from "./task-board-repository";
import { wandModelDisplayName } from "../model-catalog";
import { useWandModelCatalog } from "../use-model-catalog";

export function TaskBoardStatusGlyph({ status }: { status: WandTaskStatus }): React.ReactElement {
  return <span className={`task-board-status-glyph is-${status}`} aria-hidden="true">
    <TaskBoardStatusIcon status={status} size={14}/>
  </span>;
}

export function TaskBoardPriorityChip({
  priority,
  interactive,
}: {
  priority: WandTaskPriority;
  interactive?: boolean;
}): React.ReactElement | null {
  if (priority === "none" && !interactive) return null;
  return <Tag className={`task-board-priority is-${priority}`}>
    <TaskBoardPriorityIcon priority={priority} size={14}/>
    {issuePriorityLabel(priority)}
  </Tag>;
}

/** 截止日期胶囊：卡片、列表、详情共用；逾期变红。 */
export function TaskBoardDueChip({ date, status }: { date: string; status: WandTaskStatus }): React.ReactElement {
  const overdue = issueIsOverdue(date, status);
  return <Tag className={classNames("task-board-chip task-board-due", overdue && "is-overdue")} title={overdue ? `已逾期 · 截止 ${date}` : `截止 ${date}`}>
    <TaskBoardDueIcon size={12}/>{issueDueStamp(date)}
  </Tag>;
}

export function TaskBoardLabelChip({ label }: { label: string }): React.ReactElement {
  const tone = issueLabelTone(label);
  // 颜色只作为色相输入，底色/文字由 CSS 按当前主题与表面色混合，深浅主题都保持可读。
  return <Tag className={classNames("task-board-label", tone && `is-${tone}`)}
    style={{ "--task-label-color": issueLabelColor(label) } as React.CSSProperties}>{issueLabelName(label)}</Tag>;
}

export function TaskBoardConversationButton({ sessions, onOpen }: {
  sessions: IssueSessionSummary[];
  onOpen?: (sessionId: string) => void;
}): React.ReactElement | null {
  const catalog = useWandModelCatalog();
  if (sessions.length === 0) return null;
  if (sessions.length === 1) return <WandButton kind="ghost" type="button" className="task-board-conversation"
    title={sessions[0]!.title || sessions[0]!.id} aria-label="打开关联会话"
    onClick={event => { event.preventDefault(); event.stopPropagation(); onOpen?.(sessions[0]!.id); }}>
    <TaskBoardConversationIcon size={16}/>
  </WandButton>;
  return <WandPopover align="end" side="bottom" sideOffset={6} ariaLabel="关联会话" className="task-board-conversation-menu"
    trigger={<WandButton kind="ghost" type="button" className="task-board-conversation is-multiple" aria-label={`查看 ${sessions.length} 个会话`} onClick={event => event.stopPropagation()}>
      <TaskBoardConversationIcon size={16}/><span>+{sessions.length}</span>
    </WandButton>}>
    <div className="task-board-conversation-menu-heading">关联会话</div>
    {sessions.map(session => <WandButton kind="ghost" key={session.id} type="button" role="menuitem" onClick={() => onOpen?.(session.id)}>
      <ProviderLogo provider={session.provider} className="task-board-agent-logo"/>
      <span><strong>{session.employeeName ? `${session.employeeName} · ` : ""}{session.title || issueAgentLabel(session.provider, session.engine)}</strong>
        <small>{issueAgentProviderModelLine(session, catalog)}</small></span>
    </WandButton>)}
  </WandPopover>;
}

export function TaskBoardCommentCountButton({ task, onOpen }: { task: WandTaskListed; onOpen(): void }): React.ReactElement {
  return <WandButton kind="ghost" type="button" className="task-board-comment-count" aria-label={`查看评论（${task.commentCount ?? 0}）`}
    onClick={event => { event.preventDefault(); event.stopPropagation(); onOpen(); }}>评论 {task.commentCount ?? 0}</WandButton>;
}

export function TaskBoardProcessingRow({
  task,
  onOpenSession,
}: {
  task: WandTaskListed;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement | null {
  if (task.status !== "doing") return null;
  const running = task.sessions.some(taskSessionIsRunning);
  const queued = (task.queuedCommentCount ?? 0) + task.sessions.reduce((count, session) =>
    count + (taskSessionActivity(session) === "排队中" ? Math.max(1, session.queuedMessageCount ?? 0) : 0), 0);
  return <Flex align="center" gap="small" className={classNames("task-board-processing", running && "is-running")}>
    {running ? <TaskBoardProcessingGlyph/> : null}
    <span className="task-board-processing-label">{running ? "正在处理..." : queued > 0
      ? queued === 1 ? "排队中 · 等待执行" : `排队中 · ${queued} 条等待执行`
      : resolveTaskDelivery(task).blocker ? `待处理：${resolveTaskDelivery(task).blocker}`
      : task.sessions.length > 0 ? taskSessionSummary(task.sessions) + " · 尚待验收" : "等待派发"}</span>
    <span style={{ flex: 1 }} aria-hidden="true"/>
    {onOpenSession && <TaskBoardConversationButton sessions={task.sessions} onOpen={onOpenSession}/>}
  </Flex>;
}

export function TaskBoardProgressRow({ task }: { task: WandTaskListed }): React.ReactElement | null {
  if (task.status !== "doing" || task.sessions.length === 0) return null;
  return <Typography.Text type="secondary" className="task-board-progress-row">
    {`${task.sessions.length} 个关联会话 · ${taskSessionSummary(task.sessions)}`}
  </Typography.Text>;
}

export function TaskBoardFilterMenu({
  tasks,
  filters,
  onChange,
}: {
  tasks: WandTaskListed[];
  filters: IssueBoardFilters;
  onChange(next: IssueBoardFilters): void;
}): React.ReactElement {
  const labels = collectIssueLabels(tasks);
  const count = issueFilterCount(filters);
  const toggleValue = <T,>(value: T, current: T[]): T[] => (
    current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]
  );
  return <WandPopover
    align="end"
    side="bottom"
    ariaLabel="筛选任务"
    className="task-board-filter-menu"
    trigger={<WandIconButton
      className={classNames("task-board-icon-button", count > 0 && "is-active")}
      aria-label={count > 0 ? `筛选（${count}）` : "筛选"}
      title="筛选"
    >
      <TaskBoardFilterIcon/>
      {count > 0 ? <span className="task-board-filter-badge">{count}</span> : null}
    </WandIconButton>}
  >
    <strong>筛选</strong>
    <div role="group" aria-labelledby="task-filter-status">
      <p id="task-filter-status">状态</p>
      {ISSUE_STATUS_FILTERS.map((column) => <Checkbox key={column.status} checked={filters.statuses.includes(column.status)} onChange={() => onChange({ ...filters, statuses: toggleValue(column.status, filters.statuses) })}>
        <TaskBoardStatusIcon status={column.status} size={14}/>
        {column.label}
      </Checkbox>)}
    </div>
    <div role="group" aria-labelledby="task-filter-priority">
      <p id="task-filter-priority">优先级</p>
      {ISSUE_PRIORITIES.map((entry) => <Checkbox key={entry.value} checked={filters.priorities.includes(entry.value)} onChange={() => onChange({ ...filters, priorities: toggleValue(entry.value, filters.priorities) })}>
        <TaskBoardPriorityIcon priority={entry.value} size={14}/>
        {entry.label}
      </Checkbox>)}
    </div>
    {labels.length > 0 && <div role="group" aria-labelledby="task-filter-labels">
      <p id="task-filter-labels">标签</p>
      {labels.map((label) => <Checkbox key={label} checked={filters.labels.includes(label)} onChange={() => onChange({ ...filters, labels: toggleValue(label, filters.labels) })}>
        <TaskBoardLabelChip label={label}/>
      </Checkbox>)}
    </div>}
    {count > 0 && <WandButton kind="ghost" type="button" className="task-board-filter-clear" onClick={() => onChange(EMPTY_ISSUE_FILTERS)}>
      清除筛选
    </WandButton>}
  </WandPopover>;
}

export function TaskBoardDisplayOptions({
  display,
  onChange,
}: {
  display: IssueBoardDisplay;
  onChange(next: IssueBoardDisplay): void;
}): React.ReactElement {
  return <Flex vertical gap="small" className="task-board-display-menu" aria-label="显示设置">
    <strong>显示设置</strong>
    <WandSwitch
      checked={display.body}
      onCheckedChange={(body) => onChange({ ...display, body })}
      ariaLabel="显示正文"
      label="正文"
    />
  </Flex>;
}

export function TaskBoardArchiveFolder({
  count,
  open,
  onToggle,
  onPurge,
  purging = false,
  children,
}: {
  count: number;
  open: boolean;
  onToggle(): void;
  /** 「清空归档」入口；省略时目录只展示，不提供批量删除。 */
  onPurge?(): void;
  purging?: boolean;
  children: React.ReactNode;
}): React.ReactElement | null {
  if (count === 0) return null;
  return <div className="task-board-archive-folder">
    <div className="task-board-archive-heading" style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <WandButton kind="ghost"
        type="button"
        className="task-board-archive-header"
        style={{ flex: 1, minWidth: 0, justifyContent: "flex-start" }}
        aria-expanded={open}
        onClick={onToggle}
      >
        <WandIcon name={open ? "chevron" : "chevronLeft"} size={12}/>
        <TaskBoardFolderIcon size={13}/>
        <strong>{ISSUE_ARCHIVE_COLUMN.label}</strong>
        <span>{count}</span>
      </WandButton>
      {onPurge ? <WandButton kind="ghost" size="small" type="button" className="task-board-archive-purge"
        disabled={purging}
        title="永久删除归档目录里的全部任务，无法恢复"
        onClick={onPurge}
      >{purging ? "清理中…" : "清空归档"}</WandButton> : null}
    </div>
    {open ? children : null}
  </div>;
}

/** Keep assigned-session vocabulary aligned with sidebar state. */
function sessionStatusLabel(session: IssueSessionSummary): string {
  return taskSessionActivity(session);
}

function TaskBoardListRow({
  task,
  parentLabel,
  workspaceLabel,
  allTasks,
  onOpen,
  onOpenSession,
  onOpenComments,
}: {
  task: WandTaskListed;
  parentLabel?: string;
  workspaceLabel: string;
  allTasks: WandTaskListed[];
  onOpen(id: string): void;
  onOpenSession?: (sessionId: string) => void;
  onOpenComments?(id: string): void;
}): React.ReactElement {
  const description = task.description;
  const delivery = resolveTaskDelivery(task, allTasks);
  // 整行都是进入详情的入口；行内的按钮/链接各自处理自己的点击。
  return <Card
    hoverable
    className={classNames("task-board-list-row", task.status === "archived" && "is-archived")}
    onClick={(event) => {
      if ((event.target as HTMLElement).closest("button, a")) return;
      onOpen(task.id);
    }}
  >
    <div className="task-board-list-content">
      <WandButton kind="ghost"
        type="button"
        className="task-board-list-title"
        aria-label={`打开 ${task.identifier}: ${task.title}`}
        onClick={() => onOpen(task.id)}
      >
        <small>{task.identifier}{parentLabel ? ` ↳ ${parentLabel}` : ""}</small>
        <strong>{task.title}</strong>
      </WandButton>
      <Typography.Text type={delivery.tone}>{delivery.label}</Typography.Text>
      {delivery.detail && <Typography.Paragraph type="warning">{delivery.detail}</Typography.Paragraph>}
      <Typography.Paragraph type="secondary">下一步：{delivery.next} · {delivery.source}</Typography.Paragraph>
      {description ? <p className="task-board-list-description">任务描述 / 历史记录：{description}</p> : null}
    </div>
    <Flex wrap align="center" gap={4} className="task-board-list-meta">
      {/* 列表已按阶段分组，只有「排队中」这类组名表达不了的状态才单独标出。 */}
      {issueTaskStatusLabel(task) !== issueStatusLabel(task.status) && <Tag className="task-board-chip task-detail-stage" data-stage={taskWorkflowStage(task.status)}>{issueTaskStatusLabel(task)}</Tag>}
      <TaskBoardPriorityChip priority={task.priority}/>
      {task.milestone && task.milestone.name !== DEFAULT_ITERATION_NAME ? <TaskBoardMilestoneChip name={task.milestone.name}/> : null}
      {task.labels.slice(0, 2).map((label) => <TaskBoardLabelChip key={label} label={label}/>)}
      {task.dueDate ? <TaskBoardDueChip date={task.dueDate} status={task.status}/> : null}
      <span>{workspaceLabel}</span>
      <TaskBoardConversationButton sessions={task.sessions} onOpen={onOpenSession}/>
      {(task.commentCount ?? 0) > 0 && <TaskBoardCommentCountButton task={task} onOpen={() => onOpenComments?.(task.id)}/>}
      <time dateTime={task.updatedAt} title={`任务更新时间：${formatIssueStamp(task.updatedAt)}`}>{formatIssueStamp(task.updatedAt)}</time>
    </Flex>
    <TaskGoalChildren task={task} tasks={allTasks} onOpen={onOpen}/>
  </Card>;
}

export function TaskBoardListView({
  archiveOnly = false,
  inferredWorkspaces,
  grouped,
  allTasks,
  collapsed,
  archiveOpen,
  archiveCount = grouped.archived.length,
  onToggle,
  onToggleArchive,
  onPurgeArchive,
  archivePurging = false,
  onOpen,
  onOpenSession,
  onOpenComments,
}: {
  archiveOnly?: boolean;
  inferredWorkspaces?: ReadonlyMap<string, { name: string }>;
  grouped: Record<WandTaskStatus, WandTaskListed[]>;
  allTasks: WandTaskListed[];
  collapsed: Record<WandTaskStatus, boolean>;
  archiveOpen: boolean;
  archiveCount?: number;
  onToggle(status: WandTaskStatus): void;
  onToggleArchive(): void;
  onPurgeArchive?(): void;
  archivePurging?: boolean;
  onOpen(id: string): void;
  onOpenSession?: (sessionId: string) => void;
  onOpenComments?(id: string): void;
}): React.ReactElement {
  const archived = grouped.archived;
  const identifierById = React.useMemo(() => new Map(allTasks.map((task) => [task.id, task.identifier])), [allTasks]);
  const renderRow = (task: WandTaskListed): React.ReactElement => <TaskBoardListRow
    key={task.id}
    task={task}
    allTasks={allTasks}
    parentLabel={task.parentTaskId ? identifierById.get(task.parentTaskId) : undefined}
    workspaceLabel={task.workspace?.name ?? (inferredWorkspaces?.get(task.id) ? `${inferredWorkspaces.get(task.id)!.name}（按会话目录）` : "未归属工作区")}
    onOpen={onOpen}
    onOpenSession={onOpenSession}
    onOpenComments={onOpenComments}
  />;
  return <Flex vertical gap="middle" className="task-board-list-view">
    {archiveOnly && <Flex justify="space-between" align="center"><Typography.Text type="secondary">归档保留交付与执行历史，不代表旧任务已经通过本轮验收。</Typography.Text>{onPurgeArchive && archived.length > 0 && <WandButton kind="danger" disabled={archivePurging} onClick={onPurgeArchive}>清空归档</WandButton>}</Flex>}
    {(archiveOnly ? [ISSUE_ARCHIVE_COLUMN] : ISSUE_COLUMNS).map((column) => {
      const items = grouped[column.status] ?? (column.status === "review" ? grouped.done : []) ?? [];
      const isCollapsed = column.status === "ready" && archiveOpen && archived.length > 0
        ? false
        : collapsed[column.status];
      return <section key={column.status} className={`task-board-list-group is-${column.status}`}>
        <WandButton kind="ghost"
          type="button"
          className="task-board-list-header"
          aria-expanded={!isCollapsed}
          onClick={() => onToggle(column.status)}
        >
          <span className="task-board-list-heading">
            <WandIcon name="chevron" size={12} className={isCollapsed ? "task-disclosure-chevron" : "task-disclosure-chevron is-open"}/>
            <TaskBoardStatusGlyph status={column.status}/>
            <strong>{column.label}</strong>
          </span>
          <b>{items.length}</b>
        </WandButton>
        {!isCollapsed && <Flex vertical gap="small" className="task-board-list-rows">
          {items.length === 0 && column.status !== "ready" && <p className="task-board-column-empty">{column.empty}</p>}
          {items.length === 0 && column.status === "ready" && archived.length === 0 && <p className="task-board-column-empty">{column.empty}</p>}
          {items.map(renderRow)}
          {!archiveOnly && column.status === "ready" && archiveOpen && archived.length > 0 ? <TaskBoardArchiveFolder
            count={archiveCount}
            open={archiveOpen}
            onToggle={onToggleArchive}
            onPurge={onPurgeArchive}
            purging={archivePurging}
          >
            <Flex vertical gap="small" className="task-board-archive-rows">
              {archived.map(renderRow)}
            </Flex>
          </TaskBoardArchiveFolder> : null}
        </Flex>}
      </section>;
    })}
  </Flex>;
}

export function TaskBoardDashboard({ tasks, allTasks = tasks, projectName, onOpen, onOpenAcceptance, onStage }: {
  allTasks?: WandTaskListed[]; projectName: string; tasks: WandTaskListed[];
  onOpen(id: string): void; onOpenAcceptance?(id: string): void; onOpenSession?: (sessionId: string) => void;
  onStage?(status: WandTaskStatus): void; actionHub?: React.ReactNode;
}): React.ReactElement {
  const goals = tasks, baseStats = issueBoardStats(goals);
  const stats = { ...baseStats, accepted: goals.filter(task => resolveTaskDelivery(task, allTasks).completed).length };
  const active = goals.filter(task => task.status !== "archived");
  const ready = active.filter(task => task.status === "ready" && resolveTaskDelivery(task, allTasks).verified && !resolveTaskDelivery(task, allTasks).gaps.length);
  const review = active.filter(task => taskWorkflowStage(task.status) === "review");
  const running = active.filter(task => task.sessions.some(taskSessionIsRunning));
  const gaps = goals.filter(task => resolveTaskDelivery(task, allTasks).tone === "warning");
  const due = [...active].filter(task => task.dueDate).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)).slice(0, 5);
  const count = (status: WandTaskStatus): number => status === "backlog" ? stats.backlog : status === "todo" ? stats.todo : status === "doing" ? stats.doing : status === "review" ? stats.review : stats.ready;
  const completion = stats.total ? Math.round(stats.accepted / stats.total * 100) : 0;
  // 「需要你处理」只放必须由人决定的事：等你确认的交付，以及有阻塞的任务。
  const attention = [
    ...ready.map(task => ({ task, reason: "AI 已通过 · 等你确认", tone: "success" as const, action: () => (onOpenAcceptance ?? onOpen)(task.id), label: "查看交付" })),
    ...gaps.filter(task => !ready.includes(task)).map(task => ({ task, reason: resolveTaskDelivery(task, allTasks).label, tone: "warning" as const, action: () => onOpen(task.id), label: "处理阻塞" })),
  ];
  const owners = [...new Set(goals.map(task => task.assignedExecutor?.id).filter(Boolean))].map(id => {
    const owned = goals.filter(task => task.assignedExecutor?.id === id);
    return { id: id!, name: owned[0]!.assignedExecutor!.name, active: owned.filter(task => task.status !== "archived").length, waiting: owned.filter(task => task.status === "ready").length, accepted: owned.filter(task => resolveTaskDelivery(task, allTasks).completed).length };
  }).sort((a, b) => b.active - a.active).slice(0, 6);
  const list = (items: WandTaskListed[], caption: (task: WandTaskListed) => string, empty: string): React.ReactElement => items.length
    ? <div className="task-dash-list">{items.slice(0, 5).map(task => <TaskSummaryRow key={task.id} task={task} caption={caption(task)} onOpen={onOpen}/>)}</div>
    : <p className="task-dash-empty">{empty}</p>;
  return <div className="task-board-dashboard task-dash">
    <header className="task-dash-head">
      <div>
        <h2>{projectName}</h2>
        <p>{active.length} 个任务进行中 · 已完成 {stats.accepted}/{stats.total}（{completion}%）{stats.overdue ? ` · ${stats.overdue} 个已逾期` : ""}</p>
      </div>
    </header>
    <nav className="task-dash-stages" aria-label="各阶段任务数">
      {ISSUE_COLUMNS.map(column => <WandButton key={column.status} kind="ghost" className="task-dash-stage" data-stage={column.status}
        aria-label={`查看${column.label}任务（${count(column.status)}）`} onClick={() => onStage?.(column.status)}>
        <span><TaskBoardStatusGlyph status={column.status}/>{column.label}</span><strong>{count(column.status)}</strong>
      </WandButton>)}
      <div className="task-dash-stage-bar" aria-hidden="true">{ISSUE_COLUMNS.map(column => <i key={column.status} data-stage={column.status} style={{ flexGrow: count(column.status) }}/>)}</div>
    </nav>
    <section className="task-dash-section task-dash-attention" aria-labelledby="task-dash-attention">
      <header><h3 id="task-dash-attention">需要你处理</h3><span>{attention.length ? `${attention.length} 项` : ""}</span></header>
      {attention.length ? <div className="task-dash-list">{attention.slice(0, 8).map(({ task, reason, tone, action, label }) => <div className="task-dash-attention-row" key={task.id} data-tone={tone}>
        <TaskSummaryRow task={task} caption={`${task.identifier} · ${reason}`} onOpen={onOpen}/>
        <WandButton size="small" kind={tone === "success" ? "primary" : "secondary"} onClick={action}>{label}</WandButton>
      </div>)}</div> : <p className="task-dash-empty">没有等你确认或处理的事项。</p>}
    </section>
    <div className="task-dash-grid">
      <section className="task-dash-section" aria-labelledby="task-dash-running"><header><h3 id="task-dash-running">正在执行</h3><span>{running.length || ""}</span></header>
        {list(running, task => `${task.identifier} · ${task.assignedExecutor?.name || "负责人未记录"}`, "暂无已确认运行的任务。")}</section>
      <section className="task-dash-section" aria-labelledby="task-dash-review"><header><h3 id="task-dash-review">AI 验收中</h3><span>{review.length || ""}</span></header>
        {list(review, task => `${task.identifier} · ${task.legacyReview ? "历史交付待核对" : task.sessions.some(taskSessionIsRunning) ? "正在核验" : (task.queuedCommentCount ?? 0) > 0 || task.sessions.some(session => taskSessionActivity(session) === "排队中") ? "验收排队中" : "交付已提交"}`, "暂无待 AI 验收的任务。")}</section>
      <section className="task-dash-section" aria-labelledby="task-dash-due"><header><h3 id="task-dash-due">近期到期</h3><span>{due.length || ""}</span></header>
        {list(due, task => `${task.identifier} · ${issueDueStamp(task.dueDate!)} · ${issueStatusLabel(task.status)}`, "没有设置截止日期的任务。")}</section>
      <section className="task-dash-section" aria-labelledby="task-dash-owners"><header><h3 id="task-dash-owners">负责人</h3><span>{owners.length || ""}</span></header>
        {owners.length ? <table className="task-dash-owners"><thead><tr><th scope="col">负责人</th><th scope="col">进行中</th><th scope="col">待确认</th><th scope="col">已确认</th></tr></thead>
          <tbody>{owners.map(owner => <tr key={owner.id}><th scope="row">{owner.name}</th><td>{owner.active}</td><td>{owner.waiting}</td><td>{owner.accepted}</td></tr>)}</tbody></table>
          : <p className="task-dash-empty">暂无已记录的负责人。</p>}</section>
    </div>
  </div>;
}

export function TaskBoardGantt({
  allTasks = [],
  tasks: orderedTasks,
  zoom,
  hideCompleted,
  onZoom,
  onHideCompleted,
  onOpen,
  statuses,
  onStatuses,
}: {
  tasks: WandTaskListed[];
  allTasks?: WandTaskListed[];
  zoom: IssueGanttZoom;
  hideCompleted: boolean;
  onZoom(zoom: IssueGanttZoom): void;
  onHideCompleted(hide: boolean): void;
  onOpen(id: string): void;
  statuses: WandTaskStatus[];
  onStatuses(statuses: WandTaskStatus[]): void;
}): React.ReactElement {
  const { employees } = useSiliconEmployees();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [expandedWeeks, setExpandedWeeks] = React.useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = React.useState(() => new Date());
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const closed = (status: WandTaskStatus): boolean => status === "archived";
  const hidden = (task: WandTaskListed): boolean => hideCompleted && closed(task.status) && !taskHasOpenDescendant(allTasks, task.id);
  const range = issueGanttRange(zoom, anchor);
  const tasks = orderedTasks.filter(task => !hidden(task) && issueGanttSpan(task, range.start, range.days, now).length > 0);
  const dayWidth = zoom === "day" ? 580 : zoom === "week" ? 220 : 180;
  const navigate = (direction: number) => setAnchor(() => {
    const next = new Date(`${range.start}T12:00:00`);
    if (zoom === "month") next.setMonth(next.getMonth() + direction);
    else next.setDate(next.getDate() + direction * range.days);
    return next;
  });
  const weekday = (day: string) => new Date(`${day}T12:00:00`).getDay();
  const weekends = range.columns.map((day, index) => [0, 6].includes(weekday(day)) ?
    <span key={day} className="task-calendar-weekend" aria-hidden="true" style={{ left: `${index / range.days * 100}%`, width: `${100 / range.days}%` }}/> : null);
  const today = isoDate(now);
  const todayIndex = range.columns.indexOf(today);
  React.useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let width = -1;
    const revealToday = () => {
      if (width === scroll.clientWidth) return;
      width = scroll.clientWidth;
      scroll.style.setProperty("--gantt-viewport", `${width}px`);
      scroll.scrollLeft = Math.max(0, 100 + (todayIndex + 1) * dayWidth - width + 32);
    };
    revealToday();
    const observer = new ResizeObserver(revealToday);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [zoom, range.start, tasks.length === 0]);
  const quickStatuses = [{ status: "backlog", label: "待排期" }, { status: "todo", label: "待认领" }, { status: "review", label: "待验收" }, { status: "ready", label: "待归档" }] as const;
  const ganttLabel = (status: WandTaskStatus): string => quickStatuses.find(item => item.status === status)?.label ?? issueStatusLabel(status);
  const months: Array<{ key: string; start: number; days: number }> = [];
  range.columns.forEach((day, index) => {
    const key = day.slice(0, 7);
    const last = months.at(-1);
    if (last?.key === key) last.days += 1;
    else months.push({ key, start: index, days: 1 });
  });
  const monthStart = addIsoDays(range.start, -weekday(range.start));
  const weeks = Array.from({ length: Math.ceil((weekday(range.start) + range.days) / 7) }, (_, index) => addIsoDays(monthStart, index * 7));
  const barContent = (task: WandTaskListed, length: number) => {
    const people = taskExecutors(task.sessions, null, null, employees).filter(person => person.employeeId || person.key.startsWith("legacy-employee:"));
    const names = people.map(person => person.name).join("、");
    return <>
      <span className="task-board-gantt-label">
        <Tag className="task-detail-stage" data-stage={taskWorkflowStage(task.status)}>{ganttLabel(task.status)}</Tag>
        <span className="task-board-gantt-title">{task.title}</span>
      </span>
      <span className="task-calendar-age" title={`创建于 ${new Date(task.createdAt).toLocaleString()}，距今 ${issueTaskAge(task.createdAt, now)}`} aria-label={`已创建 ${issueTaskAge(task.createdAt, now)}`}>{issueTaskAge(task.createdAt, now)}</span>
      {people.length > 0 && <span className="task-board-gantt-people" title={`历史参与者：${names}`} aria-label={`历史参与者：${names}`}>
        <Avatar.Group size={24} max={{ count: length === 1 ? 1 : 3 }}>
          {people.map(person => <Avatar key={person.key} size={24} aria-label={person.name} icon={<TaskPersonAvatar id={person.employeeId} name={person.name} avatar={person.avatar} kind="employee"/>}/>)}
        </Avatar.Group>
      </span>}
    </>;
  };
  const timelineColumns = `repeat(${range.days}, minmax(0, 1fr))`;
  const todayLine = todayIndex >= 0 ? <span className="task-board-gantt-today-line" aria-hidden="true"
    style={{ position: "absolute", top: 0, bottom: 0, left: `${(todayIndex + 0.5) / range.days * 100}%`, borderLeft: "1px dashed var(--accent)", pointerEvents: "none" }}/> : null;
  return <Card size="small" className="task-board-gantt" styles={{ body: { minWidth: 0 } }}>
    <Flex wrap align="center" justify="space-between" gap="small" className="task-board-gantt-toolbar">
      <Flex wrap gap={8} role="group" aria-label="日历状态快捷筛选">
        {quickStatuses.map(item => <WandButton key={item.status} size="small" kind="secondary"
          aria-pressed={statuses.length === 1 && statuses[0] === item.status}
          onClick={() => onStatuses(statuses.length === 1 && statuses[0] === item.status ? [] : [item.status])}>{item.label}</WandButton>)}
      </Flex>
      <Checkbox className="task-board-gantt-hide" checked={hideCompleted} onChange={(event) => onHideCompleted(event.target.checked)}>
        隐藏已归档
      </Checkbox>
      <WandStretchTabs
        className="task-board-gantt-zooms"
        ariaLabel="日历范围"
        value={zoom}
        tabs={ISSUE_GANTT_ZOOMS.map((entry) => ({ value: entry.value, label: entry.label }))}
        onValueChange={(next) => onZoom(next as IssueGanttZoom)}
      />
    </Flex>
    <Flex wrap align="center" justify="space-between" gap={8} className="task-calendar-navigation">
      <Flex align="center" gap={8}>
        <WandButton kind="secondary" size="small" aria-label="上一时段" onClick={() => navigate(-1)}>‹</WandButton>
        <Typography.Text strong aria-live="polite">{range.start}{range.days > 1 ? ` — ${range.columns.at(-1)}` : ""}</Typography.Text>
        <WandButton kind="secondary" size="small" aria-label="下一时段" onClick={() => navigate(1)}>›</WandButton>
        <WandButton kind="secondary" size="small" onClick={() => { const current = new Date(); setAnchor(current); setNow(current); }}>回到今天</WandButton>
      </Flex>
      <Typography.Text type="secondary">{tasks.length} 个任务 · 时长为创建至今</Typography.Text>
    </Flex>
    {zoom === "month" ? <div className="task-month-scroll" role="region" aria-label="月历，周日到周六" tabIndex={0}>
      <div className="task-month-grid">
        <div className="task-month-weekdays">{["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map(day => <span key={day}>{day}</span>)}</div>
        {weeks.map(start => {
          const days = Array.from({ length: 7 }, (_, index) => addIsoDays(start, index));
          const items = tasks.filter(task => issueGanttSpan(task, start, 7, now).length > 0);
          const expanded = expandedWeeks.has(start);
          const visibleItems = expanded ? items : items.slice(0, 4);
          return <section key={start} className="task-month-week" aria-label={`${start} 至 ${days[6]}`}>
            <div className="task-month-day-backgrounds" aria-hidden="true">{days.map(day => <span key={day} className={`${[0, 6].includes(weekday(day)) ? "is-weekend" : ""} ${day.slice(0, 7) !== range.start.slice(0, 7) ? "is-outside" : ""}`}/>)}</div>
            <div className="task-month-dates">{days.map(day => <time key={day} dateTime={day} aria-current={day === today ? "date" : undefined} className={day.slice(0, 7) !== range.start.slice(0, 7) ? "is-outside" : undefined}>{day.endsWith("-01") ? `${Number(day.slice(5, 7))}月1日` : Number(day.slice(8))}</time>)}</div>
            <div className="task-month-events">
              {visibleItems.map((task, index) => {
                const span = issueGanttSpan(task, start, 7, now);
                return <WandButton key={task.id} kind="ghost" className={`task-board-gantt-bar task-month-event is-${task.status}`} style={{ gridColumn: `${span.offset + 1} / span ${span.length}`, gridRow: index + 1 }}
                  aria-label={`${task.identifier} ${task.title}`} title={`${task.identifier} · ${ganttLabel(task.status)} · ${task.title} · 已创建 ${issueTaskAge(task.createdAt, now)}`}
                  onClick={() => onOpen(task.id)}><span className="task-month-content">{barContent(task, span.length)}</span></WandButton>;
              })}
            </div>
            {items.length > 4 && <WandButton kind="ghost" size="small" className="task-month-more" aria-expanded={expanded} onClick={() => setExpandedWeeks(current => { const next = new Set(current); if (expanded) next.delete(start); else next.add(start); return next; })}>{expanded ? "收起本周任务" : `展开其余 ${items.length - 4} 个任务`}</WandButton>}
          </section>;
        })}
      </div>
    </div> : tasks.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个时段没有匹配的任务，可切换日期或筛选"/> :
    <div ref={scrollRef} className="task-board-gantt-scroll" tabIndex={0} role="region" aria-label="任务时间线，可横向滚动" style={{ overflowX: "auto", marginTop: 12 }}>
      <div className="task-board-gantt-grid" style={{ minWidth: Math.max(680, 100 + range.days * dayWidth) }}>
        <div className="task-board-gantt-head" style={{ display: "grid", gridTemplateColumns: "100px minmax(0, 1fr)", borderBottom: "1px solid var(--border-subtle)" }}>
          <Typography.Text strong style={{ alignSelf: "center", paddingInline: 8 }}>任务</Typography.Text>
          <div>
            <div className="task-board-gantt-months" style={{ display: "grid", gridTemplateColumns: timelineColumns }}>
              {months.map((month) => <Typography.Text strong key={month.key} ellipsis
                title={`${month.key.slice(0, 4)}年${Number(month.key.slice(5))}月`}
                aria-label={`${month.key.slice(0, 4)}年${Number(month.key.slice(5))}月`}
                style={{ gridColumn: `${month.start + 1} / span ${month.days}`, minWidth: 0, borderLeft: "1px solid var(--border-subtle)", padding: "4px", whiteSpace: "nowrap" }}>
                {month.days < 4 ? `${Number(month.key.slice(5))}月` : `${month.key.slice(0, 4)}年${Number(month.key.slice(5))}月`}
              </Typography.Text>)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: timelineColumns, textAlign: "center" }}>
              {range.columns.map((day) => <time key={day} dateTime={day} title={day} className={[0, 6].includes(weekday(day)) ? "is-weekend" : undefined} aria-current={day === today ? "date" : undefined}
                style={{ paddingBlock: 6, color: day === today ? "var(--accent)" : "var(--text-secondary)", fontWeight: day === today ? 700 : 400, borderLeft: day.endsWith("-01") ? "1px solid var(--border-subtle)" : undefined }}>
                {day.slice(5)} · {day === today ? "今天" : `周${"日一二三四五六"[weekday(day)]}`}
              </time>)}
            </div>
          </div>
        </div>
        <section className="task-board-gantt-group">
            {tasks.map((task) => {
              const span = issueGanttSpan(task, range.start, range.days, now);
              const inRange = span.length > 0;
              const period = task.dueDate ? `截止 ${task.dueDate}` : `添加 ${formatIssueStamp(task.createdAt)} → ${task.status === "archived" ? task.archivedAt ? `归档 ${formatIssueStamp(task.archivedAt)}` : "归档时间缺失" : "现在"}`;
              return <div key={task.id}><WandButton kind="ghost"
                type="button"
                className="task-board-gantt-row"
                title={`${task.title} · ${period}`}
                style={{ width: "100%", height: 56, padding: 0, display: "grid", gridTemplateColumns: "100px minmax(0, 1fr)", gap: 0, textAlign: "left" }}
                aria-label={`${task.identifier} ${task.title}，${period}`}
                onClick={() => onOpen(task.id)}
              >
                <Typography.Text type="secondary" className="task-board-gantt-id">{task.identifier}</Typography.Text>
                <div className="task-board-gantt-track" style={{ position: "relative", display: "grid", gridTemplateColumns: timelineColumns, alignItems: "center", height: "100%", minWidth: 0,
                  backgroundImage: "linear-gradient(to right, var(--border-subtle) 1px, transparent 1px)", backgroundSize: `${100 / range.days}% 100%` }}>
                  {weekends}
                  {inRange ? <span className={`task-board-gantt-bar is-${task.status}${task.dueDate ? " is-milestone" : ""}`}
                    style={{ gridColumn: `${span.offset + 1} / span ${span.length}` }}>
                    {barContent(task, span.length)}
                  </span> : <Typography.Text type="secondary" style={{ gridColumn: `1 / ${range.days + 1}`, paddingInline: 8 }}>{task.title} · {task.dueDate ? "截止日期不在当前范围" : "添加或归档时间缺失，无法显示时间段"}</Typography.Text>}

                  {todayLine}
                </div>
              </WandButton></div>;
            })}
          </section>
      </div>
    </div>}
  </Card>;
}

export function TaskBoardContextMenu({
  x,
  y,
  task,
  onOpen,
  onCopy,
  onDispatch,
  onNewSession,
  onArchive,
  onRestore,
  onMove,
  onClose,
}: {
  x: number;
  y: number;
  task: WandTaskListed;
  /** 不依赖拖拽的换列入口（键盘与触屏）；与拖拽共用同一条落点逻辑。 */
  onMove?(status: WandTaskStatus): void;
  onOpen(): void;
  onCopy(): void;
  onDispatch(): void;
  onNewSession?(): void;
  /** 归档：卡片进归档目录，侧栏不再显示，终端与记录都保留。 */
  onArchive(): void;
  /** 恢复归档卡片：重建侧栏任务并带回它的终端。 */
  onRestore(): void;
  onClose(): void;
}): React.ReactElement {
  usePopupDismiss(true, onClose);
  React.useEffect(() => {
    const close = (event: PointerEvent): void => {
      if (!isWandPopupOwnedBy(event.target, "task-board-context")) onClose();
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onClose]);
  const actions = [
    { key: "open", label: "打开", icon: <WandIcon name="folder"/>, onClick: onOpen },
    { key: "copy", label: "复制 ID", icon: <WandIcon name="copy"/>, onClick: onCopy },
    ...(onNewSession ? [{ key: "new-session", label: "新建会话", icon: <WandIcon name="plus"/>,
      disabled: task.status === "archived" || !task.workspaceTaskId, onClick: onNewSession }] : []),
    ...(task.status === "archived"
      ? [{ key: "restore", label: "恢复到等待认领", icon: <WandIcon name="resume"/>, onClick: onRestore }]
      : [
          ...(onMove ? [{ key: "move", label: "移动到", icon: <WandIcon name="board"/>,
            children: ISSUE_COLUMNS.filter((column) => column.status !== task.status).map((column) => ({
              key: `move-${column.status}`, label: column.label, onClick: () => { onMove(column.status); onClose(); },
            })) }] : []),
          { key: "dispatch", label: "派发 Agent", icon: <WandIcon name="zap"/>, onClick: onDispatch },
          ...(canArchiveBoardTask(task) ? [{ key: "archive", label: "归档", icon: <WandIcon name="archive"/>, onClick: onArchive }] : []),
        ]),
  ];
  return <Dropdown open autoFocus placement="bottomLeft" trigger={[]}
    onOpenChange={(open) => { if (!open) onClose(); }}
    menu={{ items: actions.map((action) => "children" in action ? action : { ...action, onClick: () => { action.onClick(); onClose(); } }) }}
    popupRender={(menu) => <div data-wand-popup-owner="task-board-context">{menu}</div>}>
    <span style={{ position: "fixed", left: x, top: y, width: 1, height: 1 }} aria-hidden="true"/>
  </Dropdown>;
}

export function TaskBoardAgentChip({
  agent,
  running = false,
}: {
  agent: WandTaskAgent | null;
  running?: boolean;
}): React.ReactElement | null {
  if (!agent) return null;
  return <Tag className={classNames("task-board-chip is-agent", running && "is-running")}>
    <ProviderLogo provider={agent.provider} className="task-board-agent-logo"/>
    {issueAgentLabel(agent.provider, agent.engine)}
    {running ? <Badge status="processing"/> : null}
  </Tag>;
}


export function TaskBoardAgentSessionList({ sessions, assigned, subject, assignee, onOpenSession, catalog }: {
  sessions: IssueSessionSummary[]; assigned: WandTaskAgent | null; subject?: TaskExecutionSubject | null; assignee?: WandTaskListed["assignedExecutor"];
  onOpenSession?: (sessionId: string) => void; catalog?: IssueModelCatalog | null;
}): React.ReactElement {
  const { employees } = useSiliconEmployees();
  const executors = taskExecutors(sessions, assigned, subject, employees, assignee);
  return <div className="task-board-agent-list" aria-label="任务执行者与指派记录">
    <TaskBoardAgentChips sessions={sessions} assigned={assigned} subject={subject} assignee={assignee}/>
    {executors.map(person => <section key={person.key} className="task-board-agent-group">
      <header className="task-board-agent-group-head"><strong>{person.name}</strong></header>
      {person.sessions.map(session => <WandButton key={session.id} kind="ghost" type="button" className="task-board-agent-session" onClick={() => onOpenSession?.(session.id)}>
        <span className={classNames("task-board-agent-session-status", taskSessionIsRunning(session) && "is-running")}/>
        <strong>{session.title || person.name}</strong>
        <small>{[issueAgentLabel(session.provider, session.engine), wandModelDisplayName(catalog ?? null, session.provider, session.model), issueAgentEffortLabel(session.thinkingEffort), issueAgentModeLabel(session.mode), sessionStatusLabel(session)].join(" · ")}</small>
      </WandButton>)}
    </section>)}
  </div>;
}

export function TaskBoardProjectChip({ name, inferred = false }: { name: string; inferred?: boolean }): React.ReactElement {
  return <Tag className={classNames("task-board-chip", inferred && "is-inferred")} title={inferred ? `${name}（任务未绑定项目，按会话运行目录归入）` : name}>
    <TaskBoardFolderIcon size={12}/>
    <span>{name}</span>
  </Tag>;
}

/** 卡片上的里程碑胶囊；名字由服务端 DTO 直接给出。 */
export function TaskBoardMilestoneChip({ name }: { name: string }): React.ReactElement {
  return <Tag className="task-board-chip is-milestone" title={`里程碑：${name}`}>
    <WandIcon name="milestone" size={12}/>
    <span>{name}</span>
  </Tag>;
}
