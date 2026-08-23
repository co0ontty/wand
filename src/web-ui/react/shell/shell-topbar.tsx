import * as React from "react";

import { WandIcon, WandPopover, type WandIconName } from "../ui";
import { classNames } from "../ui/class-names";

import { getShellSidebarEntryActions } from "./shell-sidebar";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import type { UiAction } from "./ui-store";

void React;

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
  icon: Extract<WandIconName, "copy" | "folder" | "hash" | "merge" | "trash">;
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
      <WandIcon name={icon} size={14}/><span>{label}</span>
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
        {snapshot.viewport.mobile && (
          <button
            id="sessions-toggle-button"
            className={classNames("floating-sidebar-toggle", snapshot.layout.sessionsDrawerOpen && "active")}
            aria-label="切换会话侧栏"
            type="button"
            onClick={() => void dispatch({ type: "layout.drawer.toggle" })}
          >
            <span className="hamburger-icon"><span/><span/><span/></span>
          </button>
        )}
        {!snapshot.layout.sidebarAnchored && <span className="topbar-brand" aria-hidden="true">W</span>}
      </div>
      <div className="topbar-center">
        {selected ? (
          <>
            <span
              className={classNames("topbar-session-title", snapshot.topbar.titleGenerating && "title-generating")}
              title={snapshot.topbar.description || selected.title}
              aria-busy={snapshot.topbar.titleGenerating || undefined}
            >
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
          <WandIcon name="explorer"/>
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
              <WandIcon name="git" size={14} className="topbar-git-icon"/>
              <span className="topbar-git-branch">{snapshot.topbar.git.branch}</span>
              {snapshot.topbar.git.clean
                ? <span className="topbar-git-clean" aria-hidden="true"><WandIcon name="check" size={11}/></span>
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
                  <WandIcon name="more"/>
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
                  icon="folder"
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
                  icon="trash"
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
