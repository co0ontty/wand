import { TaskSummaryRow } from "./task-inline-summary.js";
import { taskExecutors } from "./task-executors";
import { TaskBoardAgentChips } from "./task-executor-chips";
export { TaskBoardAgentChips } from "./task-executor-chips";
import { useSiliconEmployees } from "../agents/employee-repository";
import { taskHasOpenDescendant } from "../../../task-hierarchy";
import { TaskGoalChildren } from "./task-goal-children";
import { canArchiveBoardTask } from "./task-board-repository";
import { WandButton } from "../ui";
import { Alert, Badge, Checkbox, Card, Collapse, Descriptions, Empty, Flex, List, Tag, Progress, Dropdown, Typography } from "antd";
import * as React from "react";
import { taskAcceptanceLabel, taskSessionIsRunning, taskSessionSummary } from "./task-delivery-state";
import { taskAiVerified, taskHumanAccepted, taskWorkflowStage, type TaskExecutionSubject, type WandTaskAgent, type WandTaskPriority, type WandTaskStatus } from "../../../task-types";
import { DEFAULT_ITERATION_NAME } from "../../../task-types";
import { ProviderLogo } from "../provider-logo";
import { WandIcon, WandIconButton, WandPopover, WandStretchTabs, WandSwitch } from "../ui";
import { isWandPopupOwnedBy, usePopupDismiss } from "../ui/popup-lifecycle";
import { classNames } from "../ui/class-names";
import {
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
  isoDate,
  issueHideStatusFilterLabel,
  issueIsOverdue,
  issueLabelColor,
  issueLabelName,
  issueLabelTone,
  issuePriorityLabel,
  issueSessionRunning,
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
  TaskBoardPanelIcon,
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
  const running = task.executionStatus === "running" || task.sessions.some(taskSessionIsRunning);
  const queued = task.queuedExecutionCount ?? task.queuedCommentCount ?? 0;
  return <Flex align="center" gap="small" className={classNames("task-board-processing", running && "is-running")}>
    {running ? <TaskBoardProcessingGlyph/> : null}
    <span className="task-board-processing-label">{running ? "正在处理..." : queued > 0
      ? queued === 1 ? "排队中 · 等待执行" : `排队中 · ${queued} 条等待执行`
      : taskHumanAccepted(task) ? "人工已确认 · 已完成" : task.acceptance?.blocker ? `待处理：${task.acceptance.blocker}`
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

export function TaskBoardDisplayMenu({
  display,
  onChange,
}: {
  display: IssueBoardDisplay;
  onChange(next: IssueBoardDisplay): void;
}): React.ReactElement {
  return <WandPopover
    align="end"
    side="bottom"
    ariaLabel="显示设置"
    className="task-board-display-menu"
    trigger={<WandIconButton className="task-board-icon-button" aria-label="显示设置" title="显示设置">
      <TaskBoardPanelIcon/>
    </WandIconButton>}
  >
    <strong>显示设置</strong>
    <WandSwitch
      checked={display.body}
      onCheckedChange={(body) => onChange({ ...display, body })}
      ariaLabel="显示正文"
      label="正文"
    />
    <p>主列</p>
    {ISSUE_COLUMNS.map((column) => {
      const checked = display.mainStatuses.includes(column.status);
      return <Checkbox key={column.status} className="task-board-display-status" checked={checked} onChange={() => {
            const mainStatuses = checked
              ? display.mainStatuses.filter((status) => status !== column.status)
              : [...display.mainStatuses, column.status];
            onChange({
              ...display,
              mainStatuses: mainStatuses.length > 0 ? mainStatuses : [column.status],
            });
          }}>
        <TaskBoardStatusIcon status={column.status} size={14}/>
        {column.label}
      </Checkbox>;
    })}
  </WandPopover>;
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

/**
 * 会话状态的界面名，唯一来源（原来这里和「已指派的 Agent」列表各有一份映射，同概念两套词）。
 * 覆盖 SessionStatus 的全部取值 + 看板用到的 thinking / waiting-input；认不出来才回退原值，
 * 空值给「会话」，不再一律显示「空闲」把异常状态藏起来。
 */
function sessionStatusLabel(status: string): string {
  if (status === "queued") return "排队中";
  if (status === "running" || status === "thinking") return "运行中";
  if (status === "waiting-input") return "等待输入";
  if (status === "idle") return "空闲";
  if (status === "exited" || status === "stopped") return "已结束";
  if (status === "failed") return "失败";
  return status || "会话";
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
  const description = task.description.trim();
  // 整行都是进入详情的入口；行内的按钮/链接各自处理自己的点击。
  return <Card
    hoverable
    className={classNames("task-board-list-row", task.status === "archived" && "is-archived")}
    onClick={(event) => {
      if ((event.target as HTMLElement).closest("button, a")) return;
      onOpen(task.id);
    }}
  >
    <WandButton kind="ghost"
      type="button"
      className="task-board-list-title"
      aria-label={`打开 ${task.identifier}: ${task.title}`}
      onClick={() => onOpen(task.id)}
    >
      <small>{task.identifier}{parentLabel ? ` ↳ ${parentLabel}` : ""}</small>
      <strong>{task.title}</strong>
    </WandButton>
    {description ? <p className="task-board-list-description">{description}</p> : null}
    <Flex wrap align="center" gap={4} className="task-board-list-meta">
      {/* 列表已按阶段分组，只有「排队中」这类组名表达不了的状态才单独标出。 */}
      {issueTaskStatusLabel(task) !== issueStatusLabel(task.status) && <Tag className="task-board-chip task-detail-stage" data-stage={taskWorkflowStage(task.status)}>{issueTaskStatusLabel(task)}</Tag>}
      {["review", "ready", "archived"].includes(task.status) || task.acceptance?.blocker?.trim()
        ? <Typography.Text type={taskHumanAccepted(task) ? "success" : task.acceptance?.blocker?.trim() ? "warning" : "secondary"}>{taskAcceptanceLabel(task.acceptance, task)}</Typography.Text> : null}
      <TaskBoardPriorityChip priority={task.priority}/>
      {task.milestone && task.milestone.name !== DEFAULT_ITERATION_NAME ? <TaskBoardMilestoneChip name={task.milestone.name}/> : null}
      {task.labels.slice(0, 2).map((label) => <TaskBoardLabelChip key={label} label={label}/>)}
      {task.dueDate ? <TaskBoardDueChip date={task.dueDate} status={task.status}/> : null}
      <span>{workspaceLabel}</span>
      <TaskBoardConversationButton sessions={task.sessions} onOpen={onOpenSession}/>
      {(task.commentCount ?? 0) > 0 && <TaskBoardCommentCountButton task={task} onOpen={() => onOpenComments?.(task.id)}/>}
      <time>{formatIssueStamp(task.updatedAt)}</time>
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

export function TaskBoardDashboard({ tasks, projectName, onOpen, onOpenAcceptance, onStage }: {
  allTasks?: WandTaskListed[]; projectName: string; tasks: WandTaskListed[];
  onOpen(id: string): void; onOpenAcceptance?(id: string): void; onOpenSession?: (sessionId: string) => void;
  onStage?(status: WandTaskStatus): void; actionHub?: React.ReactNode;
}): React.ReactElement {
  const goals = tasks.filter(task => !task.parentTaskId), stats = issueBoardStats(goals);
  const active = goals.filter(task => task.status !== "archived");
  const ready = active.filter(task => task.status === "ready" && taskAiVerified(task));
  const review = active.filter(task => taskWorkflowStage(task.status) === "review");
  const running = active.filter(task => task.executionStatus === "running" || task.sessions.some(taskSessionIsRunning));
  const gaps = active.filter(task => task.acceptance?.blocker.trim());
  const due = [...active].filter(task => task.dueDate).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)).slice(0, 5);
  const count = (status: WandTaskStatus): number => status === "backlog" ? stats.backlog : status === "todo" ? stats.todo : status === "doing" ? stats.doing : status === "review" ? stats.review : stats.ready;
  const completion = stats.total ? Math.round(stats.accepted / stats.total * 100) : 0;
  // 「需要你处理」只放必须由人决定的事：等你确认的交付，以及有阻塞的任务。
  const attention = [
    ...ready.map(task => ({ task, reason: "AI 已通过 · 等你确认", tone: "success" as const, action: () => (onOpenAcceptance ?? onOpen)(task.id), label: "查看交付" })),
    ...gaps.filter(task => !ready.includes(task)).map(task => ({ task, reason: task.acceptance!.blocker.trim(), tone: "warning" as const, action: () => onOpen(task.id), label: "处理阻塞" })),
  ];
  const owners = [...new Set(goals.map(task => task.assignedExecutor?.id).filter(Boolean))].map(id => {
    const owned = goals.filter(task => task.assignedExecutor?.id === id);
    return { id: id!, name: owned[0]!.assignedExecutor!.name, active: owned.filter(task => task.status !== "archived").length, waiting: owned.filter(task => task.status === "ready").length, accepted: owned.filter(taskHumanAccepted).length };
  }).sort((a, b) => b.active - a.active).slice(0, 6);
  const list = (items: WandTaskListed[], caption: (task: WandTaskListed) => string, empty: string): React.ReactElement => items.length
    ? <div className="task-dash-list">{items.slice(0, 5).map(task => <TaskSummaryRow key={task.id} task={task} caption={caption(task)} onOpen={onOpen}/>)}</div>
    : <p className="task-dash-empty">{empty}</p>;
  return <div className="task-board-dashboard task-dash">
    <header className="task-dash-head">
      <div>
        <h2>{projectName}</h2>
        <p>{active.length} 个任务进行中 · 人工确认完成 {stats.accepted}/{stats.total}（{completion}%）{stats.overdue ? ` · ${stats.overdue} 个已逾期` : ""}</p>
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
        {list(running, task => `${task.identifier} · ${task.assignedExecutor?.name || "未指派"}`, "当前没有正在运行的任务。")}</section>
      <section className="task-dash-section" aria-labelledby="task-dash-review"><header><h3 id="task-dash-review">AI 验收中</h3><span>{review.length || ""}</span></header>
        {list(review, task => `${task.identifier} · ${task.legacyReview ? "历史交付待核对" : task.executionStatus === "running" ? "正在核验" : task.executionStatus === "queued" ? "验收排队中" : "交付已提交"}`, "暂无待 AI 验收的任务。")}</section>
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
  grouped,
  zoom,
  hideCompleted,
  onZoom,
  onHideCompleted,
  onOpen,
}: {
  grouped: Record<WandTaskStatus, WandTaskListed[]>;
  allTasks?: WandTaskListed[];
  zoom: IssueGanttZoom;
  hideCompleted: boolean;
  onZoom(zoom: IssueGanttZoom): void;
  onHideCompleted(hide: boolean): void;
  onOpen(id: string): void;
}): React.ReactElement {
  const closed = (status: WandTaskStatus): boolean => status === "archived";
  const hidden = (task: WandTaskListed): boolean => hideCompleted && closed(task.status) && !taskHasOpenDescendant(allTasks, task.id);
  const tasks = [...ISSUE_COLUMNS.flatMap((column) => grouped[column.status]), ...grouped.archived]
    .filter((task) => !hidden(task));
  const range = issueGanttRange(tasks, zoom);
  const today = isoDate(new Date());
  const todayIndex = range.columns.indexOf(today);
  const months: Array<{ key: string; start: number; days: number }> = [];
  range.columns.forEach((day, index) => {
    const key = day.slice(0, 7);
    const last = months.at(-1);
    if (last?.key === key) last.days += 1;
    else months.push({ key, start: index, days: 1 });
  });
  const timelineColumns = `repeat(${range.days}, minmax(0, 1fr))`;
  const todayLine = todayIndex >= 0 ? <span className="task-board-gantt-today-line" aria-hidden="true"
    style={{ position: "absolute", top: 0, bottom: 0, left: `${(todayIndex + 0.5) / range.days * 100}%`, borderLeft: "1px dashed var(--accent)", pointerEvents: "none" }}/> : null;
  return <Card size="small" className="task-board-gantt" styles={{ body: { minWidth: 0 } }}>
    <Flex wrap align="center" justify="space-between" gap="small" className="task-board-gantt-toolbar">
      <Checkbox className="task-board-gantt-hide" checked={hideCompleted} onChange={(event) => onHideCompleted(event.target.checked)}>
        隐藏已归档
      </Checkbox>
      <WandStretchTabs
        className="task-board-gantt-zooms"
        ariaLabel="甘特图缩放"
        value={zoom}
        tabs={ISSUE_GANTT_ZOOMS.map((entry) => ({ value: entry.value, label: entry.label }))}
        onValueChange={(next) => onZoom(next as IssueGanttZoom)}
      />
    </Flex>
    <Typography.Paragraph type="secondary" style={{ margin: "8px 0 0" }}>
      今天 {today} · 只标记真实截止日期；未设置日期的任务保留为待排期，不虚构持续时长。
    </Typography.Paragraph>
    {tasks.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有可显示的任务"/> :
    <div className="task-board-gantt-scroll" tabIndex={0} role="region" aria-label="任务时间线，可横向滚动" style={{ overflowX: "auto", marginTop: 12 }}>
      <div className="task-board-gantt-grid" style={{ minWidth: Math.max(680, 180 + range.days * (zoom === "day" ? 32 : 24)) }}>
        <div className="task-board-gantt-head" style={{ display: "grid", gridTemplateColumns: "180px minmax(0, 1fr)", borderBottom: "1px solid var(--border-subtle)" }}>
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
              {range.columns.map((day) => <time key={day} dateTime={day} title={day} aria-current={day === today ? "date" : undefined}
                style={{ paddingBlock: 6, color: day === today ? "var(--accent)" : "var(--text-secondary)", fontWeight: day === today ? 700 : 400, borderLeft: day.endsWith("-01") ? "1px solid var(--border-subtle)" : undefined }}>
                {day === today ? "今" : Number(day.slice(8, 10))}
              </time>)}
            </div>
          </div>
        </div>
        {[...ISSUE_COLUMNS, ISSUE_ARCHIVE_COLUMN].map((column) => {
          const items = (grouped[column.status] ?? []).filter((task) => !hidden(task));
          if (items.length === 0) return null;
          return <section key={column.status} className={`task-board-gantt-group is-${column.status}`}>
            <div style={{ display: "grid", gridTemplateColumns: "180px minmax(0, 1fr)", height: 36 }}>
              <Flex component="header" align="center" gap="small" style={{ paddingInline: 8 }}><TaskBoardStatusGlyph status={column.status}/><Typography.Text strong>{column.label}</Typography.Text><Tag>{items.length}</Tag></Flex>
              <div style={{ position: "relative" }}>{todayLine}</div>
            </div>
            {items.map((task) => {
              const span = issueGanttSpan(task, range.start, range.days);
              const inRange = span.length > 0;
              return <div key={task.id}><WandButton kind="ghost"
                type="button"
                className="task-board-gantt-row"
                title={`${task.title} · ${task.dueDate ? `截止 ${task.dueDate}` : "待排期，未设置截止日期"}`}
                style={{ width: "100%", height: 48, padding: 0, display: "grid", gridTemplateColumns: "180px minmax(0, 1fr)", gap: 0, textAlign: "left" }}
                aria-label={`${task.identifier} ${task.title}，${task.dueDate ? `截止 ${task.dueDate}` : "待排期，未设置截止日期"}`}
                onClick={() => onOpen(task.id)}
              >
                <Flex vertical style={{ minWidth: 0, paddingInline: 8 }}><Typography.Text type="secondary">{task.identifier}{task.parentTaskId ? ` · 归属 ${allTasks.find(parent => parent.id === task.parentTaskId)?.identifier ?? "历史主目标"}` : ""}</Typography.Text><Typography.Text ellipsis>{task.title}</Typography.Text></Flex>
                <div className="task-board-gantt-track" style={{ position: "relative", display: "grid", gridTemplateColumns: timelineColumns, alignItems: "center", height: "100%", minWidth: 0,
                  backgroundImage: "linear-gradient(to right, var(--border-subtle) 1px, transparent 1px)", backgroundSize: `${100 / range.days}% 100%` }}>
                  {inRange ? <i className={`is-${task.status}`} aria-hidden="true"
                    style={{ gridColumn: `${span.offset + 1} / span 1`, height: 12, width: 12, justifySelf: "center", borderRadius: "50%", background: taskHumanAccepted(task) ? "var(--success)" : task.status === "archived" ? "var(--text-tertiary)" : "var(--accent)" }}/>
                    : <Typography.Text type="secondary" style={{ gridColumn: `1 / ${range.days + 1}`, paddingInline: 8 }}>{task.dueDate ? "截止日期不在当前范围" : "待排期 · 未设置截止日期"}</Typography.Text>}
                  {todayLine}
                </div>
              </WandButton><TaskGoalChildren task={task} tasks={allTasks} onOpen={onOpen}/></div>;
            })}
          </section>;
        })}
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
        <span className={classNames("task-board-agent-session-status", issueSessionRunning(session.status) && "is-running")}/>
        <strong>{session.title || person.name}</strong>
        <small>{[issueAgentLabel(session.provider, session.engine), wandModelDisplayName(catalog ?? null, session.provider, session.model), issueAgentEffortLabel(session.thinkingEffort), issueAgentModeLabel(session.mode), sessionStatusLabel(session.status)].join(" · ")}</small>
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
