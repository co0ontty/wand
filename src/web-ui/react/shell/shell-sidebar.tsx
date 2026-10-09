import { Avatar, Checkbox, Flex, Layout, Tag, Typography } from "antd";
import { WandUiBoundary } from "../theme";
import { ImSidebarGroup } from "./im-sidebar-group";
import { WandBrandMark } from "../ui/brand-mark";
import { wandOverlay } from "../overlay-controller";
import * as React from "react";
import { settingsController, settingsStore } from "../settings/controller";
import { isSessionJustCompleted } from "../../../session-completion-state.js";
import { WAND_AGENT_LABEL, normalizeProviderId, providerDisplayName } from "../../provider-identity";
import { ProviderLogo } from "../provider-logo";
import { WorkspacesPanel } from "../workspaces/workspaces-panel";
import { SidebarProjectionSwap } from "../workspaces/sidebar-projection-swap";
import { conversationUi, useConversationUi } from "../conversations/state";
import { ConversationNavigation, ConversationSidebarList, ConversationSidebarTools } from "../conversations/sidebar";
import { SidebarPresentationContext, useSidebarPresentation } from "../workspaces/sidebar-display-mode";
import { sidebarSafeError } from "../workspaces/sidebar-safe-error";
import { useUserProfile } from "../user-profile-repository";
import { avatarFaceParts } from "../ai-teams/avatar";
import { DEFAULT_USER_DISPLAY_NAME } from "../../../user-profile.js";
import { SidebarToggleIcon } from "./sidebar-toggle-icon";
import { DaemonUpdateNotice } from "./daemon-update-notice";
import {
  WandButton,
  WandDropdownMenu,
  WandDropdownMenuContent,
  WandDropdownMenuItem,
  WandDropdownMenuSeparator,
  WandDropdownMenuTrigger,
  WandIcon,
  WandIconButton,
  type WandIconName,
} from "../ui";
import { classNames } from "../ui/class-names";
import { sidebarSearchMatches } from "../workspaces/sidebar-search";
import {
  getSidebarListError,
  subscribeSidebarListError,
  type SidebarListErrorKind,
} from "../workspaces/sidebar-list-error";

import { taskBoardController, taskBoardStore } from "../issues/task-board-controller";
import { HomeAttentionBadge } from "../attention/home-attention";
import { useAiTeamAttentionCount } from "../ai-teams/repository";
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

export async function confirmSidebarLogout(onConfirm: () => void): Promise<void> {
  const answer = await wandOverlay.dialog({
    title: "退出登录？",
    description: "退出后需要重新连接。正在运行的任务会继续执行。",
    actions: [
      { label: "取消", value: false, autoFocus: true },
      { label: "退出登录", value: true, kind: "danger" },
    ],
  });
  if (answer.dismissed !== true && answer.action) onConfirm();
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
      <SidebarToggleIcon open={!active}/>
      <span className="sidebar-compact-toggle-label" hidden>{label}</span>
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
  const setOpen = (expanded: boolean): void => {
    if (!manageMode) void dispatch({
      type: "layout.drawer.group.set",
      group: automation ? "automation" : "history",
      expanded,
    });
  };
  return <div className={classNames(
    automation ? "automation-session-group" : "non-wand-session-group",
    manageMode && "manage-mode",
  )}>
    <ImSidebarGroup label={group.label} count={group.entries.length}
      description={automation
        ? "由自动化或启动任务创建，不参与普通 Wand 会话排序"
        : "本机原生会话，不参与 Wand 会话排序"}
      avatarNode={<WandIcon name={automation ? "zap" : "history"}/>}
      expanded={manageMode || group.expanded}
      onToggle={() => setOpen(!group.expanded)} onSetOpen={setOpen}>
      {entries}
    </ImSidebarGroup>
  </div>;
}

export function ShellSidebar() {
  const snapshot = useUiStoreSnapshot();
  const conversationState = useConversationUi();
  const dispatch = useUiDispatch();
  const taskBoard = React.useSyncExternalStore(taskBoardStore.subscribe, taskBoardStore.getSnapshot, taskBoardStore.getSnapshot);
  const settings = React.useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot, settingsStore.getSnapshot);
  const teamAttention = useAiTeamAttentionCount();
  const profile = useUserProfile();
  const profileName = profile.name || DEFAULT_USER_DISPLAY_NAME;
  const profileFace = avatarFaceParts({ id: "user", name: profileName, avatar: profile.avatar }, 32);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const presentation = useSidebarPresentation();
  const { query: searchQuery, setQuery: setSearchQuery } = presentation;
  // 报错清单默认收起：头部徽标只显示条数，点开才在下方就地展开。
  const [attentionOpen, setAttentionOpen] = React.useState(false);
  const narrow = !snapshot.layout.sidebarDrawer && snapshot.layout.sidebarPinned && snapshot.layout.sidebarCollapsed;
  const sidebarClass = classNames(
    "sidebar sidebar-refined",
    snapshot.layout.sessionsDrawerOpen && "open",
    !snapshot.layout.sidebarDrawer && snapshot.layout.sidebarAnchored && "pinned",
    narrow && "collapsed",
  );
  const primaryAction = getShellSidebarPrimaryAction();
  const visible = snapshot.layout.sessionsDrawerOpen
    || (!snapshot.layout.sidebarDrawer && snapshot.layout.sidebarAnchored);
  const overlay = visible && (snapshot.layout.sidebarDrawer || !snapshot.layout.sidebarPinned);
  const drawerRef = useSidebarDrawer(overlay, () => void dispatch({ type: "layout.drawer.close" }));
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const peekSurfaceRef = React.useRef<HTMLDivElement>(null);
  // 窄栏的悬浮目录树：只在有真实指针的设备上启用（触摸设备没有悬停语义）。
  const hoverPointer = useHoverPointer();
  const [peekDirectory, setPeekDirectory] = React.useState<{ id: string; name: string; top: number } | null>(null);
  const selectPeekDirectory = React.useCallback((id: string, trigger: HTMLElement): void => {
    const sidebarTop = drawerRef.current?.getBoundingClientRect().top ?? 0;
    const top = Math.max(8, Math.min(
      trigger.getBoundingClientRect().top - sidebarTop,
      window.innerHeight - sidebarTop - 300,
    ));
    const name = trigger.dataset.sidebarDirectoryName ?? "目录";
    setPeekDirectory((current) => current?.id === id && current.name === name && current.top === top
      ? current : { id, name, top });
  }, [drawerRef]);
  const peek = useSidebarPeek(visible && narrow && hoverPointer && !moreOpen, drawerRef, peekSurfaceRef, selectPeekDirectory);
  const scrollPositions = React.useRef<Record<string, number>>({ ...conversationState.scrolls });
  React.useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const mode = `sidebar:${conversationState.mode}:${narrow ? "compact" : "full"}`;
    body.scrollTop = scrollPositions.current[mode] ?? 0;
    return () => { scrollPositions.current[mode] = body.scrollTop; conversationUi.scroll(mode, body.scrollTop); };
  }, [narrow, conversationState.mode]);
  const dismissSidebarSurfaces = (): void => {
    peek.close();
    if (overlay) void dispatch({ type: "layout.drawer.close" });
  };
  const navigate = (action: UiAction): void => {
    // 设置、创建表单和辅助面板只暂时覆盖当前页面，取消后仍留在原视图。
    if (sidebarActionLeavesPage(action)) { settingsController.close(); taskBoardController.close(); conversationUi.suspend(); }
    if (action.type === "nav.home") conversationUi.show();
    dismissSidebarSurfaces();
    void dispatch(action);
  };
  // 真正打开任务 / 会话时离开看板；树内创建表单复用临时弹层入口。
  const navigateFromTree = (): void => {
    settingsController.close();
    taskBoardController.close();
    conversationUi.suspend();
    dismissSidebarSurfaces();
  };
  const dispatchEntryAction = (action: UiAction): void => {
    if (action.type === "session.select" || action.type === "session.resume"
      || action.type === "session.resumeHistory") {
      navigate(action);
      return;
    }
    void dispatch(action);
  };
  React.useEffect(() => {
    setMoreOpen(false);
  }, [visible, narrow, conversationState.mode, conversationState.directory]);
  // 收起抽屉时同步关闭通知浮层；压缩列表不影响导航入口。
  React.useEffect(() => {
    if (!visible) setAttentionOpen(false);
  }, [visible]);
  const extraGroups = snapshot.sidebar.groups
    .filter((group) => group.kind === "history")
    .map((group) => ({
      ...group,
      entries: searchQuery.trim()
        ? group.entries.filter((entry) => sidebarSearchMatches(
          searchQuery, entry.title, entry.description, entry.cwd, entry.provider,
        ))
        : group.entries,
    }))
    .map((group) => (
      <SessionGroup key={group.kind} group={group} manageMode={false} dispatch={dispatchEntryAction}/>
    ));
  // 窄栏展示目录图标；悬浮树按当前目录过滤，不携带全局搜索和历史分组。
  const taskTree = (compact: boolean, directoryId?: string): React.ReactNode => (
    <WorkspacesPanel
      key={directoryId ?? "sidebar-tree"}
      compact={compact}
      directoryId={directoryId}
      peekDirectoryId={peek.open ? peekDirectory?.id : undefined}
      onExpand={() => {
        peek.close();
        void dispatch({ type: "layout.drawer.collapse" });
      }}
      onNavigate={navigateFromTree}
      onOpenDialog={dismissSidebarSurfaces}
      searchQuery={searchQuery}
      surfacesEnabled={directoryId ? visible && peek.open : visible && !narrow && conversationState.mode === "tasks"}
      onSearchChange={setSearchQuery}
      selectedSessionId={snapshot.selected?.id ?? null}
      sessionTitles={Object.fromEntries(snapshot.sidebar.groups.flatMap((group) => (
        group.entries.map((entry) => [entry.id, entry.title] as const)
      )))}
      sessionTitleGenerating={Object.fromEntries(snapshot.sidebar.groups.flatMap((group) => (
        group.entries.map((entry) => [entry.id, entry.titleGenerating] as const)
      )))}
      extraGroups={extraGroups}
    />
  );

  return (
    <SidebarPresentationContext.Provider value={presentation}>
      <div
        id="sessions-drawer-backdrop"
        className={classNames("drawer-backdrop", snapshot.layout.sessionsBackdropVisible && "open")}
        aria-hidden="true"
        style={{ position: "fixed", inset: 0, background: "var(--bg-overlay)", zIndex: 19999, display: snapshot.layout.sessionsBackdropVisible ? undefined : "none" }}
        onClick={() => void dispatch({ type: "layout.drawer.close" })}
      />
      <Layout.Sider id="sessions-drawer" ref={drawerRef as React.RefObject<HTMLDivElement | null>} className={sidebarClass}
        width="min(376px, calc(100vw - 24px))" collapsedWidth={128} collapsed={narrow} theme="light"
        style={{ position: overlay ? "fixed" : "relative", top: overlay ? "var(--wand-safe-top, 0px)" : undefined, bottom: overlay ? "var(--wand-safe-bottom, 0px)" : undefined, left: 0, display: visible ? undefined : "none", zIndex: overlay ? 20000 : 2, height: "100%", overflow: "visible" }}
        styles={{ body: { display: "flex", flexDirection: "row", height: "100%", minHeight: 0 } }}
        aria-label="主导航与会话列表" role={overlay ? "dialog" : undefined}
        aria-modal={overlay || undefined} aria-hidden={!visible || undefined}
        inert={!visible} tabIndex={-1} {...peek.triggerBindings}>
        <Flex vertical align="center" className="sidebar-navigation-rail">
          <div className="sidebar-rail-scroll">
            <WandBrandMark className="sidebar-brand-mark" style={{ width: 24, height: 24 }} />
            <ConversationNavigation activePage={settings.open ? null : taskBoard.open ? taskBoard.page === "board" ? "board" : "teams"
              : conversationState.directory ? "contacts" : conversationState.mode} teamAttention={teamAttention}
              onNavigate={(page) => {
                setAttentionOpen(false);
                settingsController.close();
                peek.close();
                if (page === "board" || page === "teams") {
                  taskBoardController.open(snapshot.selected?.workspaceId ?? "", snapshot.selected?.id ?? "", page === "teams" ? "teams" : "board");
                } else {
                  taskBoardController.close();
                  if (page === "contacts") conversationUi.directory(true);
                  else {
                    conversationUi.mode(page);
                    if (page === "chats") conversationUi.show();
                    else conversationUi.suspend();
                  }
                }
                if (page !== "chats" && page !== "tasks") dismissSidebarSurfaces();
              }}/>
            <Flex vertical align="center" gap={4} className="sidebar-rail-notices">
              <HomeAttentionBadge compact open={attentionOpen} onToggle={() => setAttentionOpen(value => !value)} />
              <SidebarListErrorBadge />
              <DaemonUpdateNotice compact visible={visible} />
            </Flex>
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
                      <WandIcon name="more" size={18}/>
                    </WandIconButton>
                  )}
                />
                <WandDropdownMenuContent
                  id="sidebar-overflow-menu"
                  className="sidebar-tools-menu"
                  aria-label="侧栏更多操作"
                  align="end"
                  sideOffset={6}
                >
                  <WandDropdownMenuItem
                    id="missions-button"
                    icon="zap"
                    onClick={() => {
                      setMoreOpen(false);
                      navigate({ type: "missions.open" });
                    }}
                  >
                    并行任务
                  </WandDropdownMenuItem>
                  <WandDropdownMenuItem
                    id="github-issues-button"
                    icon="git"
                    onClick={() => {
                      setMoreOpen(false);
                      peek.close();
                      if (overlay) void dispatch({ type: "layout.drawer.close" });
                      window.__wandReactGithubIssues?.open(snapshot.selected?.id ?? "");
                    }}
                  >
                    GitHub 议题
                  </WandDropdownMenuItem>
                  <WandDropdownMenuSeparator/>
                  <WandDropdownMenuItem
                    id="sidebar-home-btn"
                    icon="home"
                    onClick={() => {
                      setMoreOpen(false);
                      navigate({ type: "nav.home" });
                    }}
                  >
                    返回对话
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
                  <WandDropdownMenuSeparator/>
                  <WandDropdownMenuItem
                    id="logout-button"
                    icon="logout"
                    tone="danger"
                    onClick={() => {
                      setMoreOpen(false);
                      void confirmSidebarLogout(() => navigate({ type: "auth.logout" }));
                    }}
                  >
                    退出登录
                  </WandDropdownMenuItem>
                </WandDropdownMenuContent>
              </WandDropdownMenu>
            </div>
          </div>
          <WandIconButton kind={settings.open ? "soft" : "ghost"} aria-current={settings.open ? "page" : undefined}
            id="settings-button" className="sidebar-profile-button" title={`${profileName} · 设置`} aria-label="设置"
            onClick={() => { setAttentionOpen(false); navigate({ type: "settings.open" }); }}>
            <Avatar size={32} src={profileFace.src} style={profileFace.style} icon={profileFace.icon}/>
          </WandIconButton>
        </Flex>
        <Flex vertical className="sidebar-list-panel">
          <Flex vertical gap="small" className="sidebar-header" style={{ padding: narrow ? "12px 8px" : "12px 16px", flexShrink: 0 }}>
            <Flex vertical={narrow} align="center" justify="space-between" gap="small" className="sidebar-header-primary">
              <Flex align="center" gap="small" className="sidebar-header-main">
                <Typography.Text strong className="sidebar-title" hidden={narrow} style={{ whiteSpace: "nowrap" }}>{conversationState.mode === "tasks" ? "工作区" : "对话"}</Typography.Text>
              </Flex>
              <Flex align="center" gap={4} vertical={narrow} className="sidebar-header-actions">
                <div hidden={conversationState.mode !== "chats"}><ConversationSidebarTools enabled={visible && conversationState.mode === "chats"}
                  onCreateSession={() => navigate(primaryAction.action)}
                  onNavigate={() => { taskBoardController.close(); dismissSidebarSurfaces(); }}/></div>
                {!snapshot.layout.sidebarDrawer && (
                  <SidebarCompactToggle
                    active={narrow}
                    onToggle={() => {
                      peek.close();
                      void dispatch({ type: "layout.drawer.collapse" });
                    }}
                  />
                )}
                {snapshot.layout.sidebarDrawer && (
                  <WandIconButton
                    id="close-drawer-button"
                    className="sidebar-close"
                    aria-label="关闭侧栏"
                    title="关闭侧栏"
                    size="medium"
                    onClick={() => void dispatch({ type: "layout.drawer.close" })}
                  >
                    <SidebarToggleIcon open/>
                  </WandIconButton>
                )}
              </Flex>
            </Flex>
          </Flex>
          <Flex hidden={conversationState.mode !== "tasks"} vertical className="sidebar-feature-nav" style={{ padding: narrow ? "0 8px 8px" : "0 16px 12px", flexShrink: 0 }}>
            <WandButton id="drawer-new-session-button" className="sidebar-new-task" kind="primary" title={primaryAction.label}
              aria-label={primaryAction.ariaLabel} onClick={() => navigate(primaryAction.action)}>
              <WandIcon name="plus" size={18}/><span hidden={narrow}>{primaryAction.label}</span>
            </WandButton>
          </Flex>
          <div className="sidebar-body" ref={bodyRef} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: narrow ? 4 : "0 8px" }}>
            <div id="sessions-panel">
              <div className="sessions-list" id="sessions-list">
                <SidebarProjectionSwap value={conversationState.mode}>
                  <div hidden={conversationState.mode !== "chats"} inert={conversationState.mode !== "chats"}><ConversationSidebarList compact={narrow} enabled={visible && conversationState.mode === "chats"} onNavigate={() => { taskBoardController.close(); dismissSidebarSurfaces(); }}/></div>
                  <div hidden={conversationState.mode !== "tasks"} inert={conversationState.mode !== "tasks"}>{taskTree(narrow)}</div>
                </SidebarProjectionSwap>
              </div>
            </div>
          </div>
          {/* 首次悬停才挂载，之后常驻（关闭态用 CSS visibility 藏起来）：
              既不预览就多跑一份任务树轮询，也不会每次悬停都重新拉一次。 */}
          {narrow && hoverPointer && peek.mounted && peekDirectory ? (
            <SidebarPeek
              title={peekDirectory.name}
              top={peekDirectory.top}
              open={peek.open}
              surfaceRef={peekSurfaceRef}
              onExpand={() => {
                peek.close();
                void dispatch({ type: "layout.drawer.collapse" });
              }}
              {...peek.surfaceBindings}
            >
              {/* 仅渲染当前目录，不复制 legacy DOM id。 */}
              <div className="sessions-list">{taskTree(false, peekDirectory.id)}</div>
            </SidebarPeek>
          ) : null}
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
