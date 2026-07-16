import * as React from "react";
import { WandPopover } from "../ui";

import { getShellSidebarEntryActions } from "./shell-sidebar";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import type { UiAction } from "./ui-store";

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function TopbarIcon({ name, size = 16 }: {
  name: "copy" | "file" | "git" | "hash" | "merge" | "more" | "trash";
  size?: number;
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
    "aria-hidden": true,
  };
  switch (name) {
    case "copy": return <svg {...common}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>;
    case "file": return <svg {...common}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
    case "git": return <svg {...common} className="topbar-git-icon"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 8v8M18 11v1a3 3 0 01-3 3H9"/></svg>;
    case "hash": return <svg {...common}><path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/></svg>;
    case "merge": return <svg {...common}><path d="M7 7h10M7 12h10M7 17h10M5 7L3 9l2 2M19 15l2 2-2 2"/></svg>;
    case "more": return <svg {...common}><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>;
    case "trash": return <svg {...common}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>;
  }
}

function MoreItem({
  action,
  actionName,
  label,
  icon,
  danger,
  disabled,
  onAction,
}: {
  action: UiAction;
  actionName: string;
  label: string;
  icon: "copy" | "file" | "hash" | "merge" | "trash";
  danger?: boolean;
  disabled?: boolean;
  onAction(action: UiAction): void;
}) {
  return (
    <button
      className={classNames("topbar-more-item", danger && "topbar-more-item-danger")}
      data-action={actionName}
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => onAction(action)}
    >
      <TopbarIcon name={icon} size={14}/><span>{label}</span>
    </button>
  );
}

export function ShellTopbar() {
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const selected = snapshot.selected;
  const moreOpen = snapshot.layout.topbarMoreOpen;
  const selectedActions = selected ? getShellSidebarEntryActions(selected, false) : null;
  const openFiles = () => {
    if (!snapshot.layout.filePanelOpen) void dispatch({ type: "layout.files.toggle" });
  };
  const runMoreAction = (action: UiAction) => {
    if (moreOpen) void dispatch({ type: "topbar.menu.toggle" });
    void dispatch(action);
  };

  return (
    <div className="main-header-row">
      <div className="topbar-left">
        <button
          id="sessions-toggle-button"
          className={classNames("floating-sidebar-toggle", snapshot.layout.sessionsDrawerOpen && "active")}
          aria-label="切换会话侧栏"
          type="button"
          onClick={() => void dispatch({ type: "layout.drawer.toggle" })}
        >
          <span className="hamburger-icon"><span/><span/><span/></span>
        </button>
        <span className="topbar-brand" aria-hidden="true">W</span>
      </div>
      <div className="topbar-center">
        {selected ? (
          <>
            <span className="topbar-session-title" title={snapshot.topbar.description || selected.title}>
              {snapshot.topbar.title}
            </span>
            <span
              className={classNames("session-status-pill", snapshot.topbar.statusTone)}
              title={snapshot.topbar.statusLabel}
            >
              <span className="session-status-dot"/>
              <span className="session-status-text">{snapshot.topbar.statusLabel}</span>
            </span>
            <span
              className={classNames("current-task", !snapshot.topbar.currentTask && "hidden")}
              id="current-task"
              title={snapshot.topbar.currentTask || undefined}
            >
              {snapshot.topbar.currentTask}
            </span>
            {snapshot.topbar.cwd && (
              <span
                className="topbar-cwd tail-marquee-path"
                id="topbar-cwd"
                role="button"
                tabIndex={0}
                title={snapshot.topbar.cwd}
                onClick={openFiles}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  openFiles();
                }}
              >
                <span className="tail-marquee-path-inner">{snapshot.topbar.cwd}</span>
              </span>
            )}
          </>
        ) : (
          <>
            <span className="topbar-tagline">{snapshot.topbar.title || "Wand 控制台"}</span>
            <span className="current-task hidden" id="current-task"/>
          </>
        )}
      </div>
      <div className="topbar-right">
        <button
          id="topbar-file-button"
          className={classNames("topbar-btn square", snapshot.layout.filePanelOpen && "active")}
          type="button"
          aria-label="文件"
          title="查看文件（可修改路径）"
          onClick={() => void dispatch({ type: "layout.files.toggle" })}
        >
          <TopbarIcon name="file"/>
        </button>
        <span id="topbar-git-slot" className="topbar-git-slot">
          {snapshot.topbar.git && (
            <button
              id="topbar-git-badge"
              className="topbar-git-badge"
              type="button"
              title={`${snapshot.topbar.git.branch}  ·  ${snapshot.topbar.git.clean
                ? "工作区干净"
                : `${snapshot.topbar.git.modifiedCount} 个文件待提交`}`}
              aria-label="快捷提交"
              onClick={() => void dispatch({ type: "topbar.gitCommit" })}
            >
              <TopbarIcon name="git" size={14}/>
              <span className="topbar-git-branch">{snapshot.topbar.git.branch}</span>
              {snapshot.topbar.git.clean
                ? <span className="topbar-git-clean" aria-hidden="true">✓</span>
                : <span className="topbar-git-count">·{snapshot.topbar.git.modifiedCount}</span>}
            </button>
          )}
        </span>
        {selected && (
          <div className="topbar-more-wrap">
            <WandPopover
              open={moreOpen}
              onOpenChange={(open) => {
                if (open !== moreOpen) void dispatch({ type: "topbar.menu.toggle" });
              }}
              align="end"
              sideOffset={6}
              portalled={false}
              forceMount
              showArrow={false}
              contentId="topbar-more-menu"
              contentRole="menu"
              ariaLabel="当前会话"
              className={classNames("topbar-more-menu", "wand-shell-menu-popover", !moreOpen && "hidden")}
              trigger={(
                <button
                  id="topbar-more-button"
                  className={classNames("topbar-btn square", moreOpen && "active")}
                  type="button"
                  aria-label="当前会话操作"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  aria-controls="topbar-more-menu"
                  title="当前会话操作"
                >
                  <TopbarIcon name="more"/>
                </button>
              )}
            >
              {selected.claudeSessionId && (
                <MoreItem
                  action={{ type: "topbar.copy", field: "providerSessionId" }}
                  actionName="copy-claude-session-id"
                  label={selected.provider === "codex"
                    ? "复制 Codex thread ID"
                    : selected.provider === "opencode"
                      ? "复制 OpenCode session ID"
                      : "复制 Claude 会话 ID"}
                  icon="copy"
                  onAction={runMoreAction}
                />
              )}
              {selected.cwd && (
                <MoreItem
                  action={{ type: "topbar.copy", field: "cwd" }}
                  actionName="copy-cwd"
                  label="复制工作目录"
                  icon="file"
                  onAction={runMoreAction}
                />
              )}
              <MoreItem
                action={{ type: "topbar.copy", field: "sessionId" }}
                actionName="copy-session-id"
                label="复制会话 ID"
                icon="hash"
                onAction={runMoreAction}
              />
              <div className="topbar-more-divider" role="separator"/>
              {selectedActions?.merge && (
                <MoreItem
                  action={selectedActions.merge}
                  actionName="worktree-merge"
                  label="合并到主分支…"
                  icon="merge"
                  disabled={selected.status === "running" || selected.worktree?.mergeStatus === "merging"}
                  onAction={runMoreAction}
                />
              )}
              {selectedActions?.cleanup && (
                <MoreItem
                  action={selectedActions.cleanup}
                  actionName="worktree-cleanup"
                  label="重试 worktree 清理"
                  icon="merge"
                  onAction={runMoreAction}
                />
              )}
              {selectedActions?.delete && (
                <MoreItem
                  action={selectedActions.delete}
                  actionName="delete-session"
                  label="删除当前会话"
                  icon="trash"
                  danger
                  onAction={runMoreAction}
                />
              )}
            </WandPopover>
          </div>
        )}
      </div>
    </div>
  );
}
