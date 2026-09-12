import * as React from "react";
import type { WandTaskAgent, WandTaskPriority, WandTaskStatus } from "../../../task-types";
import { ProviderLogo } from "../provider-logo";
import { WandIcon, WandPopover, WandSwitch } from "../ui";
import { classNames } from "../ui/class-names";
import {
  collectIssueLabels,
  EMPTY_ISSUE_FILTERS,
  formatIssueStamp,
  groupIssueSessionsByAgent,
  ISSUE_COLUMNS,
  ISSUE_GANTT_ZOOMS,
  ISSUE_PRIORITIES,
  issueAgentEffortLabel,
  issueAgentProviderLabel,
  issueBoardStats,
  issueDueStamp,
  issueFilterCount,
  issueGanttRange,
  issueGanttSpan,
  issueIsOverdue,
  issueLabelColor,
  issueLabelName,
  issueLabelTone,
  issuePriorityLabel,
  issueProgressSeries,
  issueSessionRunning,
  listIssueAgents,
  type IssueBoardDisplay,
  type IssueBoardFilters,
  type IssueGanttZoom,
} from "./task-board-agent";
import {
  TaskBoardCompleteIcon,
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
  return <span className={`task-board-priority is-${priority}`}>
    <TaskBoardPriorityIcon priority={priority} size={14}/>
    {issuePriorityLabel(priority)}
  </span>;
}

export function TaskBoardLabelChip({ label }: { label: string }): React.ReactElement {
  const tone = issueLabelTone(label);
  return <span
    className={classNames("task-board-label", tone && `is-${tone}`)}
    style={tone ? undefined : { "--label-color": issueLabelColor(label) } as React.CSSProperties}
  >
    <i aria-hidden="true"/>
    <span>{issueLabelName(label)}</span>
  </span>;
}

export function TaskBoardConversationButton({
  sessions,
  onOpen,
}: {
  sessions: IssueSessionSummary[];
  onOpen?: (sessionId: string) => void;
}): React.ReactElement | null {
  if (sessions.length === 0) return null;
  const multiple = sessions.length > 1;
  if (!multiple) {
    return <button
      type="button"
      className="task-board-conversation"
      title={sessions[0]!.title || sessions[0]!.id}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen?.(sessions[0]!.id);
      }}
    >
      <TaskBoardConversationIcon size={16}/>
    </button>;
  }
  return <WandPopover
    align="end"
    side="bottom"
    sideOffset={6}
    showArrow={false}
    ariaLabel="关联会话"
    className="task-board-conversation-menu"
    trigger={<button
      type="button"
      className="task-board-conversation is-multiple"
      aria-label={`查看 ${sessions.length} 个会话`}
      onClick={(event) => event.stopPropagation()}
    >
      <TaskBoardConversationIcon size={16}/>
      <span>+{sessions.length}</span>
    </button>}
  >
    <div className="task-board-conversation-menu-heading">关联会话</div>
    {sessions.map((session) => <button
      key={session.id}
      type="button"
      role="menuitem"
      onClick={() => onOpen?.(session.id)}
    >
      <ProviderLogo provider={session.provider} className="task-board-agent-logo"/>
      <span>
        <strong>{session.title || issueAgentProviderLabel(session.provider)}</strong>
        <small>{issueAgentProviderLabel(session.provider)}{session.model ? ` · ${session.model}` : ""}</small>
      </span>
    </button>)}
  </WandPopover>;
}

export function TaskBoardProcessingRow({
  task,
  onOpenSession,
}: {
  task: WandTaskListed;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement | null {
  if (task.status !== "doing") return null;
  const running = task.sessions.some((session) => issueSessionRunning(session.status));
  return <div className={classNames("task-board-processing", running && "is-running")}>
    {running ? <TaskBoardProcessingGlyph/> : null}
    <span className="task-board-processing-label">{running ? "正在处理..." : task.sessions.length > 0 ? "暂停处理" : "等待派发"}</span>
    <span className="task-board-processing-spacer" aria-hidden="true"/>
    <TaskBoardConversationButton sessions={task.sessions} onOpen={onOpenSession}/>
  </div>;
}

export function TaskBoardProgressRow({ task }: { task: WandTaskListed }): React.ReactElement | null {
  if (task.status !== "doing") return null;
  const total = Math.max(4, task.sessions.length + 2);
  const completed = task.sessions.filter((session) => session.status === "exited" || session.status === "idle").length;
  return <div className="task-board-progress-row">
    <div className={classNames("task-board-progress-segments", task.sessions.some((session) => issueSessionRunning(session.status)) && "is-running")} aria-hidden="true">
      {Array.from({ length: total }, (_, index) => <span key={index} className={index < completed ? "is-complete" : undefined}/>)}
    </div>
  </div>;
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
    showArrow={false}
    ariaLabel="筛选任务"
    className="task-board-filter-menu"
    trigger={<button
      type="button"
      className={classNames("task-board-icon-button", count > 0 && "is-active")}
      aria-label={count > 0 ? `筛选（${count}）` : "筛选"}
      title="筛选"
    >
      <TaskBoardFilterIcon size={14}/>
      {count > 0 ? <b>{count}</b> : null}
    </button>}
  >
    <strong>筛选</strong>
    <p>状态</p>
    {ISSUE_COLUMNS.map((column) => <label key={column.status}>
      <input
        type="checkbox"
        checked={filters.statuses.includes(column.status)}
        onChange={() => onChange({ ...filters, statuses: toggleValue(column.status, filters.statuses) })}
      />
      <TaskBoardStatusIcon status={column.status} size={14}/>
      {column.label}
    </label>)}
    <p>优先级</p>
    {ISSUE_PRIORITIES.map((entry) => <label key={entry.value}>
      <input
        type="checkbox"
        checked={filters.priorities.includes(entry.value)}
        onChange={() => onChange({ ...filters, priorities: toggleValue(entry.value, filters.priorities) })}
      />
      <TaskBoardPriorityIcon priority={entry.value} size={14}/>
      {entry.label}
    </label>)}
    {labels.length > 0 && <>
      <p>标签</p>
      {labels.map((label) => <label key={label}>
        <input
          type="checkbox"
          checked={filters.labels.includes(label)}
          onChange={() => onChange({ ...filters, labels: toggleValue(label, filters.labels) })}
        />
        <TaskBoardLabelChip label={label}/>
      </label>)}
    </>}
    {count > 0 && <button type="button" className="task-board-filter-clear" onClick={() => onChange(EMPTY_ISSUE_FILTERS)}>
      清除筛选
    </button>}
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
    showArrow={false}
    ariaLabel="显示设置"
    className="task-board-display-menu"
    trigger={<button type="button" className="task-board-icon-button" aria-label="显示设置" title="显示设置">
      <TaskBoardPanelIcon size={15}/>
    </button>}
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
      return <label key={column.status} className="task-board-display-status">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => {
            const mainStatuses = checked
              ? display.mainStatuses.filter((status) => status !== column.status)
              : [...display.mainStatuses, column.status];
            onChange({
              ...display,
              mainStatuses: mainStatuses.length > 0 ? mainStatuses : [column.status],
            });
          }}
        />
        <TaskBoardStatusIcon status={column.status} size={14}/>
        {column.label}
      </label>;
    })}
  </WandPopover>;
}

export function TaskBoardListView({
  grouped,
  collapsed,
  onToggle,
  onOpen,
  onOpenSession,
}: {
  grouped: Record<WandTaskStatus, WandTaskListed[]>;
  collapsed: Record<WandTaskStatus, boolean>;
  onToggle(status: WandTaskStatus): void;
  onOpen(id: string): void;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement {
  return <div className="task-board-list-view">
    {ISSUE_COLUMNS.map((column) => {
      const items = grouped[column.status];
      const isCollapsed = collapsed[column.status];
      return <section key={column.status} className={`task-board-list-group is-${column.status}`}>
        <button
          type="button"
          className="task-board-list-header"
          aria-expanded={!isCollapsed}
          onClick={() => onToggle(column.status)}
        >
          <WandIcon name={isCollapsed ? "chevronLeft" : "chevron"} size={12}/>
          <TaskBoardStatusGlyph status={column.status}/>
          <strong>{column.label}</strong>
          <span>{items.length}</span>
        </button>
        {!isCollapsed && <div className="task-board-list-rows">
          {items.length === 0 && <p className="task-board-column-empty">{column.empty}</p>}
          {items.map((task) => <div
            key={task.id}
            role="button"
            tabIndex={0}
            className="task-board-list-row"
            onClick={() => onOpen(task.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(task.id);
              }
            }}
          >
            <span className="task-board-list-title">
              <small>{task.identifier}</small>
              <strong>{task.title}</strong>
            </span>
            <span className="task-board-list-meta" onClick={(event) => event.stopPropagation()}>
              <TaskBoardPriorityChip priority={task.priority}/>
              {task.labels.slice(0, 2).map((label) => <TaskBoardLabelChip key={label} label={label}/>)}
              {task.dueDate ? <span className="task-board-due"><TaskBoardDueIcon size={12}/>{issueDueStamp(task.dueDate)}</span> : null}
              <span>{task.workspace?.name ?? "未指定项目"}</span>
              <TaskBoardConversationButton sessions={task.sessions} onOpen={onOpenSession}/>
              <time>{formatIssueStamp(task.updatedAt)}</time>
            </span>
          </div>)}
        </div>}
      </section>;
    })}
  </div>;
}

export function TaskBoardDashboard({
  projectName,
  tasks,
  onOpen,
  onOpenSession,
}: {
  projectName: string;
  tasks: WandTaskListed[];
  onOpen(id: string): void;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement {
  const stats = issueBoardStats(tasks);
  const series = issueProgressSeries(tasks);
  const max = Math.max(1, ...series.map((point) => point.scope));
  const path = (key: "scope" | "started" | "completed"): string => series
    .map((point, index) => {
      const x = (index / Math.max(1, series.length - 1)) * 426;
      const y = 250 - (point[key] / max) * 220;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const dueSoon = [...tasks]
    .filter((task) => task.dueDate && task.status !== "done")
    .sort((left, right) => (left.dueDate ?? "").localeCompare(right.dueDate ?? ""))
    .slice(0, 6);
  const byPriority = ISSUE_PRIORITIES.map((entry) => ({
    ...entry,
    count: tasks.filter((task) => task.priority === entry.value).length,
  })).filter((entry) => entry.count > 0);
  const labels = collectIssueLabels(tasks).map((label) => ({
    label,
    count: tasks.filter((task) => task.labels.includes(label)).length,
  }));
  const summary = stats.remaining === 0
    ? `${projectName} 当前没有未完成任务。`
    : `${projectName} 还有 ${stats.remaining} 项未完成，其中 ${stats.doing} 项正在处理、${stats.todo} 项等待认领。`;
  const metric = (
    label: string,
    value: number,
    tone: string,
    total = stats.total,
  ): React.ReactElement => <article className={`task-board-metric tone-${tone}`}>
    <span className="task-board-metric-label">{label}</span>
    <div className="task-board-metric-value">
      <strong>{value}</strong>
      <b>{total ? Math.round((value / total) * 100) : 0}%</b>
    </div>
    <span className="task-board-metric-meter"><i style={{ width: `${total ? (value / total) * 100 : 0}%` }}/></span>
  </article>;

  return <div className="task-board-dashboard">
    <div className="task-board-dashboard-content">
      <div className="task-board-dashboard-overview">
        <header className="task-board-dashboard-heading">
          <h1>{projectName}</h1>
          <p className="task-board-hero-value">
            <strong>{stats.remaining}</strong>
            <span>未完成</span>
          </p>
        </header>
        <div className="task-board-dashboard-summary">
          <div className="task-board-summary-bubble"><p>{summary}</p></div>
        </div>
      </div>
      <div className="task-board-metrics">
        {metric("处理中", stats.doing, "doing")}
        {metric("等你确认", stats.done, "done")}
        {metric("等待认领", stats.todo, "todo")}
        {metric("已逾期", stats.overdue, "overdue")}
        {metric("高优先级", stats.high, "high")}
      </div>
      <section className="task-board-progress-panel" aria-label="进度">
        <header>
          <span>进度</span>
          <div className="task-board-progress-legend">
            <span className="tone-scope"><i/>范围 <strong>{stats.total}</strong></span>
            <span className="tone-started"><i/>已开始 <strong>{stats.doing + stats.done}</strong></span>
            <span className="tone-completed"><i/>已确认 <strong>{stats.done}</strong></span>
          </div>
        </header>
        <svg className="task-board-progress-chart" viewBox="0 0 426 272" role="img" aria-label="任务进度图">
          <path d="M0 250h426" className="task-board-progress-baseline"/>
          <path d={path("scope")} className="task-board-progress-line is-scope"/>
          <path d={path("started")} className="task-board-progress-line is-started"/>
          <path d={path("completed")} className="task-board-progress-line is-completed"/>
        </svg>
      </section>
      <div className="task-board-dashboard-grid">
        <section className="task-board-dashboard-panel">
          <header><span>即将到期</span></header>
          {dueSoon.length === 0 ? <p className="task-board-column-empty">没有设置截止日期的任务</p> : dueSoon.map((task) => <button
            key={task.id}
            type="button"
            className="task-board-dashboard-row"
            onClick={() => onOpen(task.id)}
          >
            <TaskBoardStatusGlyph status={task.status}/>
            <strong>{task.title}</strong>
            <span className={classNames("task-board-due", issueIsOverdue(task.dueDate, task.status) && "is-overdue")}>
              <TaskBoardDueIcon size={12}/>{issueDueStamp(task.dueDate)}
            </span>
          </button>)}
        </section>
        <section className="task-board-dashboard-panel">
          <header><span>优先级</span></header>
          {byPriority.length === 0 ? <p className="task-board-column-empty">还没有优先级分布</p> : byPriority.map((entry) => <div key={entry.value} className="task-board-stack-row">
            <TaskBoardPriorityIcon priority={entry.value} size={14}/>
            <span>{entry.label}</span>
            <b>{entry.count}</b>
            <i style={{ width: `${(entry.count / Math.max(1, stats.total)) * 100}%` }}/>
          </div>)}
        </section>
        <section className="task-board-dashboard-panel">
          <header><span>标签</span></header>
          {labels.length === 0 ? <p className="task-board-column-empty">还没有标签</p> : labels.map((entry) => <div key={entry.label} className="task-board-stack-row">
            <TaskBoardLabelChip label={entry.label}/>
            <b>{entry.count}</b>
          </div>)}
        </section>
        <section className="task-board-dashboard-panel">
          <header><span>最近会话</span></header>
          {tasks.flatMap((task) => task.sessions.map((session) => ({ task, session }))).slice(0, 6).map(({ task, session }) => <button
            key={session.id}
            type="button"
            className="task-board-dashboard-row"
            onClick={() => onOpenSession?.(session.id)}
          >
            <ProviderLogo provider={session.provider} className="task-board-agent-logo"/>
            <strong>{task.title}</strong>
            <span>{issueAgentProviderLabel(session.provider)}</span>
          </button>)}
          {tasks.every((task) => task.sessions.length === 0) && <p className="task-board-column-empty">还没有派发会话</p>}
        </section>
      </div>
    </div>
  </div>;
}

export function TaskBoardGantt({
  grouped,
  zoom,
  hideCompleted,
  onZoom,
  onHideCompleted,
  onOpen,
}: {
  grouped: Record<WandTaskStatus, WandTaskListed[]>;
  zoom: IssueGanttZoom;
  hideCompleted: boolean;
  onZoom(zoom: IssueGanttZoom): void;
  onHideCompleted(hide: boolean): void;
  onOpen(id: string): void;
}): React.ReactElement {
  const tasks = ISSUE_COLUMNS.flatMap((column) => grouped[column.status])
    .filter((task) => !(hideCompleted && task.status === "done"));
  const range = issueGanttRange(tasks, zoom);
  return <div className="task-board-gantt">
    <div className="task-board-gantt-toolbar">
      <label className="task-board-gantt-hide">
        <input type="checkbox" checked={hideCompleted} onChange={(event) => onHideCompleted(event.currentTarget.checked)}/>
        隐藏已确认
      </label>
      <div className="task-board-gantt-zooms">
        {ISSUE_GANTT_ZOOMS.map((entry) => <button
          key={entry.value}
          type="button"
          className={classNames(zoom === entry.value && "is-active")}
          onClick={() => onZoom(entry.value)}
        >
          {entry.label}
        </button>)}
      </div>
    </div>
    <div className="task-board-gantt-scroll">
      <div className="task-board-gantt-grid" style={{ "--gantt-days": range.days } as React.CSSProperties}>
        <div className="task-board-gantt-head">
          <span>任务</span>
          <div>
            {range.columns.map((day) => <b key={day}>{Number(day.slice(8, 10))}</b>)}
          </div>
        </div>
        {ISSUE_COLUMNS.map((column) => {
          const items = grouped[column.status].filter((task) => !(hideCompleted && task.status === "done"));
          if (items.length === 0) return null;
          return <section key={column.status} className={`task-board-gantt-group is-${column.status}`}>
            <header>
              <TaskBoardStatusGlyph status={column.status}/>
              <strong>{column.label}</strong>
              <span>{items.length}</span>
            </header>
            {items.map((task) => {
              const span = issueGanttSpan(task, range.start, range.days);
              return <button
                key={task.id}
                type="button"
                className="task-board-gantt-row"
                onClick={() => onOpen(task.id)}
              >
                <span>
                  <small>{task.identifier}</small>
                  <strong>{task.title}</strong>
                </span>
                <div className="task-board-gantt-track">
                  <i
                    className={`is-${task.status}`}
                    style={{ gridColumn: `${span.offset + 1} / span ${span.length}` }}
                  />
                </div>
              </button>;
            })}
          </section>;
        })}
      </div>
    </div>
  </div>;
}

export function TaskBoardContextMenu({
  x,
  y,
  task,
  onOpen,
  onCopy,
  onDispatch,
  onArchive,
  onClose,
}: {
  x: number;
  y: number;
  task: WandTaskListed;
  onOpen(): void;
  onCopy(): void;
  onDispatch(): void;
  onArchive(): void;
  onClose(): void;
}): React.ReactElement {
  React.useEffect(() => {
    const close = (): void => onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [onClose]);
  return <div
    className="task-board-context-menu"
    role="menu"
    style={{ left: x, top: y }}
    onPointerDown={(event) => event.stopPropagation()}
  >
    <button type="button" role="menuitem" onClick={onOpen}>打开</button>
    <button type="button" role="menuitem" onClick={onCopy}>复制 ID</button>
    <button type="button" role="menuitem" onClick={onDispatch}>派发 Agent</button>
    <button type="button" role="menuitem" className="is-danger" onClick={onArchive}>归档</button>
  </div>;
}

export function TaskBoardCompleteButton({
  onClick,
}: {
  onClick(): void;
}): React.ReactElement {
  return <button type="button" className="task-board-card-complete" onClick={(event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  }}>
    <TaskBoardCompleteIcon/>
    完成
  </button>;
}

export function TaskBoardAgentChip({ agent }: { agent: WandTaskAgent | null }): React.ReactElement | null {
  if (!agent) return null;
  return <span className="task-board-chip is-agent">
    <ProviderLogo provider={agent.provider} className="task-board-agent-logo"/>
    {issueAgentProviderLabel(agent.provider)}
  </span>;
}

export function TaskBoardAgentChips({
  sessions,
  assigned,
}: {
  sessions: IssueSessionSummary[];
  assigned: WandTaskAgent | null;
}): React.ReactElement | null {
  const agents = listIssueAgents(sessions, assigned);
  if (agents.length === 0) return null;
  return <>{agents.map((agent) => <TaskBoardAgentChip key={agent.provider} agent={agent}/>)}</>;
}

function issueSessionStatusLabel(status: string): string {
  if (status === "running") return "进行中";
  if (status === "idle") return "空闲";
  if (status === "exited") return "已结束";
  if (status === "failed") return "失败";
  return status || "会话";
}

export function TaskBoardAgentSessionList({
  sessions,
  assigned,
  onOpenSession,
}: {
  sessions: IssueSessionSummary[];
  assigned: WandTaskAgent | null;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement {
  const groups = groupIssueSessionsByAgent(sessions, assigned);
  if (groups.length === 0) {
    return <div className="task-board-agent-list" aria-label="指派记录">
      <p className="task-board-agent-empty">还没有指派 Agent。</p>
    </div>;
  }
  return <div className="task-board-agent-list" aria-label="已指派的 Agent">
    {groups.map((group) => <section key={group.provider} className="task-board-agent-group">
      <header className="task-board-agent-group-head">
        <ProviderLogo provider={group.agent?.provider ?? group.provider} className="task-board-agent-logo"/>
        <strong>{issueAgentProviderLabel(group.agent?.provider ?? group.provider)}</strong>
        {group.agent ? <span>{group.agent.model === "default" ? "默认模型" : group.agent.model} · {issueAgentEffortLabel(group.agent.thinkingEffort)}</span> : null}
        <b>{group.sessions.length}</b>
      </header>
      {group.sessions.length === 0
        ? <p className="task-board-agent-empty">已指派，等待派发</p>
        : group.sessions.map((session) => <button
            key={session.id}
            type="button"
            className="task-board-agent-session"
            onClick={() => onOpenSession?.(session.id)}
          >
            <span className={classNames("task-board-agent-session-status", issueSessionRunning(session.status) && "is-running")}/>
            <strong>{session.title || issueAgentProviderLabel(session.provider)}</strong>
            <small>
              {[session.model && session.model !== "default" ? session.model : null, issueSessionStatusLabel(session.status)]
                .filter(Boolean)
                .join(" · ")}
            </small>
          </button>)}
    </section>)}
  </div>;
}

export function TaskBoardProjectChip({ name }: { name: string }): React.ReactElement {
  return <span className="task-board-chip" title={name}>
    <TaskBoardFolderIcon size={12}/>
    <span>{name}</span>
  </span>;
}
