import * as React from "react";

import {
  WandBrandMark,
  WandDropdownMenu,
  WandDropdownMenuContent,
  WandDropdownMenuItem,
  WandDropdownMenuSeparator,
  WandDropdownMenuTrigger,
  WandIcon,
  WandIconButton,
  type WandIconName,
} from "../ui";
import { localPreviewController } from "../local-preview/controller";
import { classNames } from "../ui/class-names";

import { getShellSidebarEntryActions, type ShellSidebarEntryActions } from "./shell-sidebar";
import { ChatWidthToggle } from "./chat-width-toggle";
import { SidebarToggleIcon } from "./sidebar-toggle-icon";
import { SessionElapsed } from "./session-elapsed";
import { TopbarGitBadge } from "./topbar-git-badge";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import type { UiAction, UiSessionVm } from "./ui-store";

void React;

type TopbarMoreIcon = Extract<WandIconName, "copy" | "folder" | "hash" | "merge" | "trash">;

export interface TopbarMoreAction {
  readonly action: UiAction;
  /** The `data-action` hook the browser layer dispatches through. */
  readonly actionName: string;
  readonly label: string;
  readonly icon: TopbarMoreIcon;
  readonly tone?: "danger";
  readonly disabled?: boolean;
  /** Draw a separator before this row. */
  readonly dividerBefore?: boolean;
}

/**
 * The open-session action list as data.
 *
 * Kept separate from the JSX so the contract (which actions exist, in which
 * order, and the `data-action` hooks the browser layer dispatches through) can
 * be asserted without rendering a portalled menu.
 */
export function getTopbarMoreActions(
  selected: UiSessionVm,
  actions: ShellSidebarEntryActions | null,
): TopbarMoreAction[] {
  const items: TopbarMoreAction[] = [];
  if (selected.claudeSessionId) {
    items.push({
      action: { type: "topbar.copy", field: "providerSessionId" },
      actionName: "copy-claude-session-id",
      label: selected.provider === "codex"
        ? "复制 Codex thread ID"
        : selected.provider === "opencode"
          ? "复制 OpenCode session ID"
          : "复制 Claude 会话 ID",
      icon: "copy",
    });
  }
  if (selected.cwd) {
    items.push({
      action: { type: "topbar.copy", field: "cwd" },
      actionName: "copy-cwd",
      label: "复制工作目录",
      icon: "folder",
    });
  }
  items.push({
    action: { type: "topbar.copy", field: "sessionId" },
    actionName: "copy-session-id",
    label: "复制会话 ID",
    icon: "hash",
  });
  if (actions?.merge) {
    items.push({
      action: actions.merge,
      actionName: "worktree-merge",
      label: "合并到主分支…",
      icon: "merge",
      dividerBefore: true,
      disabled: selected.status === "running" || selected.worktree?.mergeStatus === "merging",
    });
  }
  if (actions?.cleanup) {
    items.push({
      action: actions.cleanup,
      actionName: "worktree-cleanup",
      label: "重试 worktree 清理",
      icon: "trash",
    });
  }
  if (actions?.delete) {
    items.push({
      action: actions.delete,
      actionName: "delete-session",
      label: "删除当前会话",
      icon: "trash",
      tone: "danger",
    });
  }
  return items;
}

export interface TopbarMoreMenuProps {
  selected: UiSessionVm;
  actions: ShellSidebarEntryActions | null;
  onAction(action: UiAction): void;
}

/**
 * The open-session action list.
 *
 * Exported on its own so the menu contract (which actions exist, and the
 * `data-action` hooks the browser layer dispatches through) can be tested
 * without rendering a portalled popover.
 */
export function TopbarMoreMenu({ selected, actions, onAction }: TopbarMoreMenuProps) {
  return (
    <>
      {getTopbarMoreActions(selected, actions).map((item) => (
        <React.Fragment key={item.actionName}>
          {item.dividerBefore ? <WandDropdownMenuSeparator/> : null}
          <WandDropdownMenuItem
            data-action={item.actionName}
            icon={item.icon}
            tone={item.tone ?? "default"}
            disabled={item.disabled}
            onClick={() => onAction(item.action)}
          >
            {item.label}
          </WandDropdownMenuItem>
        </React.Fragment>
      ))}
    </>
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
  // Selecting an item closes the menu through `onOpenChange`, so the action
  // itself is all that is left to dispatch here.
  const runMoreAction = (action: UiAction) => {
    void dispatch(action);
  };

  return (
    <div className={classNames(
      "main-header-row",
      (selected?.turnActive || selected?.permissionBlocked) && "is-running",
      selected?.permissionBlocked && "is-permission-blocked",
    )}>
      <div className="topbar-left">
        {(snapshot.layout.sidebarDrawer || !snapshot.layout.sidebarAnchored) && (
          <WandIconButton
            id="sessions-toggle-button"
            className={classNames("floating-sidebar-toggle", snapshot.layout.sessionsDrawerOpen && "active")}
            aria-label={snapshot.layout.sessionsDrawerOpen ? "关闭会话侧栏" : "打开会话侧栏"}
            aria-expanded={snapshot.layout.sessionsDrawerOpen}
            aria-controls="sessions-drawer"
            data-pressed={snapshot.layout.sessionsDrawerOpen || undefined}
            onClick={() => void dispatch({ type: "layout.drawer.toggle" })}
          >
            <SidebarToggleIcon open={snapshot.layout.sessionsDrawerOpen} size={18}/>
          </WandIconButton>
        )}
        {!snapshot.layout.sidebarAnchored && <WandBrandMark className="topbar-brand"/>}
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
              {selected.inFlight && <SessionElapsed key={selected.id}/>}
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
        <ChatWidthToggle className="topbar-chat-width"/>
        <WandIconButton
          id="topbar-file-button"
          kind="ghost"
          size="medium"
          aria-label="文件"
          aria-pressed={snapshot.layout.filePanelOpen}
          data-pressed={snapshot.layout.filePanelOpen || undefined}
          title="查看文件（可修改路径）"
          onClick={() => void dispatch({ type: "layout.files.toggle" })}
        >
          <WandIcon name="explorer" size={18}/>
        </WandIconButton>
        <WandIconButton
          id="topbar-local-preview-button"
          kind="ghost"
          size="medium"
          aria-label="本地预览"
          title="打开本机 Web 服务或 HTML 文件"
          onClick={() => localPreviewController.show()}
        >
          <WandIcon name="eye" size={18}/>
        </WandIconButton>
        <span id="topbar-git-slot" className="topbar-git-slot">
          <TopbarGitBadge/>
        </span>
        {selected && (
          <div className="topbar-more-wrap">
            <WandDropdownMenu
              open={moreOpen}
              onOpenChange={(open) => {
                if (open !== moreOpen) void dispatch({ type: "topbar.menu.toggle" });
              }}
            >
              <WandDropdownMenuTrigger
                render={(
                  <WandIconButton
                    id="topbar-more-button"
                    kind="ghost"
                    size="medium"
                    aria-label="当前会话操作"
                    title="当前会话操作"
                    data-pressed={moreOpen || undefined}
                  >
                    <WandIcon name="more" size={18}/>
                  </WandIconButton>
                )}
              />
              <WandDropdownMenuContent
                id="topbar-more-menu"
                aria-label="当前会话"
                align="end"
                sideOffset={6}
              >
                <TopbarMoreMenu selected={selected} actions={selectedActions} onAction={runMoreAction}/>
              </WandDropdownMenuContent>
            </WandDropdownMenu>
          </div>
        )}
      </div>
    </div>
  );
}
