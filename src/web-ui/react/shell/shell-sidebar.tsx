import * as React from "react";
import { normalizeProviderId, providerDisplayName } from "../../provider-identity";
import { ProviderLogo } from "../provider-logo";
import { WorkspacesPanel } from "../workspaces/workspaces-panel";
import {
  WandButton,
  WandDropdownMenu,
  WandDropdownMenuContent,
  WandDropdownMenuItem,
  WandDropdownMenuTrigger,
  WandIcon,
  WandIconButton,
  WandNavigation,
  WandNavigationItem,
  WandNavigationLink,
  WandNavigationList,
  type WandIconName,
} from "../ui";
import { classNames } from "../ui/class-names";
import { sidebarSearchMatches } from "../workspaces/sidebar-search";

import { taskBoardController, taskBoardStore } from "../issues/task-board-controller";
import { SidebarPeek } from "./sidebar-peek";
import { useHoverPointer, useSidebarPeek } from "./use-sidebar-peek";
import { useSidebarDrawer } from "./use-sidebar-drawer";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import type {
  UiAction,
  UiManageTarget,
  UiNativeHistoryProvider,
  UiSessionVm,
  UiSidebarGroupVm,
} from "./ui-store";

export interface ShellSidebarEntryActions {
  readonly primary: UiAction;
  readonly resume: UiAction | null;
  readonly delete: UiAction | null;
  readonly merge: UiAction | null;
  readonly cleanup: UiAction | null;
}

export function getSidebarEntryTarget(entry: Readonly<UiSessionVm>): UiManageTarget {
  if (entry.source.endsWith("-history")) return entry.source as UiManageTarget;
  return "session";
}

function isHistoryEntry(entry: Readonly<UiSessionVm>): boolean {
  return entry.source.endsWith("-history");
}

function historyProviderFor(entry: Readonly<UiSessionVm>): UiNativeHistoryProvider | null {
  if (!isHistoryEntry(entry)) return null;
  const provider = entry.source.slice(0, -"-history".length);
  return provider === "codex" || provider === "opencode" || provider === "qoder"
    ? provider
    : "claude";
}

export function getShellSidebarEntryActions(
  entry: Readonly<UiSessionVm>,
  manageMode: boolean,
): ShellSidebarEntryActions {
  const target = getSidebarEntryTarget(entry);
  if (manageMode) {
    return {
      primary: { type: "session.manage.select", target, id: entry.id },
      resume: null,
      delete: null,
      merge: null,
      cleanup: null,
    };
  }

  const historyProvider = historyProviderFor(entry);
  const historyResume: UiAction | null = historyProvider
    ? { type: "session.resumeHistory", provider: historyProvider, id: entry.id, cwd: entry.cwd }
    : null;
  const cleanup = entry.worktree?.enabled && entry.worktree.mergeStatus === "merged"
    ? { type: "session.cleanup", id: entry.id } satisfies UiAction
    : null;
  const merge = entry.worktree?.enabled
    && entry.worktree.branch
    && entry.worktree.path
    && entry.worktree.mergeStatus !== "merged"
    ? { type: "session.merge", id: entry.id } satisfies UiAction
    : null;

  return {
    primary: historyResume ?? { type: "session.select", id: entry.id },
    resume: historyResume ?? (entry.resumable ? { type: "session.resume", id: entry.id } : null),
    delete: { type: "session.delete", target, id: entry.id },
    merge,
    cleanup,
  };
}



function ActionButton({
  action,
  dispatch,
  actionName,
  label,
  icon,
  className,
  disabled,
  data,
}: {
  action: UiAction;
  dispatch(action: UiAction): void | Promise<unknown>;
  actionName: string;
  label: string;
  icon: Extract<WandIconName, "merge" | "resume" | "trash">;
  className?: string;
  disabled?: boolean;
  data?: Record<string, string>;
}) {
  return (
    <WandIconButton
      className={classNames("session-action-btn", className)}
      data-action={actionName}
      data-session-id={data?.sessionId}
      data-claude-session-id={data?.historyId}
      data-cwd={data?.cwd}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        void dispatch(action);
      }}
    >
      <WandIcon name={icon}/>
    </WandIconButton>
  );
}

function ManageCheckbox({
  entry,
  dispatch,
}: {
  entry: Readonly<UiSessionVm>;
  dispatch(action: UiAction): void | Promise<unknown>;
}) {
  const target = getSidebarEntryTarget(entry);
  const legacyKind = target === "session" ? "sessions" : target === "codex-history" ? "codex" : "history";
  return (
    <label className="session-manage-check" onClick={(event) => event.stopPropagation()}>
      <input
        type="checkbox"
        data-action="toggle-selection"
        data-kind={legacyKind}
        data-id={entry.id}
        checked={entry.selected}
        aria-label={`选择会话 ${entry.title}`}
        onChange={() => void dispatch({ type: "session.manage.select", target, id: entry.id })}
      />
      <span/>
    </label>
  );
}

function WorktreeBadges({ entry }: { entry: Readonly<UiSessionVm> }) {
  if (!entry.worktree?.enabled) return null;
  const labels: Readonly<Record<string, string>> = {
    ready: "可合并",
    checking: "检查中",
    merging: "合并中",
    merged: "已合并",
    failed: "合并失败",
  };
  const title = [
    entry.worktree.branch && `Worktree: ${entry.worktree.branch}`,
    entry.worktree.path && `Path: ${entry.worktree.path}`,
  ].filter(Boolean).join("\n");
  return (
    <>
      <span className="session-kind-badge worktree" title={title || undefined}>Worktree</span>
      {entry.worktree.mergeStatus && (
        <span className={classNames("session-kind-badge worktree-merge", entry.worktree.mergeStatus)}>
          {labels[entry.worktree.mergeStatus] ?? entry.worktree.mergeStatus}
        </span>
      )}
    </>
  );
}

function formatEntryTime(entry: Readonly<UiSessionVm>): string {
  const value = entry.endedAt ?? entry.startedAt;
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  if (!entry.endedAt && entry.turnActive && entry.startedAt) {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(entry.startedAt).getTime()) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  const delta = Math.max(0, Date.now() - parsed.getTime());
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}小时前`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}天前`;
  return parsed.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function ProviderMark({ entry }: { entry: Readonly<UiSessionVm> }) {
  const label = providerDisplayName(entry.provider);
  const provider = normalizeProviderId(entry.provider);
  return (
    <span
      className={classNames("session-provider-mark", `provider-${provider ?? "generic"}`)}
      aria-hidden="true"
      title={label}
    >
      <ProviderLogo provider={provider}/>
    </span>
  );
}

function PathReveal({ path }: { path: string }) {
  const containerRef = React.useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = React.useState(0);
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  const separator = normalized.lastIndexOf("/");
  const prefix = separator >= 0 ? normalized.slice(0, separator + 1) : "";
  const leaf = separator >= 0 ? normalized.slice(separator + 1) : normalized;
  const staggerMs = Array.from(normalized).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 1_200;

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const inner = container.firstElementChild as HTMLElement | null;
      setOverflow(Math.max(0, (inner?.scrollWidth ?? 0) - container.clientWidth));
    };
    const frame = requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [normalized]);

  const travelSeconds = Math.max(4.8, overflow / 28);
  if (!path) return null;
  return (
    <span
      ref={containerRef}
      className={classNames("session-path", "tail-marquee-path", overflow > 1 && "is-overflowing")}
      title={path}
      aria-label={path}
      style={{
        "--tail-marquee-shift": `${overflow}px`,
        "--tail-marquee-duration": `${Math.min(8, travelSeconds)}s`,
        "--tail-marquee-delay": `${1.8 + staggerMs / 1_000}s`,
      } as React.CSSProperties}
    >
      <span className="tail-marquee-path-inner">
        <span className="tail-marquee-prefix">{prefix}</span>
        <span className="tail-marquee-leaf">{leaf}</span>
      </span>
    </span>
  );
}

function SessionEntry({
  entry,
  manageMode,
  dispatch,
}: {
  entry: Readonly<UiSessionVm>;
  manageMode: boolean;
  dispatch(action: UiAction): void | Promise<unknown>;
}) {
  const actions = getShellSidebarEntryActions(entry, manageMode);
  const isHistory = isHistoryEntry(entry);
  const provider = historyProviderFor(entry) ?? "claude";
  const data: Record<string, string> = isHistory
    ? { historyId: entry.id, cwd: entry.cwd }
    : { sessionId: entry.id };
  const activate = () => void dispatch(actions.primary);
  const time = formatEntryTime(entry);
  const prominentStatus = !isHistory && (
    entry.permissionBlocked
    || entry.inFlight
    || entry.turnActive
    || ["thinking", "waiting-input", "waiting_input", "reconnecting"].includes(entry.status)
  );
  const prominentWarning = entry.permissionBlocked
    || ["waiting-input", "waiting_input", "reconnecting"].includes(entry.status);

  return (
    <div
      className={classNames(
        "session-item",
        isHistory && "non-wand-session",
        entry.active && "active",
        manageMode && entry.selected && "selected",
        manageMode && "session-managing",
        prominentStatus && "status-prominent",
        prominentWarning && "status-prominent-warning",
      )}
      data-session-id={isHistory ? undefined : entry.id}
      data-claude-history-id={isHistory ? entry.id : undefined}
      data-provider={isHistory ? provider : undefined}
      data-cwd={isHistory ? entry.cwd : undefined}
      role="button"
      tabIndex={0}
      aria-current={entry.active ? "page" : undefined}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        activate();
      }}
    >
      {!manageMode && !isHistory && actions.delete && (
        <div className="session-swipe-bg" aria-hidden="true">
          <WandButton
            className="session-swipe-delete"
            kind="danger"
            size="small"
            data-action="swipe-delete-session"
            data-session-id={entry.id}
            tabIndex={-1}
            aria-label="删除会话"
            onClick={(event) => {
              event.stopPropagation();
              void dispatch(actions.delete!);
            }}
          >
            <WandIcon name="trash" slot="start" size={18}/><span>删除</span>
          </WandButton>
        </div>
      )}
      <div className="session-item-content">
        <div className="session-item-row">
          {manageMode && <ManageCheckbox entry={entry} dispatch={dispatch}/>} 
          <div className="session-main">
            <div className="session-title-row">
              <span className="session-leading-slot"><ProviderMark entry={entry}/></span>
              <div
                className={classNames(
                  isHistory ? "session-command claude-history-preview" : "session-title",
                  entry.titleGenerating && "title-generating",
                )}
                aria-busy={entry.titleGenerating || undefined}
              >
                {entry.title}
              </div>
            </div>
            {entry.description && <div className="session-description">{entry.description}</div>}
            <div className="session-meta">
              <span className="session-leading-slot session-time">{time}</span>
              {isHistory ? (
                <>
                  <span className="session-context session-context-recoverable"><WandIcon name="history" size={11}/>可恢复</span>
                  <PathReveal path={entry.cwd}/>
                </>
              ) : (
                <>
                  <span className={classNames("session-status", entry.permissionBlocked
                    ? "permission-blocked"
                    : (entry.inFlight || (entry.turnActive && entry.status === "running"))
                      ? "running"
                      : entry.status === "running" && Boolean(entry.provider) && entry.kind === "pty"
                        ? "idle"
                        : entry.status)}>
                    {entry.statusLabel}
                  </span>
                  <PathReveal path={entry.cwd}/>
                  <WorktreeBadges entry={entry}/>
                </>
              )}
            </div>
          </div>
          {!manageMode && (
            <span className="session-actions">
              {actions.resume && (
                <ActionButton
                  action={actions.resume}
                  dispatch={dispatch}
                  actionName={isHistory
                    ? provider === "claude" ? "resume-history" : `resume-${provider}-history`
                    : "resume"}
                  label={isHistory ? `恢复此 ${providerDisplayName(provider)} 会话` : "恢复会话"}
                  icon="resume"
                  data={data}
                />
              )}
              {actions.merge && (
                <ActionButton
                  action={actions.merge}
                  dispatch={dispatch}
                  actionName="worktree-merge"
                  label="合并到主分支"
                  icon="merge"
                  className="merge-btn"
                  disabled={entry.status === "running" || entry.worktree?.mergeStatus === "merging"}
                  data={data}
                />
              )}
              {actions.cleanup && (
                <ActionButton
                  action={actions.cleanup}
                  dispatch={dispatch}
                  actionName="worktree-cleanup"
                  label="重试清理 worktree"
                  icon="trash"
                  className="merge-btn"
                  data={data}
                />
              )}
              {actions.delete && (
                <ActionButton
                  action={actions.delete}
                  dispatch={dispatch}
                  actionName={isHistory
                    ? provider === "claude" ? "delete-history" : `delete-${provider}-history`
                    : "delete-session"}
                  label="删除会话"
                  icon="trash"
                  className="delete-btn"
                  data={data}
                />
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}


export interface ShellSidebarPrimaryAction {
  readonly action: UiAction;
  readonly label: string;
  readonly ariaLabel: string;
}

export function getShellSidebarPrimaryAction(): ShellSidebarPrimaryAction {
  // 侧栏统一为任务视图：主按钮固定为「新任务」，不再有独立的「新会话」入口。
  return {
    action: { type: "workspace.new" },
    label: "新建任务",
    ariaLabel: "新建任务",
  };
}



function SidebarCompactToggle({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle(): void;
}) {
  const label = active ? "展开完整侧边栏" : "收起为窄栏";
  return (
    <WandIconButton
      className={classNames("sidebar-compact-toggle", active && "active")}
      kind="ghost"
      size="small"
      aria-label={label}
      aria-pressed={active}
      data-pressed={active || undefined}
      title={label}
      onClick={onToggle}
    >
      <WandIcon name="rail" size={15} className={active ? "sidebar-rail-icon is-collapsed" : "sidebar-rail-icon"}/>
      <span className="sidebar-compact-toggle-label">{label}</span>
    </WandIconButton>
  );
}

function SessionGroup({
  group,
  manageMode,
  dispatch,
}: {
  group: Readonly<UiSidebarGroupVm>;
  manageMode: boolean;
  dispatch(action: UiAction): void | Promise<unknown>;
}) {
  if (group.entries.length === 0) return null;
  const entries = (
    <section className={classNames(
      "session-group",
      group.kind === "automation" && "automation-session-list",
      group.kind === "history" && "non-wand-session-list",
    )}>
      {group.entries.map((entry) => (
        <SessionEntry key={`${entry.source}:${entry.id}`} entry={entry} manageMode={manageMode} dispatch={dispatch}/>
      ))}
    </section>
  );
  if (group.kind === "wand") return entries;

  const automation = group.kind === "automation";
  return (
    <details
      className={classNames(
        automation ? "automation-session-group" : "non-wand-session-group",
        manageMode && "manage-mode",
      )}
      open={manageMode || group.expanded}
      onToggle={(event) => {
        if (manageMode) return;
        void dispatch({
          type: "layout.drawer.group.set",
          group: automation ? "automation" : "history",
          expanded: event.currentTarget.open,
        });
      }}
    >
      <summary
        className={automation ? "automation-session-summary" : "non-wand-session-summary"}
        title={automation
          ? "由自动化或启动任务创建，不参与普通 Wand 会话排序"
          : "Claude 与 Codex 的本机原生会话，不参与 Wand 会话排序"}
        onClick={manageMode ? (event) => event.preventDefault() : undefined}
      >
        <span className={automation ? "automation-session-icon" : "non-wand-session-icon"} aria-hidden="true">
          <WandIcon name={automation ? "zap" : "history"}/>
        </span>
        <span className={automation ? "automation-session-title" : "non-wand-session-title"}>{group.label}</span>
        <span
          className={automation ? "automation-session-count" : "non-wand-session-count"}
          aria-label={`${group.entries.length} 个会话`}
        >
          {group.entries.length}
        </span>
        <WandIcon
          name="chevron"
          className={automation ? "automation-session-chevron" : "non-wand-session-chevron"}
        />
      </summary>
      {entries}
    </details>
  );
}

export function ShellSidebar() {
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const taskBoard = React.useSyncExternalStore(taskBoardStore.subscribe, taskBoardStore.getSnapshot, taskBoardStore.getSnapshot);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const narrow = !snapshot.viewport.mobile && snapshot.layout.sidebarPinned && snapshot.layout.sidebarCollapsed;
  const sidebarClass = classNames(
    "sidebar",
    snapshot.layout.sessionsDrawerOpen && "open",
    !snapshot.viewport.mobile && snapshot.layout.sidebarAnchored && "pinned",
    narrow && "collapsed",
  );
  const primaryAction = getShellSidebarPrimaryAction();
  const visible = snapshot.layout.sessionsDrawerOpen || (!snapshot.viewport.mobile && snapshot.layout.sidebarAnchored);
  const overlay = visible && (snapshot.viewport.mobile || !snapshot.layout.sidebarPinned);
  const drawerRef = useSidebarDrawer(overlay, () => void dispatch({ type: "layout.drawer.close" }));
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const peekSurfaceRef = React.useRef<HTMLDivElement>(null);
  // 窄栏的悬浮目录树：只在有真实指针的设备上启用（触摸设备没有悬停语义）。
  const hoverPointer = useHoverPointer();
  const peek = useSidebarPeek(narrow && hoverPointer, drawerRef, peekSurfaceRef);
  const scrollPositions = React.useRef({ full: 0, compact: 0 });
  React.useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const mode = narrow ? "compact" : "full";
    body.scrollTop = scrollPositions.current[mode];
    return () => { scrollPositions.current[mode] = body.scrollTop; };
  }, [narrow]);
  const leaveBoard = (): void => {
    taskBoardController.close();
  };
  const navigate = (action: UiAction): void => {
    leaveBoard();
    peek.close();
    if (overlay) void dispatch({ type: "layout.drawer.close" });
    void dispatch(action);
  };
  // 目录树里点任意一项（含窄栏图标）都先收掉弹出面板，再切会话。
  const navigateFromTree = (): void => {
    leaveBoard();
    peek.close();
    if (overlay) void dispatch({ type: "layout.drawer.close" });
  };
  const extraGroups = snapshot.sidebar.groups
    .filter((group) => group.kind !== "wand")
    .map((group) => ({
      ...group,
      entries: searchQuery.trim()
        ? group.entries.filter((entry) => sidebarSearchMatches(
          searchQuery, entry.title, entry.description, entry.cwd, entry.provider,
        ))
        : group.entries,
    }))
    .map((group) => (
      <SessionGroup key={group.kind} group={group} manageMode={false} dispatch={dispatch}/>
    ));
  // 同一份目录树渲染两处：窄栏里是图标 rail，悬浮面板里是完整层级。
  const taskTree = (compact: boolean): React.ReactNode => (
    <WorkspacesPanel
      compact={compact}
      onExpand={() => void dispatch({ type: "layout.drawer.collapse" })}
      onNavigate={navigateFromTree}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      selectedSessionId={snapshot.selected?.id ?? null}
      sessionTitles={Object.fromEntries(snapshot.sidebar.groups.flatMap((group) => (
        group.entries.map((entry) => [entry.id, entry.title] as const)
      )))}
      extraGroups={extraGroups}
    />
  );

  return (
    <>
      <div
        id="sessions-drawer-backdrop"
        className={classNames("drawer-backdrop", snapshot.layout.sessionsBackdropVisible && "open")}
        aria-hidden="true"
        onClick={() => void dispatch({ type: "layout.drawer.close" })}
      />
      <aside id="sessions-drawer" ref={drawerRef} className={sidebarClass}
        aria-label="任务侧栏" role={overlay ? "dialog" : undefined}
        aria-modal={overlay || undefined} aria-hidden={!visible || undefined}
        inert={!visible} tabIndex={-1} {...peek.triggerBindings}>
        <div className="sidebar-header">
          <div className="sidebar-header-primary">
            <div className="sidebar-header-main">
              <div className="topbar-logo-icon">W</div>
              <span className="sidebar-title">Wand</span>
            </div>
            <div className="sidebar-header-actions">
              <div className="sidebar-header-more">
                <WandDropdownMenu
                  open={moreOpen}
                  onOpenChange={setMoreOpen}
                  modal={false}
                >
                  <WandDropdownMenuTrigger
                    render={(
                      <WandIconButton
                        id="sidebar-more-btn"
                        className="sidebar-more-trigger"
                        kind="ghost"
                        size="medium"
                        title="更多操作"
                        aria-label="侧栏更多操作"
                      >
                        <WandIcon name="more"/>
                      </WandIconButton>
                    )}
                  />
                  <WandDropdownMenuContent
                    id="sidebar-overflow-menu"
                    aria-label="侧栏更多操作"
                    align="end"
                    sideOffset={6}
                  >
                    <WandDropdownMenuItem
                      id="sidebar-home-btn"
                      icon="home"
                      onClick={() => {
                        setMoreOpen(false);
                        navigate({ type: "nav.home" });
                      }}
                    >
                      回到首页
                    </WandDropdownMenuItem>
                    <WandDropdownMenuItem
                      id="sidebar-refresh-btn"
                      icon="refresh"
                      onClick={() => {
                        setMoreOpen(false);
                        void dispatch({ type: "nav.refresh" });
                      }}
                    >
                      刷新页面
                    </WandDropdownMenuItem>
                  </WandDropdownMenuContent>
                </WandDropdownMenu>
              </div>
              {!snapshot.viewport.mobile && (
                <SidebarCompactToggle
                  active={narrow}
                  onToggle={() => void dispatch({ type: "layout.drawer.collapse" })}
                />
              )}
              {snapshot.viewport.mobile && (
                <>
                  <WandIconButton
                    id="sidebar-collapse-btn"
                    className="legacy-sidebar-collapse"
                    title="收起侧栏"
                    aria-label="收起侧栏"
                    tabIndex={-1}
                    size="medium"
                    onClick={() => void dispatch({ type: "layout.drawer.close" })}
                  >
                    <WandIcon name="chevronLeft"/>
                  </WandIconButton>
                  <WandIconButton
                    id="close-drawer-button"
                    className="sidebar-close"
                    aria-label="关闭侧栏"
                    title="关闭侧栏"
                    size="medium"
                    onClick={() => void dispatch({ type: "layout.drawer.close" })}
                  >
                    <WandIcon name="close"/>
                  </WandIconButton>
                </>
              )}
            </div>
          </div>
        </div>
        <WandNavigation
          className="sidebar-feature-nav"
          aria-label="功能菜单"
          active={taskBoard.open ? "task-board" : null}
        >
          <WandNavigationList className="sidebar-feature-list">
            <WandNavigationItem>
              <WandButton
                id="drawer-new-session-button"
                className="sidebar-new-task"
                kind="primary"
                size="medium"
                title="新建任务"
                aria-label={primaryAction.ariaLabel}
                onClick={() => navigate(primaryAction.action)}
              >
                <WandIcon name="plus" slot="start" size={18}/>
                <span>{primaryAction.label}</span>
              </WandButton>
            </WandNavigationItem>
            <WandNavigationItem>
              <WandNavigationLink
                id="missions-button"
                title="自动化任务"
                value="missions"
                render={<button type="button"/>}
                onClick={() => navigate({ type: "missions.open" })}
              >
                <WandIcon name="zap" slot="start" size={17}/>
                <span>自动化</span>
              </WandNavigationLink>
            </WandNavigationItem>
            <WandNavigationItem>
              <WandNavigationLink
                id="task-board-button"
                title="任务管理"
                value="task-board"
                render={<button type="button"/>}
                onClick={() => {
                  if (overlay) void dispatch({ type: "layout.drawer.close" });
                  taskBoardController.open(snapshot.selected?.workspaceId ?? "", snapshot.selected?.id ?? "");
                }}
              >
                <WandIcon name="clipboard" slot="start" size={17}/>
                <span>任务管理</span>
              </WandNavigationLink>
            </WandNavigationItem>
            <WandNavigationItem>
              <WandNavigationLink
                id="github-issues-button"
                title="GitHub 议题"
                value="github-issues"
                render={<button type="button"/>}
                onClick={() => {
                  if (overlay) void dispatch({ type: "layout.drawer.close" });
                  window.__wandReactGithubIssues?.open(snapshot.selected?.id ?? "");
                }}
              >
                <WandIcon name="git" slot="start" size={17}/>
                <span>GitHub</span>
              </WandNavigationLink>
            </WandNavigationItem>
          </WandNavigationList>
        </WandNavigation>
        <div className="sidebar-body" ref={bodyRef}>
          <div id="sessions-panel">
            <div className="sessions-list" id="sessions-list">
              {taskTree(narrow)}
            </div>
          </div>
        </div>
        {narrow && hoverPointer && peek.mounted ? (
          <SidebarPeek
            open={peek.open}
            surfaceRef={peekSurfaceRef}
            onExpand={() => {
              peek.close();
              void dispatch({ type: "layout.drawer.collapse" });
            }}
            {...peek.surfaceBindings}
          >
            {/* 面板里的目录树不带 #sessions-panel / #sessions-list 这些 legacy id。 */}
            <div className="sessions-list">{taskTree(false)}</div>
          </SidebarPeek>
        ) : null}
        <div className="sidebar-footer">
          <WandNavigation
            className="sidebar-footer-actions"
            aria-label="侧栏快捷操作"
            orientation="horizontal"
            size="sm"
          >
            <WandNavigationList>
              <WandNavigationItem>
                <WandNavigationLink
                  id="settings-button"
                  title="设置"
                  value="settings"
                  render={<button type="button"/>}
                  onClick={() => navigate({ type: "settings.open" })}
                >
                  <WandIcon name="gear" slot="start" size={16}/>
                  <span>设置</span>
                </WandNavigationLink>
              </WandNavigationItem>
              {snapshot.viewport.mobile && (
                <WandNavigationItem>
                  <WandNavigationLink
                    id="file-panel-toggle-btn"
                    className={classNames("sidebar-file-toggle", snapshot.layout.filePanelOpen && "active")}
                    title="查看文件"
                    value="files"
                    active={snapshot.layout.filePanelOpen}
                    render={<button type="button"/>}
                    onClick={() => navigate({ type: "layout.files.toggle" })}
                  >
                    <WandIcon name="explorer" slot="start" size={16}/>
                    <span>文件</span>
                  </WandNavigationLink>
                </WandNavigationItem>
              )}
              {snapshot.capabilities.backToNative && (
                <WandNavigationItem>
                  <WandNavigationLink
                    id="back-to-native-button"
                    className="sidebar-back-to-native"
                    title="返回 App 原生界面"
                    value="native-back"
                    render={<button type="button"/>}
                    onClick={() => navigate({ type: "native.back" })}
                  >
                    <WandIcon name="back" slot="start" size={16}/>
                    <span>返回App</span>
                  </WandNavigationLink>
                </WandNavigationItem>
              )}
              {snapshot.capabilities.switchServer && (
                <WandNavigationItem>
                  <WandNavigationLink
                    id="switch-server-button"
                    className="sidebar-switch-server"
                    title="切换服务器"
                    value="switch-server"
                    render={<button type="button"/>}
                    onClick={() => navigate({ type: "native.switchServer" })}
                  >
                    <WandIcon name="server" slot="start" size={16}/>
                    <span>切换</span>
                  </WandNavigationLink>
                </WandNavigationItem>
              )}
              <WandNavigationItem>
                <WandNavigationLink
                  id="logout-button"
                  className="sidebar-logout"
                  title="退出登录"
                  value="logout"
                  render={<button type="button"/>}
                  onClick={() => navigate({ type: "auth.logout" })}
                >
                  <WandIcon name="logout" slot="start" size={16}/>
                  <span>退出</span>
                </WandNavigationLink>
              </WandNavigationItem>
            </WandNavigationList>
          </WandNavigation>
        </div>
      </aside>
    </>
  );
}
