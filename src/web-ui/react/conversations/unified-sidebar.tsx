import { isSessionAttention } from "../workspaces/sidebar-display-mode";
import { agentToolDisplayName } from "../../provider-identity";
import { WorktreeDirectoryPicker, WorkspaceWorktreeLaunchDialog } from "../workspaces/worktree-directory-picker";
import { sessionWorktree } from "../workspaces/worktree-presentation";
import { SESSION_RUNTIME_OPTIONS, runtimeSelections, toggleSessionRuntime, isSessionNeedsConfirmation, normalizeSessionRuntime } from "./runtime-filter";
import * as React from "react";
import { Flex, Typography } from "antd";
import type { ConversationSummary } from "../../../conversation-types.js";
import { ImSidebarItem } from "../shell/im-sidebar-item";
import { WandButton } from "../ui/button";
import { WandHintButton } from "../ui/hint-button";
import { WandIcon, WandIconFamily } from "../ui/icons";
import { WandPopover } from "../ui/popover";
import { WandSearchField } from "../ui/search-field";
import { SessionProviderMark } from "../workspaces/session-mark";
import { sidebarSessionLabel, workspaceSessionProvider } from "../workspaces/session-order";
import { sidebarSessionState, sessionGlowStatus } from "../workspaces/sidebar-session-state";
import { SidebarSurfacesContext } from "../workspaces/sidebar-popup-owner";
import { SidebarSessionMenu } from "../workspaces/sidebar-session-menu";
import { archiveSidebarSession } from "../workspaces/sidebar-session-actions";
import { taskGroupsStore } from "../workspaces/task-groups-store";
import { DEFAULT_CONVERSATION_FILTERS,
  workspaceSelections, employeeSelections, toggleWorkspaceSelection, toggleEmployeeSelection, type ConversationEmployeeOption, type ConversationListFilters } from "./list-filters";
import { cachedSiliconEmployee } from "../agents/employee-repository";
import { EmployeeAvatar } from "../agents/employee-avatar";
import { ConversationListFilterSummary } from "./list-filter-controls";
import { conversationsRepository } from "./repository";
import { SidebarRowMenu } from "../workspaces/sidebar-row-menu";
import { employeeProfile } from "../agents/employee-profile-state";
import { conversationUi, useConversationUi } from "./state";
import {
  collectUnifiedSessions,
  orderUnifiedSidebarRows,
  useUnifiedSidebar,
  type UnifiedSidebarEntry,
  type UnifiedSidebarModel,
} from "./unified-sidebar-model";

export {
  collectUnifiedSessions,
  orderUnifiedSidebarRows,
  useUnifiedSidebar,
  type UnifiedSidebarEntry,
  type UnifiedSidebarModel,
};

/** Two quick choices remain visible; the capsule itself reveals the rest. */
export function SidebarFilterCapsules({ model, enabled }: { model: UnifiedSidebarModel; enabled: boolean }) {
  const ui = useConversationUi();
  const [expanded, setExpanded] = React.useState<"runtime" | "workspaces" | "employees" | null>(null);
  const [search, setSearch] = React.useState<"workspaces" | "employees" | null>(null);
  const [merge, setMerge] = React.useState<{ workspace: import("../workspaces/types").Workspace; sourcePath: string } | null>(null);
  const [query, setQuery] = React.useState("");
  const [employeeQuery, setEmployeeQuery] = React.useState("");
  const workspacePicker = React.useRef<HTMLDivElement>(null);
  const workspaceAllButton = React.useRef<HTMLButtonElement>(null);
  const employeePicker = React.useRef<HTMLDivElement>(null);
  const employeeAllButton = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { if (!enabled) { setExpanded(null); setSearch(null); } }, [enabled]);
  React.useEffect(() => { if (search !== "workspaces") setQuery(""); }, [search]);
  React.useEffect(() => { if (search !== "employees") setEmployeeQuery(""); }, [search]);
  const selectedRuntime = normalizeSessionRuntime(model.facets.runtime);
  const runtimeSelected = runtimeSelections(selectedRuntime);
  const workspaceSelected = workspaceSelections(model.facets.workspace);
  const employeeSelected = employeeSelections(model.facets.employee);
  const isRuntimeSelected = (value: string) => value === "all" ? !runtimeSelected.length : runtimeSelected.some(item => item === value);
  const isWorkspaceSelected = (value: string) => value === "all" ? !workspaceSelected.length : workspaceSelected.includes(value);
  const isEmployeeSelected = (value: string) => value === "all" ? !employeeSelected.length : employeeSelected.includes(value);
  const rememberedRuntime = selectedRuntime === "all" ? normalizeSessionRuntime(ui.lastCapsuleRuntime) : selectedRuntime;
  const preferredRuntime = SESSION_RUNTIME_OPTIONS.find(option => option.value === runtimeSelections(rememberedRuntime)[0] && option.value !== "all") ?? SESSION_RUNTIME_OPTIONS[1];
  const workspaces = model.workspaces.filter(option => option.value !== "all");
  const preferredWorkspace = workspaces.find(option => option.value === (workspaceSelections(ui.lastCapsuleWorkspace)[0] ?? workspaceSelected[0]))
    ?? workspaces.find(option => option.value.startsWith("id:")) ?? workspaces[0];
  const employeeChoices = model.employees.filter(option => option.value !== "all");
  const employees = employeeChoices.filter(option => option.value !== "none");
  const preferredEmployee = employees.find(option => option.value === (employeeSelections(ui.lastCapsuleEmployee)[0] ?? employeeSelected[0])) ?? employees[0];
  const collapsedRuntimes = runtimeSelected.length ? SESSION_RUNTIME_OPTIONS.filter(option => runtimeSelected.includes(option.value)) : [preferredRuntime];
  const collapsedWorkspaces = workspaceSelected.length ? workspaces.filter(option => workspaceSelected.includes(option.value)) : preferredWorkspace ? [preferredWorkspace] : [];
  const collapsedEmployees = employeeSelected.length ? employeeChoices.filter(option => employeeSelected.includes(option.value)) : preferredEmployee ? [preferredEmployee] : [];
  const [pinnedRuntimes, setPinnedRuntimes] = React.useState(collapsedRuntimes);
  const [pinnedWorkspaces, setPinnedWorkspaces] = React.useState(collapsedWorkspaces);
  const [pinnedEmployees, setPinnedEmployees] = React.useState(collapsedEmployees);
  const visibleRuntimes = expanded === "runtime" ? pinnedRuntimes : collapsedRuntimes;
  const visibleWorkspaces = expanded === "workspaces" || search === "workspaces" ? pinnedWorkspaces : collapsedWorkspaces;
  const visibleEmployees = expanded === "employees" || search === "employees" ? pinnedEmployees : collapsedEmployees;
  const expand = (kind: "runtime" | "workspaces" | "employees") => {
    if (!enabled || expanded === kind) return;
    setPinnedRuntimes(collapsedRuntimes); setPinnedWorkspaces(collapsedWorkspaces); setPinnedEmployees(collapsedEmployees); setExpanded(kind);
  };
  const update = (patch: Partial<ConversationListFilters>): void => {
    conversationUi.listFacets({ ...model.facets, ...patch });
  };
  const runtimeHint = (value: string): string => value === "confirmation" ? "需要我确认：查看等待授权或补充回答的会话"
    : value === "running" ? "运行中：包含正在执行及刚完成但尚未查看的会话"
    : value === "queued" ? "排队中：查看等待开始执行的会话"
    : value === "idle" ? "空闲：本轮已跑完、正在等你下一次输入的会话"
    : value === "finished" ? "已结束：进程已退出或被停止的会话"
    : value === "failed" ? "运行失败：查看执行失败的会话，统一归入我需要关注"
    : value === "archived" ? "已归档：默认不显示，勾选后查看已归档的任务与会话"
    : "全部运行状态：不含已归档的任务，保留工作区和其他筛选条件";
  const runtimeButton = (option: typeof SESSION_RUNTIME_OPTIONS[number]) => <WandHintButton key={option.value} iconOnly
    aria-label={`筛选运行状态：${option.label}`} aria-pressed={isRuntimeSelected(option.value)}
    data-filter-active={isRuntimeSelected(option.value)} hint={runtimeHint(option.value)}
    kind={isRuntimeSelected(option.value) ? "soft" : "ghost"} onClick={() => update({ runtime: toggleSessionRuntime(model.facets.runtime, option.value), activityOnly: false })}>
    <WandIcon name={option.icon} size={18}/>
  </WandHintButton>;
  const capsuleInitials = (label: string): string => {
    const words = label.trim().split(/[\s_/-]+/).filter(Boolean);
    return (words.length > 1 ? words.slice(0, 2).map(word => [...word][0]).join("") : [...label].slice(0, 2).join("")).toLocaleUpperCase();
  };
  const workspaceButton = (option: { value: string; label: string }) => <WandHintButton key={option.value} iconOnly
    ref={option.value === "all" ? workspaceAllButton : undefined} aria-label={`筛选工作区：${option.label}`} aria-pressed={isWorkspaceSelected(option.value)}
    data-filter-active={isWorkspaceSelected(option.value)}
    hint={option.value === "all" ? "全部工作区：显示所有工作区的会话，保留运行状态筛选" : `切换「${option.label}」的选中状态，可同时选择多个工作区`}
    kind={isWorkspaceSelected(option.value) ? "soft" : "ghost"} onClick={() => update({ workspace: toggleWorkspaceSelection(model.facets.workspace, option.value) })}>
    {option.value === "all" ? <WandIcon name="folders" size={22}/> : option.value === "none" ? <WandIcon name="folder" size={22}/>
      : <span className="sidebar-capsule-symbol" aria-hidden="true"><WandIcon name="folder" size={22}/>
        <span className="sidebar-capsule-monogram">{capsuleInitials(option.label)}</span></span>}
  </WandHintButton>;
  const employeeButton = (option: ConversationEmployeeOption) => <WandHintButton key={option.value} iconOnly
    ref={option.value === "all" ? employeeAllButton : undefined} aria-label={`筛选员工：${option.label}`} aria-pressed={isEmployeeSelected(option.value)}
    data-filter-active={isEmployeeSelected(option.value)}
    hint={option.value === "all" ? "全部员工" : option.value === "none" ? "未分配员工" : option.label}
    kind={isEmployeeSelected(option.value) ? "soft" : "ghost"} onClick={() => update({ employee: toggleEmployeeSelection(model.facets.employee, option.value) })}>
    {option.value === "all" ? <WandIcon name="users" size={22}/> : option.value === "none" ? <WandIcon name="user" size={22}/>
      : <span className="sidebar-capsule-avatar" aria-hidden="true">
          <EmployeeAvatar
            employee={cachedSiliconEmployee(option.value) ?? { id: option.value, name: option.label, avatar: option.avatar }}
            provider=""
            size="toolbar"
            renderMode="static"
          />
        </span>}
  </WandHintButton>;
  const capsule = (kind: NonNullable<typeof expanded>, children: React.ReactNode) => <div className="sidebar-filter-capsule" role="group"
    aria-label={kind === "runtime" ? "运行状态筛选" : kind === "workspaces" ? "工作区筛选" : "员工筛选"} data-expanded={expanded === kind}
    onMouseEnter={() => expand(kind)}
    onMouseLeave={() => setExpanded(previous => previous === kind ? null : previous)}
    onFocusCapture={() => expand(kind)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(previous => previous === kind ? null : previous); }}
    onKeyDown={event => { if (event.key === "Escape" && !search) { event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }); setExpanded(null); event.stopPropagation(); } }}>
    {children}
  </div>;
  return <WandIconFamily value="lucide"><div className="sidebar-filter-capsules">
    <span className="sidebar-capsule-label">运行状态</span>
    {capsule("runtime", <>
      {runtimeButton(SESSION_RUNTIME_OPTIONS.find(option => option.value === "all")!)}
      {visibleRuntimes.map(runtimeButton)}
      {expanded === "runtime" ? <div className="sidebar-capsule-rest">
        {SESSION_RUNTIME_OPTIONS.filter(option => option.value !== "all" && !visibleRuntimes.some(visible => visible.value === option.value)).map(runtimeButton)}
      </div> : null}
    </>)}
    <span className="sidebar-capsule-label">工作区</span>
    {capsule("workspaces", <>
      {workspaceButton({ value: "all", label: "全部工作区" })}
      {visibleWorkspaces.map(workspaceButton)}
      {expanded === "workspaces" || search === "workspaces" ? <div className="sidebar-capsule-rest">
        {workspaces.filter(option => !visibleWorkspaces.some(visible => visible.value === option.value)).map(workspaceButton)}
        <WandPopover side="right" align="start" open={enabled && search === "workspaces"} onOpenChange={open => setSearch(open ? "workspaces" : null)}
          ariaLabel="搜索工作区" popupOwner="sidebar-filter-capsules" returnFocusRef={workspaceAllButton}
          onAfterOpenChange={shown => { if (shown) workspacePicker.current?.querySelector("input")?.focus({ preventScroll: true }); }}
          trigger={<WandHintButton iconOnly aria-label="搜索工作区" hint={search === "workspaces" ? undefined : "搜索工作区：按名称查找更多工作区"}>
            <WandIcon name="search" size={18}/>
          </WandHintButton>}>
          <div ref={workspacePicker} className="sidebar-capsule-picker">
            <Typography.Text strong>搜索工作区</Typography.Text>
            <WandSearchField label="搜索工作区" value={query} onValueChange={setQuery}/>
            <div className="sidebar-capsule-options">
              {model.workspaces.filter(option => (option.value === "all" || option.value === "none") && option.label.toLowerCase().includes(query.toLowerCase())).map(option =>
                <WandButton key={option.value} kind={isWorkspaceSelected(option.value) ? "soft" : "ghost"} aria-pressed={isWorkspaceSelected(option.value)}
                  onClick={() => update({ workspace: toggleWorkspaceSelection(model.facets.workspace, option.value) })}>{option.label}</WandButton>)}
              <WorktreeDirectoryPicker onMerge={(workspace, sourcePath) => { setSearch(null); setExpanded(null); setMerge({ workspace, sourcePath }); }} groups={model.groups} query={query} selected={isWorkspaceSelected} onSelect={value => update({ workspace: toggleWorkspaceSelection(model.facets.workspace, value) })}/>
            </div>
          </div>
        </WandPopover>
      </div> : null}
    </>)}
    <span className="sidebar-capsule-label">员工</span>
    {capsule("employees", <>
      {employeeButton({ value: "all", label: "全部员工" })}
      {visibleEmployees.map(employeeButton)}
      {expanded === "employees" || search === "employees" ? <div className="sidebar-capsule-rest">
        {employeeChoices.filter(option => !visibleEmployees.some(visible => visible.value === option.value)).map(employeeButton)}
        <WandPopover side="right" align="start" open={enabled && search === "employees"} onOpenChange={open => setSearch(open ? "employees" : null)}
          ariaLabel="搜索员工" popupOwner="sidebar-filter-capsules" returnFocusRef={employeeAllButton}
          onAfterOpenChange={shown => { if (shown) employeePicker.current?.querySelector("input")?.focus({ preventScroll: true }); }}
          trigger={<WandHintButton iconOnly aria-label="搜索员工" hint={search === "employees" ? undefined : "搜索员工：按名称查找更多员工"}>
            <WandIcon name="search" size={18}/>
          </WandHintButton>}>
          <div ref={employeePicker} className="sidebar-capsule-picker">
            <Typography.Text strong>搜索员工</Typography.Text>
            <WandSearchField label="搜索员工" value={employeeQuery} onValueChange={setEmployeeQuery}/>
            <div className="sidebar-capsule-options">
              {model.employees.filter(option => (option.value === "all" || option.value === "none") && option.label.toLowerCase().includes(employeeQuery.toLowerCase())).map(option =>
                <WandButton key={option.value} kind={isEmployeeSelected(option.value) ? "soft" : "ghost"} aria-pressed={isEmployeeSelected(option.value)}
                  onClick={() => update({ employee: toggleEmployeeSelection(model.facets.employee, option.value) })}>{option.label}</WandButton>)}
              {employees.filter(option => option.label.toLowerCase().includes(employeeQuery.toLowerCase())).map(option =>
                <WandButton key={option.value} kind={isEmployeeSelected(option.value) ? "soft" : "ghost"} aria-pressed={isEmployeeSelected(option.value)}
                  onClick={() => update({ employee: toggleEmployeeSelection(model.facets.employee, option.value) })}>
                  <span className="sidebar-capsule-choice">
                    <span className="sidebar-capsule-avatar" aria-hidden="true">
                      <EmployeeAvatar
                        employee={cachedSiliconEmployee(option.value) ?? { id: option.value, name: option.label, avatar: option.avatar }}
                        provider=""
                        size="toolbar"
                        renderMode="static"
                      />
                    </span>
                    <span>{option.label}</span>
                  </span>
                  {isEmployeeSelected(option.value) ? <WandIcon name="check" size={14}/> : null}
                </WandButton>)}
            </div>
          </div>
        </WandPopover>
      </div> : null}
    </>)}
  </div>{merge ? <WorkspaceWorktreeLaunchDialog {...merge} onDismiss={() => setMerge(null)}/> : null}</WandIconFamily>;
}

export function UnifiedSidebarList({ model, titles, selectedSessionId, selectedConversationId, onOpen, onCreate, historyRows, historyCount = 0, enabled }: {
  model: UnifiedSidebarModel; titles: Readonly<Record<string, string>>; selectedSessionId: string | null;
  selectedConversationId: string | null; onOpen(entry: UnifiedSidebarEntry): void; onCreate(): void;
  historyRows?: React.ReactNode; historyCount?: number; enabled: boolean;
}) {
  const ui = useConversationUi();
  const list = React.useRef<HTMLDivElement>(null);
  const scope = `${ui.listWorktree}:${model.facets.runtime}:${model.facets.taskStage}:${model.facets.workspace}:${model.facets.archive}:${model.facets.activityOnly}:${model.query}`;
  const scrolls = React.useRef<Record<string, number>>({});
  React.useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    node.scrollTop = scrolls.current[scope] ?? ui.scrolls[`unified:${scope}`] ?? 0;
    return () => { scrolls.current[scope] = node.scrollTop; conversationUi.scroll(`unified:${scope}`, node.scrollTop); };
  }, [scope]);
  const attentionRows = model.orderedRows.filter(entry => isSessionAttention(entry.session) || isSessionNeedsConfirmation(entry.session));
  const otherRows = model.orderedRows.filter(entry => !isSessionAttention(entry.session) && !isSessionNeedsConfirmation(entry.session));
  const orderedRows = model.orderedRows;
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
      {ui.listWorktree ? <WandButton kind="soft" className="sidebar-worktree-filter" aria-label="取消 Worktree 筛选" title={ui.listWorktree} onClick={() => conversationUi.clearWorktree()}>
        <WandIcon name="branch" size={14}/><span>Worktree · {ui.listWorktree.split("/").filter(Boolean).at(-1)}</span><WandIcon name="close" size={12}/>
      </WandButton> : null}
      <ConversationListFilterSummary value={model.facets} workspaces={model.workspaces} employees={model.employees} onClear={() => conversationUi.listFacets(DEFAULT_CONVERSATION_FILTERS)}/>
      <Typography.Text type="secondary" role="status">{model.loading ? "正在读取会话…" : `${model.rows.length + historyCount} 个会话`}</Typography.Text>
      {model.error ? <Flex vertical><Typography.Text type="danger" role="alert">{model.error}</Typography.Text><WandButton onClick={model.refresh}>重新读取</WandButton></Flex> : null}
      {outside ? <div className="unified-sidebar-current" role="status"><span>当前会话不在筛选结果中</span><WandButton kind="ghost" size="small" onClick={() => {
        conversationUi.listFacets(DEFAULT_CONVERSATION_FILTERS); conversationUi.clearWorktree(); conversationUi.filter("list-query", ""); setLocate(true);
      }}>定位当前会话</WandButton></div> : null}
    </div>
    <div className="unified-sidebar-rows" ref={list}>
      {orderedRows.map((entry, index) => {
        const session = entry.session;
        const title = sidebarSessionLabel(session, model.entries.indexOf(entry), titles[session.id]);
        const tree = sessionWorktree(entry.group, entry.task, session);
        const parent = entry.group.worktree?.parentWorkspaceId ? model.groups.find(group => group.workspaceId === entry.group.worktree?.parentWorkspaceId) : undefined;
        const workspace = parent?.workspaceName ?? (entry.group.synthetic || entry.group.global ? "未分配工作区" : entry.group.workspaceName);
        const summary = [session.employeeName || entry.conversation?.title || (workspaceSessionProvider(session) ? agentToolDisplayName(workspaceSessionProvider(session), session.engine) : session.sessionKind === "pty" ? "空白终端" : "执行工具未知"), workspace,
          entry.archived ? "已归档" : sidebarSessionState(session).label].filter(Boolean).join(" · ");
        const row = <div data-unified-session={session.id} className={`unified-sidebar-row${selected(entry) ? " is-selected" : ""}`}><ImSidebarItem id={session.id} title={title} titleGenerating={session.titleGenerating}
          avatarNode={<SessionProviderMark session={session} size={13}/>} state={sidebarSessionState(session)} glow={sessionGlowStatus(session)} summary={summary}
          active={selected(entry)} onClick={() => onOpen(entry)}/>
          {tree ? <WandButton kind={ui.listWorktree === tree.path ? "soft" : "ghost"} size="small" className="session-worktree-tag"
            aria-pressed={ui.listWorktree === tree.path} aria-label={`筛选 Worktree ${tree.name}`} title={`${tree.path}\n分支：${tree.branch || "detached HEAD"}`}
            onClick={event => { event.stopPropagation(); conversationUi.worktree(tree.path); }}><WandIcon name="branch" size={12}/><span>{tree.name}</span></WandButton> : null}
        </div>;
        const content = entry.conversation ? <UnifiedConversationMenu key={session.id} item={entry.conversation} row={row} onOpen={() => onOpen(entry)} onChanged={model.refresh}/> : <SidebarSessionMenu key={session.id} session={{ ...session, archived: entry.archived }} label={title}
          intoNewTask={session.workspaceTaskId ? undefined : entry.group} onOpen={() => onOpen(entry)}
          onArchive={async archived => { await archiveSidebarSession(session.id, archived); await taskGroupsStore.reload(); }} row={row}/>;
        return <React.Fragment key={session.id}>
          {attentionRows.length && index === 0 ? <div className="unified-sidebar-section">我需要关注 <span>{attentionRows.length}</span></div> : null}
          {attentionRows.length && index === attentionRows.length ? <div className="unified-sidebar-section">其他会话 <span>{otherRows.length}</span></div> : null}
          {content}
        </React.Fragment>;
      })}
      {historyRows}
      {!model.loading && !model.rows.length && !historyCount && !model.error ? <Flex vertical gap={8} className="unified-sidebar-empty" role="status"><Typography.Text type="secondary">{model.entries.length ? "没有符合条件的会话" : "还没有会话"}</Typography.Text>
        <WandButton kind="ghost" onClick={() => { conversationUi.listFacets(DEFAULT_CONVERSATION_FILTERS); conversationUi.clearWorktree(); conversationUi.filter("list-query", ""); }}>清除筛选与搜索</WandButton>
        <WandButton onClick={onCreate}>新建会话</WandButton></Flex> : null}
    </div>
  </div></SidebarSurfacesContext.Provider>;
}

/** Legacy conversations keep identity actions; session lifecycle belongs to the session menu. */
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
    setBusy(true);
    try {
      if (key === "pin") await conversationsRepository.updateListState(item.id, { pinned: !item.pinnedAt });
      onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败，请重试。"); }
    finally { setBusy(false); }
  };
  return <SidebarRowMenu row={row} rowRef={ref} open={open} onOpenChange={setOpen} title={item.title} label="会话菜单" error={error}
    menu={{ items: [{ key: "open", label: "打开会话", disabled: busy },
      ...(item.peerEmployeeId ? [{ key: "profile", label: "查看员工资料", disabled: busy }] : []),
      { key: "pin", label: item.pinnedAt ? "取消置顶" : "置顶", disabled: busy }], onClick: ({ key }) => { void run(key); } }}/>;
}
