import * as React from "react";
import { WandPopover } from "../ui";

import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import type {
  UiAction,
  UiManageTarget,
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

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function getSidebarEntryTarget(entry: Readonly<UiSessionVm>): UiManageTarget {
  if (entry.source === "claude-history") return "claude-history";
  if (entry.source === "codex-history") return "codex-history";
  return "session";
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

  const historyProvider = entry.source === "codex-history"
    ? "codex"
    : entry.source === "claude-history"
      ? "claude"
      : null;
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

function Icon({ name, size = 14, className }: {
  name: "back" | "chevron" | "cleanup" | "close" | "file" | "gear" | "history"
    | "logout" | "merge" | "more" | "pin" | "resume" | "server" | "spark" | "trash";
  size?: number;
  className?: string;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
  switch (name) {
    case "back":
      return <svg {...common}><rect x="10" y="3" width="11" height="18" rx="2"/><path d="M7 8l-4 4 4 4M3 12h11"/></svg>;
    case "chevron":
      return <svg {...common}><path d="M6 9l6 6 6-6"/></svg>;
    case "cleanup":
    case "trash":
      return <svg {...common}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>;
    case "close":
      return <svg {...common}><path d="M6 6l12 12M18 6L6 18"/></svg>;
    case "file":
      return <svg {...common}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
    case "gear":
      return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9L7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>;
    case "history":
      return <svg {...common}><path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.7L3 8M3 3v5h5M12 7v5l3 2"/></svg>;
    case "logout":
      return <svg {...common}><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>;
    case "merge":
      return <svg {...common}><path d="M7 7h10M7 12h10M7 17h10M5 7L3 9l2 2M19 15l2 2-2 2"/></svg>;
    case "more":
      return <svg {...common}><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>;
    case "pin":
      return <svg {...common}><path d="M12 17v5M5 17h14M9 12V6H8a2 2 0 010-4h8a2 2 0 010 4h-1v6"/></svg>;
    case "resume":
      return <svg {...common}><path d="M1 4v6h6M3.5 15A9 9 0 109 3.6L3 10"/></svg>;
    case "server":
      return <svg {...common}><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/></svg>;
    case "spark":
      return <svg {...common}><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/><circle cx="12" cy="12" r="3"/></svg>;
  }
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
  icon: "cleanup" | "merge" | "resume" | "trash";
  className?: string;
  disabled?: boolean;
  data?: Record<string, string>;
}) {
  return (
    <button
      type="button"
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
      <Icon name={icon}/>
    </button>
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
  return parsed.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
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
  const isHistory = entry.source === "claude-history" || entry.source === "codex-history";
  const provider = entry.source === "codex-history" ? "codex" : "claude";
  const data: Record<string, string> = isHistory
    ? { historyId: entry.id, cwd: entry.cwd }
    : { sessionId: entry.id };
  const activate = () => void dispatch(actions.primary);
  const time = formatEntryTime(entry);

  return (
    <div
      className={classNames(
        "session-item",
        isHistory && "non-wand-session",
        entry.active && "active",
        manageMode && entry.selected && "selected",
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
          <button
            className="session-swipe-delete"
            data-action="swipe-delete-session"
            data-session-id={entry.id}
            type="button"
            tabIndex={-1}
            aria-label="删除会话"
            onClick={(event) => {
              event.stopPropagation();
              void dispatch(actions.delete!);
            }}
          >
            <Icon name="trash" size={18}/><span>删除</span>
          </button>
        </div>
      )}
      <div className="session-item-content">
        <div className="session-item-row">
          {manageMode && <ManageCheckbox entry={entry} dispatch={dispatch}/>} 
          <div className="session-main">
            <div className="session-title-row">
              <div className={isHistory ? "session-command claude-history-preview" : "session-title"}>
                {entry.title}
              </div>
              {time && <span className="session-time">{time}</span>}
            </div>
            {entry.description && <div className="session-description">{entry.description}</div>}
            {entry.inFlight && <div className="session-activity">思考中</div>}
            <div className="session-meta">
              {isHistory ? (
                <>
                  <span className="session-id" title={entry.claudeSessionId ?? entry.id}>
                    {entry.id.slice(0, 8)}
                  </span>
                  <span>{time}</span>
                </>
              ) : (
                <>
                  <span className={classNames("session-status", entry.permissionBlocked
                    ? "permission-blocked"
                    : entry.inFlight
                      ? "running"
                      : entry.status)}>
                    {entry.statusLabel}
                  </span>
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
                    ? entry.source === "codex-history" ? "resume-codex-history" : "resume-history"
                    : "resume"}
                  label={isHistory ? `恢复此 ${provider === "codex" ? "Codex" : "Claude"} 会话` : "恢复会话"}
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
                  icon="cleanup"
                  className="merge-btn"
                  data={data}
                />
              )}
              {actions.delete && (
                <ActionButton
                  action={actions.delete}
                  dispatch={dispatch}
                  actionName={isHistory
                    ? entry.source === "codex-history" ? "delete-codex-history" : "delete-history"
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
          <Icon name={automation ? "spark" : "history"}/>
        </span>
        <span className={automation ? "automation-session-title" : "non-wand-session-title"}>{group.label}</span>
        <span
          className={automation ? "automation-session-count" : "non-wand-session-count"}
          aria-label={`${group.entries.length} 个会话`}
        >
          {group.entries.length}
        </span>
        <Icon
          name="chevron"
          className={automation ? "automation-session-chevron" : "non-wand-session-chevron"}
        />
      </summary>
      {entries}
    </details>
  );
}

function ManageBar({
  manageMode,
  selectedCount,
  totalCount,
  dispatch,
}: {
  manageMode: boolean;
  selectedCount: number;
  totalCount: number;
  dispatch(action: UiAction): void | Promise<unknown>;
}) {
  if (!manageMode) {
    return (
      <div className="session-manage-bar">
        <span className="sidebar-intro">Wand 会话</span>
        <button
          className="btn btn-ghost btn-xs session-manage-toggle"
          data-action="toggle-manage-mode"
          type="button"
          onClick={() => void dispatch({ type: "session.manage.toggle" })}
        >
          <span>管理</span>
        </button>
      </div>
    );
  }

  const allSelected = totalCount > 0 && selectedCount >= totalCount;
  return (
    <div className="session-manage-bar active">
      <button
        className="session-manage-exit"
        data-action="toggle-manage-mode"
        type="button"
        aria-label="退出管理模式"
        title="退出管理模式"
        onClick={() => void dispatch({ type: "session.manage.toggle" })}
      >
        <Icon name="close"/>
      </button>
      <div className="session-manage-summary">
        {selectedCount > 0 ? (
          <><span className="session-manage-count">{selectedCount}</span><span className="session-manage-summary-label">已选择</span></>
        ) : (
          <span className="session-manage-summary-label muted">选择要管理的项目</span>
        )}
      </div>
      <div className="session-manage-actions">
        <button
          className="btn btn-ghost btn-xs"
          data-action={allSelected ? "clear-selection" : "select-all-visible"}
          type="button"
          disabled={totalCount === 0}
          onClick={() => void dispatch({
            type: allSelected ? "session.manage.clear" : "session.manage.selectAll",
          })}
        >
          {allSelected ? "取消全选" : "全选"}
        </button>
        <button
          className="btn btn-danger btn-xs"
          data-action="delete-selected"
          type="button"
          disabled={selectedCount === 0}
          onClick={() => void dispatch({ type: "session.manage.deleteSelected" })}
        >
          删除{selectedCount > 0 ? ` ${selectedCount}` : ""}
        </button>
      </div>
    </div>
  );
}

function CollapsedSessions({
  groups,
  dispatch,
}: {
  groups: readonly Readonly<UiSidebarGroupVm>[];
  dispatch(action: UiAction): void | Promise<unknown>;
}) {
  const wand = groups.find((group) => group.kind === "wand")?.entries ?? [];
  const automation = groups.find((group) => group.kind === "automation")?.entries ?? [];
  const history = groups.find((group) => group.kind === "history")?.entries ?? [];
  return (
    <div className="sidebar-collapsed-tiles">
      {wand.map((entry, index) => (
        <button
          key={entry.id}
          className={classNames("sidebar-collapsed-tile", entry.active && "active")}
          type="button"
          data-collapsed-session-id={entry.id}
          title={entry.title}
          onClick={() => void dispatch({ type: "session.select", id: entry.id })}
        >
          {index + 1}
        </button>
      ))}
      {automation.length > 0 && (
        <button
          className={classNames(
            "sidebar-collapsed-tile automation-count-tile",
            automation.some((entry) => entry.active) && "active-group",
          )}
          type="button"
          data-expand-session-group="automation"
          title={`展开查看 ${automation.length} 个自动化会话`}
          aria-label={`展开查看 ${automation.length} 个自动化会话`}
          onClick={() => void dispatch({ type: "layout.drawer.expandGroup", group: "automation" })}
        >
          <Icon name="spark" size={16}/>
          <span className="non-wand-count-badge">{automation.length > 99 ? "99+" : automation.length}</span>
        </button>
      )}
      {history.length > 0 && (
        <button
          className="sidebar-collapsed-tile non-wand-count-tile"
          type="button"
          data-expand-session-group="non-wand"
          title={`展开查看 ${history.length} 个非 Wand 会话`}
          aria-label={`展开查看 ${history.length} 个非 Wand 会话`}
          onClick={() => void dispatch({ type: "layout.drawer.expandGroup", group: "history" })}
        >
          <Icon name="history" size={16}/>
          <span className="non-wand-count-badge">{history.length > 99 ? "99+" : history.length}</span>
        </button>
      )}
      <button
        className="sidebar-collapsed-tile add"
        type="button"
        data-collapsed-new-session="1"
        title="新建会话"
        aria-label="新建会话"
        onClick={() => void dispatch({ type: "session.new" })}
      >
        <span aria-hidden="true">＋</span>
      </button>
    </div>
  );
}

export function ShellSidebar() {
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const [moreOpen, setMoreOpen] = React.useState(false);
  const narrow = snapshot.layout.sidebarPinned && snapshot.layout.sidebarCollapsed;
  const sidebarClass = classNames(
    "sidebar",
    snapshot.layout.sessionsDrawerOpen && "open",
    snapshot.layout.sidebarAnchored && "pinned",
    narrow && "collapsed",
  );

  return (
    <>
      <div
        id="sessions-drawer-backdrop"
        className={classNames("drawer-backdrop", snapshot.layout.sessionsBackdropVisible && "open")}
        aria-hidden="true"
        onClick={() => void dispatch({ type: "layout.drawer.close" })}
      />
      <aside id="sessions-drawer" className={sidebarClass} aria-label="会话侧栏">
        <div className="sidebar-header">
          <div className="sidebar-header-main">
            <div className="topbar-logo-icon">W</div>
            <span className="sidebar-title">会话</span>
            <span className="session-count" id="session-count">{snapshot.sidebar.interactiveCount}</span>
          </div>
          <div className="sidebar-header-actions">
            <div className="sidebar-header-more">
              <WandPopover
                open={moreOpen}
                onOpenChange={setMoreOpen}
                align="end"
                sideOffset={6}
                portalled={false}
                forceMount
                showArrow={false}
                contentId="sidebar-overflow-menu"
                contentRole="menu"
                ariaLabel="侧栏更多操作"
                className={classNames("sidebar-header-overflow", "wand-shell-menu-popover", moreOpen && "open")}
                trigger={(
                  <button
                    id="sidebar-more-btn"
                    className="btn btn-ghost btn-sm"
                    type="button"
                    title="更多操作"
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                    aria-controls="sidebar-overflow-menu"
                  >
                    <Icon name="more"/>
                  </button>
                )}
              >
                  <button
                    className="overflow-item"
                    id="sidebar-home-btn"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      void dispatch({ type: "nav.home" });
                    }}
                  >
                    <span>回到首页</span>
                  </button>
                  <button
                    className="overflow-item"
                    id="sidebar-refresh-btn"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      void dispatch({ type: "nav.refresh" });
                    }}
                  >
                    <span>刷新页面</span>
                  </button>
              </WandPopover>
            </div>
            <button
              id="sidebar-pin-btn"
              className={classNames("btn btn-ghost btn-sm sidebar-pin-toggle", snapshot.layout.sidebarPinned && "pinned")}
              type="button"
              title={snapshot.layout.sidebarPinned ? "已固定常驻（点击解除锁定）" : "固定侧栏常驻"}
              aria-label={snapshot.layout.sidebarPinned ? "解除固定常驻" : "固定侧栏常驻"}
              aria-pressed={snapshot.layout.sidebarPinned}
              onClick={() => void dispatch({ type: "layout.drawer.pin" })}
            >
              <Icon name="pin"/>
            </button>
            <button
              id="sidebar-collapse-btn"
              className={classNames("btn btn-ghost btn-sm sidebar-collapse-toggle", narrow && "collapsed")}
              type="button"
              title={narrow ? "展开为全尺寸" : "收起为窄条"}
              aria-label={narrow ? "展开为全尺寸" : "收起为窄条"}
              onClick={() => void dispatch({ type: "layout.drawer.collapse" })}
            >
              <Icon name="chevron"/>
            </button>
            <button
              id="close-drawer-button"
              className="btn btn-ghost btn-icon sidebar-close drawer-close-btn"
              type="button"
              aria-label="关闭菜单"
              onClick={() => void dispatch({ type: "layout.drawer.close" })}
            >
              <Icon name="close"/>
            </button>
          </div>
        </div>
        <div className="sidebar-body">
          <div id="sessions-panel">
            <div className="sessions-list" id="sessions-list">
              {narrow ? (
                <CollapsedSessions groups={snapshot.sidebar.groups} dispatch={dispatch}/>
              ) : (
                <>
                  <ManageBar
                    manageMode={snapshot.sidebar.manageMode}
                    selectedCount={snapshot.sidebar.selectedCount}
                    totalCount={snapshot.sidebar.totalCount}
                    dispatch={dispatch}
                  />
                  {snapshot.sidebar.totalCount === 0 ? (
                    <div className="empty-state">
                      <strong>还没有会话记录</strong><br/>点击上方「新对话」开始你的第一次对话。
                    </div>
                  ) : snapshot.sidebar.groups.map((group) => (
                    <SessionGroup key={group.kind} group={group} manageMode={snapshot.sidebar.manageMode} dispatch={dispatch}/>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="sidebar-footer">
          <button
            id="drawer-new-session-button"
            className="btn btn-primary btn-block"
            type="button"
            onClick={() => void dispatch({ type: "session.new" })}
          >
            <span>+</span> 新会话
          </button>
          <div className="sidebar-footer-actions">
            <button
              id="file-panel-toggle-btn"
              className={classNames("btn btn-ghost btn-sm", snapshot.layout.filePanelOpen && "active")}
              type="button"
              title="查看文件"
              onClick={() => void dispatch({ type: "layout.files.toggle" })}
            >
              <Icon name="file" size={16}/><span>文件</span>
            </button>
            <button
              id="settings-button"
              className="btn btn-ghost btn-sm"
              type="button"
              title="设置"
              onClick={() => void dispatch({ type: "settings.open" })}
            >
              <Icon name="gear" size={16}/><span>设置</span>
            </button>
            {snapshot.capabilities.backToNative && (
              <button
                id="back-to-native-button"
                className="btn btn-ghost btn-sm sidebar-back-to-native"
                type="button"
                title="返回 App 原生界面"
                onClick={() => void dispatch({ type: "native.back" })}
              >
                <Icon name="back" size={16}/><span>返回App</span>
              </button>
            )}
            {snapshot.capabilities.switchServer && (
              <button
                id="switch-server-button"
                className="btn btn-ghost btn-sm sidebar-switch-server"
                type="button"
                title="切换服务器"
                onClick={() => void dispatch({ type: "native.switchServer" })}
              >
                <Icon name="server" size={16}/><span>切换</span>
              </button>
            )}
            <button
              id="logout-button"
              className="btn btn-ghost btn-sm sidebar-logout"
              type="button"
              title="退出登录"
              onClick={() => void dispatch({ type: "auth.logout" })}
            >
              <Icon name="logout" size={16}/><span>退出</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
