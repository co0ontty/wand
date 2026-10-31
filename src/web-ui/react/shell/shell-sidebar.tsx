import { Checkbox, Flex, Layout, Tag, Typography } from "antd";
import { CopyPageLink } from "../ui/copy-page-link";
import { WandUiBoundary } from "../theme";
import { WandBrandMark } from "../ui/brand-mark";
import { wandOverlay } from "../overlay-controller";
import * as React from "react";
import { settingsController, settingsStore } from "../settings/controller";
import { isSessionJustCompleted } from "../../../session-completion-state.js";
import { WAND_AGENT_LABEL, normalizeProviderId, providerDisplayName } from "../../provider-identity";
import { ProviderLogo } from "../provider-logo";
import { openSessionWithOwningTask } from "../workspaces/session-open";
import { conversationUi, useConversationUi } from "../conversations/state";
import { ConversationNavigation } from "../conversations/sidebar";
import { SidebarFilterCapsules, UnifiedSidebarList, useUnifiedSidebar, type UnifiedSidebarEntry } from "../conversations/unified-sidebar";
import { newSessionController } from "../new-session/controller";
import { SidebarPresentationContext, useSidebarPresentation } from "../workspaces/sidebar-display-mode";
import { sidebarSafeError } from "../workspaces/sidebar-safe-error";
import { useUserProfile } from "../user-profile-repository";
import { DEFAULT_USER_DISPLAY_NAME } from "../../../user-profile.js";
import { SidebarToggleIcon } from "./sidebar-toggle-icon";
import { DaemonUpdateNotice } from "./daemon-update-notice";
import { WandButton, WandIconButton } from "../ui/button";
import { WandDropdownMenu, WandDropdownMenuContent, WandDropdownMenuItem, WandDropdownMenuSeparator, WandDropdownMenuTrigger } from "../ui/dropdown-menu";
import { WandIcon, type WandIconName } from "../ui/icons";
import { classNames } from "../ui/class-names";
import { sidebarSearchMatches } from "../workspaces/sidebar-search";
import {
  getSidebarListError,
  subscribeSidebarListError,
  type SidebarListErrorKind,
} from "../workspaces/sidebar-list-error";

import { taskBoardController, taskBoardStore } from "../issues/task-board-controller";
import { knowledgeController, knowledgeStore } from "../knowledge/controller";
import { HomeAttentionBadge } from "../attention/home-attention";
import { useAiTeamAttentionCount } from "../ai-teams/repository";
import { GROUP_CHAT_VISIBLE } from "../../group-chat-visibility.js";
import { useSidebarDrawer } from "./use-sidebar-drawer";
import { useSidebarGesture } from "./use-sidebar-gesture";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import type {
  UiAction,
  UiManageTarget,
  UiNativeHistoryProvider,
  UiSessionVm,
} from "./ui-store";

export interface ShellSidebarEntryActions {
  readonly primary: UiAction;
  readonly resume: UiAction | null;
  readonly delete: UiAction | null;
  readonly merge: UiAction | null;
  readonly cleanup: UiAction | null;
}

/**
 * worktree / 会话动作的界面名，唯一来源。
 * 侧栏条目动作与顶栏「更多」菜单是同一批 UiAction，之前各写一套词序
 * （「重试清理 worktree」⇄「重试 worktree 清理」），这里收口。
 * 「重试 worktree 清理」与 `worktree-merge/model.ts` 的提示语、
 * `tests/web-ui-worktree-merge.test.ts` 的钉保持一致；「删除会话」对齐点击后弹出的
 * 确认框标题（`browser/shell-commands.ts` 的 `confirmDelete(…, { title: "删除会话" })`）；
 * 「合并到主分支…」保留省略号，因为这个动作总是先打开确认弹层。
 */
export const SHELL_WORKTREE_MERGE_LABEL = "合并到主分支…";
export const SHELL_WORKTREE_CLEANUP_LABEL = "重试 worktree 清理";
export const SHELL_SESSION_DELETE_LABEL = "删除会话";

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
    <span className="wand-session-manage-check" onClick={(event) => event.stopPropagation()}>
      <WandUiBoundary><Checkbox
        data-action="toggle-selection"
        data-kind={legacyKind}
        data-id={entry.id}
        checked={entry.selected}
        aria-label={`选择会话 ${entry.title}`}
        onChange={() => void dispatch({ type: "session.manage.select", target, id: entry.id })}
      /></WandUiBoundary>
    </span>
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
      <Tag className="session-kind-badge worktree" title={title || undefined}>Worktree</Tag>
      {entry.worktree.mergeStatus && (
        <Tag className={classNames("session-kind-badge worktree-merge", entry.worktree.mergeStatus)}>
          {labels[entry.worktree.mergeStatus] ?? entry.worktree.mergeStatus}
        </Tag>
      )}
    </>
  );
}

function formatEntryTime(entry: Readonly<UiSessionVm>): string {
  const value = entry.endedAt ?? entry.startedAt;
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  if (!entry.endedAt && entry.turnActive) {
    // 优先服务端本轮锚点：会话可能开了几天，用 startedAt 计时会把「本轮已运行」读成
    // 「会话已存在」，静默期数字还在涨，等于用错的时长骗用户。锚点缺失时不显示时长。
    const anchor = entry.turnStartedAt ?? entry.startedAt;
    if (!anchor) return "";
    const started = new Date(anchor).getTime();
    if (!Number.isFinite(started)) return "";
    const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
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
  // 日期格式跟着浏览器 locale 走（和 ai-teams/team-chat-view.tsx 的 chatTurnClock、
  // teams-page.tsx 的运行记录同一口径）：写死 "zh-CN" 会让英文环境的用户在同一页里
  // 看到两种日期写法。
  return parsed.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

function ProviderMark({ entry }: { entry: Readonly<UiSessionVm> }) {
  // 引擎决定名字：Wand Agent 与 Pi 共用一个 provider，标记不能都写成 Pi。
  const label = entry.engine === "sdk" ? WAND_AGENT_LABEL : providerDisplayName(entry.provider);
  const provider = normalizeProviderId(entry.provider);
  return (
    <span
      className={classNames("session-provider-mark", `provider-${provider ?? "generic"}`,
        entry.engine === "sdk" && "provider-engine-sdk")}
      aria-hidden="true"
      title={label}
    >
      <ProviderLogo provider={provider}/>
    </span>
  );
}

function PathReveal({ path }: { path: string }): React.ReactElement | null {
  if (!path) return null;
  return <Typography.Text ellipsis type="secondary" className="session-path" style={{ maxWidth: 160, fontSize: 12 }} title={path} aria-label={path}>{path}</Typography.Text>;
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

  const glow = isHistory ? "none"
    : entry.permissionBlocked ? "permission"
    : entry.status === "waiting-input" || entry.status === "waiting_input" ? "waiting-input"
    : entry.status === "reconnecting" ? "reconnecting"
    : entry.status === "failed" ? "failed"
    : (entry.inFlight || (entry.turnActive && entry.status === "running"))
      ? (entry.status === "thinking" ? "thinking" : "running")
    : entry.status === "running" && Boolean(entry.provider) && entry.kind === "pty" && !entry.ptyBusy
      ? "none"
    : entry.status === "running"
      ? "running"
    : entry.status === "thinking"
      ? "thinking"
    : isSessionJustCompleted(entry)
      ? "just-completed"
    : "none";

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
      style={{ marginBlock: 4 }}
      data-session-id={isHistory ? undefined : entry.id}
      data-claude-history-id={isHistory ? entry.id : undefined}
      data-provider={isHistory ? provider : undefined}
      data-cwd={isHistory ? entry.cwd : undefined}

    >
      <div className="session-item-content">
        <Flex align="center" gap={4} className="session-item-row">
          {manageMode && <ManageCheckbox entry={entry} dispatch={dispatch}/>} 
          <WandButton kind={entry.active ? "soft" : "ghost"} className="session-main wand-sidebar-history-action"
            style={{ flex: 1, minWidth: 0, height: "auto", whiteSpace: "normal", padding: 8, display: "flex", flexDirection: "column", alignItems: "stretch", textAlign: "start" }}
            aria-current={entry.active ? "page" : undefined} onClick={activate}>
            <Flex align="center" gap="small" className="session-title-row">
              <span
                className={classNames("session-leading-slot", glow !== "none" && `wand-logo-glow glow-${glow}`)}
                data-glow={glow}
                style={{ display: "inline-flex", width: 20, height: 20, flexShrink: 0 }}
              >
                <ProviderMark entry={entry}/>
              </span>
              <div
                className={classNames(
                  isHistory ? "session-command claude-history-preview" : "session-title",
                  entry.titleGenerating && "title-generating",
                )}
                aria-busy={entry.titleGenerating || undefined}
                aria-label={entry.titleGenerating ? `${entry.title}，AI 正在生成标题` : undefined}
                style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {entry.title}
              </div>
            </Flex>
            {entry.description && <div className="session-description">{entry.description}</div>}
            <Flex gap="small" wrap className="session-meta" style={{ fontSize: 12 }}>
              <span className="session-leading-slot session-time">{time}</span>
              {isHistory ? (
                <>
                  <span className="session-context session-context-recoverable"><WandIcon name="history" size={11}/>可恢复</span>
                  <PathReveal path={entry.cwd}/>
                </>
              ) : (
                <>
                  <PathReveal path={entry.cwd}/>
                  <WorktreeBadges entry={entry}/>
                </>
              )}
            </Flex>
          </WandButton>
          {!manageMode && (
            <Flex align="center" gap={2} className="session-actions">
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
                  label={SHELL_WORKTREE_MERGE_LABEL}
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
                  label={SHELL_WORKTREE_CLEANUP_LABEL}
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
                  label={SHELL_SESSION_DELETE_LABEL}
                  icon="trash"
                  className="delete-btn"
                  data={data}
                />
              )}
            </Flex>
          )}
        </Flex>
      </div>
    </div>
  );
}


const SIDEBAR_ERROR_LABELS: Readonly<Record<SidebarListErrorKind, string>> = {
  load: "加载失败",
  sync: "未同步",
};

/**
 * 任务列表的加载 / 同步报错在导航栏显示重试图标：
 * 完整原因留在 tooltip，点击就地重试，成功后徽标自行消失。
 */
function SidebarListErrorBadge() {
  const error = React.useSyncExternalStore(
    subscribeSidebarListError, getSidebarListError, getSidebarListError,
  );
  const [retrying, setRetrying] = React.useState(false);
  React.useEffect(() => {
    if (!error) setRetrying(false);
  }, [error]);
  if (!error) return null;
  const label = SIDEBAR_ERROR_LABELS[error.kind];
  return (
    <WandButton kind="ghost"
      type="button"
      className={classNames("sidebar-list-error", retrying && "is-retrying")}
      title={`${sidebarSafeError(error.message)}｜点击重新加载`}
      aria-label={`${label}：${sidebarSafeError(error.message)}，点击重新加载`}
      disabled={retrying}
      onClick={() => {
        setRetrying(true);
        void error.retry().finally(() => setRetrying(false));
      }}
    >
      <WandIcon name="refresh" size={18} className="sidebar-list-error-icon"/>
    </WandButton>
  );
}

export interface ShellSidebarPrimaryAction {
  readonly action: UiAction;
  readonly label: string;
  readonly ariaLabel: string;
}

export function getShellSidebarPrimaryAction(): ShellSidebarPrimaryAction {
  // 统一创建器创建的是会话，是否归入任务由用户在创建器中选择。
  return {
    action: { type: "workspace.new" },
    label: "新建会话",
    ariaLabel: "新建会话",
  };
}

export function sidebarActionLeavesPage(action: UiAction): boolean {
  switch (action.type) {
    case "session.select":
    case "session.resume":
    case "session.resumeHistory":
    case "nav.home":
    case "auth.logout":
    case "native.back":
    case "native.switchServer":
      return true;
    default:
      return false;
  }
}

export async function confirmSidebarLogout(onConfirm: () => void, onCancel?: () => void): Promise<void> {
  const answer = await wandOverlay.dialog({
    title: "退出登录？",
    focusTriggerAfterClose: false,
    description: "退出后需要重新连接。正在运行的任务会继续执行。",
    actions: [
      { label: "取消", value: false, autoFocus: true },
      { label: "退出登录", value: true, kind: "danger" },
    ],
  });
  if (answer.dismissed !== true && answer.action) onConfirm();
  else onCancel?.();
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
      <WandIcon name="chevronLeft" className="sidebar-collapse-direction"/>
      <span className="sidebar-compact-toggle-label">{active ? "展开" : "收起"}</span>
    </WandIconButton>
  );
}

export function ShellSidebar() {
  const snapshot = useUiStoreSnapshot();
  const conversationState = useConversationUi();
  const dispatch = useUiDispatch();
  const taskBoard = React.useSyncExternalStore(taskBoardStore.subscribe, taskBoardStore.getSnapshot, taskBoardStore.getSnapshot);
  const knowledge = React.useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.getSnapshot, knowledgeStore.getSnapshot);
  const settings = React.useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot, settingsStore.getSnapshot);
  const teamAttention = useAiTeamAttentionCount(GROUP_CHAT_VISIBLE);
  const profile = useUserProfile();
  const profileName = profile.name || DEFAULT_USER_DISPLAY_NAME;
  const [moreOpen, setMoreOpen] = React.useState(false);
  const accountTriggerRef = React.useRef<HTMLButtonElement>(null);
  const presentation = useSidebarPresentation();
  // 报错清单默认收起：头部徽标只显示条数，点开才在下方就地展开。
  const [attentionOpen, setAttentionOpen] = React.useState(false);
  // Secondary management surfaces borrow the list space without changing the user's pinned/collapsed preference.
  const contextRail = !snapshot.layout.sidebarDrawer && (settings.open || conversationState.directory
    || taskBoard.open || knowledge.open || snapshot.layout.filePanelOpen);
  const narrow = !snapshot.layout.sidebarDrawer && snapshot.layout.sidebarPinned && snapshot.layout.sidebarCollapsed;
  const sidebarClass = classNames(
    "sidebar sidebar-refined sidebar-unified",
    snapshot.layout.sessionsDrawerOpen && "open",
    !snapshot.layout.sidebarDrawer && snapshot.layout.sidebarAnchored && "pinned",
    narrow && !contextRail && "collapsed",
    contextRail && "context-rail",

  );
  const visible = snapshot.layout.sessionsDrawerOpen
    || (!snapshot.layout.sidebarDrawer && snapshot.layout.sidebarAnchored);
  const overlay = visible && (snapshot.layout.sidebarDrawer || !snapshot.layout.sidebarPinned);
  const drawerRef = useSidebarDrawer(overlay, () => void dispatch({ type: "layout.drawer.close" }));
  const backdropRef = React.useRef<HTMLDivElement>(null);
  useSidebarGesture({
    drawerRef,
    backdropRef,
    enabled: snapshot.layout.sidebarDrawer || overlay,
    isOpen: snapshot.layout.sessionsDrawerOpen,
    onOpen: () => void dispatch({ type: "layout.drawer.open" }),
    onClose: () => void dispatch({ type: "layout.drawer.close" }),
  });
  const sessionTitles = Object.fromEntries(snapshot.sidebar.groups.flatMap(group => group.entries.map(entry => [entry.id, entry.title] as const)));
  const model = useUnifiedSidebar(visible, sessionTitles);
  const dismissSidebarSurfaces = (): void => {
    if (overlay) void dispatch({ type: "layout.drawer.close" });
  };
  const createSession = (): void => {
    const workspace = model.groups.find(group => `id:${group.workspaceId}` === model.facets.workspace && !group.synthetic && !group.global);
    settingsController.close(); taskBoardController.close(); knowledgeController.close();
    newSessionController.open(workspace ? { workspaceId: workspace.workspaceId, initialCwd: workspace.workspaceCwd } : undefined);
    dismissSidebarSurfaces();
  };
  const openEntry = (entry: UnifiedSidebarEntry): void => {
    settingsController.close(); taskBoardController.close(); knowledgeController.close();
    dismissSidebarSurfaces();
    if (entry.conversation) conversationUi.select(entry.conversation.id);
    else {
      conversationUi.suspend();
      void openSessionWithOwningTask(entry.session.id, id => { void dispatch({ type: "session.select", id }); });
    }
  };
  const navigate = (action: UiAction): void => {
    // 设置、创建表单和辅助面板只暂时覆盖当前页面，取消后仍留在原视图。
    if (sidebarActionLeavesPage(action)) { settingsController.close(); taskBoardController.close(); knowledgeController.close(); conversationUi.suspend(); }
    if (action.type === "nav.home") conversationUi.show();
    dismissSidebarSurfaces();
    void dispatch(action);
  };
  // Native CLI histories retain their resume/delete commands, flattened beside managed sessions.
  const historyEntries = model.facets.runtime === "all" && model.facets.taskStage === "all" && model.facets.workspace === "all" && model.facets.archive === "all" && !model.facets.activityOnly
    ? snapshot.sidebar.groups.filter(group => group.kind === "history").flatMap(group => group.entries)
      .filter(entry => !model.entries.some(candidate => candidate.session.id === entry.id)
        && sidebarSearchMatches(model.query, entry.title, entry.description, entry.cwd, entry.provider)) : [];
  React.useEffect(() => { setMoreOpen(false); }, [visible, narrow, contextRail]);
  React.useEffect(() => { if (!visible) setAttentionOpen(false); }, [visible]);

  return (
    <SidebarPresentationContext.Provider value={presentation}>
      <div
        id="sessions-drawer-backdrop"
        ref={backdropRef}
        className={classNames("drawer-backdrop", snapshot.layout.sessionsBackdropVisible && "open")}
        aria-hidden="true"
        style={{ position: "fixed", inset: 0, background: "var(--bg-overlay)", zIndex: 19999, display: snapshot.layout.sessionsBackdropVisible ? undefined : "none" }}
        onClick={() => void dispatch({ type: "layout.drawer.close" })}
      />
      <Layout.Sider id="sessions-drawer" ref={drawerRef as React.RefObject<HTMLDivElement | null>} className={sidebarClass}
        width={contextRail ? 76 : "min(356px, calc(100vw - 24px))"} collapsedWidth={76} collapsed={narrow && !contextRail} theme="light"
        style={{ position: overlay ? "fixed" : "relative", top: overlay ? "var(--wand-safe-top, 0px)" : undefined, bottom: overlay ? "var(--wand-safe-bottom, 0px)" : undefined, left: 0, display: visible ? undefined : "none", zIndex: overlay ? 20000 : 2, height: "100%", overflow: "visible" }}
        styles={{ body: { display: "flex", flexDirection: "row", height: "100%", minHeight: 0 } }}
        aria-label="主导航与会话列表" role={overlay ? "dialog" : undefined}
        aria-modal={overlay || undefined} aria-hidden={!visible || undefined}
        inert={!visible} tabIndex={-1}>
        <Flex vertical align="center" className="sidebar-navigation-rail">
          <div className="sidebar-rail-scroll">
            <WandBrandMark className="sidebar-brand-mark" style={{ width: "var(--conversation-brand-size, 24px)", height: "var(--conversation-brand-size, 24px)" }} />
            {!snapshot.layout.sidebarDrawer && <SidebarCompactToggle active={narrow} onToggle={() => { void dispatch({ type: "layout.drawer.collapse" }); }}/>}
            <ConversationNavigation activePage={settings.open ? null : knowledge.open ? "knowledge" : taskBoard.open ? taskBoard.page === "board" ? "board" : taskBoard.page === "schedules" ? "schedules" : taskBoard.page === "calendar" ? "calendar" : "teams"
              : conversationState.directory ? "teams" : "chats"} teamAttention={teamAttention}
              onNavigate={(page) => {
                setAttentionOpen(false);
                settingsController.close();
                if (page !== "knowledge" && knowledge.open) knowledgeController.close();
                if (page === "knowledge") {
                  taskBoardController.close();
                  knowledgeController.open();
                } else if (page === "board" || page === "teams" || page === "schedules" || page === "calendar") {
                  taskBoardController.open(page === "calendar" ? "" : snapshot.selected?.workspaceId ?? "", page === "calendar" ? "" : snapshot.selected?.id ?? "", page);
                } else {
                  taskBoardController.close();
                  if (page === "contacts") conversationUi.directory(true);
                  else {
                    conversationUi.mode("tasks");
                    conversationUi.suspend();
                  }
                }
                if (page !== "chats" && page !== "tasks") dismissSidebarSurfaces();
              }}/>
            <SidebarFilterCapsules model={model} enabled={visible}/>
          </div>
          <Flex vertical align="center" gap={4} className="sidebar-rail-notices">
              <HomeAttentionBadge compact open={attentionOpen} onToggle={() => setAttentionOpen(value => !value)} />
              <SidebarListErrorBadge />
              <DaemonUpdateNotice compact visible={visible} />
          </Flex>
          <WandDropdownMenu open={moreOpen} onOpenChange={setMoreOpen} modal={false}>
            <WandDropdownMenuTrigger ref={accountTriggerRef} render={(
              <WandIconButton kind={settings.open ? "soft" : "ghost"} aria-current={settings.open ? "page" : undefined}
                id="settings-button" className="sidebar-profile-button" title={`${profileName} · 设置`} aria-label="账户与设置">
                <WandIcon name="gear" size={18}/>
                <span className="sidebar-nav-label" aria-hidden="true">设置</span>
              </WandIconButton>
            )}/>
            <WandDropdownMenuContent id="sidebar-account-menu" className="sidebar-tools-menu" aria-label="账户与设置"
              side="right" align="end" sideOffset={6}>
              <WandDropdownMenuItem icon="user" onClick={() => { setMoreOpen(false); settingsController.close(); taskBoardController.close(); conversationUi.directory(true); dismissSidebarSurfaces(); }}>员工与通讯录</WandDropdownMenuItem>
              <WandDropdownMenuItem id="sidebar-settings-entry" icon="gear"
                onClick={() => { setMoreOpen(false); setAttentionOpen(false); navigate({ type: "settings.open" }); }}>
                设置
              </WandDropdownMenuItem>
              <WandDropdownMenuSeparator/>
              <CopyPageLink menuItem/>
              <WandDropdownMenuItem id="logout-button" icon="logout" tone="danger"
                onClick={() => { setMoreOpen(false); void confirmSidebarLogout(() => navigate({ type: "auth.logout" }), () => {
                  requestAnimationFrame(() => accountTriggerRef.current?.focus({ preventScroll: true }));
                }); }}>
                退出登录
              </WandDropdownMenuItem>
            </WandDropdownMenuContent>
          </WandDropdownMenu>
        </Flex>
        <Flex vertical className="sidebar-list-panel" hidden={contextRail || narrow} inert={contextRail || narrow}>
          <Flex align="center" justify="space-between" className="sidebar-header" style={{ padding: "10px 12px", flexShrink: 0 }}>
            <Typography.Text strong className="sidebar-title">会话</Typography.Text>
            {snapshot.layout.sidebarDrawer && <WandIconButton id="close-drawer-button" aria-label="关闭侧栏" onClick={() => void dispatch({ type: "layout.drawer.close" })}><SidebarToggleIcon open/></WandIconButton>}
          </Flex>
          <UnifiedSidebarList model={model} titles={sessionTitles} enabled={visible && !contextRail && !narrow} selectedSessionId={snapshot.selected?.id ?? null}
            selectedConversationId={conversationState.active && !conversationState.directory ? conversationState.selectedId : null}
            onOpen={openEntry} onCreate={createSession} historyCount={historyEntries.length}
            historyRows={historyEntries.map(entry => <SessionEntry key={`${entry.source}:${entry.id}`} entry={entry} manageMode={false} dispatch={navigate}/>)}/>
          {(snapshot.layout.sidebarDrawer || snapshot.capabilities.backToNative || snapshot.capabilities.switchServer) && <Flex vertical={narrow} align="center" justify="space-between" gap="small" className="sidebar-footer" style={{ flexShrink: 0, padding: narrow ? 8 : "8px 16px", borderTop: "1px solid var(--border-subtle)" }}>
            <Flex component="nav" wrap gap={4} vertical={narrow} className="sidebar-footer-actions" aria-label="侧栏快捷操作">
              {snapshot.layout.sidebarDrawer && <WandIconButton id="file-panel-toggle-btn" title="查看文件" aria-label="文件"
                aria-pressed={snapshot.layout.filePanelOpen} onClick={() => navigate({ type: "layout.files.toggle" })}>
                <WandIcon name="explorer" size={16}/><span>文件</span>
              </WandIconButton>}
              {snapshot.capabilities.backToNative && <WandIconButton id="back-to-native-button" title="返回 App 原生界面" aria-label="返回 App"
                onClick={() => navigate({ type: "native.back" })}>
                <WandIcon name="back" size={16}/><span hidden={narrow}>返回App</span>
              </WandIconButton>}
              {snapshot.capabilities.switchServer && <WandIconButton id="switch-server-button" title="切换服务器" aria-label="切换服务器"
                onClick={() => navigate({ type: "native.switchServer" })}>
                <WandIcon name="server" size={16}/><span hidden={narrow}>切换</span>
              </WandIconButton>}
            </Flex>
          </Flex>}
        </Flex>
      </Layout.Sider>
    </SidebarPresentationContext.Provider>
  );
}
