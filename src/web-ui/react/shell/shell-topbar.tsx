import * as React from "react";
import { CopyPageLink } from "../ui/copy-page-link";
import { QuickTerminalActionContext, QuickTerminalTopbarAction } from "../quick-terminal/action";
import { createPortal } from "react-dom";
import { Flex, Typography } from "antd";

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

import {
  getShellSidebarEntryActions,
  SHELL_SESSION_DELETE_LABEL,
  SHELL_WORKTREE_CLEANUP_LABEL,
  SHELL_WORKTREE_MERGE_LABEL,
  type ShellSidebarEntryActions,
} from "./shell-sidebar";
import { SidebarToggleIcon } from "./sidebar-toggle-icon";
import { TopbarGitBadge } from "./topbar-git-badge";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import type { UiAction, UiSessionVm, UiSnapshotData } from "./ui-store";

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
      label: SHELL_WORKTREE_MERGE_LABEL,
      icon: "merge",
      dividerBefore: true,
      disabled: selected.status === "running" || selected.worktree?.mergeStatus === "merging",
    });
  }
  if (actions?.cleanup) {
    items.push({
      action: actions.cleanup,
      actionName: "worktree-cleanup",
      label: SHELL_WORKTREE_CLEANUP_LABEL,
      icon: "trash",
    });
  }
  if (actions?.delete) {
    items.push({
      action: actions.delete,
      actionName: "delete-session",
      label: SHELL_SESSION_DELETE_LABEL,
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
      <CopyPageLink menuItem label="复制会话链接"/>
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

export function ShellTopbar({ terminalActionVisible = true }: { terminalActionVisible?: boolean } = {}) {
  const snapshot = useUiStoreSnapshot();
  const terminalAction = React.useContext(QuickTerminalActionContext);
  const dispatch = useUiDispatch();
  const moreOpen = snapshot.layout.topbarMoreOpen;
  const menuOpenIntent = React.useRef(moreOpen);
  React.useEffect(() => { menuOpenIntent.current = moreOpen; }, [moreOpen]);
  const chrome = <ShellTopbarChrome snapshot={snapshot} onAction={dispatch} terminalActionVisible={terminalActionVisible}
    onMoreOpenChange={(open) => {
      if (open !== menuOpenIntent.current) {
        menuOpenIntent.current = open;
        void dispatch({ type: "topbar.menu.toggle" });
      }
    }}
    gitBadge={<TopbarGitBadge/>}/>;
  // Keep the existing header at full workspace width while docking resizes only its content.
  return terminalAction && terminalActionVisible ? createPortal(chrome, terminalAction.chromeHost) : chrome;
}

/** Static chrome shared by the live shell and invisible creation measurement. */
export function ShellTopbarChrome({ snapshot, onAction, onMoreOpenChange, gitBadge, measurement = false, terminalActionVisible = true }: {
  snapshot: Readonly<UiSnapshotData>;
  onAction?: (action: UiAction) => void | Promise<unknown>;
  onMoreOpenChange?: (open: boolean) => void;
  gitBadge?: React.ReactNode;
  measurement?: boolean;
  terminalActionVisible?: boolean;
}) {
  const selected = snapshot.selected;
  const moreOpen = snapshot.layout.topbarMoreOpen;
  const selectedActions = selected ? getShellSidebarEntryActions(selected, false) : null;
  const chromeId = (value: string) => measurement ? undefined : value;
  const runMoreAction = (action: UiAction) => { void onAction?.(action); };
  return (
    <Flex align="center" gap="small" wrap className={classNames(
      "main-header-row",
      (selected?.turnActive || selected?.permissionBlocked) && "is-running",
      selected?.permissionBlocked && "is-permission-blocked",
    )} style={{ flexShrink: 0, padding: "8px var(--wand-page-inset, 20px)", borderBottom: "1px solid var(--border-subtle)" }}>
      <Flex align="center" gap="small" className="topbar-left">
        {(snapshot.layout.sidebarDrawer || !snapshot.layout.sidebarAnchored) && (
          <WandIconButton
            id={chromeId("sessions-toggle-button")}
            className={classNames("floating-sidebar-toggle", snapshot.layout.sessionsDrawerOpen && "active")}
            aria-label={snapshot.layout.sessionsDrawerOpen ? "关闭会话侧栏" : "打开会话侧栏"}
            aria-expanded={snapshot.layout.sessionsDrawerOpen}
            aria-controls={measurement ? undefined : "sessions-drawer"}
            data-pressed={snapshot.layout.sessionsDrawerOpen || undefined}
            onClick={() => void onAction?.({ type: "layout.drawer.toggle" })}
          >
            <SidebarToggleIcon open={snapshot.layout.sessionsDrawerOpen} size={18}/>
          </WandIconButton>
        )}
        {!snapshot.layout.sidebarAnchored && <WandBrandMark className="topbar-brand" style={{ width: 24, height: 24 }}/>}
      </Flex>
      <Flex vertical gap={2} className="topbar-center" style={{ flex: "1 1 0", minWidth: 0 }}>
        {selected ? (
          <>
            <Flex align="center" gap={8} className="topbar-title-row">
            <Typography.Text ellipsis
              className={classNames("topbar-session-title", snapshot.topbar.titleGenerating && "title-generating")}
              title={[snapshot.topbar.title, snapshot.topbar.titleGenerating && "AI 正在生成标题", snapshot.topbar.description].filter(Boolean).join("\n")}
              aria-label={snapshot.topbar.titleGenerating ? `${snapshot.topbar.title}，AI 正在生成标题` : undefined}
              aria-busy={snapshot.topbar.titleGenerating || undefined}
              style={{ minWidth: 0, maxWidth: 520, fontWeight: "var(--font-weight-semibold)" }}
            >
              {snapshot.topbar.title}
            </Typography.Text>
            <Typography.Text
              className={classNames("current-task", !snapshot.topbar.currentTask && "hidden")}
              id={chromeId("current-task")}
              title={snapshot.topbar.currentTask || undefined} hidden={!snapshot.topbar.currentTask}
            >
              {snapshot.topbar.currentTask}
            </Typography.Text>
            </Flex>
          </>
        ) : (
          <>
            <span className="topbar-tagline">{snapshot.topbar.title || "Wand 控制台"}</span>
            <span className="current-task hidden" id={chromeId("current-task")}/>
          </>
        )}
      </Flex>
      <Flex align="center" gap={4} className="topbar-right">
        {!measurement && <QuickTerminalTopbarAction visible={terminalActionVisible}/>}
        <WandIconButton
          id={chromeId("topbar-file-button")}
          kind="ghost"
          size="medium"
          aria-label="文件"
          aria-pressed={snapshot.layout.filePanelOpen}
          data-pressed={snapshot.layout.filePanelOpen || undefined}
          title="查看文件（可修改路径）"
          onClick={() => void onAction?.({ type: "layout.files.toggle" })}
        >
          <WandIcon name="explorer" size={18}/>
        </WandIconButton>
        <WandIconButton
          id={chromeId("topbar-local-preview-button")}
          kind="ghost"
          size="medium"
          aria-label="本地预览"
          title="打开本机 Web 服务或 HTML 文件"
          onClick={measurement ? undefined : () => localPreviewController.show()}
        >
          <WandIcon name="eye" size={18}/>
        </WandIconButton>
        <span id={chromeId("topbar-git-slot")} className="topbar-git-slot">
          {gitBadge}
        </span>
        {selected && (
          <div className="topbar-more-wrap">
            {measurement ? <WandIconButton kind="ghost" size="medium"><WandIcon name="more" size={18}/></WandIconButton> : <WandDropdownMenu
              open={moreOpen}
              onOpenChange={onMoreOpenChange}
            >
              <WandDropdownMenuTrigger
                render={(
                  <WandIconButton
                    id={chromeId("topbar-more-button")}
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
                id={chromeId("topbar-more-menu")}
                aria-label="当前会话"
                align="end"
                sideOffset={6}
              >
                <TopbarMoreMenu selected={selected} actions={selectedActions} onAction={runMoreAction}/>
              </WandDropdownMenuContent>
            </WandDropdownMenu>}
          </div>
        )}
      </Flex>

    </Flex>
  );
}
