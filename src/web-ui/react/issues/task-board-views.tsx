import { WandButton } from "../ui";
import { Alert, Badge, Checkbox, Card, Collapse, Descriptions, Empty, Flex, List, Tag, Progress, Dropdown, Typography } from "antd";
import * as React from "react";
import type { WandTaskAgent, WandTaskPriority, WandTaskStatus } from "../../../task-types";
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

export function TaskBoardConversationButton({
  sessions,
  onOpen,
}: {
  sessions: IssueSessionSummary[];
  onOpen?: (sessionId: string) => void;
}): React.ReactElement | null {
  const catalog = useWandModelCatalog();
  if (sessions.length === 0) return null;
  const multiple = sessions.length > 1;
  if (!multiple) {
    return <WandButton kind="ghost"
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
    </WandButton>;
  }
  return <WandPopover
    align="end"
    side="bottom"
    sideOffset={6}
    ariaLabel="关联会话"
    className="task-board-conversation-menu"
    trigger={<WandButton kind="ghost"
      type="button"
      className="task-board-conversation is-multiple"
      aria-label={`查看 ${sessions.length} 个会话`}
      onClick={(event) => event.stopPropagation()}
    >
      <TaskBoardConversationIcon size={16}/>
      <span>+{sessions.length}</span>
    </WandButton>}
  >
    <div className="task-board-conversation-menu-heading">关联会话</div>
    {sessions.map((session) => <WandButton kind="ghost"
      key={session.id}
      type="button"
      role="menuitem"
      onClick={() => onOpen?.(session.id)}
    >
      <ProviderLogo provider={session.provider} className="task-board-agent-logo"/>
      <span>
        <strong>{session.title || issueAgentLabel(session.provider)}</strong>
        <small>{issueAgentProviderModelLine({ provider: session.provider, model: session.model }, catalog)}</small>
      </span>
    </WandButton>)}
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
  return <Flex align="center" gap="small" className={classNames("task-board-processing", running && "is-running")}>
    {running ? <TaskBoardProcessingGlyph/> : null}
    <span className="task-board-processing-label">{running ? "正在处理..." : task.sessions.length > 0 ? "暂停处理" : "等待派发"}</span>
    <span style={{ flex: 1 }} aria-hidden="true"/>
    <TaskBoardConversationButton sessions={task.sessions} onOpen={onOpenSession}/>
  </Flex>;
}

export function TaskBoardProgressRow({ task }: { task: WandTaskListed }): React.ReactElement | null {
  if (task.status !== "doing" || task.sessions.length === 0) return null;
  const running = task.sessions.filter((session) => issueSessionRunning(session.status)).length;
  return <Typography.Text type="secondary" className="task-board-progress-row">
    {running > 0 ? `${running} 个会话运行中 · 共 ${task.sessions.length} 个关联会话` : `${task.sessions.length} 个关联会话`}
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
  expanded,
  onToggle,
  onOpen,
  onOpenSession,
  bindTrigger,
}: {
  task: WandTaskListed;
  parentLabel?: string;
  expanded: boolean;
  onToggle(): void;
  onOpen(id: string): void;
  onOpenSession?: (sessionId: string) => void;
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
      <TaskBoardPriorityChip priority={task.priority}/>
      {task.milestone ? <TaskBoardMilestoneChip name={task.milestone.name}/> : null}
      {task.labels.slice(0, 2).map((label) => <TaskBoardLabelChip key={label} label={label}/>)}
      {task.dueDate ? <span className="task-board-due"><TaskBoardDueIcon size={12}/>{issueDueStamp(task.dueDate)}</span> : null}
      <span>{task.workspace?.name ?? "未归属工作区"}</span>
      <TaskBoardConversationButton sessions={task.sessions} onOpen={onOpenSession}/>
      <time>{formatIssueStamp(task.updatedAt)}</time>
    </Flex>
    <Collapse bordered={false} ghost activeKey={expanded ? ["details"] : []}
      styles={{ header: { display: "none" }, body: { padding: 0 } }}
      items={[{ key: "details", label: "任务详情", forceRender: true, showArrow: false, children: <div className="task-board-list-detail" id={`task-list-detail-${task.id}`} inert={!expanded}>
      <div className="task-board-list-detail-inner">
        <p>
          <span>{issueStatusLabel(task.status)}</span>
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
  const assignee = agent
    ? `${issueAgentLabel(agent.provider, agent.engine)} · ${issueAgentModeLabel(agent.mode)}`
    : "未指派";
  const fields = [
    { key: "status", label: "状态", children: issueStatusLabel(task.status) },
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
          {task.sessions.length > 0 ? <List size="small" className="task-board-card-detail-sessions" dataSource={task.sessions}
            renderItem={(session) => {
              const glow = taskSessionGlow(session.status);
              return <List.Item>
                <WandButton kind="ghost" type="button" onClick={() => onOpenSession?.(session.id)} title={session.cwd} data-session-glow={glow}
                  style={{ height: "auto", width: "100%", justifyContent: "flex-start", textAlign: "left", whiteSpace: "normal" }}>
                  <Badge status={glow === "failed" ? "error" : glow === "none" ? "default" : "processing"}><ProviderLogo provider={session.provider}/></Badge>
                  <Flex vertical align="flex-start" style={{ minWidth: 0 }}>
                    <Typography.Text>{session.title || issueAgentLabel(session.provider, session.engine)}</Typography.Text>
                    <Typography.Text type="secondary">{sessionStatusLabel(session.status)}</Typography.Text>
                    <Typography.Text code style={{ overflowWrap: "anywhere" }}>{session.cwd}</Typography.Text>
                  </Flex>
                </WandButton>
              </List.Item>;
            }}/>
          : <Typography.Text type="secondary">还没有关联会话。</Typography.Text>}
          <Flex wrap gap="small" className="task-board-card-detail-actions">
            <WandButton kind="ghost" type="button" className="task-board-card-detail-open" onClick={() => onOpen(task.id)}>查看完整详情</WandButton>
            <WandButton kind="ghost" type="button" className="task-board-card-detail-collapse" onClick={() => onCollapse()}>收起</WandButton>
          </Flex>
        </Flex>
      </div>,
    }]}/>;
}

export function TaskBoardListView({
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
}: {
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
}): React.ReactElement {
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const bindTrigger = useExpansionFocusReturn(expandedId ?? "");
  const toggleExpanded = (id: string): void => {
    setExpandedId((current) => current === id ? null : id);
  };
  const archived = grouped.archived;
  return <Flex vertical gap="middle" className="task-board-list-view">
    {ISSUE_COLUMNS.map((column) => {
      const items = grouped[column.status];
      const isCollapsed = column.status === "done" && archiveOpen && archived.length > 0
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
          {items.length === 0 && column.status !== "done" && <p className="task-board-column-empty">{column.empty}</p>}
          {items.length === 0 && column.status === "done" && archived.length === 0 && <p className="task-board-column-empty">{column.empty}</p>}
          {items.map((task) => <TaskBoardListRow
            key={task.id}
            task={task}
            expanded={expandedId === task.id}
            parentLabel={allTasks.find((parent) => parent.id === task.parentTaskId)?.identifier}
            onToggle={() => toggleExpanded(task.id)}
            onOpen={onOpen}
            onOpenSession={onOpenSession}
            bindTrigger={bindTrigger}
          />)}
          {column.status === "done" ? <TaskBoardArchiveFolder
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
                expanded={expandedId === task.id}
                parentLabel={allTasks.find((parent) => parent.id === task.parentTaskId)?.identifier}
                onToggle={() => toggleExpanded(task.id)}
                onOpen={onOpen}
                onOpenSession={onOpenSession}
                bindTrigger={bindTrigger}
              />)}
            </Flex>
          </TaskBoardArchiveFolder> : null}
        </Flex>}
      </section>;
    })}
  </Flex>;
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
  const activeTasks = tasks.filter((task) => task.status !== "archived");
  const dueSoon = [...activeTasks]
    .filter((task) => task.dueDate && task.status !== "done")
    .sort((left, right) => (left.dueDate ?? "").localeCompare(right.dueDate ?? ""))
    .slice(0, 6);
  const byPriority = ISSUE_PRIORITIES.map((entry) => ({
    ...entry,
    count: activeTasks.filter((task) => task.priority === entry.value).length,
  })).filter((entry) => entry.count > 0);
  const labels = collectIssueLabels(activeTasks).map((label) => ({
    label,
    count: activeTasks.filter((task) => task.labels.includes(label)).length,
  }));
  const summary = stats.total === 0
    ? `${projectName} 当前没有任务。`
    : `共 ${stats.total} 项任务，${stats.remaining} 项待处理，${stats.done} 项${issueStatusLabel("done")}。`;
  const highRemaining = activeTasks.filter((task) => task.status !== "done" && (task.priority === "high" || task.priority === "urgent")).length;
  const metric = (label: string, value: number, tone: string, total = stats.total): React.ReactElement =>
    <Card size="small" className={`task-board-metric tone-${tone}`} style={{ flex: "1 1 160px" }}>
      <Typography.Text type="secondary">{label}</Typography.Text>
      <Typography.Title level={3} style={{ margin: "4px 0" }}>{value}</Typography.Title>
      <Progress status="normal" percent={Math.round(total ? value / total * 100 : 0)} aria-label={`${label}占当前任务比例`}/>
    </Card>;
  const panel = (title: string, children: React.ReactNode): React.ReactElement =>
    <Card title={title} size="small" className="task-board-dashboard-panel" style={{ flex: "1 1 260px", minWidth: 0 }}>{children}</Card>;
  return <Flex vertical gap="middle" className="task-board-dashboard">
    <Card size="small"><Typography.Title level={4} style={{ margin: 0 }}>{projectName}</Typography.Title><Typography.Paragraph style={{ margin: "8px 0 0" }}>{summary}</Typography.Paragraph></Card>
    <section aria-label="任务状态">
      <Typography.Title level={5} style={{ margin: "0 0 8px" }}>任务状态</Typography.Title>
      <Flex wrap gap="small" className="task-board-metrics">
        {metric(issueStatusLabel("todo"), stats.todo, "todo")}
        {metric(issueStatusLabel("doing"), stats.doing, "doing")}
        {metric(issueStatusLabel("done"), stats.done, "done")}
      </Flex>
    </section>
    <Card size="small" title="需要关注" className="task-board-risk-panel">
      <Flex wrap gap="small">
        <Tag color={stats.overdue > 0 ? "error" : "default"}>已逾期 {stats.overdue}</Tag>
        <Tag color={highRemaining > 0 ? "warning" : "default"}>高优先级待处理 {highRemaining}</Tag>
      </Flex>
      <Typography.Paragraph type="secondary" style={{ margin: "8px 0 0" }}>
        {stats.overdue === 0 && highRemaining === 0 ? "当前没有逾期或高优先级待处理任务。" : "同一任务可能同时逾期且属于高优先级。"}
      </Typography.Paragraph>
    </Card>
    <Flex wrap gap="middle" className="task-board-dashboard-grid">
      {panel("即将到期", dueSoon.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有设置截止日期的任务"/> : <List size="small" dataSource={dueSoon} renderItem={(task) => <List.Item><WandButton kind="ghost" onClick={() => onOpen(task.id)} style={{ height: "auto", whiteSpace: "normal" }}><TaskBoardStatusGlyph status={task.status}/><span>{task.title}</span><Tag color={issueIsOverdue(task.dueDate, task.status) ? "error" : "default"}>{issueDueStamp(task.dueDate)}</Tag></WandButton></List.Item>}/>)}
      {panel("优先级", byPriority.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有优先级分布"/> : <List size="small" dataSource={byPriority} renderItem={(entry) => <List.Item><Flex vertical style={{ width: "100%" }}><Flex justify="space-between"><span>{entry.label}</span><span>{entry.count}</span></Flex><Progress status="normal" percent={Math.round(entry.count / Math.max(1, stats.total) * 100)} size="small" showInfo={false}/></Flex></List.Item>}/>)}
      {panel("标签", labels.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有标签"/> : <List size="small" dataSource={labels} renderItem={(entry) => <List.Item><TaskBoardLabelChip label={entry.label}/><Tag>{entry.count}</Tag></List.Item>}/>)}
      {panel("最近会话", tasks.every((task) => task.sessions.length === 0) ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有派发会话"/> : <List size="small" dataSource={tasks.flatMap((task) => task.sessions.map((session) => ({ task, session }))).slice(0, 6)} renderItem={({ task, session }) => <List.Item><WandButton kind="ghost" onClick={() => onOpenSession?.(session.id)} style={{ height: "auto", whiteSpace: "normal" }}><ProviderLogo provider={session.provider}/><span>{task.title}</span><span>{issueAgentLabel(session.provider, session.engine)}</span></WandButton></List.Item>}/>)}
    </Flex>
  </Flex>;
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
  const closed = (status: WandTaskStatus): boolean => status === "done" || status === "archived";
  const tasks = [...ISSUE_COLUMNS.flatMap((column) => grouped[column.status]), ...grouped.archived]
    .filter((task) => !(hideCompleted && closed(task.status)));
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
        {issueHideStatusFilterLabel("done")}
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
      今天 {today} · 时间条表示创建至截止日期，未设截止日期时仅标记创建日。
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
        {[...ISSUE_COLUMNS, ...(hideCompleted ? [] : [ISSUE_ARCHIVE_COLUMN])].map((column) => {
          const items = grouped[column.status].filter((task) => !(hideCompleted && closed(task.status)));
          if (items.length === 0) return null;
          return <section key={column.status} className={`task-board-gantt-group is-${column.status}`}>
            <div style={{ display: "grid", gridTemplateColumns: "180px minmax(0, 1fr)", height: 36 }}>
              <Flex component="header" align="center" gap="small" style={{ paddingInline: 8 }}><TaskBoardStatusGlyph status={column.status}/><Typography.Text strong>{column.label}</Typography.Text><Tag>{items.length}</Tag></Flex>
              <div style={{ position: "relative" }}>{todayLine}</div>
            </div>
            {items.map((task) => {
              const created = isoDate(new Date(task.createdAt));
              const finish = task.dueDate || created;
              const inRange = created <= range.columns.at(-1)! && finish >= range.start;
              const span = issueGanttSpan({ ...task, dueDate: finish }, range.start, range.days);
              return <WandButton kind="ghost"
                key={task.id}
                type="button"
                className="task-board-gantt-row"
                title={`${task.title} · ${created}${task.dueDate ? ` 至 ${task.dueDate}` : " · 未设置截止日期"}`}
                style={{ width: "100%", height: 48, padding: 0, display: "grid", gridTemplateColumns: "180px minmax(0, 1fr)", gap: 0, textAlign: "left" }}
                onClick={() => onOpen(task.id)}
              >
                <Flex vertical style={{ minWidth: 0, paddingInline: 8 }}><Typography.Text type="secondary">{task.identifier}</Typography.Text><Typography.Text ellipsis>{task.title}</Typography.Text></Flex>
                <div className="task-board-gantt-track" style={{ position: "relative", display: "grid", gridTemplateColumns: timelineColumns, alignItems: "center", height: "100%", minWidth: 0,
                  backgroundImage: "linear-gradient(to right, var(--border-subtle) 1px, transparent 1px)", backgroundSize: `${100 / range.days}% 100%` }}>
                  {inRange ? <i className={`is-${task.status}`} aria-hidden="true"
                    style={{ gridColumn: `${span.offset + 1} / span ${span.length}`, height: 16, borderRadius: 4, marginInline: 2, background: task.status === "done" ? "var(--success)" : task.status === "archived" ? "var(--text-tertiary)" : "var(--accent)" }}/>
                    : <Typography.Text type="secondary" style={{ gridColumn: `1 / ${range.days + 1}`, paddingInline: 8 }}>时间不在当前范围</Typography.Text>}
                  {todayLine}
                </div>
              </WandButton>;
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
    ...(task.status === "archived"
      ? [{ key: "restore", label: "恢复到等待认领", icon: <WandIcon name="resume"/>, onClick: onRestore }]
      : [
          { key: "dispatch", label: "派发 Agent", icon: <WandIcon name="zap"/>, onClick: onDispatch },
          { key: "archive", label: "归档", icon: <WandIcon name="archive"/>, danger: true, onClick: onArchive },
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

export function TaskBoardAgentChips({
  sessions,
  assigned,
}: {
  sessions: IssueSessionSummary[];
  assigned: WandTaskAgent | null;
}): React.ReactElement | null {
  const agents = listIssueAgents(sessions, assigned);
  if (agents.length === 0) return null;
  return <>{agents.map((agent) => <TaskBoardAgentChip
    key={agent.provider}
    agent={agent}
    running={sessions.some((session) => session.provider === agent.provider && issueSessionRunning(session.status))}
  />)}</>;
}

export function TaskBoardAgentSessionList({
  sessions,
  assigned,
  onOpenSession,
  catalog,
}: {
  sessions: IssueSessionSummary[];
  assigned: WandTaskAgent | null;
  onOpenSession?: (sessionId: string) => void;
  catalog?: IssueModelCatalog | null;
}): React.ReactElement {
  const groups = groupIssueSessionsByAgent(sessions, assigned);
  if (groups.length === 0) {
    return <div className="task-board-agent-list" aria-label="指派记录">
      <p className="task-board-agent-empty">还没有指派 Agent。</p>
    </div>;
  }
  return <div className="task-board-agent-list" aria-label="已指派的 Agent">
    {groups.map((group) => <section key={`${group.provider}:${group.engine ?? "cli"}`} className="task-board-agent-group">
      <header className="task-board-agent-group-head">
        <ProviderLogo provider={group.agent?.provider ?? group.provider} className="task-board-agent-logo"/>
        <strong>{issueAgentLabel(group.agent?.provider ?? group.provider, group.engine ?? group.agent?.engine)}</strong>
        {group.agent ? <span>{[
          wandModelDisplayName(catalog ?? null, group.agent.provider, group.agent.model),
          issueAgentEffortLabel(group.agent.thinkingEffort),
          issueAgentModeLabel(group.agent.mode),
        ].filter(Boolean).join(" · ")}</span> : null}
        <b>{group.sessions.length}</b>
      </header>
      {group.sessions.length === 0
        ? <p className="task-board-agent-empty">已指派，等待派发</p>
        : group.sessions.map((session) => <WandButton kind="ghost"
            key={session.id}
            type="button"
            className="task-board-agent-session"
            onClick={() => onOpenSession?.(session.id)}
          >
            <span className={classNames("task-board-agent-session-status", issueSessionRunning(session.status) && "is-running")}/>
            <strong>{session.title || issueAgentLabel(session.provider, session.engine)}</strong>
            <small>
              {[wandModelDisplayName(catalog ?? null, session.provider, session.model), sessionStatusLabel(session.status)]
                .filter(Boolean)
                .join(" · ")}
            </small>
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
