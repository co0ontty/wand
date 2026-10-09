import { SidebarPopupOwnerContext, SidebarSurfacesContext, useSidebarPopupOwner, useSidebarPopupState } from "./sidebar-popup-owner";
import { ConversationMorphIcon } from "../conversations/controls";
import { SidebarRowMenu } from "./sidebar-row-menu";
import { SidebarSessionMenu } from "./sidebar-session-menu";
import { confirmSidebarAction, confirmClearSessions } from "./sidebar-menu-confirm";
import { Badge, Checkbox, Flex, Menu, Skeleton, Typography } from "antd";
import { WandUiBoundary } from "../theme";
import * as React from "react";
import { workspacesStore } from "./controller";
import { httpWorkspacesRepository } from "./repository";
import { workspaceContextStore } from "./workspace-context";
import { newSessionController } from "../new-session/controller";
import { WorkspaceWorktreeDialog } from "./workspace-worktree-dialog";
import type { WorkspaceMergeAgentBrief } from "./workspace-worktree-model";
import { closeSessionPane } from "./window-layout";
import type {
  OpenWorkspaceTaskPayload,
  TaskDirectoryGroup,
  TaskSummary,
  WorkspaceSessionSummary,
} from "./types";
import { taskBoardController } from "../issues/task-board-controller";
import { classNames } from "../ui/class-names";
import { MOTION_DWELL_FAILED_MS, MOTION_DWELL_RESULT_SENTENCE_MS, useReducedMotion } from "../ui/motion-tokens";
import {
  WandButton,
  WandIcon,
  WandIconButton,
  WandInput,
  WandNavigationLink,
  WandPopover,
  WandStretchTabs,
} from "../ui";
import { SessionProviderMark, TeamChatSessionMark } from "./session-mark";
import { sidebarSessionLabel } from "./session-order";
import {
  SidebarChevron, SidebarDisclosure, useSidebarExpansion, anchorSidebarDisclosure, sidebarDisclosureKeys,
} from "./sidebar-disclosure";
import { sidebarSessionState, sidebarAggregateState, sessionGlowStatus, sidebarGlowColor } from "./sidebar-session-state";
import { SidebarProjectionSwap } from "./sidebar-projection-swap";
import { sidebarSelection } from "./sidebar-task-meta";
import { filterSidebarGroups } from "./sidebar-search";
import {
  useSidebarPresentation,
  SidebarPresentationContext,
  filterActiveGroups,
  type SidebarDisplayMode,
} from "./sidebar-display-mode";
import {
  collectRecentEntries,
  filterRecentEntries,
} from "./sidebar-recent";
import { SidebarRecentSection } from "./sidebar-recent-section";
import { nonTeamSessions, splitTeamSessions } from "./team-sessions";
import { findSessionTask } from "./session-task-lookup";
import { useTaskGroups } from "./task-groups-store";
import { draggedSessionId, isSessionDrag, startSessionDrag } from "./session-drag";
import {
  EMPTY_SIDEBAR_MANAGE_SELECTION,
  collectManagedIds,
  describeManagedAction,
  describeManagedDelete,
  describeManagedResult,
  isManagedGroupSelected,
  pruneManagedSelection,
  sidebarManageCount,
  toggleManagedGroup,
  toggleManagedSession,
  toggleManagedTask,
  type SidebarManageSelection,
} from "./sidebar-manage";
import { reportSidebarListError } from "./sidebar-list-error";
import { describeError } from "../errors";
import { sidebarSafeError } from "./sidebar-safe-error";

const NAME_MAX = 80;

// 名称禁止包含控制字符 / 换行 / Unicode 行分隔符；用码点判断，不在源码写字面控制字符。
function containsControlOrLineBreak(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code < 32 || code === 127 || (code >= 128 && code <= 159) || code === 8232 || code === 8233) return true;
  }
  return false;
}

function isValidName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (Array.from(trimmed).length > NAME_MAX) return false;
  return !containsControlOrLineBreak(trimmed);
}

function runtime() {
  return workspacesStore.getRuntime();
}

function toast(message: string, tone?: "info" | "success" | "warning" | "danger"): void {
  runtime()?.toast(message, tone);
}

/** 侧栏目录副标题：保留末两段，避免整条绝对路径压过任务名。 */
export function shortenWorkspacePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return path;
  const rooted = normalized.startsWith("/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return rooted ? `/${parts.join("/")}` : parts.join("/") || normalized;
  return `…/${parts.slice(-2).join("/")}`;
}

async function removeSessions(sessionIds: readonly string[], task: TaskSummary | null): Promise<void> {
  const ids = [...new Set(sessionIds.filter((id) => id.trim().length > 0))];
  if (ids.length === 0) return;
  await httpWorkspacesRepository.deleteSessions(ids);
  const rt = runtime();
  try {
    const context = workspaceContextStore.getSnapshot();
    if (rt && task && context.taskId === task.id && context.layout) {
      const next = ids.reduce((layout, sessionId) => closeSessionPane(layout, sessionId), context.layout);
      await rt.saveTaskLayout(next);
    }
  } finally {
    await rt?.refreshSessions();
  }
}

import { useSiliconEmployees } from "../agents/employee-repository.js";

function ManageCheck({
  checked,
  label,
}: {
  checked: boolean;
  label: string;
}) {
  return (
    <span className="wand-workspace-manage-check" aria-hidden="true">
      <WandUiBoundary><Checkbox tabIndex={-1} checked={checked} aria-label={label}/></WandUiBoundary>
    </span>
  );
}

function TaskSessionItem({
  session,
  index,
  liveTitle,
  active,
  manageMode = false,
  selected = false,
  onToggleSelect,
  onOpen,
  onDelete,
  onArchive,
  intoNewTask,
}: {
  session: WorkspaceSessionSummary;
  index: number;
  liveTitle?: string;
  active: boolean;
  manageMode?: boolean;
  selected?: boolean;
  onToggleSelect?(): void;
  onOpen(): void;
  onDelete(): Promise<void>;
  /** 归档会停止会话；恢复用原来的会话 ID 续上。归档行传 false 表示恢复。 */
  onArchive?(archived: boolean): Promise<void>;
  /** 未分组会话所在的目录组：给出「归纳为新任务」入口；任务内的会话不传。 */
  intoNewTask?: TaskDirectoryGroup;
}) {
  const isArchived = session.archived === true;
  const label = sidebarSessionLabel(session, index, liveTitle);
  const rowTitle = session.teamStep
    ? `${session.teamStep.teamName} · ${session.teamStep.memberName} · ${session.teamStep.title}`
    : session.cwd || session.title || session.id;
  const state = sidebarSessionState(session);
  const glow = sessionGlowStatus(session);
  const activate = manageMode ? (onToggleSelect ?? onOpen) : onOpen;
  const row = (
    <Flex align="center" gap={4} style={{ minWidth: 0, width: "100%" }} className={classNames(
      "workspace-session",
      active && "active",
      isArchived && "archived",
      manageMode && "managing",
      manageMode && selected && "selected",
    )}
      data-session-id={session.id}
      draggable={!manageMode && !isArchived}
      onDragStart={(event) => {
        event.stopPropagation();
        startSessionDrag(event.dataTransfer, session.id);
      }}>
      <WandNavigationLink style={{ flex: 1, minWidth: 0, width: "100%", height: "auto", whiteSpace: "normal", justifyContent: "flex-start", textAlign: "start", padding: 6 }}
        className="workspace-session-main"
        orientation="vertical"
        size="sm"
        active={active}
        aria-pressed={manageMode ? selected : undefined}
        title={`${label} · ${state.label} · ${rowTitle}`}
        render={<button type="button" onClick={activate}/>}
      >
        {manageMode && <ManageCheck checked={selected} label={`选择终端 ${label}`}/>}
        <span style={{ display: "inline-flex", width: 20, height: 20, flexShrink: 0 }}
          className={classNames("workspace-session-mark", glow !== "none" && `wand-logo-glow glow-${glow}`)}
          data-glow={glow}
          aria-hidden="true"
        >
          <Badge dot={glow !== "none"} color={sidebarGlowColor(glow)}>{session.teamChat
            ? <TeamChatSessionMark teamChat={session.teamChat}/>
            : <SessionProviderMark session={session} size={14}/>}</Badge>
        </span>
        <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} className={classNames("workspace-session-name", session.titleGenerating && "title-generating")}
          aria-busy={session.titleGenerating || undefined}
          aria-label={session.titleGenerating ? `${label}，AI 正在生成标题` : undefined}
          title={session.titleGenerating ? "AI 正在生成标题" : undefined}>{label}</span>
        {session.teamStep ? (
          <span
            className="workspace-session-kind workspace-session-kind-team"
            title={`${session.teamStep.teamName} · ${session.teamStep.stepStatus}`}
          >{session.teamStep.memberName || "团队"}</span>
        ) : session.teamChat ? (
          <span
            className="workspace-session-kind workspace-session-kind-team"
            title={`${session.teamChat.teamName} · ${session.teamChat.memberCount} 人`}
          >群聊</span>
        ) : session.sessionKind === "pty" && (
          <span className="workspace-session-kind">终端</span>
        )}
      </WandNavigationLink>
    </Flex>
  );
  return <SidebarSessionMenu row={row} session={session} label={label} disabled={manageMode}
    intoNewTask={session.workspaceTaskId ? undefined : intoNewTask}
    onOpen={onOpen} onArchive={onArchive} onDelete={onDelete}/>;
}

// ── 任务行 ──

/**
 * 「已归档」会话区：与任务的归档同一套逻辑，收起在触发点原位、可展开、可恢复。
 * 归档不是破坏性操作，所以默认不起来；删除统一走 confirmSessionDelete 的公共确认。
 */
function ArchivedSessionsFold({
  id,
  storageKey,
  sessions,
  label,
  activeSessionId,
  liveTitles,
  onOpen,
  onDelete,
  onArchive,
}: {
  id: string;
  storageKey: string;
  sessions: readonly WorkspaceSessionSummary[];
  label: string;
  activeSessionId: string | null;
  liveTitles?: Readonly<Record<string, string>>;
  onOpen(session: WorkspaceSessionSummary): void;
  onDelete(session: WorkspaceSessionSummary, index: number): Promise<void>;
  onArchive(sessionId: string, archived: boolean): Promise<void>;
}) {
  const [open, setOpen] = useSidebarExpansion(storageKey, true);
  if (sessions.length === 0) return null;
  return (
    <div className="workspace-archive-fold">
      <WandButton style={{ width: "100%", justifyContent: "flex-start", height: "auto" }} kind="ghost"
        type="button"
        className="workspace-archive-fold-head"
        aria-expanded={open}
        aria-controls={id}
        title={open ? `收起${label}` : `展开 ${sessions.length} 个${label}`}
        onClick={(event) => anchorSidebarDisclosure(event.currentTarget, () => setOpen(!open))}
        onKeyDown={(event) => sidebarDisclosureKeys(event, open, setOpen)}
      >
        <SidebarChevron open={open} size={10} className={classNames("workspace-task-chevron", open && "open")}/>
        <WandIcon name="archive" size={11}/>
        <span className="workspace-archive-fold-label">{label}</span>
        <span className="workspace-archive-fold-count">{sessions.length}</span>
      </WandButton>
      <SidebarDisclosure id={id} open={open}>
        <Flex vertical gap={4} style={{ paddingInlineStart: 12 }} className="workspace-archive-fold-list">
          {sessions.map((session, index) => (
            <TaskSessionItem
              key={session.id}
              session={session}
              index={index}
              liveTitle={liveTitles?.[session.id]}
              active={activeSessionId === session.id}
              onOpen={() => onOpen(session)}
              onDelete={() => onDelete(session, index)}
              onArchive={(archived) => onArchive(session.id, archived)}
            />
          ))}
        </Flex>
      </SidebarDisclosure>
    </div>
  );
}

function TaskItem({
  task,
  now,
  liveTitles,
  activeTaskId,
  activeSessionId,
  manageMode = false,
  displayMode = "full",
  selected = false,
  selectedSessionIds,
  onToggleSelect,
  onToggleSession,
  onOpen,
  onOpenSession,
  onRequestNewSession,
  isOnlyTask = false,
  onClearSessions,
  onClearTeamHistory,
  onDeleteSession,
  onArchiveSession,
  onRename,
  onArchive,
  onDelete,
  onMoveSession,
}: {
  task: TaskSummary;
  now: number;
  liveTitles?: Readonly<Record<string, string>>;
  activeTaskId: string | null;
  activeSessionId: string | null;
  manageMode?: boolean;
  /** 侧栏显示模式：folded 时任务下的终端整块收起。 */
  displayMode?: SidebarDisplayMode;
  selected?: boolean;
  selectedSessionIds?: ReadonlySet<string>;
  onToggleSelect?(): void;
  onToggleSession?(sessionId: string): void;
  onOpen(): void;
  onOpenSession(session: WorkspaceSessionSummary): void;
  /** 请求在该任务中新建会话；由上层弹出 Agent 选择器后回调。 */
  onRequestNewSession(): void;
  /** 该任务是否为目录里的唯一任务；唯一任务才默认展开空提示。 */
  isOnlyTask?: boolean;
  /** 批量结束并删除该任务的全部会话（batch-delete）。 */
  onClearSessions(): Promise<void>;
  /** 只清空已结束运行的团队会话，人工会话和任务本身不动。 */
  onClearTeamHistory(sessionIds: readonly string[]): Promise<void>;
  onDeleteSession(session: WorkspaceSessionSummary, index?: number): Promise<void>;
  /** 归档 / 恢复会话（批量入口，内部按单个处理）；与任务同一套逻辑。 */
  onArchiveSession(sessionIds: readonly string[], archived: boolean): Promise<void>;
  onRename(name: string): Promise<void>;
  /** 归档（软删除）：终端与 worktree 都保留，只从侧栏隐藏并进入看板归档。 */
  onArchive(): Promise<void>;
  /** 硬删除；只有隔离任务还留着它，用来清理 worktree。 */
  onDelete(): Promise<void>;
  onMoveSession(sessionId: string): Promise<void>;
}) {
  const [teamOpen, setTeamOpen] = useSidebarExpansion(`team.${task.id}`, true);
  const [teamHistoryOpen, setTeamHistoryOpen] = useSidebarExpansion(`teamhistory.${task.id}`, true);
  const [dropTarget, setDropTarget] = React.useState(false);
  const [taskMenuOpen, setTaskMenuOpen] = useSidebarPopupState();
  const taskMenuTrigger = React.useRef<HTMLElement>(null);
  const [taskActionError, setTaskActionError] = React.useState("");
  const wasRenaming = React.useRef(false);
  const [renaming, setRenaming] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState(task.name);
  React.useLayoutEffect(() => {
    if (wasRenaming.current && !renaming && document.activeElement === document.body) {
      taskMenuTrigger.current?.querySelector<HTMLElement>(".workspace-task-main")?.focus({ preventScroll: true });
    }
    wasRenaming.current = renaming;
  }, [renaming]);
  const [renameError, setRenameError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const isolated = Boolean(task.worktree);
  const isActive = activeTaskId === task.id;
  const sessionsId = React.useId();
  const teamId = React.useId();
  const teamHistoryId = React.useId();
  const archivedId = React.useId();

  // 人工会话和群聊入口照常显示，团队派发的会话收进一个可点的折叠头。
  const teamSplit = splitTeamSessions(task.sessions);
  const shownSessions = nonTeamSessions(task.sessions);
  const teamCount = teamSplit.live.length + teamSplit.history.length;
  const archivedSessions = task.archivedSessions ?? [];
  const sessionCount = shownSessions.length;
  const totalSessionCount = sessionCount + teamCount;
  const [open, setSessionsOpen] = useSidebarExpansion(
    `task.${task.id}`, true, false, isActive || isOnlyTask,
  );
  React.useEffect(() => {
    if (activeSessionId && task.sessions.some(session => session.id === activeSessionId)) setSessionsOpen(true);
  }, [activeSessionId]);
  const toggleSessionsOpen = (): void => setSessionsOpen(!open);
  const teamActivity = sidebarAggregateState(teamSplit.live);
  const taskAggregate = sidebarAggregateState(task.sessions);
  const countId = React.useId();

  const submitRename = async () => {
    if (busy) return;
    const trimmed = renameValue.trim();
    if (!isValidName(trimmed)) {
      setRenameError(trimmed ? "任务名称无效或过长（最多 80 字符）。" : "请输入任务名称。");
      return;
    }
    if (trimmed === task.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    setRenameError("");
    try {
      await onRename(trimmed);
      setRenaming(false);
    } catch (renameFailure) {
      setRenameError(describeError(renameFailure, "重命名任务失败。"));
    } finally {
      setBusy(false);
    }
  };

  const runTaskAction = async (key: "archive" | "delete" | "clear" | "clear-history"): Promise<void> => {
    if (busy) return;
    setBusy(true); setTaskActionError(""); setTaskMenuOpen(false);
    try {
      const confirmed = key === "clear" || key === "clear-history"
        ? await confirmClearSessions(key === "clear" ? totalSessionCount : teamSplit.history.length,
          `任务「${task.name}」${key === "clear-history" ? "已结束的团队会话" : ""}`, taskMenuTrigger.current,
          key === "clear-history" ? `将删除这一轮协作留下的 ${teamSplit.history.length} 个成员会话，无法撤销。你自己的会话和任务都会保留。` : undefined)
        : await confirmSidebarAction({ title: `${key === "archive" ? "归档" : "删除"}「${task.name}」？`,
          description: key === "archive" ? "任务从侧栏移到看板归档，保留会话和 Worktree，不停止正在执行的工作。"
            : "将删除任务、所属会话并清理 Worktree，无法撤销。", action: key === "archive" ? "确认归档任务" : "确认删除任务",
          danger: key === "delete", trigger: taskMenuTrigger.current });
      if (!confirmed) return;
      if (key === "archive") await onArchive();
      else if (key === "delete") await onDelete();
      else if (key === "clear") await onClearSessions();
      else await onClearTeamHistory(teamSplit.history.map(session => session.id));
    } catch (cause) {
      setTaskActionError(describeError(cause, "无法处理任务，请重试。"));
      if (taskMenuTrigger.current?.contains(document.activeElement)) setTaskMenuOpen(true);
    } finally { setBusy(false); }
  };

  if (renaming) {
    return (
      <form style={{ display: "flex", alignItems: "center", gap: 4 }} noValidate
        className="workspace-task workspace-task-rename"
        aria-busy={busy}
        onSubmit={(event) => { event.preventDefault(); void submitRename(); }}
      >
        <span style={{ minWidth: 0, flex: 1 }} className="workspace-task-rename-field">
          <WandInput
            className="workspace-task-rename-input"
            value={renameValue}
            disabled={busy}
            maxLength={NAME_MAX}
            autoFocus
            aria-label={`重命名任务 ${task.name}`}
            aria-invalid={Boolean(renameError) || undefined}
            onChange={(event) => { setRenameValue(event.currentTarget.value); setRenameError(""); }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              if (!busy) setRenaming(false);
            }}
          />
          {renameError && <span className="workspace-task-rename-error" role="alert">{renameError}</span>}
        </span>
        <WandIconButton type="submit" className="workspace-task-action confirm" disabled={busy} title="保存任务名称" aria-label="保存任务名称">
          <WandIcon name="check" size={13}/>
        </WandIconButton>
        <WandIconButton className="workspace-task-action cancel" disabled={busy} title="取消重命名" aria-label="取消重命名" onClick={() => setRenaming(false)}>
          <WandIcon name="close" size={13}/>
        </WandIconButton>
      </form>
    );
  }

  return (
    <div className={classNames(
      "workspace-task-group",
      dropTarget && "is-session-drop-target",
      isActive && "active",
      open && "is-open",
      manageMode && "managing",
      manageMode && selected && "selected",
    )}
      data-workspace-task-id={task.id}
      aria-busy={busy || undefined}
      onDragOver={(event) => {
        if (manageMode || busy || !isSessionDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDropTarget(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(false);
      }}
      onDrop={(event) => {
        if (!isSessionDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(false);
        const id = draggedSessionId(event.dataTransfer);
        if (!id || busy || manageMode || task.sessions.some((session) => session.id === id)) return;
        setBusy(true);
        void onMoveSession(id).then(() => setSessionsOpen(true))
          .catch((cause) => toast(describeError(cause, "无法移动会话。"), "danger"))
          .finally(() => setBusy(false));
      }}>
      {dropTarget && <span className="workspace-task-drop-hint">移入此任务 · 运行目录不变</span>}
      <SidebarRowMenu open={taskMenuOpen} disabled={manageMode} rowRef={taskMenuTrigger}
        onOpenChange={(next) => { if (!next || !busy) setTaskMenuOpen(next); }}
        label={`任务 ${task.name} 的更多操作`} title={task.name} description={isolated ? "隔离任务 · 保留 Worktree 的归档" : undefined}
        error={taskActionError} className="workspace-task-menu"
        row={<Flex align="center" gap={4} style={{ minWidth: 0 }} className={classNames(
        "workspace-task",
        isActive && "active",
        !isolated && "not-isolated",
        manageMode && "managing",
        manageMode && selected && "selected",
      )}>
        <WandIconButton className="workspace-task-chevron-btn" title={open ? "收起会话" : "展开会话"}
          aria-label={`${open ? "收起" : "展开"}任务 ${task.name} 的会话`}
          aria-expanded={open} aria-controls={sessionsId} aria-describedby={countId}
          onClick={(event) => anchorSidebarDisclosure(event.currentTarget, toggleSessionsOpen)}
          onKeyDown={(event) => sidebarDisclosureKeys(event, open, setSessionsOpen)}>
          <SidebarChevron open={open} size={16} className={classNames("workspace-task-chevron", open && "open")}/>
        </WandIconButton>
        <WandNavigationLink style={{ flex: 1, minWidth: 0, height: "auto", whiteSpace: "normal", justifyContent: "flex-start", textAlign: "start" }}
          className="workspace-task-main"
          orientation="vertical"
          size="sm"
          active={isActive}
          aria-pressed={manageMode ? selected : undefined}
          title={`${task.name}\n${task.worktree?.path ?? task.cwd}`}
          render={<button type="button" onClick={manageMode ? (onToggleSelect ?? onOpen) : onOpen}/>}
        >
          {manageMode && <ManageCheck checked={selected} label={`选择任务 ${task.name}`}/>}
          <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} className="workspace-task-name">{task.name}</span>
        </WandNavigationLink>
        <span id={countId} className="workspace-task-count" title={taskAggregate.description}>
          {totalSessionCount}
        </span>
        <span className={`sidebar-head-activity tone-${taskAggregate.tone}`} title={taskAggregate.description}
          aria-label={taskAggregate.description}>{taskAggregate.label ? <Badge status={taskAggregate.tone === "warning" ? "warning" : taskAggregate.tone === "success" ? "success" : "processing"}/> : null}</span>
      </Flex>} menu={{ items: [
        { key: "open", disabled: busy, icon: <WandIcon name="task"/>, label: "打开任务" },
        { key: "new", disabled: busy, icon: <WandIcon name="plus"/>, label: "新建会话" },
        { key: "rename", disabled: busy, icon: <WandIcon name="edit"/>, label: "重命名任务" },
        { key: "archive", disabled: busy, icon: <WandIcon name="archive"/>, label: isolated ? "归档任务（保留 Worktree）" : "归档任务" },
        ...(totalSessionCount || isolated ? [{ key: "danger-divider", type: "divider" as const }] : []),
        ...(totalSessionCount ? [{ key: "clear", disabled: busy, danger: true, icon: <WandIcon name="terminal"/>, label: `清空所列会话（${totalSessionCount}）` }] : []),
        ...(teamSplit.history.length ? [{ key: "clear-history", disabled: busy, danger: true, icon: <WandIcon name="archive"/>, label: `清理团队历史（${teamSplit.history.length}）` }] : []),
        ...(isolated ? [{ key: "delete", disabled: busy, danger: true, icon: <WandIcon name="trash"/>, label: "删除任务并清理 Worktree…" }] : []),
      ], onClick: ({ key }) => {
        if (busy) return;
        if (key === "open") { setTaskMenuOpen(false); onOpen(); }
        else if (key === "new") { setTaskMenuOpen(false); onRequestNewSession(); }
        else if (key === "rename") { setTaskMenuOpen(false); setRenameValue(task.name); setRenameError(""); setRenaming(true); }
        else if (key === "archive" || key === "delete" || key === "clear" || key === "clear-history") void runTaskAction(key);
      } }}/>

      <SidebarDisclosure id={sessionsId} open={open}>
        {totalSessionCount === 0 && !manageMode && <WandButton kind="ghost" type="button" className="workspace-task-empty"
          onClick={onRequestNewSession}><WandIcon name="plus" size={12}/>添加会话，或拖入已有会话</WandButton>}
        <Flex vertical gap={4} style={{ paddingInlineStart: 12 }} className="workspace-task-sessions">
          {(manageMode ? task.sessions : shownSessions).map((session, index) => (
            <TaskSessionItem
              key={session.id}
              session={session}
              index={index}
              liveTitle={liveTitles?.[session.id]}
              active={activeSessionId === session.id}
              manageMode={manageMode}
              selected={selectedSessionIds?.has(session.id) ?? false}
              onToggleSelect={() => onToggleSession?.(session.id)}
              onOpen={() => onOpenSession(session)}
              onDelete={() => onDeleteSession(session)}
              onArchive={manageMode ? undefined : (archived) => onArchiveSession([session.id], archived)}
            />
          ))}
          {/* 批量选择照常列出团队会话，折叠只作用于日常视图，不缩小删除范围。 */}
          {!manageMode && teamCount > 0 && (
            <div className="workspace-team-fold">
              <WandButton style={{ width: "100%", justifyContent: "flex-start", height: "auto" }} kind="ghost"
                type="button"
                className="workspace-team-fold-head"
                aria-expanded={teamOpen}
                aria-controls={teamId}
                title={teamOpen ? "收起团队会话" : `展开任务「${task.name}」的 ${teamCount} 个团队会话`}
                onClick={(event) => anchorSidebarDisclosure(event.currentTarget, () => setTeamOpen(!teamOpen))}
                onKeyDown={(event) => sidebarDisclosureKeys(event, teamOpen, setTeamOpen)}
              >
                <SidebarChevron open={teamOpen} size={10} className={classNames("workspace-task-chevron", teamOpen && "open")}/>
                <span className="workspace-team-fold-label">团队会话</span>
                {teamActivity.label ? (
                  <span className={`workspace-task-activity ${teamActivity.tone}`} title={teamActivity.description}>{teamActivity.label}</span>
                ) : null}
                <span className="workspace-team-fold-count">{teamCount}</span>
              </WandButton>
              <SidebarDisclosure id={teamId} open={teamOpen}>
                <Flex vertical gap={4} style={{ paddingInlineStart: 12 }} className="workspace-team-fold-list">
                  {teamSplit.live.map((session, index) => (
                    <TaskSessionItem
                      key={session.id}
                      session={session}
                      index={index}
                      liveTitle={liveTitles?.[session.id]}
                      active={activeSessionId === session.id}
                      onOpen={() => onOpenSession(session)}
                      onDelete={() => onDeleteSession(session)}
                      onArchive={(archived) => onArchiveSession([session.id], archived)}
                    />
                  ))}
                  {teamSplit.history.length > 0 && (
                    <div className="workspace-team-history">
                      <Flex align="center" gap={4} className="workspace-team-history-head">
                        <WandButton style={{ width: "100%", justifyContent: "flex-start", height: "auto" }} kind="ghost"
                          type="button"
                          className="workspace-team-fold-head is-nested"
                          aria-expanded={teamHistoryOpen}
                          aria-controls={teamHistoryId}
                          title={teamHistoryOpen ? "收起已结束的团队会话" : `展开 ${teamSplit.history.length} 个已结束的团队会话`}
                          onClick={(event) => anchorSidebarDisclosure(event.currentTarget, () => setTeamHistoryOpen(!teamHistoryOpen))}
                          onKeyDown={(event) => sidebarDisclosureKeys(event, teamHistoryOpen, setTeamHistoryOpen)}
                        >
                          <SidebarChevron open={teamHistoryOpen} size={10} className={classNames("workspace-task-chevron", teamHistoryOpen && "open")}/>
                          <span className="workspace-team-fold-label">已结束</span>
                          <span className="workspace-team-fold-count">{teamSplit.history.length}</span>
                        </WandButton>
                      </Flex>
                      <SidebarDisclosure id={teamHistoryId} open={teamHistoryOpen}>
                        <Flex vertical gap={4} className="workspace-team-fold-list">
                          {teamSplit.history.map((session, index) => (
                            <TaskSessionItem
                              key={session.id}
                              session={session}
                              index={index}
                              liveTitle={liveTitles?.[session.id]}
                              active={activeSessionId === session.id}
                              onOpen={() => onOpenSession(session)}
                              onDelete={() => onDeleteSession(session)}
                              onArchive={(archived) => onArchiveSession([session.id], archived)}
                            />
                          ))}
                        </Flex>
                      </SidebarDisclosure>
                    </div>
                  )}
                </Flex>
              </SidebarDisclosure>
            </div>
          )}

          </Flex>
      {displayMode !== "active" && archivedSessions.length > 0 && (
        <ArchivedSessionsFold
          id={archivedId}
          storageKey={`archived.task.${task.id}`}
          sessions={archivedSessions}
          label="已归档会话"
          activeSessionId={activeSessionId}
          liveTitles={liveTitles}
          onOpen={(session) => onOpenSession(session)}
          onDelete={(session, index) => onDeleteSession(session, index)}
          onArchive={(sessionId, archived) => onArchiveSession([sessionId], archived)}
        />
      )}
      </SidebarDisclosure>
    </div>
  );
}

// ── 目录分组 ──

function TaskGroupSection({
  group,
  now,
  preview = false,
  directoryCount,
  liveTitles,
  activeWorkspaceId,
  activeTaskId,
  activeSessionId,
  manageMode = false,
  displayMode = "full",
  selection,
  onToggleTask,
  onToggleGroup,
  onToggleSession,
  onActiveTaskOpen,
  onOpenSession,
  onRequestNewSessionInTask,
  onTasksChanged,
  onOpenDialog,
}: {
  group: TaskDirectoryGroup;
  now: number;
  preview?: boolean;
  directoryCount: number;
  liveTitles?: Readonly<Record<string, string>>;
  activeWorkspaceId: string | null;
  activeTaskId: string | null;
  activeSessionId: string | null;
  manageMode?: boolean;
  /** 侧栏显示模式，透传给每个任务行。 */
  displayMode?: SidebarDisplayMode;
  selection?: SidebarManageSelection;
  onToggleTask?(taskId: string): void;
  onToggleGroup?(group: TaskDirectoryGroup): void;
  onToggleSession?(sessionId: string): void;
  onActiveTaskOpen(group: TaskDirectoryGroup, task: TaskSummary): void;
  onOpenSession(group: TaskDirectoryGroup, session: WorkspaceSessionSummary): void;
  onRequestNewSessionInTask(task: TaskSummary): void;
  onTasksChanged(): Promise<void>;
  onOpenDialog?: () => void;
}) {
  const [directoryOpen, setDirectoryOpen] = useSidebarExpansion(`project.${group.workspaceId}`, false, true);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [directoryActionError, setDirectoryActionError] = React.useState("");
  const [menuOpen, setMenuOpen] = useSidebarPopupState();
  const [renamingDirectory, setRenamingDirectory] = React.useState(false);
  const directoryMenuTrigger = React.useRef<HTMLElement>(null);
  const wasRenamingDirectory = React.useRef(false);
  React.useLayoutEffect(() => {
    if (wasRenamingDirectory.current && !renamingDirectory && document.activeElement === document.body) {
      directoryMenuTrigger.current?.querySelector<HTMLElement>(".workspace-row-main")?.focus({ preventScroll: true });
    }
    wasRenamingDirectory.current = renamingDirectory;
  }, [renamingDirectory]);
  const [directoryNameValue, setDirectoryNameValue] = React.useState(group.workspaceName);
  const [directoryNameError, setDirectoryNameError] = React.useState("");
  const [directoryRenameBusy, setDirectoryRenameBusy] = React.useState(false);
  const tasksId = React.useId();
  const looseArchivedId = React.useId();
  const open = preview || directoryOpen;
  const groupActivity = sidebarAggregateState([...group.tasks.flatMap((task) => task.sessions), ...group.standaloneSessions]);
  const canDelete = !group.synthetic && !group.global;
  // 全局（不挂目录）不参与重命名；合成目录用目录接口改名。
  const canRenameDirectory = !group.global;

  const submitDirectoryRename = async () => {
    if (directoryRenameBusy) return;
    const trimmed = directoryNameValue.trim();
    if (!trimmed) {
      setDirectoryNameError("请输入工作区名称。");
      return;
    }
    if (trimmed.length > NAME_MAX) {
      setDirectoryNameError(`工作区名称最多 ${NAME_MAX} 个字符。`);
      return;
    }
    if (trimmed === group.workspaceName) {
      setRenamingDirectory(false);
      return;
    }
    setDirectoryRenameBusy(true);
    setDirectoryNameError("");
    try {
      await httpWorkspacesRepository.renameDirectory(group.workspaceCwd, trimmed);
      toast(`已将目录「${group.workspaceName}」重命名为「${trimmed}」`, "success");
      setRenamingDirectory(false);
      await onTasksChanged();
    } catch (cause) {
      setDirectoryNameError(describeError(cause, "重命名目录失败。"));
    } finally {
      setDirectoryRenameBusy(false);
    }
  };

  // 归档是软删除：终端不杀、worktree 不清理，只从侧栏隐藏并移到看板归档。
  const handleArchiveTask = async (task: TaskSummary) => {
    await httpWorkspacesRepository.archiveTask(task.id);
    if (workspaceContextStore.getSnapshot().taskId === task.id) runtime()?.closeWorkspace();
    toast(`已归档任务「${task.name}」，可在任务看板的归档任务中恢复。`, "info");
    await onTasksChanged();
  };

  const handleDeleteTask = async (task: TaskSummary) => {
    await httpWorkspacesRepository.deleteTask(task.id, true);
    await runtime()?.refreshSessions();
    if (workspaceContextStore.getSnapshot().taskId === task.id) runtime()?.closeWorkspace();
    toast(`已删除任务「${task.name}」`, "info");
    await onTasksChanged();
  };

  const handleDeleteDirectory = async () => {
    if (!canDelete || deleting) return;
    setDeleting(true); setMenuOpen(false); setDirectoryActionError("");
    try {
      if (!await confirmSidebarAction({ title: `删除目录「${group.workspaceName}」？`,
        description: "将删除此目录及其全部任务、终端和任务 Worktree，无法撤销。",
        action: "确认删除目录", trigger: directoryMenuTrigger.current })) return;
      await httpWorkspacesRepository.remove(group.workspaceId, true);
      await runtime()?.refreshSessions();
      if (workspaceContextStore.getSnapshot().workspaceId === group.workspaceId) runtime()?.closeWorkspace();
      toast(`已删除目录「${group.workspaceName}」`, "info");
      await onTasksChanged();
    } catch (cause) {
      setDirectoryActionError(describeError(cause, "无法删除目录。"));
      if (directoryMenuTrigger.current?.contains(document.activeElement)) setMenuOpen(true);
    } finally { setDeleting(false); }
  };

  const handleStartMergeAgent = async (brief: WorkspaceMergeAgentBrief) => {
    const rt = runtime();
    if (!rt) throw new Error("工作空间运行环境尚未就绪，请刷新页面后重试。");
    await rt.startWorktreeMergeAgent({
      workspaceId: group.workspaceId,
      cwd: group.workspaceCwd,
      systemPrompt: brief.system,
      prompt: brief.message,
    });
    rt.toast(`已启动 Agent，准备合并所选 Worktree 到项目默认分支。`, "success");
  };

  const handleDeleteSessions = async (sessionIds: readonly string[], task: TaskSummary | null, label: string) => {
    await removeSessions(sessionIds, task);
    toast(label, "info");
    await onTasksChanged();
  };

  // 会话归档会停止终端，历史和 session id 保留，恢复时用它续上。
  const handleArchiveSession = async (sessionIds: readonly string[], archived: boolean) => {
    const ids = [...new Set(sessionIds)].filter((id) => id.trim().length > 0);
    if (ids.length === 0) return;
    await httpWorkspacesRepository.batchArchiveSessions(ids, archived);
    toast(
      archived
        ? `已归档 ${ids.length} 个会话，可在「已归档会话」中恢复`
        : `已恢复 ${ids.length} 个会话`,
      "info",
    );
    await onTasksChanged();
  };

  const taskCount = group.tasks.length;
  const groupSelected = manageMode && selection ? isManagedGroupSelected(selection, group) : false;
  const clearSessionIds = [...new Set([...group.tasks.flatMap(task => task.sessions.map(session => session.id)),
    ...group.standaloneSessions.map(session => session.id)])];
  const handleClearDirectory = async (): Promise<void> => {
    if (deleting) return;
    setDeleting(true); setMenuOpen(false); setDirectoryActionError("");
    try {
      if (!await confirmClearSessions(clearSessionIds.length, `目录「${group.workspaceName}」`, directoryMenuTrigger.current)) return;
      const context = workspaceContextStore.getSnapshot();
      const activeTask = group.tasks.find(task => task.id === context.taskId) ?? null;
      await handleDeleteSessions(clearSessionIds, activeTask, `已清空目录「${group.workspaceName}」的终端`);
    } catch (cause) {
      setDirectoryActionError(describeError(cause, "无法清空终端。"));
      if (directoryMenuTrigger.current?.contains(document.activeElement)) setMenuOpen(true);
    } finally { setDeleting(false); }
  };

  return (
    <section
      data-sidebar-tree-directory-id={group.workspaceId}
      className={classNames(
        "workspace-item",
        group.global && "workspace-global-tasks",
        open && "is-open",
        group.synthetic && "is-synthetic",
        activeWorkspaceId === group.workspaceId && "active-workspace",
      )}
    >
      {renamingDirectory ? (
        <form style={{ display: "flex", alignItems: "center", gap: 4 }} noValidate
          className="workspace-row-rename"
          aria-busy={directoryRenameBusy}
          onSubmit={(event) => { event.preventDefault(); void submitDirectoryRename(); }}
        >
          <span style={{ minWidth: 0, flex: 1 }} className="workspace-task-rename-field">
            <WandInput
              className="workspace-task-rename-input"
              value={directoryNameValue}
              disabled={directoryRenameBusy}
              maxLength={NAME_MAX}
              autoFocus
              aria-label={`重命名目录 ${group.workspaceName}`}
              aria-invalid={Boolean(directoryNameError) || undefined}
              onChange={(event) => { setDirectoryNameValue(event.currentTarget.value); setDirectoryNameError(""); }}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                if (!directoryRenameBusy) setRenamingDirectory(false);
              }}
            />
            {directoryNameError && <span className="workspace-task-rename-error" role="alert">{directoryNameError}</span>}
          </span>
          <WandIconButton type="submit" className="workspace-task-action confirm" disabled={directoryRenameBusy} title="保存工作区名称" aria-label="保存工作区名称">
            <WandIcon name="check" size={13}/>
          </WandIconButton>
          <WandIconButton className="workspace-task-action cancel" disabled={directoryRenameBusy} title="取消重命名" aria-label="取消重命名" onClick={() => setRenamingDirectory(false)}>
            <WandIcon name="close" size={13}/>
          </WandIconButton>
        </form>
      ) : null}
      {!preview && <SidebarRowMenu open={menuOpen} disabled={manageMode || group.global || renamingDirectory} rowRef={directoryMenuTrigger}
        onOpenChange={(next) => { if (!next || !deleting) setMenuOpen(next); }}
        label={`目录 ${group.workspaceName} 的更多操作`} title={group.workspaceName} description={shortenWorkspacePath(group.workspaceCwd)}
        error={directoryActionError} className="workspace-directory-menu"
        row={<Flex align="center" gap={4} style={{ minWidth: 0 }} className={classNames("workspace-row", renamingDirectory && "is-renaming")} hidden={renamingDirectory}>
        <WandNavigationLink style={{ flex: 1, minWidth: 0, height: "auto", whiteSpace: "normal", justifyContent: "flex-start", textAlign: "start", padding: 6 }}
          className="workspace-row-main"
          orientation="vertical"
          size="md"
          aria-expanded={manageMode ? undefined : open}
          aria-pressed={manageMode ? groupSelected : undefined}
          aria-controls={tasksId}
          title={group.global ? "这些历史任务尚未指定工作区，可在任务看板中选择工作区。" : group.workspaceCwd}
          render={<button type="button"
            onClick={manageMode ? () => onToggleGroup?.(group)
              : (event) => anchorSidebarDisclosure(event.currentTarget, () => setDirectoryOpen(!open))}
            onKeyDown={manageMode ? undefined : (event) => sidebarDisclosureKeys(event, open, setDirectoryOpen)}/>}
        >
          {manageMode && <ManageCheck checked={groupSelected} label={`选择目录 ${group.workspaceName}`}/>}
          <SidebarChevron open={open} size={16} className={classNames("workspace-row-chevron", open && "open")}/>
          <Flex vertical style={{ minWidth: 0, flex: 1 }} className="workspace-row-label">
            <Flex align="center" gap={4} style={{ minWidth: 0 }} className="workspace-row-name">
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} className="workspace-row-title">{group.workspaceName}</span>
            </Flex>
            {!group.global && <Typography.Text type="secondary" ellipsis className="workspace-row-path" title={group.workspaceCwd}
              style={{ fontSize: 12 }}>{shortenWorkspacePath(group.workspaceCwd)}</Typography.Text>}
          </Flex>
          <span className="workspace-row-count" aria-label={`${taskCount} 个任务，${group.standaloneSessions.length} 个独立会话`}>
              {taskCount + group.standaloneSessions.length}
          </span>
          <span className={`sidebar-head-activity tone-${groupActivity.tone}`} title={groupActivity.description}
            aria-label={groupActivity.description}>{groupActivity.label ? <Badge status={groupActivity.tone === "warning" ? "warning" : groupActivity.tone === "success" ? "success" : "processing"}/> : null}</span>
        </WandNavigationLink>
      </Flex>} menu={{ items: [
        { key: "new", disabled: deleting, icon: <WandIcon name="plus"/>, label: "在此新建会话" },
        ...(canRenameDirectory ? [{ key: "rename", disabled: deleting, icon: <WandIcon name="edit"/>, label: "重命名目录" }] : []),
        ...(group.tasks.some(task => task.worktree) ? [{ key: "merge", disabled: deleting, icon: <WandIcon name="merge"/>, label: "查看并合并 Worktree" }] : []),
        ...(clearSessionIds.length || canDelete ? [{ key: "danger-divider", type: "divider" as const }] : []),
        ...(clearSessionIds.length ? [{ key: "clear", disabled: deleting, danger: true, icon: <WandIcon name="terminal"/>, label: `清空所列会话（${clearSessionIds.length}）` }] : []),
        ...(canDelete ? [{ key: "delete", disabled: deleting, danger: true, icon: <WandIcon name="trash"/>, label: "删除目录…" }] : []),
      ], onClick: ({ key, domEvent }) => {
        domEvent.stopPropagation();
        if (deleting) return;
        if (key === "new") {
          setMenuOpen(false); onOpenDialog?.();
          newSessionController.open({ initialCwd: group.workspaceCwd,
            ...(group.synthetic || group.global ? {} : { workspaceId: group.workspaceId }) });
        } else if (key === "rename") {
          setMenuOpen(false); setDirectoryNameValue(group.workspaceName); setDirectoryNameError(""); setRenamingDirectory(true);
        } else if (key === "merge") { setMenuOpen(false); setWorktreeDialogOpen(true); }
        else if (key === "delete") void handleDeleteDirectory();
        else if (key === "clear") void handleClearDirectory();
      } }}/>}
      <SidebarDisclosure id={tasksId} open={open}>
        <Flex vertical gap={4} style={{ paddingInlineStart: 8 }} className="workspace-tasks">
          {taskCount === 0 && group.standaloneSessions.length === 0 && !group.synthetic && (
            <WandButton kind="ghost" size="small" className="workspaces-empty-action"
              onClick={() => { onOpenDialog?.(); newSessionController.open({
                initialCwd: group.global ? undefined : group.workspaceCwd,
                ...(group.global || group.synthetic ? {} : { workspaceId: group.workspaceId }),
              }); }}>
              <WandIcon name="plus" slot="start" size={13}/><span>创建第一个会话</span>
            </WandButton>
          )}
          {group.tasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              now={now}
              liveTitles={liveTitles}
              activeTaskId={activeTaskId}
              activeSessionId={activeSessionId}
              manageMode={manageMode}
              displayMode={displayMode}
              selected={selection?.taskIds.includes(task.id) ?? false}
              selectedSessionIds={selection ? new Set(selection.sessionIds) : undefined}
              onToggleSelect={() => onToggleTask?.(task.id)}
              onToggleSession={onToggleSession}
              onOpen={() => onActiveTaskOpen(group, task)}
              onOpenSession={(session) => onOpenSession(group, session)}
              onRequestNewSession={() => onRequestNewSessionInTask(task)}
              isOnlyTask={taskCount === 1}
              onClearSessions={async () => {
                const ids = task.sessions.map((session) => session.id);
                await handleDeleteSessions(ids, task, `已清空任务「${task.name}」的 ${ids.length} 个终端`);
              }}
              onClearTeamHistory={async (ids) => {
                await handleDeleteSessions(ids, task, `已清空任务「${task.name}」的 ${ids.length} 个已结束团队会话`);
              }}
              onDeleteSession={async (session, index) => {
                const label = sidebarSessionLabel(
                  session,
                  index ?? task.sessions.indexOf(session),
                  liveTitles?.[session.id],
                );
                await handleDeleteSessions([session.id], task, `已删除终端「${label}」`);
              }}
              onArchiveSession={handleArchiveSession}
              onRename={async (name) => {
                const updated = await httpWorkspacesRepository.updateTask(task.id, { name });
                toast(`已将任务「${task.name}」重命名为「${updated.name}」`, "success");
                await onTasksChanged();
              }}
              onMoveSession={async (sessionId) => {
                await httpWorkspacesRepository.moveSession(task.id, sessionId);
                toast(`已移入「${task.name}」，运行目录不变`, "success");
                await runtime()?.refreshSessions();
                await onTasksChanged();
              }}
              onDelete={() => handleDeleteTask(task)}
              onArchive={() => handleArchiveTask(task)}
            />
          ))}
          {group.standaloneSessions.length > 0 && (
            <div className="workspace-loose-sessions">
              {taskCount > 0 && <Typography.Text type="secondary" className="workspace-loose-label">独立会话 · {group.standaloneSessions.length}</Typography.Text>}
              <div className="workspace-loose-session-list" aria-label="独立会话">
                {group.standaloneSessions.map((session, index) => (
                  <TaskSessionItem
                    key={session.id}
                    session={session}
                    index={index}
                    liveTitle={liveTitles?.[session.id]}
                    active={activeSessionId === session.id}
                    manageMode={manageMode}
                    selected={selection?.sessionIds.includes(session.id) ?? false}
                    onToggleSelect={() => onToggleSession?.(session.id)}
                    onOpen={() => onOpenSession(group, session)}
                    onArchive={(archived) => handleArchiveSession([session.id], archived)}
                    intoNewTask={group}
                    onDelete={() => handleDeleteSessions(
                      [session.id],
                      null,
                      `已删除终端「${sidebarSessionLabel(
                        session,
                        index,
                        liveTitles?.[session.id],
                      )}」`,
                    )}
                  />
                ))}
              </div>
            </div>
          )}
          {displayMode !== "active" && group.archivedSessions && group.archivedSessions.length > 0 && (
            <ArchivedSessionsFold
              id={looseArchivedId}
              storageKey={`archived.loose.${group.workspaceId}`}
              sessions={group.archivedSessions}
              label="已归档会话"
              activeSessionId={activeSessionId}
              liveTitles={liveTitles}
              onOpen={(session) => onOpenSession(group, session)}
              onDelete={(session, index) => handleDeleteSessions(
                [session.id],
                null,
                `已删除终端「${sidebarSessionLabel(session, index, liveTitles?.[session.id])}」`,
              )}
              onArchive={(sessionId, archived) => handleArchiveSession([sessionId], archived)}
            />
          )}
        </Flex>
      </SidebarDisclosure>
      <WorkspaceWorktreeDialog
        open={worktreeDialogOpen}
        workspace={{
          id: group.workspaceId,
          name: group.workspaceName,
          cwd: group.workspaceCwd,
          layout: null,
          createdAt: "",
          lastOpenedAt: null,
        }}
        onStartAgent={handleStartMergeAgent}
        onDismiss={() => setWorktreeDialogOpen(false)}
      />
    </section>
  );
}

export function CompactDirectoryRail({
  groups,
  loading,
  error,
  activeWorkspaceId,
  peekDirectoryId,
  onExpand,
}: {
  groups: readonly TaskDirectoryGroup[];
  loading: boolean;
  error: string;
  activeWorkspaceId: string | null;
  peekDirectoryId?: string;
  onExpand(directoryId?: string): void;
}) {
  if (loading && groups.length === 0) {
    return <div className="sidebar-collapsed-tree-state" aria-label="正在加载项目">…</div>;
  }
  if (error && groups.length === 0) {
    return <div className="sidebar-collapsed-tree-state error" title={error} aria-label={error}>!</div>;
  }
  return (
    <Flex vertical align="center" gap="small" className="sidebar-collapsed-rail" aria-label="项目目录">
      {groups.map((group) => (
        <WandIconButton
          key={group.workspaceId}
          className={classNames(
            "sidebar-collapsed-rail-task",
            activeWorkspaceId === group.workspaceId && "active",
          )}
          title={group.workspaceName}
          aria-label={`查看目录 ${group.workspaceName}`}
          aria-expanded={peekDirectoryId === group.workspaceId}
          aria-controls={peekDirectoryId === group.workspaceId ? "sidebar-peek" : undefined}
          data-sidebar-directory-id={group.workspaceId}
          data-sidebar-directory-name={group.workspaceName}
          data-pressed={activeWorkspaceId === group.workspaceId || undefined}
          onClick={() => onExpand(group.workspaceId)}
        >
          <WandIcon name="folder" size={18}/>
        </WandIconButton>
      ))}
    </Flex>
  );
}
function SidebarWorkspacesPanel({
  selectedSessionId = null,
  sessionTitles = null,
  sessionTitleGenerating = null,
  extraGroups = null,
  compact = false,
  directoryId,
  peekDirectoryId,
  onExpand,
  onNavigate,
  onOpenDialog,
  searchQuery: externalQuery,
  onSearchChange: externalSearchChange,
  surfacesEnabled = true,
}: {
  selectedSessionId?: string | null;
  /** 实时会话标题（WS 已生成的命令摘要），覆盖轮询列表里的旧 title。 */
  sessionTitles?: Readonly<Record<string, string>> | null;
  /** WS 的生成状态同时覆盖目录树和最近会话，不等待列表轮询。 */
  sessionTitleGenerating?: Readonly<Record<string, boolean>> | null;
  /** 侧栏附加分组（原生历史 / 自动化等），渲染在任务列表之后。 */
  extraGroups?: React.ReactNode;
  /** 窄栏模式下保留项目 → 任务的紧凑目录层级。 */
  compact?: boolean;
  /** 悬浮树只呈现这个目录，省略全局搜索和附加分组。 */
  directoryId?: string;
  peekDirectoryId?: string;
  onExpand?: () => void;
  onNavigate?: () => void;
  onOpenDialog?: () => void;
  surfacesEnabled?: boolean;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
} = {}) {
  const popupOwner = useSidebarPopupOwner();
  const panelRef = React.useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const [fullLayerHidden, setFullLayerHidden] = React.useState(compact);
  React.useLayoutEffect(() => {
    if (!compact || reduced) setFullLayerHidden(compact);
  }, [compact, reduced]);
  const [locateDirectoryId, setLocateDirectoryId] = React.useState<string | null>(null);
  React.useLayoutEffect(() => {
    if (compact || fullLayerHidden || !locateDirectoryId) return;
    const row = panelRef.current?.querySelector<HTMLElement>(
      `[data-sidebar-tree-directory-id="${CSS.escape(locateDirectoryId)}"] .workspace-row-main`,
    );
    row?.scrollIntoView({ block: "nearest", behavior: "instant" });
    row?.focus({ preventScroll: true });
    setLocateDirectoryId(null);
  }, [compact, fullLayerHidden, locateDirectoryId]);
  // 订阅控制器：新建任务对话框关闭时刷新列表（创建后立即出现）。
  const controllerSnapshot = React.useSyncExternalStore(
    workspacesStore.subscribe,
    workspacesStore.getSnapshot,
    workspacesStore.getSnapshot,
  );
  const [refreshTick, setRefreshTick] = React.useState(0);
  const lastOpenRef = React.useRef(controllerSnapshot.open);
  React.useEffect(() => {
    // open 从 true → false：对话框刚关，可能新建了任务。
    if (lastOpenRef.current && !controllerSnapshot.open) {
      setRefreshTick((n) => n + 1);
    }
    lastOpenRef.current = controllerSnapshot.open;
  }, [controllerSnapshot.open]);

  const { groups: sourceGroups, loading, error, reload } = useTaskGroups(refreshTick);
  // Every task is a visible container, including empty and legacy unnamed tasks.
  const groups = React.useMemo(() => {
    if (!sessionTitleGenerating) return sourceGroups;
    const project = (session: WorkspaceSessionSummary): WorkspaceSessionSummary => (
      session.id in sessionTitleGenerating
        ? { ...session, titleGenerating: sessionTitleGenerating[session.id] }
        : session
    );
    return sourceGroups.map((group) => ({ ...group,
      standaloneSessions: group.standaloneSessions.map(project),
      archivedSessions: group.archivedSessions?.map(project),
      tasks: group.tasks.map((task) => ({ ...task,
        sessions: task.sessions.map(project),
        archivedSessions: task.archivedSessions?.map(project),
      })),
    }));
  }, [sourceGroups, sessionTitleGenerating]);
  // 报错只由侧栏主树上报（窄栏 rail 自己显示「!」，悬浮预览树不接管头部徽标）。
  const reportsHeaderError = !compact && directoryId === undefined;
  React.useEffect(() => {
    if (!reportsHeaderError) return;
    if (!error) {
      reportSidebarListError(null);
      return;
    }
    reportSidebarListError({
      kind: groups.length === 0 ? "load" : "sync",
      message: error,
      retry: () => reload(),
    });
  }, [reportsHeaderError, error, groups.length, reload]);
  const scope = React.useContext(SidebarPresentationContext)!;
  const { mode: displayMode, setMode: setDisplayMode } = scope;
  const searchQuery = externalQuery ?? scope.query;
  const onSearchChange = externalSearchChange ?? scope.setQuery;
  const searchedGroups = filterSidebarGroups(
    directoryId === undefined ? groups : groups.filter((group) => group.workspaceId === directoryId),
    searchQuery, sessionTitles ?? {},
  );
  const visibleGroups = displayMode === "active"
    ? filterActiveGroups(searchedGroups, selectedSessionId) : searchedGroups;

  // 活动高亮统一读 workspaceContextStore（主区标签栏与这里共用同一来源，
  // 关闭工作区窗口时这里也会同步取消高亮）。
  const activeContext = React.useSyncExternalStore(
    workspaceContextStore.subscribe,
    workspaceContextStore.getSnapshot,
    workspaceContextStore.getServerSnapshot,
  );
  const { workspaceId: activeWorkspaceId, taskId: activeTaskId } = sidebarSelection(
    groups, activeContext, selectedSessionId,
  );

  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const [view, setView] = React.useState<"directory" | "recent">(() => {
    try { return localStorage.getItem("wand.sidebar.workspaceView") === "recent" ? "recent" : "directory"; }
    catch { return "directory"; }
  });
  const [listMenuOpen, setListMenuOpen] = useSidebarPopupState();
  const [manageMode, setManageMode] = React.useState(false);
  const [manageFeedback, setManageFeedback] = React.useState<"idle" | "pending" | "done" | "error">("idle");
  const [manageFeedbackLabel, setManageFeedbackLabel] = React.useState("");
  // 失败原因只进 Toast 的话，气泡一消失就没法回看，也没法知道是哪一个环节炸了；
  // 原因放在工具条左侧文案位（.sidebar-manage-count 是可换行的文本槽，按钮位放不下整句）。
  const [manageFeedbackReason, setManageFeedbackReason] = React.useState("");
  const manageFeedbackTimer = React.useRef<number | null>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const searchButtonRef = React.useRef<HTMLButtonElement>(null);
  const searchWasVisible = React.useRef(false);
  const searchId = React.useId();
  const searchVisible = surfacesEnabled && !compact && (searchOpen || Boolean(searchQuery));
  React.useEffect(() => { if (!surfacesEnabled) setSearchOpen(false); }, [surfacesEnabled]);
  const clearManageFeedbackTimer = React.useCallback(() => {
    if (manageFeedbackTimer.current === null) return;
    window.clearTimeout(manageFeedbackTimer.current);
    manageFeedbackTimer.current = null;
  }, []);
  React.useEffect(() => clearManageFeedbackTimer, [clearManageFeedbackTimer]);
  React.useEffect(() => {
    if (searchVisible) {
      searchWasVisible.current = true;
      // The shared slot becomes visible with a transition; focus after the first visible frame.
      const frame = requestAnimationFrame(() => searchInputRef.current?.focus({ preventScroll: true }));
      return () => cancelAnimationFrame(frame);
    }
    if (!searchWasVisible.current) return;
    searchWasVisible.current = false;
    searchButtonRef.current?.focus({ preventScroll: true });
  }, [searchVisible]);
  const [selection, setSelection] = React.useState<SidebarManageSelection>(EMPTY_SIDEBAR_MANAGE_SELECTION);
  const [confirmingManage, setConfirmingManage] = React.useState<"archive" | "delete" | false>(false);
  const [manageBusy, setManageBusy] = React.useState(false);
  const prunedSelection = pruneManagedSelection(selection, visibleGroups);
  const selectedCount = sidebarManageCount(prunedSelection);
  const hasManageSessions = prunedSelection.sessionIds.length > 0;
  const visibleManaged = collectManagedIds(visibleGroups);
  const allVisibleSelected = selectedCount > 0
    && prunedSelection.taskIds.length === visibleManaged.taskIds.length
    && prunedSelection.sessionIds.length === visibleManaged.sessionIds.length;
  const exitManageMode = React.useCallback(() => {
    clearManageFeedbackTimer();
    setManageMode(false);
    setSelection(EMPTY_SIDEBAR_MANAGE_SELECTION);
    setConfirmingManage(false);
    setManageFeedback("idle");
    setManageFeedbackLabel("");
    setManageFeedbackReason("");
  }, [clearManageFeedbackTimer]);

  const openTask = React.useCallback((group: TaskDirectoryGroup, task: TaskSummary, preferredSessionId?: string): unknown => {
    onNavigate?.();
    const rt = runtime();
    if (!rt) {
      toast("工作空间运行环境尚未就绪，请刷新页面后重试。", "warning");
      return undefined;
    }
    const payload: OpenWorkspaceTaskPayload = {
      workspaceId: task.workspaceId,
      workspaceName: group.global ? "" : group.workspaceName,
      taskId: task.id,
      taskName: task.name,
      cwd: task.cwd,
    };
    if (preferredSessionId) payload.preferredSessionId = preferredSessionId;
    // 可能返回恢复完成的 Promise；调用方按需 await（见 newSessionInTask）。
    return rt.openTask(payload);
  }, [onNavigate]);

  const openSession = React.useCallback((group: TaskDirectoryGroup, session: WorkspaceSessionSummary) => {
    onNavigate?.();
    // 群聊条目不进普通会话渲染：打开独立的 IM 群聊页（复用团队页按需脚本里的 TeamChatView）。
    if (session.teamChat) {
      taskBoardController.open("", "", "teamchat", session.teamChat.runId);
      return;
    }
    const rt = runtime();
    if (!rt) {
      toast("工作空间运行环境尚未就绪，请刷新页面后重试。", "warning");
      return;
    }
    const task = findSessionTask(group, session, sourceGroups);
    if (task) {
      // 已经在这个任务里：上下文无需切换，直接选中会话。再走一次 openTask 会先
      // goHome() 把正文清空、重新拉布局与任务详情，回来后还只选中布局里存着的
      // 那个标签（点 A 先看到 B），点击感就是「要等一会才显示正文」。
      if (workspaceContextStore.getSnapshot().taskId === task.id) {
        rt.selectSession(session.id);
        return;
      }
      // 不在该任务：恢复任务时让布局直接选中点的那一个会话（openTask 内部会选中它）。
      void Promise.resolve(openTask(group, task, session.id)).then(() => rt.selectSession(session.id));
      return;
    }
    if (!group.synthetic && !group.global) {
      rt.openWorkspace({
        id: group.workspaceId,
        name: group.workspaceName,
        cwd: group.workspaceCwd,
        layout: null,
        createdAt: "",
        lastOpenedAt: null,
      });
    } else {
      rt.closeWorkspace();
    }
    rt.selectSession(session.id);
  }, [onNavigate, openTask, sourceGroups]);

  // 最近会话与目录树是同一批会话：归档 / 删除共用同一条服务端入口，不另写一套。
  const archiveListedSession = React.useCallback(async (sessionId: string, archived: boolean): Promise<void> => {
    await httpWorkspacesRepository.batchArchiveSessions([sessionId], archived);
    toast(archived
      ? "已归档会话，可在所属任务的「已归档会话」中恢复"
      : "已恢复会话", "info");
    await reload();
  }, [reload]);

  const deleteListedSession = React.useCallback(async (session: WorkspaceSessionSummary): Promise<void> => {
    const owner = sourceGroups
      .map((group) => findSessionTask(group, session, sourceGroups))
      .find(Boolean) ?? null;
    await removeSessions([session.id], owner);
    toast(`已删除会话「${sidebarSessionLabel(session, 0, sessionTitles?.[session.id])}」`, "info");
    await reload();
  }, [reload, sessionTitles, sourceGroups]);

  const sessionRefresh = React.useRef(true);
  const contacts = useSiliconEmployees();
  const { employees } = contacts;
  // 最近对话：目录树里的全部会话拍平后按归属分组（口径见 sidebar-recent.ts），
  // 搜索与「在跑」档在同一个入口过滤，再用同一份结果渲染。
  const recentEntries = React.useMemo(() => collectRecentEntries(groups), [groups]);
  const visibleRecentEntries = React.useMemo(() => filterRecentEntries(recentEntries, {
    query: searchQuery,
    employees,
    activeOnly: displayMode === "active",
    selectedSessionId,
  }), [recentEntries, searchQuery, employees, displayMode, directoryId, selectedSessionId]);
  React.useEffect(() => {
    if (sessionRefresh.current) {
      sessionRefresh.current = false;
      return;
    }
    setRefreshTick((n) => n + 1);
  }, [selectedSessionId, activeTaskId]);

  // 批量操作里任务和会话是同一套逻辑：收默认归档（软处理）、删除只作用于显式选中的终端。
  const applyManagedSelection = async (mode: "archive" | "delete"): Promise<void> => {
    if (manageBusy) return;
    const resolved = prunedSelection;
    if (sidebarManageCount(resolved) === 0) return;
    // 危险按钮只删选中的会话；若期间数据刷新把它们都挤掉了，直接在加锁前退出。
    if (mode === "delete" && resolved.sessionIds.length === 0) return;
    setManageBusy(true);
    setManageFeedback("pending");
    setManageFeedbackLabel("");
    setManageFeedbackReason("");
    try {
      if (mode === "delete") {
        const ownedTask = sourceGroups
          .flatMap((group) => group.tasks)
          .find((task) => task.sessions.some((session) => resolved.sessionIds.includes(session.id))) ?? null;
        await removeSessions(resolved.sessionIds, ownedTask);
      } else {
        for (const taskId of resolved.taskIds) {
          await httpWorkspacesRepository.archiveTask(taskId);
          if (activeTaskId === taskId) runtime()?.closeWorkspace();
        }
        if (resolved.sessionIds.length > 0) {
          await httpWorkspacesRepository.batchArchiveSessions(resolved.sessionIds, true);
          await runtime()?.refreshSessions();
        } else {
          await runtime()?.refreshSessions();
        }
      }
      const result = mode === "delete"
        ? `已删除 ${resolved.sessionIds.length} 个终端`
        : `已${describeManagedResult(resolved)}`;
      setManageFeedback("done");
      setManageFeedbackLabel(result);
      await reload();
      clearManageFeedbackTimer();
      manageFeedbackTimer.current = window.setTimeout(() => {
        manageFeedbackTimer.current = null;
        exitManageMode();
      }, MOTION_DWELL_RESULT_SENTENCE_MS);
    } catch (cause) {
      setManageFeedback("error");
      setManageFeedbackLabel("处理失败");
      setManageFeedbackReason(describeError(cause, "无法处理所选任务。"));
      clearManageFeedbackTimer();
      // 定时器只收回确认行；原因留在原位，直到下一次尝试或退出选择模式才清，
      // 否则 1.5s 的 dwell 一过，用户既看不到 Toast 也看不到为什么失败。
      manageFeedbackTimer.current = window.setTimeout(() => {
        manageFeedbackTimer.current = null;
        setConfirmingManage(false);
        setManageFeedback("idle");
        setManageFeedbackLabel("");
      }, MOTION_DWELL_FAILED_MS);
    } finally {
      setManageBusy(false);
    }
  };


  return (
    <section ref={panelRef} data-sidebar-popup-owner={popupOwner} className={classNames("workspaces-panel", compact && "workspaces-panel-compact")}
      aria-label="工作区执行会话">
      <div className="sidebar-full-list" hidden={fullLayerHidden} inert={compact} aria-hidden={compact || undefined}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === "opacity") setFullLayerHidden(compact);
        }}>
        <>
          {manageMode ? (
            <Flex align="center" wrap gap="small" className="sidebar-manage-bar" role="toolbar" aria-label="批量操作">
              <span className="sidebar-manage-count" role={manageFeedbackReason ? "alert" : undefined}>
                {manageFeedbackReason || (selectedCount > 0 ? `已选择 ${selectedCount} 项` : "点选任务或终端")}
              </span>
              <WandButton
                className="sidebar-manage-action"
                kind="ghost"
                size="small"
                disabled={manageBusy}
                onClick={() => {
                  setSelection(allVisibleSelected ? EMPTY_SIDEBAR_MANAGE_SELECTION : visibleManaged);
                  setConfirmingManage(false);
                }}
              >
                {allVisibleSelected ? "取消全选" : "全选"}
              </WandButton>
              {confirmingManage ? (
                <>
                  <WandButton className="sidebar-manage-action" kind="ghost" size="small" disabled={manageBusy} onClick={() => setConfirmingManage(false)}>返回</WandButton>
                  <WandButton
                    className={classNames("sidebar-manage-action", confirmingManage === "delete" && "danger")}
                    kind={confirmingManage === "delete" ? "danger" : "secondary"}
                    size="small"
                    aria-live="polite"
                    disabled={(manageBusy || selectedCount === 0) && manageFeedback !== "done"}
                    onClick={() => { void applyManagedSelection(confirmingManage); }}
                  >
                    {manageFeedback === "pending"
                      ? "正在处理…"
                      : manageFeedback === "done" || manageFeedback === "error"
                        ? manageFeedbackLabel
                        : confirmingManage === "delete"
                          ? `确认${describeManagedDelete(prunedSelection)}`
                          : `确认${describeManagedAction(prunedSelection)}`}
                  </WandButton>
                </>
              ) : (
                <>
                  <WandButton
                    className="sidebar-manage-action"
                    kind="secondary"
                    size="small"
                    disabled={manageBusy || selectedCount === 0}
                    onClick={() => setConfirmingManage("archive")}
                  >
                    {describeManagedAction(prunedSelection)}
                  </WandButton>
                  {hasManageSessions && (
                    <WandButton
                      className="sidebar-manage-action danger"
                      kind="danger"
                      size="small"
                      disabled={manageBusy || selectedCount === 0}
                      onClick={() => setConfirmingManage("delete")}
                    >
                      {describeManagedDelete(prunedSelection)}
                    </WandButton>
                  )}
                </>
              )}
              <WandButton className="sidebar-manage-action" kind="ghost" size="small" disabled={manageBusy} onClick={exitManageMode}>完成</WandButton>
            </Flex>
          ) : directoryId === undefined ? (
            <>
            <Flex vertical gap="small" style={{ paddingBlock: 8 }} className="sidebar-presentation-tools">
            <Flex align="center" gap={4} style={{ minWidth: 0 }} className={classNames("sidebar-list-heading", searchVisible && "is-searching")}>
              <div className="sidebar-search-slot">
              <Typography.Text strong className="sidebar-list-title" aria-hidden={searchVisible || undefined}>执行会话</Typography.Text>
              <div className="sidebar-search-expand" id={searchId} aria-hidden={!searchVisible} inert={!searchVisible || undefined}>
                <WandInput
                  ref={searchInputRef}
                  className="sidebar-search-input"
                  type="search"
                  value={searchQuery}
                  placeholder={view === "recent" ? "搜索最近会话" : "搜索工作区、任务或会话"}
                  aria-label="搜索工作区、任务或会话"
                  tabIndex={searchVisible ? 0 : -1}
                  startSlot={<WandIcon name="search" size={14}/>}
                  onChange={(event) => onSearchChange?.(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    event.stopPropagation();
                    onSearchChange?.("");
                    setSearchOpen(false);
                  }}
                />
              </div>
              </div>
              <Flex align="center" gap={4} style={{ flexShrink: 0 }} className="sidebar-list-actions">
                <WandIconButton
                  ref={searchButtonRef}
                  title={searchVisible ? "收起搜索" : "搜索任务或会话"}
                  aria-label={searchVisible ? "收起搜索" : "搜索任务或会话"}
                  aria-expanded={searchVisible}
                  aria-controls={searchId}
                  onClick={() => {
                    if (searchVisible) onSearchChange?.("");
                    setSearchOpen(!searchVisible);
                  }}
                ><ConversationMorphIcon active={searchVisible} from="search" to="close" size={16}/></WandIconButton>
                <WandPopover popupOwner={popupOwner} open={listMenuOpen} onOpenChange={setListMenuOpen} align="end"
                  ariaLabel="会话列表选项" contentRole="menu"
                  trigger={<WandIconButton title="列表选项" aria-label="会话列表选项"><WandIcon name="more" size={16}/></WandIconButton>}>
                  <Menu selectable={false} items={[
                    { key: "fold", icon: <WandIcon name="folder"/>, label: displayMode === "folded" ? "展开任务会话" : "收起任务会话" },
                    { key: "manage", icon: <WandIcon name="check"/>, label: "批量管理", disabled: loading && groups.length === 0 },
                    { key: "refresh", icon: <WandIcon name="refresh"/>, label: "刷新列表", disabled: loading },
                  ]} onClick={({ key }) => {
                    setListMenuOpen(false);
                    if (key === "fold") setDisplayMode(displayMode === "folded" ? "full" : "folded");
                    else if (key === "refresh") void reload();
                    else {
                      setManageMode(true); setSelection(EMPTY_SIDEBAR_MANAGE_SELECTION); setConfirmingManage(false);
                    }
                  }}/>
                </WandPopover>
              </Flex>
            </Flex>
            <Flex align="center" justify="space-between" gap={4} className="sidebar-display-row">
              <WandStretchTabs className="sidebar-view-switch" ariaLabel="会话组织方式"
                tabs={[{ value: "directory", label: "按工作区" }, { value: "recent", label: "最近会话" }]}
                value={view} onValueChange={(value) => {
                  setView(value as "directory" | "recent"); setListMenuOpen(false);
                  try { localStorage.setItem("wand.sidebar.workspaceView", value); } catch { /* local preference only */ }
                }}/>
              <WandButton kind={displayMode === "active" ? "soft" : "ghost"} size="small" aria-pressed={displayMode === "active"}
                aria-label="只看活动会话" title="在跑、待处理、刚完成及正在查看的会话"
                onClick={() => { setListMenuOpen(false); setDisplayMode(displayMode === "active" ? "full" : "active"); }}>
                <WandIcon name="zap" size={14}/>活动
              </WandButton>
              {loading && groups.length > 0 ? <span className="sidebar-refresh-state" role="status" title="正在同步">
                <WandIcon name="refresh" size={14}/>
              </span> : null}
            </Flex>
            </Flex>
            </>
          ) : null}
          <SidebarProjectionSwap value={`${view}:${displayMode}:${manageMode}`}>
          {directoryId === undefined ? <div hidden={manageMode || view !== "recent"} inert={manageMode || view !== "recent"}>
            <SidebarRecentSection
              entries={visibleRecentEntries}
              employees={employees}
              displayMode={displayMode}
              query={searchQuery} disabled={view !== "recent" || manageMode || !surfacesEnabled || compact}
              contactsLoading={contacts.loading} contactsError={contacts.error ? sidebarSafeError(contacts.error) : null} onReloadContacts={contacts.reload}
              listLoading={loading && groups.length === 0} listError={Boolean(error && groups.length === 0)}
              liveTitles={sessionTitles ?? {}}
              selectedSessionId={selectedSessionId}
              now={now}
              onOpen={(entry) => openSession(entry.group, entry.session)}
              onStartConversation={() => onOpenDialog?.()}
              onArchiveSession={(sessionId, archived) => archiveListedSession(sessionId, archived)}
              onDeleteSession={(session) => deleteListedSession(session)}
            />
            {!loading && !error && visibleRecentEntries.length === 0 && (searchQuery || displayMode === "active")
              ? <Typography.Paragraph type="secondary">{searchQuery ? "没有匹配的会话。" : "现在没有活动会话。"}</Typography.Paragraph> : null}
            {error && groups.length === 0 ? <WandButton kind="ghost" onClick={() => void reload()}>重新加载会话</WandButton> : null}
          </div> : null}
          <SidebarSurfacesContext.Provider value={surfacesEnabled && !compact && !manageMode && (directoryId !== undefined || view === "directory")}>
          <div hidden={directoryId === undefined && !manageMode && view !== "directory"}
            inert={directoryId === undefined && !manageMode && view !== "directory"}>
          {!loading && !error && searchQuery && visibleGroups.length === 0 ? (
            <div className="sidebar-search-empty">没有找到匹配的工作区、任务或会话。</div>
          ) : null}
          {loading && groups.length === 0 ? (
            <div aria-busy="true" role="status" aria-label="正在加载任务列表"><WandUiBoundary><Skeleton active title={false} paragraph={{ rows: 2 }}/></WandUiBoundary></div>
          ) : error && groups.length === 0 ? (
            <div className="sidebar-load-error" role="alert">
              <span>任务列表加载失败</span><p>{error}</p>
              <WandButton kind="ghost" type="button" onClick={() => void reload()}>重试</WandButton>
            </div>
          ) : !searchQuery || visibleGroups.length > 0 ? (
            <div className="sidebar-results" aria-label="目录">
            {visibleGroups.length > 0 ? (
            <Flex vertical gap={8} className="workspaces-list" aria-label="目录">
                {visibleGroups.map((group) => (
                  <TaskGroupSection
                    key={group.workspaceId}
                    group={group}
                    preview={directoryId !== undefined}
                    now={now}
                    directoryCount={visibleGroups.length}
                    liveTitles={sessionTitles ?? undefined}
                    displayMode={displayMode}
                    activeWorkspaceId={activeWorkspaceId}
                    activeTaskId={activeTaskId}
                    activeSessionId={selectedSessionId}
                    manageMode={manageMode}
                    selection={prunedSelection}
                    onToggleTask={(taskId) => setSelection((current) => toggleManagedTask(current, taskId))}
                    onToggleGroup={(selectedGroup) => {
                      setSelection((current) => toggleManagedGroup(current, selectedGroup));
                      setConfirmingManage(false);
                    }}
                    onToggleSession={(sessionId) => setSelection((current) => toggleManagedSession(current, sessionId))}
                    onActiveTaskOpen={openTask}
                    onOpenSession={openSession}
                    onRequestNewSessionInTask={(task) => {
                      onOpenDialog?.();
                      const group = groups.find((candidate) => candidate.tasks.some((item) => item.id === task.id));
                      newSessionController.open({
                        initialCwd: task.cwd || group?.workspaceCwd,
                        workspaceId: task.workspaceId,
                        workspaceTaskId: task.id,
                        taskName: task.name,
                      });
                    }}
                    onTasksChanged={reload}
                    onOpenDialog={onOpenDialog}
                  />
                ))}
            </Flex>
          ) : (
            <Flex vertical gap="small" style={{ padding: 8 }} className="workspaces-section-empty">
              {displayMode === "active" ? (
                <>
                  <span>现在没有在跑、待处理或刚完成的会话。</span>
                  <WandButton kind="ghost" size="small" className="workspaces-empty-action"
                    onClick={() => setDisplayMode("full")}>
                    <WandIcon name="eye" slot="start" size={13}/><span>显示全部任务</span>
                  </WandButton>
                </>
              ) : (
                <>
                  <span>会话按工作目录归类，也可以归入任务统一管理。</span>
                  <WandButton kind="ghost" size="small" className="workspaces-empty-action" aria-label="新建会话"
                    onClick={() => { onOpenDialog?.(); newSessionController.open(); }}>
                    <WandIcon name="plus" slot="start" size={13}/><span>开始一个会话</span>
                  </WandButton>
                </>
              )}
            </Flex>
          )}
            </div>
          ) : null}
          </div>
          </SidebarSurfacesContext.Provider>
          </SidebarProjectionSwap>
        </>
      {manageMode || directoryId !== undefined || view !== "directory" ? null : extraGroups}
      </div>
      {compact ? <CompactDirectoryRail groups={visibleGroups} loading={loading} error={error}
        activeWorkspaceId={activeWorkspaceId} peekDirectoryId={peekDirectoryId}
        onExpand={(id) => { setLocateDirectoryId(id ?? null); onExpand?.(); }}/> : null}
    </section>
  );
}

function StandaloneSidebarPanel(props: React.ComponentProps<typeof SidebarWorkspacesPanel>): React.ReactElement {
  const presentation = useSidebarPresentation();
  return <SidebarPresentationContext.Provider value={presentation}>
    <SidebarWorkspacesPanel {...props}/>
  </SidebarPresentationContext.Provider>;
}

export function WorkspacesPanel(props: React.ComponentProps<typeof SidebarWorkspacesPanel> = {}): React.ReactElement {
  const scope = React.useContext(SidebarPresentationContext);
  const owner = `sidebar-${React.useId()}`;
  return <SidebarPopupOwnerContext.Provider value={owner}>
    <SidebarSurfacesContext.Provider value={props.surfacesEnabled !== false && !props.compact}>
      {scope ? <SidebarWorkspacesPanel {...props}/> : <StandaloneSidebarPanel {...props}/>}
    </SidebarSurfacesContext.Provider>
  </SidebarPopupOwnerContext.Provider>;
}
