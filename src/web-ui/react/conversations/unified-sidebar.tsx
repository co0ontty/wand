import { SESSION_RUNTIME_OPTIONS, matchesSessionRuntime, isSessionNeedsConfirmation, normalizeSessionRuntime } from "./runtime-filter";
import * as React from "react";
import { Flex, Typography } from "antd";
import type { ConversationSummary } from "../../../conversation-types.js";
import { isSidebarConversationVisible } from "../../group-chat-visibility.js";
import { agentToolDisplayName } from "../../provider-identity";
import { ImSidebarItem } from "../shell/im-sidebar-item";
import { WandButton, WandIconButton } from "../ui/button";
import { WandHintButton } from "../ui/hint-button";
import { WandIcon, WandIconFamily } from "../ui/icons";
import { WandPopover } from "../ui/popover";
import { WandSearchField } from "../ui/search-field";
import { SessionProviderMark } from "../workspaces/session-mark";
import { sidebarSessionLabel, workspaceSessionProvider } from "../workspaces/session-order";
import { sidebarSessionState, sessionGlowStatus } from "../workspaces/sidebar-session-state";
import { SidebarSurfacesContext } from "../workspaces/sidebar-popup-owner";
import { SidebarSessionMenu } from "../workspaces/sidebar-session-menu";
import { archiveSidebarSession, deleteSidebarSessions } from "../workspaces/sidebar-session-actions";
import { isSessionActive, isSessionAttention } from "../workspaces/sidebar-display-mode";
import { sidebarSearchMatches } from "../workspaces/sidebar-search";
import { useTaskGroups, taskGroupsStore } from "../workspaces/task-groups-store";
import type { TaskDirectoryGroup, TaskSummary, WorkspaceSessionSummary } from "../workspaces/types";
import { DEFAULT_CONVERSATION_FILTERS, conversationTaskStageLabel,
  conversationWorkspaceOptions, matchesConversationFacets, personSessionTaskStage, type ConversationListFilters } from "./list-filters";
import { ConversationListFilterControls, ConversationListFilterSummary } from "./list-filter-controls";
import { useConversations, conversationsRepository } from "./repository";
import { SidebarRowMenu } from "../workspaces/sidebar-row-menu";
import { wandOverlay } from "../overlay-controller";
import { employeeProfile } from "../agents/employee-profile-state";
import { conversationUi, useConversationUi } from "./state";
import type { PersonSessionEntry } from "./sidebar-sessions";

export interface UnifiedSidebarEntry extends PersonSessionEntry {
  conversation?: ConversationSummary;
}

/** One row per real session; employee identity and directory are metadata, never parent rows. */
export function collectUnifiedSessions(groups: readonly TaskDirectoryGroup[], conversations: readonly ConversationSummary[]): UnifiedSidebarEntry[] {
  const entries = new Map<string, UnifiedSidebarEntry>();
  const add = (group: TaskDirectoryGroup, session: WorkspaceSessionSummary, task?: TaskSummary, archived = false): void => {
    if (session.sessionSource === "quick-terminal" || entries.has(session.id)) return;
    entries.set(session.id, { group, session, task, taskName: task?.name ?? null, archived: archived || session.archived === true });
  };
  for (const group of groups) {
    for (const task of group.tasks) {
      for (const session of task.sessions) add(group, session, task, task.archived === true);
      for (const session of task.archivedSessions ?? []) add(group, session, task, true);
    }
    for (const session of group.standaloneSessions) add(group, session);
    for (const session of group.archivedSessions ?? []) add(group, session, undefined, true);
  }
  // Legacy direct/group chats keep their own history entry. Never fabricate an empty employee chat.
  for (const conversation of conversations.filter(isSidebarConversationVisible)) {
    const id = conversation.communicationSessionId || conversation.sessionId;
    if (!id) continue;
    const existing = entries.get(id);
    if (existing) { entries.set(id, { ...existing, conversation }); continue; }
    entries.set(id, { conversation, group: { workspaceId: "wand-global", workspaceName: "未分配工作区", workspaceCwd: "",
      synthetic: true, tasks: [], standaloneSessions: [] }, taskName: null, archived: !!conversation.dissolvedAt,
      session: { id, title: conversation.title, employeeId: conversation.peerEmployeeId ?? undefined,
        startedAt: conversation.createdAt } });
  }
  return [...entries.values()].sort((a, b) => Number(!!b.conversation?.pinnedAt) - Number(!!a.conversation?.pinnedAt)
    || (b.conversation?.pinnedAt ?? "").localeCompare(a.conversation?.pinnedAt ?? "") || (b.session.startedAt ?? "").localeCompare(a.session.startedAt ?? "") || a.session.id.localeCompare(b.session.id));
}

export function useUnifiedSidebar(enabled: boolean, titles: Readonly<Record<string, string>>) {
  const groups = useTaskGroups();
  const conversations = useConversations(false, enabled);
  const ui = useConversationUi();
  const facets: ConversationListFilters = { taskStage: ui.listTaskStage, workspace: ui.listWorkspace,
    archive: ui.listFilter, activityOnly: ui.activityOnly, runtime: ui.listRuntime };
  const entries = React.useMemo(() => collectUnifiedSessions(groups.groups, conversations.items), [groups.groups, conversations.items]);
  const query = ui.filters["list-query"] ?? "";
  const rows = entries.filter(entry => matchesSessionRuntime({ ...entry.session, archived: entry.archived }, facets.runtime) && matchesConversationFacets(entry, facets)
    && (facets.archive === "all" || (facets.archive === "archived" ? entry.archived : !entry.archived))
    && (!facets.activityOnly || !entry.archived && isSessionActive(entry.session))
    && sidebarSearchMatches(query, titles[entry.session.id] ?? "", entry.session.title ?? "", entry.taskName ?? "",
      entry.group.workspaceName, entry.session.cwd ?? "", entry.session.employeeName ?? "", entry.conversation?.title ?? "",
      agentToolDisplayName(workspaceSessionProvider(entry.session), entry.session.engine)));
  return { entries, rows, groups: groups.groups, workspaces: conversationWorkspaceOptions(groups.groups), facets, query,
    loading: groups.loading && !groups.groups.length, error: groups.error || conversations.error,
    refresh: () => { conversations.refresh(); void taskGroupsStore.reload(); } };
}
export type UnifiedSidebarModel = ReturnType<typeof useUnifiedSidebar>;

/** Two quick choices remain visible; the capsule itself reveals the rest. */
export function SidebarFilterCapsules({ model, enabled }: { model: UnifiedSidebarModel; enabled: boolean }) {
  const ui = useConversationUi();
  const [expanded, setExpanded] = React.useState<"runtime" | "workspaces" | null>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const workspacePicker = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { if (!enabled) { setExpanded(null); setSearchOpen(false); } }, [enabled]);
  React.useEffect(() => { if (!searchOpen) setQuery(""); }, [searchOpen]);
  const selectedRuntime = normalizeSessionRuntime(model.facets.runtime);
  const rememberedRuntime = selectedRuntime === "all" ? normalizeSessionRuntime(ui.lastCapsuleRuntime) : selectedRuntime;
  const favoriteRuntime = SESSION_RUNTIME_OPTIONS.find(option => option.value === rememberedRuntime && option.value !== "all") ?? SESSION_RUNTIME_OPTIONS[1];
  const workspaces = model.workspaces.filter(option => option.value !== "all");
  const favoriteWorkspace = workspaces.find(option => option.value === (model.facets.workspace === "all" ? ui.lastCapsuleWorkspace : model.facets.workspace))
    ?? workspaces.find(option => option.value.startsWith("id:")) ?? workspaces[0];
  const update = (patch: Partial<ConversationListFilters>): void => {
    conversationUi.listFacets({ ...model.facets, ...patch }); setExpanded(null); setSearchOpen(false);
  };
  const runtimeHint = (value: string): string => value === "confirmation" ? "需要我确认：查看等待审批或补充输入的会话"
    : value === "working" ? "运行中 / 排队中：查看正在执行或等待执行的会话"
    : value === "failed" ? "运行失败：查看执行失败的会话，统一归入我需要关注" : "全部运行状态：保留工作区和其他筛选条件";
  const runtimeButton = (option: typeof SESSION_RUNTIME_OPTIONS[number]) => <WandHintButton key={option.value} iconOnly
    aria-label={`筛选运行状态：${option.label}`} aria-pressed={selectedRuntime === option.value}
    data-filter-active={selectedRuntime === option.value} hint={runtimeHint(option.value)}
    kind={selectedRuntime === option.value ? "soft" : "ghost"} onClick={() => update({ runtime: option.value, activityOnly: false })}>
    <WandIcon name={option.icon} size={18}/>
  </WandHintButton>;
  const workspaceInitials = (label: string): string => {
    const words = label.trim().split(/[\s_/-]+/).filter(Boolean);
    return (words.length > 1 ? words.slice(0, 2).map(word => [...word][0]).join("") : [...label].slice(0, 2).join("")).toLocaleUpperCase();
  };
  const workspaceButton = (option: { value: string; label: string }) => <WandHintButton key={option.value} iconOnly
    aria-label={`筛选工作区：${option.label}`} aria-pressed={model.facets.workspace === option.value}
    data-filter-active={model.facets.workspace === option.value}
    hint={option.value === "all" ? "全部工作区：显示所有工作区的会话，保留运行状态筛选" : `只显示「${option.label}」的会话，不切换当前会话`}
    kind={model.facets.workspace === option.value ? "soft" : "ghost"} onClick={() => update({ workspace: option.value })}>
    {option.value === "all" ? <WandIcon name="folders" size={22}/> : option.value === "none" ? <WandIcon name="folder" size={22}/>
      : <span className="sidebar-workspace-symbol" aria-hidden="true"><WandIcon name="folder" size={22}/>
        <span className="sidebar-workspace-monogram">{workspaceInitials(option.label)}</span></span>}
  </WandHintButton>;
  const capsule = (kind: NonNullable<typeof expanded>, children: React.ReactNode) => <div className="sidebar-filter-capsule" role="group"
    aria-label={kind === "runtime" ? "运行状态筛选" : "工作区筛选"} data-expanded={expanded === kind}
    onMouseEnter={() => { if (enabled) setExpanded(kind); }}
    onMouseLeave={() => setExpanded(previous => previous === kind ? null : previous)}
    onFocusCapture={() => { if (enabled) setExpanded(kind); }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(previous => previous === kind ? null : previous); }}
    onKeyDown={event => { if (event.key === "Escape" && !searchOpen) { event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }); setExpanded(null); event.stopPropagation(); } }}>
    {children}
  </div>;
  return <WandIconFamily value="lucide"><div className="sidebar-filter-capsules">
    <span className="sidebar-capsule-label">运行状态</span>
    {capsule("runtime", <>
      {runtimeButton(SESSION_RUNTIME_OPTIONS[2])}
      {runtimeButton(favoriteRuntime)}
      {expanded === "runtime" ? <div className="sidebar-capsule-rest">
        {SESSION_RUNTIME_OPTIONS.filter(option => option.value !== "all" && option.value !== favoriteRuntime.value).map(runtimeButton)}
      </div> : null}
    </>)}
    <span className="sidebar-capsule-label">工作区</span>
    {capsule("workspaces", <>
      {workspaceButton({ value: "all", label: "全部工作区" })}
      {favoriteWorkspace ? workspaceButton(favoriteWorkspace) : null}
      {expanded === "workspaces" || searchOpen ? <div className="sidebar-capsule-rest">
        {workspaces.filter(option => option.value !== favoriteWorkspace?.value).map(workspaceButton)}
        <WandPopover side="right" align="start" open={enabled && searchOpen} onOpenChange={setSearchOpen}
          ariaLabel="搜索工作区" popupOwner="sidebar-filter-capsules"
          onAfterOpenChange={shown => { if (shown) workspacePicker.current?.querySelector("input")?.focus({ preventScroll: true }); }}
          trigger={<WandHintButton iconOnly aria-label="搜索工作区" hint={searchOpen ? undefined : "搜索工作区：按名称查找更多工作区"}>
            <WandIcon name="search" size={18}/>
          </WandHintButton>}>
          <div ref={workspacePicker} className="sidebar-capsule-picker">
            <Typography.Text strong>搜索工作区</Typography.Text>
            <WandSearchField label="搜索工作区" value={query} onValueChange={setQuery}/>
            <div className="sidebar-capsule-options">
              {model.workspaces.filter(option => option.label.toLowerCase().includes(query.toLowerCase())).map(option =>
                <WandButton key={option.value} kind={model.facets.workspace === option.value ? "soft" : "ghost"}
                  onClick={() => update({ workspace: option.value })}>{option.label}</WandButton>)}
              {!model.workspaces.some(option => option.label.toLowerCase().includes(query.toLowerCase())) ? <Typography.Text type="secondary" role="status">没有匹配的工作区</Typography.Text> : null}
            </div>
          </div>
        </WandPopover>
      </div> : null}
    </>)}
  </div></WandIconFamily>;
}

export function UnifiedSidebarList({ model, titles, selectedSessionId, selectedConversationId, onOpen, onCreate, historyRows, historyCount = 0, enabled }: {
  model: UnifiedSidebarModel; titles: Readonly<Record<string, string>>; selectedSessionId: string | null;
  selectedConversationId: string | null; onOpen(entry: UnifiedSidebarEntry): void; onCreate(): void;
  historyRows?: React.ReactNode; historyCount?: number; enabled: boolean;
}) {
  const ui = useConversationUi();
  const list = React.useRef<HTMLDivElement>(null);
  const scope = `${model.facets.runtime}:${model.facets.taskStage}:${model.facets.workspace}:${model.facets.archive}:${model.facets.activityOnly}:${model.query}`;
  const scrolls = React.useRef<Record<string, number>>({});
  React.useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    node.scrollTop = scrolls.current[scope] ?? ui.scrolls[`unified:${scope}`] ?? 0;
    return () => { scrolls.current[scope] = node.scrollTop; conversationUi.scroll(`unified:${scope}`, node.scrollTop); };
  }, [scope]);
  const attentionRows = model.rows.filter(entry => isSessionAttention(entry.session) || isSessionNeedsConfirmation(entry.session));
  const otherRows = model.rows.filter(entry => !isSessionAttention(entry.session) && !isSessionNeedsConfirmation(entry.session));
  const orderedRows = [...attentionRows, ...otherRows];
  const selected = (entry: UnifiedSidebarEntry): boolean => selectedConversationId
    ? entry.conversation?.id === selectedConversationId : entry.session.id === selectedSessionId;
  const current = model.entries.find(selected);
  const outside = current && !model.rows.some(selected);
  const [locate, setLocate] = React.useState(false);
  React.useLayoutEffect(() => {
    if (!locate) return;
    const node = [...(list.current?.querySelectorAll<HTMLElement>("[data-unified-session]") ?? [])]
      .find(node => node.dataset.unifiedSession === current?.session.id);
    if (node) { node.scrollIntoView({ block: "nearest" }); node.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }); setLocate(false); }
  }, [locate, scope, current?.session.id]);
  return <SidebarSurfacesContext.Provider value={enabled}><div className="unified-sidebar-list">
    <div className="unified-sidebar-tools">
      <WandButton id="drawer-new-session-button" kind="primary" className="sidebar-new-task" onClick={onCreate}><WandIcon name="plus" size={18}/>新建会话</WandButton>
      <Flex align="center" gap={6}><WandSearchField label="搜索会话" value={model.query} onValueChange={query => conversationUi.filter("list-query", query)}/>
        <ConversationListFilterControls value={model.facets} workspaces={model.workspaces} enabled={enabled} onChange={conversationUi.listFacets}/></Flex>
      <ConversationListFilterSummary value={model.facets} workspaces={model.workspaces} onClear={() => conversationUi.listFacets(DEFAULT_CONVERSATION_FILTERS)}/>
      <Typography.Text type="secondary" role="status">{model.loading ? "正在读取会话…" : `${model.rows.length + historyCount} 个会话`}</Typography.Text>
      {model.error ? <Flex vertical><Typography.Text type="danger" role="alert">{model.error}</Typography.Text><WandButton onClick={model.refresh}>重新读取</WandButton></Flex> : null}
      {outside ? <div className="unified-sidebar-current" role="status"><span>当前会话不在筛选结果中</span><WandButton kind="ghost" size="small" onClick={() => {
        conversationUi.listFacets(DEFAULT_CONVERSATION_FILTERS); conversationUi.filter("list-query", ""); setLocate(true);
      }}>定位当前会话</WandButton></div> : null}
    </div>
    <div className="unified-sidebar-rows" ref={list}>
      {orderedRows.map((entry, index) => {
        const session = entry.session;
        const title = sidebarSessionLabel(session, model.entries.indexOf(entry), titles[session.id]);
        const workspace = entry.group.synthetic || entry.group.global ? "未分配工作区" : entry.group.workspaceName;
        const summary = [session.employeeName || entry.conversation?.title || (workspaceSessionProvider(session) ? agentToolDisplayName(workspaceSessionProvider(session), session.engine) : session.sessionKind === "pty" ? "空白终端" : "执行工具未知"), workspace,
          entry.task ? conversationTaskStageLabel(personSessionTaskStage(entry)) : "", entry.archived ? "已归档" : sidebarSessionState(session).label].filter(Boolean).join(" · ");
        const row = <div data-unified-session={session.id} className="unified-sidebar-row"><ImSidebarItem id={session.id} title={title} titleGenerating={session.titleGenerating}
          avatarNode={<SessionProviderMark session={session} size={20}/>} state={sidebarSessionState(session)} glow={sessionGlowStatus(session)} summary={summary}
          active={selected(entry)} onClick={() => onOpen(entry)}/>
          <WandIconButton className="unified-sidebar-more" aria-label={`${title}的菜单`} onClick={event => {
            const bounds = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: bounds.right, clientY: bounds.bottom, button: 2 }));
          }}><WandIcon name="more" size={16}/></WandIconButton></div>;
        const content = entry.conversation ? <UnifiedConversationMenu key={session.id} item={entry.conversation} row={row} onOpen={() => onOpen(entry)} onChanged={model.refresh}/> : <SidebarSessionMenu key={session.id} session={{ ...session, archived: entry.archived }} label={title}
          intoNewTask={session.workspaceTaskId ? undefined : entry.group} onOpen={() => onOpen(entry)}
          onArchive={async archived => { await archiveSidebarSession(session.id, archived); await taskGroupsStore.reload(); }}
          onDelete={async () => { await deleteSidebarSessions([session.id], entry.task ?? null); await taskGroupsStore.reload(); }} row={row}/>;
        return <React.Fragment key={session.id}>
          {attentionRows.length && index === 0 ? <div className="unified-sidebar-section">我需要关注 <span>{attentionRows.length}</span></div> : null}
          {attentionRows.length && index === attentionRows.length ? <div className="unified-sidebar-section">其他会话 <span>{otherRows.length}</span></div> : null}
          {content}
        </React.Fragment>;
      })}
      {historyRows}
      {!model.loading && !model.rows.length && !historyCount && !model.error ? <Flex vertical gap={8} className="unified-sidebar-empty" role="status"><Typography.Text type="secondary">{model.entries.length ? "没有符合条件的会话" : "还没有会话"}</Typography.Text>
        <WandButton kind="ghost" onClick={() => { conversationUi.listFacets(DEFAULT_CONVERSATION_FILTERS); conversationUi.filter("list-query", ""); }}>清除筛选与搜索</WandButton>
        <WandButton onClick={onCreate}>新建会话</WandButton></Flex> : null}
    </div>
  </div></SidebarSurfacesContext.Provider>;
}

/** Legacy chat deletion keeps its original scope; ordinary session menus remain session-owned. */
function UnifiedConversationMenu({ item, row, onOpen, onChanged }: {
  item: ConversationSummary; row: React.ReactElement<React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> }>; onOpen(): void; onChanged(): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const ref = React.useRef<HTMLElement>(null);
  const run = async (key: string): Promise<void> => {
    if (busy) return;
    setOpen(false); setError("");
    if (key === "open") { onOpen(); return; }
    if (key === "profile" && item.peerEmployeeId) { employeeProfile.open({ id: item.peerEmployeeId, name: item.title }, ref.current?.querySelector("button") ?? null); return; }
    if (key === "delete") {
      const answer = await wandOverlay.dialog({ title: `删除对话「${item.title}」？`,
        description: item.kind === "group" ? "将删除群聊及关联任务、消息与执行记录，此操作无法撤销。" : "将永久删除此私聊的消息记录和会话文件。员工资料及已经派出的群聊任务保留。此操作无法撤销。",
        actions: [{ label: "取消", value: false, autoFocus: true }, { label: "删除对话", value: true, kind: "danger" }] });
      if (answer.dismissed === true) return;
      if (!answer.action) return;
    }
    setBusy(true);
    try {
      if (key === "pin") await conversationsRepository.updateListState(item.id, { pinned: !item.pinnedAt });
      else if (key === "delete") {
        await conversationsRepository.remove(item.id);
        if (conversationUi.getSnapshot().selectedId === item.id) conversationUi.select("");
      }
      onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败，请重试。"); }
    finally { setBusy(false); }
  };
  return <SidebarRowMenu row={row} rowRef={ref} open={open} onOpenChange={setOpen} title={item.title} label="会话菜单" error={error}
    menu={{ items: [{ key: "open", label: "打开会话", disabled: busy },
      ...(item.peerEmployeeId ? [{ key: "profile", label: "查看员工资料", disabled: busy }] : []),
      { key: "pin", label: item.pinnedAt ? "取消置顶" : "置顶", disabled: busy },
      { key: "delete", label: "删除对话…", danger: true, disabled: busy }], onClick: ({ key }) => { void run(key); } }}/>;
}
