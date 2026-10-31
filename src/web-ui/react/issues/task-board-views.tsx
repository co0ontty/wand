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
import { taskAcceptanceLabel, taskSessionActivity, taskSessionSummary } from "./task-delivery-state";
import { taskAiVerified, taskHumanAccepted, taskWorkflowStage, type TaskExecutionSubject, type WandTaskAgent, type WandTaskPriority, type WandTaskStatus } from "../../../task-types";
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

export function TaskBoardLabelChip({ label }: { label: string }): React.ReactElement {
  const tone = issueLabelTone(label);
  return <Tag className={classNames("task-board-label", tone && `is-${tone}`)}
    color={issueLabelColor(label)}>{issueLabelName(label)}</Tag>;
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
  const running = task.executionStatus === "running" || task.sessions.some((session) => taskSessionActivity(session) === "运行中");
  const queued = task.queuedExecutionCount ?? task.queuedCommentCount ?? 0;
  return <Flex align="center" gap="small" className={classNames("task-board-processing", running && "is-running")}>
    {running ? <TaskBoardProcessingGlyph/> : null}
    <span className="task-board-processing-label">{running ? "正在处理..." : queued > 0
      ? queued === 1 ? "排队中 · 等待执行" : `排队中 · ${queued} 条等待执行`
      : taskHumanAccepted(task) ? "人工已确认 · 已完成" : task.acceptance?.blocker ? `待处理：${task.acceptance.blocker}`
      : task.sessions.length > 0 ? taskSessionSummary(task.sessions) + " · 尚待验收" : "等待派发"}</span>
    <span style={{ flex: 1 }} aria-hidden="true"/>
    <TaskBoardConversationButton sessions={task.sessions} onOpen={onOpenSession}/>
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
    <p>状态</p>
    {ISSUE_STATUS_FILTERS.map((column) => <Checkbox key={column.status} checked={filters.statuses.includes(column.status)} onChange={() => onChange({ ...filters, statuses: toggleValue(column.status, filters.statuses) })}>
      <TaskBoardStatusIcon status={column.status} size={14}/>
      {column.label}
    </Checkbox>)}
    <p>优先级</p>
    {ISSUE_PRIORITIES.map((entry) => <Checkbox key={entry.value} checked={filters.priorities.includes(entry.value)} onChange={() => onChange({ ...filters, priorities: toggleValue(entry.value, filters.priorities) })}>
      <TaskBoardPriorityIcon priority={entry.value} size={14}/>
      {entry.label}
    </Checkbox>)}
    {labels.length > 0 && <>
      <p>标签</p>
      {labels.map((label) => <Checkbox key={label} checked={filters.labels.includes(label)} onChange={() => onChange({ ...filters, labels: toggleValue(label, filters.labels) })}>
        <TaskBoardLabelChip label={label}/>
      </Checkbox>)}
    </>}
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
  if (status === "running" || status === "thinking") return "进行中";
  if (status === "waiting-input") return "等待输入";
  if (status === "idle") return "空闲";
  if (status === "exited" || status === "stopped") return "已结束";
  if (status === "failed") return "失败";
  return status || "会话";
}

function taskSessionGlow(status: string): string {
  if (issueSessionRunning(status)) return "running";
  if (status === "thinking") return "thinking";
  if (status === "waiting-input" || status === "waiting_input") return "waiting-input";
  if (status === "failed") return "failed";
  return "none";
}

/**
 * 就地展开收起后的「焦点归还」，看板卡片与列表行共用一份。
 *
 * 面板收起时是带着焦点一起变 inert 的（用户没点收起，而是改了筛选、换了视图、按了 Esc），
 * 浏览器会把焦点丢回 body，键盘用户就此失去位置。这里记住展开那一刻的触发按钮，
 * 只在「由开转关」且焦点确实被甩掉时还回去：
 *   - 触发按钮已经不连着文档（行被筛掉、整块视图换掉）→ 不动焦点；
 *   - 焦点已经在别的元素上（搜索框、下一张卡片、用户刚点的地方）→ 不抢焦点。
 * 归还只在同一个 openId 从有到无时触发；换成别的 id 说明是点开下一张，焦点本来就在新触发点上。
 */
export function useExpansionFocusReturn(openId: string): (id: string) => (element: HTMLElement | null) => void {
  const triggers = React.useRef(new Map<string, HTMLElement>());
  const lastOpenId = React.useRef("");
  const bind = React.useCallback((id: string) => (element: HTMLElement | null): void => {
    if (element) triggers.current.set(id, element);
    else triggers.current.delete(id);
  }, []);
  React.useEffect(() => {
    const previous = lastOpenId.current;
    lastOpenId.current = openId;
    if (!previous || openId) return;
    const trigger = triggers.current.get(previous);
    if (!trigger?.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    trigger.focus();
  }, [openId]);
  return bind;
}

function TaskBoardListRow({
  task,
  parentLabel,
  allTasks,
  expanded,
  onToggle,
  onOpen,
  onOpenSession,
  onOpenComments,
  bindTrigger,
}: {
  task: WandTaskListed;
  parentLabel?: string;
  allTasks: WandTaskListed[];
  expanded: boolean;
  onToggle(): void;
  onOpen(id: string): void;
  onOpenSession?: (sessionId: string) => void;
  onOpenComments?(id: string): void;
  bindTrigger(id: string): (element: HTMLElement | null) => void;
}): React.ReactElement {
  const description = task.description.trim();
  const triggerRef = React.useMemo(() => bindTrigger(task.id), [bindTrigger, task.id]);
  return <Card
    className={classNames("task-board-list-row", expanded && "is-open", task.status === "archived" && "is-archived")}
    onClick={(event) => {
      if ((event.target as HTMLElement).closest("button, a")) return;
      onToggle();
    }}
  >
    <WandButton kind="ghost"
      type="button"
      ref={triggerRef}
      className="task-board-list-title"
      aria-expanded={expanded}
      aria-controls={`task-list-detail-${task.id}`}
      aria-label={`${expanded ? "收起" : "展开"} ${task.identifier}: ${task.title}`}
      onClick={onToggle}
    >
      <WandIcon name="chevron" size={12} className="task-board-list-chevron"/>
      <small>{task.identifier}{parentLabel ? ` ↳ ${parentLabel}` : ""}</small>
      <strong>{task.title}</strong>
    </WandButton>
    <Flex wrap align="center" gap={4} className="task-board-list-meta">
      <Typography.Text type={taskHumanAccepted(task) ? "success" : "secondary"}>{taskAcceptanceLabel(task.acceptance, task)}</Typography.Text>
      <TaskBoardPriorityChip priority={task.priority}/>
      {task.milestone ? <TaskBoardMilestoneChip name={task.milestone.name}/> : null}
      {task.labels.slice(0, 2).map((label) => <TaskBoardLabelChip key={label} label={label}/>)}
      {task.dueDate ? <span className="task-board-due"><TaskBoardDueIcon size={12}/>{issueDueStamp(task.dueDate)}</span> : null}
      <span>{task.workspace?.name ?? "未归属工作区"}</span>
      <TaskBoardConversationButton sessions={task.sessions} onOpen={onOpenSession}/>
      <TaskBoardCommentCountButton task={task} onOpen={() => onOpenComments?.(task.id)}/>
      <time>{formatIssueStamp(task.updatedAt)}</time>
    </Flex>
    <TaskGoalChildren task={task} tasks={allTasks} onOpen={onOpen}/>
    <Collapse bordered={false} ghost activeKey={expanded ? ["details"] : []}
      styles={{ header: { display: "none" }, body: { padding: 0 } }}
      items={[{ key: "details", label: "任务详情", forceRender: true, showArrow: false, children: <div className="task-board-list-detail" id={`task-list-detail-${task.id}`} inert={!expanded}>
      <div className="task-board-list-detail-inner">
        <p>
          <span>{issueTaskStatusLabel(task)}</span>
          <span>更新于 {formatIssueStamp(task.updatedAt)}</span>
        </p>
        {description ? <Typography.Paragraph className="task-board-list-description" ellipsis={{ rows: 4, expandable: "collapsible", symbol: (expanded) => expanded ? "收起全文" : "展开全文" }} style={{ whiteSpace: "pre-wrap", margin: "8px 0" }}>{description}</Typography.Paragraph> : null}
        <div aria-label="全部任务标签">{task.labels.map((label) => <TaskBoardLabelChip key={label} label={label}/>)}</div>
        {task.workspace?.cwd && <p><code>{task.workspace.cwd}</code></p>}
        {task.sessions.length > 0 ? (
          <ul>
            {task.sessions.map((session) => {
              const glow = taskSessionGlow(session.status);
              return (
                <li key={session.id}>
                  <WandButton kind="ghost" type="button" onClick={() => onOpenSession?.(session.id)} data-session-glow={glow}>
                    <ProviderLogo
                      provider={session.provider}
                      className={classNames("task-board-agent-logo", glow !== "none" && `wand-logo-glow glow-${glow}`)}
                    />
                    <span>{session.title || issueAgentLabel(session.provider, session.engine)}</span>
                    <small>{sessionStatusLabel(session.status)}</small>
                    <code>{session.cwd}</code>
                  </WandButton>
                </li>
              );
            })}
          </ul>
        ) : <p className="task-board-list-description">还没有关联会话</p>}
        <WandButton kind="ghost" type="button" className="task-board-list-open" onClick={() => onOpen(task.id)}>
          查看详情
        </WandButton>
      </div>
    </div> }]}/>
  </Card>;
}

/**
 * 看板卡片的就地展开面板，和 TaskBoardListRow 同一套语义（aria-expanded + aria-controls + inert），
 * 差别有两处：卡片整面都是触发区，所以面板里必须自带「收起」按钮；
 * 面板要比重叠态多东西，因此列出的是带状态与运行目录的会话，而不是卡片上那排可拖拽的简版行。
 */
export function TaskBoardCardDetail({
  task,
  open,
  parentLabel,
  childCount,
  onOpen,
  onCollapse,
  onOpenSession,
}: {
  task: WandTaskListed;
  open: boolean;
  parentLabel?: string;
  childCount: number;
  onOpen(id: string): void;
  onCollapse(): void;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement {
  const description = task.description.trim();
  const catalog = useWandModelCatalog();
  const agent = task.agent;
  const assignee = <TaskBoardAgentChips sessions={task.sessions} assigned={agent} subject={task.executionSubject} assignee={task.assignedExecutor}/>;
  const fields = [
    { key: "status", label: "状态", children: issueTaskStatusLabel(task) },
    { key: "assignee", label: "负责人", children: assignee },
    { key: "priority", label: "优先级", children: issuePriorityLabel(task.priority) },
    { key: "workspace", label: "项目", children: <Flex vertical><span>{task.workspace?.name ?? "未归属工作区"}</span>{task.workspace?.cwd && <Typography.Text code>{task.workspace.cwd}</Typography.Text>}</Flex> },
    ...(agent ? [{ key: "model", label: "模型", children: `${issueAgentProviderModelLine(agent, catalog)} · ${issueAgentEffortLabel(agent.thinkingEffort)}` }] : []),
    { key: "milestone", label: "迭代", children: task.milestone?.name ?? "默认迭代" },
    { key: "due", label: "截止", children: task.dueDate ? issueDueStamp(task.dueDate) : "未设置" },
    { key: "updated", label: "更新", children: formatIssueStamp(task.updatedAt) },
    ...(parentLabel ? [{ key: "parent", label: "父任务", children: parentLabel }] : []),
    ...(childCount > 0 ? [{ key: "children", label: "子任务", children: `${childCount} 个` }] : []),
  ];
  return <Collapse bordered={false} ghost activeKey={open ? ["details"] : []}
    styles={{ header: { display: "none" }, body: { padding: 0 } }}
    items={[{ key: "details", label: "任务详情", showArrow: false, forceRender: true, children:
      <div className="task-board-card-detail" id={`task-card-detail-${task.id}`} inert={!open}>
        <Flex vertical gap="middle" className="task-board-card-detail-inner">
          <Descriptions size="small" column={1} items={fields}/>
          {task.labels.length > 0 && <Flex wrap gap={4} aria-label="全部任务标签">{task.labels.map((label) => <TaskBoardLabelChip key={label} label={label}/>)}</Flex>}
          <Typography.Paragraph ellipsis={{ rows: 4, expandable: "collapsible", symbol: (expanded) => expanded ? "收起全文" : "展开全文" }} style={{ whiteSpace: "pre-wrap", margin: 0 }}>{description || "还没有填写任务说明。"}</Typography.Paragraph>
          {task.sessions.length > 0 && <Flex vertical gap="small" className="task-board-card-detail-sessions" aria-label="关联会话">
            {task.sessions.map(session => <Flex key={session.id} align="center" justify="space-between" gap="small" wrap>
              <Flex vertical style={{ minWidth: 0 }}>
                <Typography.Text strong>{session.employeeName ? `${session.employeeName} · ` : ""}{session.title || issueAgentLabel(session.provider, session.engine)}</Typography.Text>
                <Typography.Text type="secondary">{session.provider}{session.model ? ` · ${session.model}` : ""} · {session.status}</Typography.Text>
                {session.cwd && <Typography.Text code>{session.cwd}</Typography.Text>}
              </Flex>
              <WandButton kind="ghost" size="small" onClick={() => onOpenSession?.(session.id)}>打开会话</WandButton>
            </Flex>)}
          </Flex>}
          <Typography.Text type="secondary">任务摘要与执行记录请在详情事项流中查看。</Typography.Text>
          <Flex wrap gap="small" className="task-board-card-detail-actions">
            <WandButton kind="ghost" type="button" className="task-board-card-detail-open" onClick={() => onOpen(task.id)}>查看完整详情</WandButton>
            <WandButton kind="ghost" type="button" className="task-board-card-detail-collapse" onClick={() => onCollapse()}>收起</WandButton>
          </Flex>
        </Flex>
      </div>,
    }]}/>;
}

export function TaskBoardListView({
  archiveOnly = false,
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
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const bindTrigger = useExpansionFocusReturn(expandedId ?? "");
  const toggleExpanded = (id: string): void => {
    setExpandedId((current) => current === id ? null : id);
  };
  const archived = grouped.archived;
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
            <WandIcon name={isCollapsed ? "chevronLeft" : "chevron"} size={12}/>
            <TaskBoardStatusGlyph status={column.status}/>
            <strong>{column.label}</strong>
          </span>
          <b>{items.length}</b>
        </WandButton>
        {!isCollapsed && <Flex vertical gap="small" className="task-board-list-rows">
          {items.length === 0 && column.status !== "ready" && <p className="task-board-column-empty">{column.empty}</p>}
          {items.length === 0 && column.status === "ready" && archived.length === 0 && <p className="task-board-column-empty">{column.empty}</p>}
          {items.map((task) => <TaskBoardListRow
            key={task.id}
            task={task}
            allTasks={allTasks}
            expanded={expandedId === task.id}
            parentLabel={allTasks.find((parent) => parent.id === task.parentTaskId)?.identifier}
            onToggle={() => toggleExpanded(task.id)}
            onOpen={onOpen}
            onOpenSession={onOpenSession}
            onOpenComments={onOpenComments}
            bindTrigger={bindTrigger}
          />)}
          {!archiveOnly && column.status === "ready" && archiveOpen && archived.length > 0 ? <TaskBoardArchiveFolder
            count={archiveCount}
            open={archiveOpen}
            onToggle={onToggleArchive}
            onPurge={onPurgeArchive}
            purging={archivePurging}
          >
            <Flex vertical gap="small" className="task-board-archive-rows">
              {archived.map((task) => <TaskBoardListRow
                key={task.id}
                task={task}
                allTasks={allTasks}
                expanded={expandedId === task.id}
                parentLabel={allTasks.find((parent) => parent.id === task.parentTaskId)?.identifier}
                onToggle={() => toggleExpanded(task.id)}
                onOpen={onOpen}
                onOpenSession={onOpenSession}
                onOpenComments={onOpenComments}
                bindTrigger={bindTrigger}
              />)}
            </Flex>
          </TaskBoardArchiveFolder> : null}
        </Flex>}
      </section>;
    })}
  </Flex>;
}

export function TaskBoardDashboard({ tasks, projectName, onOpen, onStage, actionHub }: {
  allTasks?: WandTaskListed[]; projectName: string; tasks: WandTaskListed[];
  onOpen(id: string): void; onOpenSession?: (sessionId: string) => void;
  onStage?(status: WandTaskStatus): void; actionHub?: React.ReactNode;
}): React.ReactElement {
  const goals = tasks.filter(task => !task.parentTaskId), stats = issueBoardStats(goals);
  const active = goals.filter(task => task.status !== "archived");
  const ready = active.filter(task => task.status === "ready" && taskAiVerified(task));
  const review = active.filter(task => taskWorkflowStage(task.status) === "review");
  const running = active.filter(task => task.executionStatus === "running" || task.sessions.some(session => taskSessionActivity(session) === "运行中"));
  const gaps = active.filter(task => task.acceptance?.blocker.trim());
  const due = [...active].filter(task => task.dueDate).sort((a,b) => a.dueDate!.localeCompare(b.dueDate!)).slice(0,4);
  const series = issueProgressSeries(goals), maximum = Math.max(1, stats.accepted);
  const points = series.map((point, index) => `${20 + index * 36},${120 - point.completed / maximum * 88}`).join(" ");
  const count = (status: WandTaskStatus): number => status === "backlog" ? stats.backlog : status === "todo" ? stats.todo : status === "doing" ? stats.doing : status === "review" ? stats.review : stats.ready;
  const row = (task: WandTaskListed, caption?: string): React.ReactElement => <WandButton kind="ghost" key={task.id} className="task-panel-summary-row" onClick={() => onOpen(task.id)}>
    <span><strong>{task.title}</strong><small>{caption || `${task.identifier} · ${task.assignedExecutor?.name || "未指派"}`}</small></span><WandIcon name="chevron" size={12}/>
  </WandButton>;
  const panel = (title: string, children: React.ReactNode, extra?: React.ReactNode): React.ReactElement => <Card title={title} extra={extra} size="small" className="task-panel-analysis">{children}</Card>;
  return <div className="task-board-dashboard task-panel-dashboard">
    <div className="task-panel-overview"><div><Typography.Text type="secondary">项目完成度 · 人工确认口径</Typography.Text><div className="task-panel-completion"><strong>{stats.total ? Math.round(stats.accepted / stats.total * 100) : 0}<small>%</small></strong><span>{stats.accepted} / {stats.total} 个主目标已确认</span></div></div>
      <div className="task-panel-summary"><Typography.Title level={3}>{projectName}</Typography.Title><Typography.Paragraph>当前 {active.length} 个主目标推进中，<WandButton kind="ghost" onClick={() => onStage?.("review")}>{review.length} 项待 AI 验收</WandButton>，<WandButton kind="ghost" onClick={() => onStage?.("ready")}>{ready.length} 项待你确认归档</WandButton>。{gaps.length ? `另有 ${gaps.length} 项验收缺口。` : ""}</Typography.Paragraph><Typography.Text type="secondary">AI 通过不代表人工已接受，不提前计入完成度。旧记录未核对前不自动认定通过。</Typography.Text></div>
    </div>
    <section className="task-panel-metrics" aria-label="五阶段统计">{ISSUE_COLUMNS.map(column => <WandButton key={column.status} kind="ghost" className={`task-panel-metric is-${column.status}`} aria-label={`查看${column.label}任务`} onClick={() => onStage?.(column.status)}>
      <span><TaskBoardStatusGlyph status={column.status}/>{column.label}</span><strong>{count(column.status)}</strong><Progress showInfo={false} percent={active.length ? count(column.status) / active.length * 100 : 0} strokeColor={column.status === "ready" ? "var(--success)" : column.status === "review" ? "var(--info, var(--accent))" : column.status === "doing" ? "var(--accent)" : "var(--text-secondary)"} size="small"/>
    </WandButton>)}</section>
    <div className="task-panel-section-title"><Typography.Title level={5}>先看需要你决定的事</Typography.Title><Typography.Text type="secondary">AI 做验收，你确认交付</Typography.Text></div>
    <Card title={`待你确认归档 · ${ready.length}`} extra={<WandButton kind="ghost" onClick={() => onStage?.("ready")}>查看全部</WandButton>} size="small" className="task-panel-ready">
      {ready.length ? ready.slice(0,6).map(task => <div className="task-panel-ready-row" key={task.id}><WandIcon name="shieldCheck" size={18}/><WandButton kind="ghost" onClick={() => onOpen(task.id)}><strong>{task.title}</strong><small>{task.identifier} · {task.assignedExecutor?.name || "负责人未记录"} · AI 已通过</small></WandButton><Typography.Text type="secondary">人工未确认</Typography.Text><WandButton onClick={() => onOpen(task.id)}>查看交付</WandButton></div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有等待你确认的交付"/>}
    </Card>
    {actionHub && <Collapse className="task-panel-action-hub" items={[{ key:"actions", label:"授权、待答与其他待处理事项", children:actionHub }]}/>}
    <div className="task-panel-section-title"><Typography.Title level={5}>项目分析</Typography.Title><Typography.Text type="secondary">{running.length} 项正在执行 · {gaps.length} 项有缺口 · {stats.overdue} 项已逾期</Typography.Text></div>
    <div className="task-panel-analysis-grid">
      {panel("AI 验收队列", review.length ? review.slice(0,5).map(task => row(task, `${task.identifier} · ${task.legacyReview ? "历史交付待核对" : task.executionStatus === "running" ? "正在核验" : task.executionStatus === "queued" ? "验收已排队 · 等待员工空闲" : "交付已提交 · 查看核验进度与回执"}`)) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待 AI 验收任务"/>)}
      {panel("执行与返工", gaps.length || running.length ? [...gaps, ...running.filter(task => !gaps.includes(task))].slice(0,5).map(task => row(task, task.acceptance?.blocker || `${task.identifier} · 正在执行`)) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有执行或返工项目"/>)}
      {panel("优先级分布", <div className="task-panel-distribution">{ISSUE_PRIORITIES.filter(entry => entry.value !== "none").map(entry => { const n = active.filter(task => task.priority === entry.value).length; return <div key={entry.value}><span>{entry.label}</span><Progress showInfo={false} size="small" percent={active.length ? n / active.length * 100 : 0}/><b>{n}</b></div>; })}<Typography.Text type="secondary">按未归档主目标统计，不重复计算子任务。</Typography.Text></div>)}
      {panel("累计人工确认", <><svg className="task-panel-trend" viewBox="0 0 475 150" role="img" aria-label="基于已记录确认时间的累计人工确认"><path d="M20 120H452 M20 32H452" stroke="var(--border-subtle)" fill="none"/><polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="2"/><text x="20" y="145" fontSize="11" fill="var(--text-secondary)">记录开始</text><text x="420" y="145" fontSize="11" fill="var(--text-secondary)">当前</text></svg><Typography.Text type="secondary">只计入明确人工确认的记录；不推测缺失历史。</Typography.Text></>)}
      {panel("近期到期", due.length ? due.map(task => row(task, `${task.identifier} · ${task.dueDate} · ${issueStatusLabel(task.status)}`)) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有设置截止日期"/>)}
      {panel("负责人交付", <div className="task-panel-owner-delivery">{[...new Set(goals.map(task => task.assignedExecutor?.id).filter(Boolean))].map(id => { const owned = goals.filter(task => task.assignedExecutor?.id === id); return <div key={id}><strong>{owned[0].assignedExecutor?.name}</strong><span>{owned.filter(taskHumanAccepted).length} 项人工确认 · {owned.filter(task => task.status === "ready").length} 项待归档</span></div>; })}{!goals.some(task => task.assignedExecutor) && <Typography.Text type="secondary">暂无已记录的负责人</Typography.Text>}</div>)}
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
  onClose,
}: {
  x: number;
  y: number;
  task: WandTaskListed;
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
          { key: "dispatch", label: "派发 Agent", icon: <WandIcon name="zap"/>, onClick: onDispatch },
          ...(canArchiveBoardTask(task) ? [{ key: "archive", label: "归档", icon: <WandIcon name="archive"/>, onClick: onArchive }] : []),
        ]),
  ];
  return <Dropdown open autoFocus placement="bottomLeft" trigger={[]}
    onOpenChange={(open) => { if (!open) onClose(); }}
    menu={{ items: actions.map((action) => ({ ...action, onClick: () => { action.onClick(); onClose(); } })) }}
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

export function TaskBoardProjectChip({ name }: { name: string }): React.ReactElement {
  return <Tag className="task-board-chip" title={name}>
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
