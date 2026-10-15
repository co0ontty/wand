import * as React from "react";
import { Avatar, Badge, Flex, Typography } from "antd";
import type { ConversationSummary } from "../../../conversation-types.js";
import { employeeProfile } from "../agents/employee-profile";
import { wandOverlay } from "../overlay-controller";
import { SidebarLabelTooltip } from "../workspaces/sidebar-label-tooltip";
import { SidebarRowMenu } from "../workspaces/sidebar-row-menu";
import { EmployeeAvatar } from "../agents/employee-avatar";
import { cachedSiliconEmployee, useSiliconEmployees } from "../agents/employee-repository";
import { ConversationGroupAvatar } from "./avatar";
import { WandButton, WandIcon, WandIconButton, WandSearchField, WandStretchTabs } from "../ui";
import { conversationUi, useConversationUi, type ConversationListFilter } from "./state";
import { conversationTaskStateLabel } from "./presentation";
import { conversationsRepository, notifyConversationChanges, useConversations } from "./repository";
import { ConversationMorphIcon, ConversationPanel } from "./controls";
import { GroupEditor } from "./group-editor";
import { useUserProfile } from "../user-profile-repository";
import { taskGroupsStore, useTaskGroups } from "../workspaces/task-groups-store";
import { SidebarSessionMenu } from "../workspaces/sidebar-session-menu";
import { SidebarSurfacesContext } from "../workspaces/sidebar-popup-owner";
import { archiveSidebarSession, deleteSidebarSessions } from "../workspaces/sidebar-session-actions";
import { findSessionTask } from "../workspaces/session-task-lookup";
import { SidebarSessionPreview } from "../workspaces/sidebar-session-preview";
import { SidebarDisclosure } from "../workspaces/sidebar-disclosure";
import { SidebarSessionArea } from "../workspaces/sidebar-session-area";
import { SessionProviderMark } from "../workspaces/session-mark";
import { sidebarSessionLabel, workspaceSessionProvider } from "../workspaces/session-order";
import { sidebarSessionState, sessionGlowStatus } from "../workspaces/sidebar-session-state";
import { agentToolDisplayName } from "../../provider-identity";
import { ImSidebarItem } from "../shell/im-sidebar-item";
import { SidebarActivityFilter } from "../workspaces/sidebar-activity-filter";
import { SidebarProjectionSwap } from "../workspaces/sidebar-projection-swap";
import { conversationActivitySessions, isConversationActive } from "./activity-filter";
import { indexPersonSessions, filterPersonSessions, personSessionSearchValues, type PersonSessionEntry } from "./sidebar-sessions";

export type ConversationNavigationPage = "chats" | "tasks" | "board" | "teams" | "contacts" | "schedules";

/** Global destinations stay in the left rail, independent of the current list. */
export function ConversationNavigation({ activePage, teamAttention, onNavigate }: {
  activePage: ConversationNavigationPage | null;
  teamAttention: number;
  onNavigate(page: ConversationNavigationPage): void;
}): React.ReactElement {
  const entries = [
    { value: "chats", label: "对话", icon: "chat" },
    { value: "tasks", label: "工作区", icon: "folder" },
    { value: "board", label: "任务看板", icon: "board", id: "task-board-button" },
    { value: "teams", label: "团队", icon: "users", id: "ai-teams-button" },
    { value: "schedules", label: "定时任务", icon: "history", id: "scheduled-tasks-button" },
  ] as const;
  return <Flex component="nav" vertical gap={4} className="conversation-navigation" aria-label="功能导航">
    {entries.map(entry => <WandIconButton key={entry.value} id={"id" in entry ? entry.id : undefined}
      data-stretch-value={entry.value} aria-label={entry.label} title={entry.label}
      kind={activePage === entry.value ? "soft" : "ghost"} aria-current={activePage === entry.value ? "page" : undefined}
      aria-pressed={activePage === entry.value} onClick={() => onNavigate(entry.value)}>
      <span className="sidebar-nav-icon" aria-hidden="true">{entry.value === "teams" ? <Badge count={teamAttention} size="small"><WandIcon name={entry.icon} size={18}/></Badge>
        : <WandIcon name={entry.icon} size={18}/>}</span>
      <span className="sidebar-nav-label" aria-hidden="true">{entry.value === "board" ? "任务" : entry.value === "schedules" ? "定时" : entry.label}</span>
    </WandIconButton>)}
  </Flex>;
}

export function ConversationSidebarTools({ enabled, onNavigate, onCreateSession }: {
  enabled: boolean; onNavigate(): void; onCreateSession?(): void;
}): React.ReactElement {
  const state = useConversationUi();
  const [panel, setPanel] = React.useState<"closed" | "menu" | "group">("closed");
  const anchor = React.useRef<HTMLDivElement>(null);
  const plus = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { setPanel("closed"); }, [enabled, state.mode]);
  return <Flex ref={anchor} align="center" className="conversation-sidebar-tools" style={{ position: "relative" }}>
    <WandIconButton ref={plus} className="conversation-create-button"
      aria-label={state.mode === "tasks" ? "新建会话" : panel === "closed" ? "发起群聊" : "关闭群聊表单"}
      aria-expanded={panel !== "closed"} aria-controls="conversation-create-panel"
      onClick={() => state.mode === "tasks" ? onCreateSession?.() : setPanel(panel === "closed" ? "group" : "closed")}>
      <ConversationMorphIcon active={panel !== "closed"} from="plus" to="close"/>
      <span className="conversation-create-label">{panel === "closed" ? "发起群聊" : "关闭"}</span>
    </WandIconButton>
    <ConversationPanel open={enabled && panel !== "closed"} owner="conversation-create-panel" focusKey={panel} anchorRef={anchor} triggerRef={plus} onClose={() => setPanel("closed")}>
      <div hidden={panel !== "group"}><GroupEditor open={enabled && panel === "group"} owner="conversation-create-panel"
        onCancel={() => setPanel("closed")} onCreated={id => { setPanel("closed"); conversationUi.select(id, true); onNavigate(); }}/></div>
    </ConversationPanel>
  </Flex>;
}

/** The list clock is a projection of messageAt, never an unread/online indicator. */
export function formatConversationListTime(messageAt: string, now = new Date()): string {
  const time = new Date(messageAt);
  if (!messageAt || !Number.isFinite(time.getTime())) return "";
  return time.toDateString() === now.toDateString()
    ? time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : time.toLocaleDateString([], { ...(time.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}), month: "2-digit", day: "2-digit" });
}

/** 归档档位：全部 / 未归档 / 已归档，和侧栏「在跑」是同一套顶部筛选形态。 */
export type { ConversationListFilter } from "./state";

/**
 * 归档的对话：群聊解散后归档，或它的任务已经被归档。
 * 两种都要读作「归档的任务」，不能和未归档的排在同一档里长得一样。
 */
export function isConversationArchived(
  item: { dissolvedAt?: string | null; tasks?: ReadonlyArray<{ task: { status: string } }> },
): boolean {
  return Boolean(item.dissolvedAt) || (item.tasks ?? []).some((entry) => entry.task.status === "archived");
}

/** 列表档位的空态与区块标题用户看到的字面量，只有这一份。 */
export function conversationListFilterLabel(filter: ConversationListFilter): string {
  if (filter === "archived") return "已归档";
  return filter === "active" ? "未归档" : "最近聊天";
}

/** 筛选与搜索共用一个入口：先按归档档筛，再按标题、预览与任务名匹配。 */
export function filterConversationList<
  T extends { title: string; preview: string; dissolvedAt?: string | null; tasks: ReadonlyArray<{ task: { title: string; status: string } }> },
>(items: readonly T[], filter: ConversationListFilter, query: string, extraSearch?: (item: T) => readonly string[], activity?: (item: T) => boolean): T[] {
  const needle = query.trim().toLowerCase();
  return items.filter((item) => {
    const archived = isConversationArchived(item);
    if (filter === "archived" ? !archived : filter === "active" ? archived : false) return false;
    if (activity && !activity(item)) return false;
    if (!needle) return true;
    return [item.title, item.preview, ...item.tasks.map((entry) => entry.task.title), ...(extraSearch?.(item) ?? [])]
      .join(" ").toLowerCase().includes(needle);
  });
}

/** Totals always describe the archive tier, while matches describe the current query. */
export function conversationListCounts<
  T extends { title: string; preview: string; dissolvedAt?: string | null; tasks: ReadonlyArray<{ task: { title: string; status: string } }> },
>(items: readonly T[], filter: ConversationListFilter, query: string, extraSearch?: (item: T) => readonly string[], activity?: (item: T) => boolean): { total: number; active: number; archived: number; scope: number; matches: number } {
  const archived = items.filter(isConversationArchived).length;
  const active = items.length - archived;
  return { total: items.length, active, archived, scope: filterConversationList(items, filter, "", extraSearch, activity).length,
    matches: filterConversationList(items, filter, query, extraSearch, activity).length };
}

export function ConversationSidebarList({ compact, enabled = true, onNavigate, onOpenSession, selectedSessionId = null, sessionTitles = {} }: {
  compact: boolean; enabled?: boolean; onNavigate(): void;
  onOpenSession?(sessionId: string): void;
  selectedSessionId?: string | null;
  sessionTitles?: Readonly<Record<string, string>>;
}): React.ReactElement {
  const { items, error, loaded, refresh } = useConversations();
  const { groups: sessionGroups } = useTaskGroups();
  const sessionIndex = React.useMemo(() => indexPersonSessions(sessionGroups), [sessionGroups]);
  const activitySessions = React.useMemo(() => conversationActivitySessions(sessionGroups), [sessionGroups]);
  const { employees } = useSiliconEmployees({ enabled });
  const ui = useConversationUi();
  const query = (ui.filters["list-query"] ?? "").trim().toLowerCase();
  const filter = ui.listFilter;
  const [actionError, setActionError] = React.useState("");
  const searchInput = React.useRef<HTMLInputElement>(null);
  const [engaged, setEngaged] = React.useState(false);
  const order = React.useRef<string[]>([]);
  if (!engaged) order.current = items.map(item => item.id);
  const positions = new Map(order.current.map((id, index) => [id, index]));
  const sorted = items.slice().sort((a, b) => {
    const left = positions.get(a.id) ?? -1, right = positions.get(b.id) ?? -1;
    return Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "") || (left < 0 ? items.length : left) - (right < 0 ? items.length : right);
  });
  const extraSearch = (item: ConversationSummary): string[] => personSessionSearchValues(item, sessionIndex, filter, sessionTitles);
  const activity = ui.activityOnly ? (item: ConversationSummary) => isConversationActive(item, activitySessions,
    ui.active === true ? ui.selectedId : null, selectedSessionId) : undefined;
  const rows = filterConversationList(sorted, filter, query, extraSearch, activity);
  const counts = conversationListCounts(items, filter, query, extraSearch, activity);
  const countLabel = loaded ? `${ui.activityOnly ? "活动 · " : ""}${conversationListFilterLabel(filter)}共 ${counts.scope} 个对话${query ? `，搜索匹配 ${counts.matches} 个` : ""}；全部 ${counts.total}，未归档 ${counts.active}，已归档 ${counts.archived}`
    : error ? "对话数量尚未加载" : "正在读取对话数量";
  const select = (id: string): void => { conversationUi.select(id); onNavigate(); };
  const update = async (item: ConversationSummary, patch: { pinned?: boolean; dissolved?: boolean }): Promise<void> => {
    setActionError("");
    try {
      await conversationsRepository.updateListState(item.id, patch);
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "操作失败，请重试。"); }
  };
  const remove = async (item: ConversationSummary): Promise<void> => {
    const answer = await wandOverlay.dialog({ title: `删除对话「${item.title}」？`,
      description: item.kind === "group" ? `将删除这个群聊、${item.tasks.length} 个关联任务，以及它们的消息、执行记录和资源文件。此操作无法撤销。` : "将永久删除此私聊的消息记录和会话文件。员工资料及已经派出的群聊任务保留。此操作无法撤销。", actions: [
        { label: "取消", value: false, autoFocus: true }, { label: "删除对话", value: true, kind: "danger" },
      ] });
    if (answer.dismissed !== true && answer.action) {
      try { await conversationsRepository.remove(item.id); if (conversationUi.getSnapshot().selectedId === item.id) conversationUi.select(""); }
      catch (cause) { setActionError(cause instanceof Error ? cause.message : "删除失败，请重试。"); }
    }
  };
  return <div className="conversation-sidebar-list" onPointerEnter={() => setEngaged(true)} onPointerLeave={() => setEngaged(false)}
    onFocusCapture={() => setEngaged(true)} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setEngaged(false); }}>
    {!compact ? <div className="conversation-list-tools"><div className="conversation-search-host">
      <WandSearchField inputRef={searchInput} className="conversation-search-input" label="搜索对话或任务"
        value={ui.filters["list-query"] ?? ""} onValueChange={value => conversationUi.filter("list-query", value)}/>
    </div>
    <Flex vertical align="stretch" gap={4} className="conversation-list-section">
      <Flex align="center" gap={6} className="conversation-filter-row">
      <WandStretchTabs className="conversation-list-filter" ariaLabel="对话归档筛选"
        tabs={[{ value: "all", label: "全部" }, { value: "active", label: "未归档" }, { value: "archived", label: "已归档" }]}
        value={filter} onValueChange={conversationUi.listFilter}/>
      <SidebarActivityFilter active={ui.activityOnly} label="只看活动对话" onChange={conversationUi.activityOnly}/>
      </Flex>
      <Typography.Text type="secondary" className="conversation-list-count" title={countLabel} aria-label={countLabel}>{loaded ? query ? `匹配 ${counts.matches} / ${counts.scope}` : `${counts.scope} 个对话` : error ? "数量未加载" : "读取中…"}</Typography.Text></Flex></div> : null}
    {error ? <Typography.Text type="danger" role="status">{error}<WandButton size="small" onClick={refresh}>重新读取</WandButton></Typography.Text> : null}
    {actionError ? <Typography.Paragraph type="danger" role="alert">{actionError}</Typography.Paragraph> : null}
    <SidebarProjectionSwap value={`${filter}:${ui.activityOnly}`}>
    {rows.map(item => <ConversationListRow key={item.id} item={item} employee={employees.find(employee => employee.id === item.peerEmployeeId) ?? null} compact={compact} query={query}
      enabled={enabled} filter={filter} selected={ui.selectedId === item.id && ui.active !== false} onSelect={() => select(item.id)}
      sessionEntries={filterPersonSessions(item, sessionIndex, filter, query, sessionTitles, ui.activityOnly, selectedSessionId)}
      sessionTitles={sessionTitles} selectedSessionId={selectedSessionId} onOpenSession={onOpenSession}
      onUpdate={patch => update(item, patch)} onRemove={() => remove(item)}/>) }
    {loaded && !rows.length ? <div className="conversation-list-empty" role="status"><WandIcon name={query ? "search" : "chat"} size={20}/><Typography.Paragraph type="secondary">{query ? "没有匹配的对话或任务"
      : ui.activityOnly ? "现在没有符合筛选条件的活动对话。"
      : filter === "archived" ? "还没有已归档的对话，解散群聊或归档任务后会出现在这里。"
      : filter === "active" ? "还没有未归档的对话。"
      : "还没有对话，可以从通讯录找一位员工。"}</Typography.Paragraph>{query ? <WandButton kind="ghost" size="small" onClick={() => { conversationUi.filter("list-query", ""); searchInput.current?.focus({ preventScroll: true }); }}>清空搜索</WandButton> : null}</div> : null}
    </SidebarProjectionSwap>
  </div>;
}

function ConversationListRow({ item, employee: projectedEmployee, compact, query, enabled, filter, selected, onSelect, onUpdate, onRemove,
  sessionEntries, sessionTitles, selectedSessionId, onOpenSession }: {
  item: ConversationSummary; employee: React.ComponentProps<typeof EmployeeAvatar>["employee"] | null; compact: boolean; query: string; enabled: boolean; filter: ConversationListFilter; selected: boolean; onSelect(): void;
  onUpdate(patch: { pinned?: boolean; dissolved?: boolean }): Promise<void>; onRemove(): Promise<void>;
  sessionEntries: readonly PersonSessionEntry[];
  sessionTitles: Readonly<Record<string, string>>;
  selectedSessionId: string | null;
  onOpenSession?(sessionId: string): void;
}): React.ReactElement {
  const employee = projectedEmployee ?? (item.peerEmployeeId ? cachedSiliconEmployee(item.peerEmployeeId) : null);
  const identity = employee ?? (item.peerEmployeeId ? { id: item.peerEmployeeId, name: item.title } : null);
  const selfName = useUserProfile().name || "我";
  const [menu, setMenu] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const row = React.useRef<HTMLDivElement>(null);
  const sessionToggleRef = React.useRef<HTMLButtonElement>(null);
  const sessionListId = React.useId();
  const [sessionsExpanded, setSessionsExpanded] = React.useState(false);
  React.useEffect(() => { setMenu(false); setSessionsExpanded(false); }, [enabled, compact, query, filter]);
  const action = async (run: () => Promise<void>): Promise<void> => {
    if (busy) return; setBusy(true); setMenu(false);
    (row.current?.querySelector<HTMLElement>(".conversation-row-open")
      ?? row.current?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
    try { await run(); } finally { setBusy(false); }
  };
  const tasks = query ? item.tasks.filter(task => task.task.title.toLowerCase().includes(query)) : item.tasks;
  const showTasks = !compact && !item.dissolvedAt && (item.kind !== "dm" || expanded) && (expanded || !!query && tasks.length > 0);
  const showSessions = !compact && item.kind === "dm" && sessionsExpanded;
  const sessions = sessionEntries.map(entry => entry.session);
  const toggleSessions = (): void => { setExpanded(false); setSessionsExpanded(!sessionsExpanded); };
  const refreshSessionLists = async (): Promise<void> => { await taskGroupsStore.reload(); notifyConversationChanges(); };
  const archived = isConversationArchived(item);
  const contents = <div ref={row} className={`conversation-row conversation-row-${item.kind}`} aria-current={selected ? "page" : undefined}
    data-pinned={!!item.pinnedAt} data-archived={archived || undefined} data-conversation-id={item.id} aria-busy={busy || undefined}>
    <WandIconButton className="conversation-row-avatar conversation-avatar-button" aria-label={identity && !compact ? `查看${item.title}的资料` : `打开${item.title}`}
      onClick={event => identity && !compact ? employeeProfile.open(identity, event.currentTarget) : onSelect()}>
      {identity ? <EmployeeAvatar employee={identity} size="sm"/> : item.kind === "group" ? <ConversationGroupAvatar title={item.title} members={item.team?.members ?? []} size={36}/> : <Avatar size={36} icon={<WandIcon name="chat" size={16}/>}/>}</WandIconButton>
    {!compact ? <SidebarLabelTooltip title={item.title} selector=".conversation-row-title"><WandButton kind="ghost" className="conversation-row-open" title={item.title} onClick={onSelect}>
      <span className="conversation-row-copy"><span className="conversation-row-topline"><span className="conversation-row-title">{item.title}</span>
        {formatConversationListTime(item.messageAt) ? <time className="conversation-row-time" dateTime={item.messageAt}>{formatConversationListTime(item.messageAt)}</time> : null}</span>
        <span className="conversation-row-bottomline">{archived ? <span className="conversation-archived-tag">已归档</span> : null}<span className="conversation-row-preview">{item.dissolvedAt ? "群聊已解散 · 点击查看或恢复" : item.preview || (item.kind === "group" ? `${selfName} + ${item.team?.members.length ?? 0} 位员工` : "私聊")}</span>
          {item.pinnedAt ? <span className="conversation-pin" title="已置顶" aria-label="已置顶"><WandIcon name="pin" size={13}/></span> : null}</span>
      </span></WandButton></SidebarLabelTooltip> : null}

    {!compact ? <WandIconButton className="conversation-row-more" aria-label={`${item.title}的菜单`} aria-haspopup="menu" aria-expanded={menu}
      onClick={event => {
        event.stopPropagation();
        if (menu) { setMenu(false); return; }
        const bounds = event.currentTarget.getBoundingClientRect();
        event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: bounds.right, clientY: bounds.bottom, button: 2 }));
      }}><WandIcon name="more" size={16}/></WandIconButton> : null}
  </div>;
  return <div className="conversation-list-item" onKeyDown={event => {
    if (event.key !== "Escape" || event.defaultPrevented || !showSessions || menu
      || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault(); event.stopPropagation();
    sessionToggleRef.current?.focus({ preventScroll: true }); setSessionsExpanded(false);
  }}><SidebarRowMenu row={contents} rowRef={row} open={menu} disabled={!enabled}
    onOpenChange={next => { if (!next || !busy) setMenu(next); }} label="对话菜单" title={item.title} className="conversation-row-menu"
    menu={{ items: [
      { key: "open", disabled: busy, icon: <WandIcon name="chat"/>, label: "打开对话" },
      ...(identity ? [{ key: "profile", disabled: busy, icon: <WandIcon name="info"/>, label: "查看员工资料" }] : []),
      { key: "pin", disabled: busy, icon: <WandIcon name="pin"/>, label: item.pinnedAt ? "取消置顶" : "置顶" },
      ...(item.kind === "dm" ? [{ key: "sessions", disabled: busy, icon: <WandIcon name="chat"/>, label: showSessions ? "收起会话" : `查看 ${sessions.length} 个会话` }] : []),
      ...(!item.dissolvedAt && item.tasks.length > 0 ? [{ key: "tasks", disabled: busy, icon: <WandIcon name="task"/>, label: expanded ? "收起任务" : `查看 ${item.tasks.length} 个任务` }] : []),
      { key: "danger-divider", type: "divider" },
      ...(item.kind === "group" ? [{ key: "dissolve", disabled: busy, icon: <WandIcon name={item.dissolvedAt ? "resume" : "archive"}/>, label: item.dissolvedAt ? "恢复群聊" : "解散群聊…" }] : []),
      { key: "delete", disabled: busy, danger: true, icon: <WandIcon name="trash"/>, label: item.kind === "group" ? "删除群聊…" : "删除对话…" },
    ], onClick: ({ key }) => {
      if (busy) return;
      setMenu(false);
      if (key === "open") onSelect();
      else if (key === "profile" && identity) employeeProfile.open(identity, row.current?.querySelector("button") ?? null);
      else if (key === "tasks") { setSessionsExpanded(false); setExpanded(!expanded); }
      else if (key === "sessions") toggleSessions();
      else if (key === "pin") void action(() => onUpdate({ pinned: !item.pinnedAt }));
      else if (key === "delete") void action(onRemove);
      else if (key === "dissolve") void action(async () => {
        if (item.dissolvedAt) { await onUpdate({ dissolved: false }); return; }
        const answer = await wandOverlay.dialog({ title: `解散群聊「${item.title}」？`, description: "群聊将归档并保留在会话列表。历史记录和关联任务保留，恢复后可继续聊天。", actions: [
          { label: "取消", value: false, autoFocus: true }, { label: "解散群聊", value: true, kind: "danger" },
        ] });
        if (answer.dismissed !== true && answer.action) await onUpdate({ dissolved: true });
      });
    } }}/>

    {!compact && item.kind === "dm" ? <SidebarSessionArea id={sessionListId} open={showSessions} label={item.title}
      toggleRef={sessionToggleRef} toggleClassName="conversation-session-toggle" disabled={!enabled || busy} hasSessions={sessions.length > 0}
      onOpenChange={open => { setExpanded(false); setSessionsExpanded(open); }}>
      <SidebarSessionPreview sessions={sessions} expanded={showSessions || showTasks} label={`${item.title}的会话预览`}
        className="sidebar-session-preview-person" disabled={!enabled || busy} liveTitles={sessionTitles}
        selectedSessionId={selectedSessionId} expansionRef={sessionToggleRef}
        onExpand={() => { setExpanded(false); setSessionsExpanded(true); }} onActivate={session => {
          setExpanded(false); setSessionsExpanded(false); onOpenSession?.(session.id);
        }}/>
      <SidebarDisclosure id={sessionListId} open={showSessions}>
        <SidebarSurfacesContext.Provider value={enabled && !compact && showSessions}>
        <div className="conversation-person-sessions" role="group" aria-label={`${item.title}的会话列表`}>
          {sessionEntries.map((entry, index) => {
            const session = entry.session;
            const label = sidebarSessionLabel(session, index, sessionTitles[session.id]);
            return <SidebarSessionMenu key={session.id} session={{ ...session, archived: entry.archived }} label={label}
              disabled={!enabled || busy} intoNewTask={session.workspaceTaskId ? undefined : entry.group}
              onOpen={() => onOpenSession?.(session.id)}
              onArchive={async archived => { await archiveSidebarSession(session.id, archived); await refreshSessionLists(); }}
              onDelete={async () => { await deleteSidebarSessions([session.id], findSessionTask(entry.group, session) ?? null); await refreshSessionLists(); }}
              row={<div className="conversation-person-session"><ImSidebarItem id={session.id}
                title={label} titleGenerating={session.titleGenerating}
                avatarNode={<SessionProviderMark session={session} size={14}/>} state={sidebarSessionState(session)} glow={sessionGlowStatus(session)}
                summary={`${agentToolDisplayName(workspaceSessionProvider(session), session.engine)} · ${sidebarSessionState(session).label}`}
                active={session.id === selectedSessionId} onClick={() => onOpenSession?.(session.id)}/></div>}/>;
          })}
          {!sessions.length ? <Typography.Paragraph type="secondary" className="sidebar-group-empty">暂无符合条件的会话</Typography.Paragraph> : null}
        </div>
        </SidebarSurfacesContext.Provider>
      </SidebarDisclosure>
    </SidebarSessionArea> : null}
    {!compact && item.kind !== "dm" && !item.dissolvedAt && item.tasks.length > 0 ? <WandButton kind="ghost" className="conversation-task-toggle" aria-expanded={showTasks} onClick={() => setExpanded(!expanded)}>
      <WandIcon name="chevronDown" size={12}/>{item.tasks.length} 个任务{showTasks ? " · 收起" : ""}</WandButton> : null}
    {showTasks ? tasks.map(t => <WandButton key={t.task.id} kind="ghost" className="conversation-task-row" onClick={() => {
      onSelect(); conversationUi.filter(item.id, t.task.id);
    }}><WandIcon name="task"/><span className="conversation-row-title">{t.task.title}</span><span className="conversation-row-status" data-archived={t.task.status === "archived" || undefined}>{conversationTaskStateLabel(t)}</span></WandButton>) : null}
  </div>;
}
