import * as React from "react";
import { isSessionJustCompleted } from "../../../session-completion-state.js";

import { workspacesController, workspacesStore } from "./controller";
import { httpWorkspacesRepository } from "./repository";
import { workspaceContextStore } from "./workspace-context";
import { WorkspaceAgentDialog } from "./workspace-agent-dialog";
import { WorkspaceWorktreeDialog } from "./workspace-worktree-dialog";
import type { WorkspaceMergeAgentBrief } from "./workspace-worktree-model";
import { closeSessionPane } from "./window-layout";
import type {
  OpenWorkspaceTaskPayload,
  TaskDirectoryGroup,
  TaskSummary,
  WorkspaceSessionKind,
  WorkspaceSessionSummary,
  WorkspaceSessionTarget,
} from "./types";
import { taskBoardController } from "../issues/task-board-controller";
import { classNames } from "../ui/class-names";
import { MOTION_DWELL_FAILED_MS, MOTION_DWELL_RESULT_SENTENCE_MS } from "../ui/motion-tokens";
import {
  WandButton,
  WandChip,
  WandIcon,
  WandIconButton,
  WandInput,
  WandNavigationLink,
  WandPopover,
  workspaceTaskIconName,
} from "../ui";
import { SessionProviderMark, TeamChatSessionMark } from "./session-mark";
import { sidebarSessionLabel, workspaceSessionProvider } from "./session-order";
import { SidebarDisclosure, useSidebarCollapsed } from "./sidebar-disclosure";
import {
  formatTaskRecency,
  sidebarSelection,
  taskActivity,
  taskRecency,
} from "./sidebar-task-meta";
import { filterSidebarGroups } from "./sidebar-search";
import {
  isSessionActive,
  useSidebarDisplayMode,
  filterActiveGroups,
  type SidebarDisplayMode,
} from "./sidebar-display-mode";
import {
  collectRecentEntries,
  filterRecentEntries,
  type SidebarRecentEntry,
} from "./sidebar-recent";
import { SidebarRecentSection } from "./sidebar-recent-section";
import { nonTeamSessions, splitTeamSessions } from "./team-sessions";
import {
  isDirectoryExpanded,
  isTaskSessionsExpanded,
  showsTaskSessionDisclosure,
} from "./task-tree";
import { findSessionTask } from "./session-task-lookup";
import { subscribeTaskChanges } from "../task-changes";
import { groupSessionsByArchive } from "./session-archive";
import { draggedSessionId, isSessionDrag, startSessionDrag } from "./session-drag";
import { SessionMoveButton } from "./session-move-button";
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

// ── 数据 hook：任务聚合列表（服务端已按目录组好）──

function useTaskGroups(refreshKey: number): {
  groups: TaskDirectoryGroup[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
} {
  const [groups, setGroups] = React.useState<TaskDirectoryGroup[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const generationRef = React.useRef(0);
  const revisionRef = React.useRef<string | undefined>(undefined);

  const reload = React.useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    setLoading(true);
    try {
      const page = await httpWorkspacesRepository.listTaskGroups(revisionRef.current);
      if (generation !== generationRef.current) return;
      if (page.revision) revisionRef.current = page.revision;
      if (!page.unchanged) setGroups(groupSessionsByArchive(page.groups));
      setError("");
    } catch (fetchError) {
      if (generation === generationRef.current) {
        setError(describeError(fetchError, "无法加载任务列表。"));
      }
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reload();
    const interval = window.setInterval(() => void reload(), 6_000);
    const unsubscribe = subscribeTaskChanges(() => void reload());
    return () => {
      unsubscribe();
      window.clearInterval(interval);
      generationRef.current += 1;
    };
  }, [reload, refreshKey]);

  return { groups, loading, error, reload };
}

import { useSiliconEmployees } from "../agents/employee-repository.js";
import { getEmployeePresence } from "../agents/employee-presence.js";
import { EmployeeAvatar } from "../agents/employee-avatar.js";
import { newSessionController } from "../new-session/controller.js";

function ManageCheck({
  checked,
  label,
}: {
  checked: boolean;
  label: string;
}) {
  return (
    <span className={classNames("workspace-manage-check", checked && "checked")} aria-hidden="true">
      <input type="checkbox" tabIndex={-1} checked={checked} readOnly aria-label={label}/>
      <span/>
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
  /** 归档 / 恢复：软处理，不杀终端。归档行传 false 表示恢复。 */
  onArchive?(archived: boolean): Promise<void>;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const isArchived = session.archived === true;
  const label = sidebarSessionLabel(session, index, liveTitle);
  const rowTitle = session.teamStep
    ? `${session.teamStep.teamName} · ${session.teamStep.memberName} · ${session.teamStep.title}`
    : session.cwd || session.title || session.id;
  const activate = manageMode ? (onToggleSelect ?? onOpen) : onOpen;
  const runArchive = (archived: boolean): void => {
    if (busy || !onArchive) return;
    setBusy(true);
    void onArchive(archived)
      .catch((cause) => toast(describeError(cause, archived ? "无法归档会话。" : "无法恢复会话。"), "danger"))
      .finally(() => setBusy(false));
  };

  return (
    <div className={classNames(
      "workspace-session",
      active && "active",
      isArchived && "archived",
      confirming && "confirming",
      manageMode && "managing",
      manageMode && selected && "selected",
    )}
      data-session-id={session.id}
      draggable={!manageMode && !busy && !isArchived}
      onDragStart={(event) => {
        event.stopPropagation();
        startSessionDrag(event.dataTransfer, session.id);
      }}>
      <WandNavigationLink
        className="workspace-session-main"
        orientation="vertical"
        size="sm"
        active={active}
        aria-pressed={manageMode ? selected : undefined}
        title={rowTitle}
        render={<button type="button" onClick={activate}/>}
      >
        {manageMode && <ManageCheck checked={selected} label={`选择终端 ${label}`}/>}
        <span className="workspace-session-mark" aria-hidden="true">
          {session.teamChat
            ? <TeamChatSessionMark teamChat={session.teamChat}/>
            : <SessionProviderMark session={session}/>}
        </span>
        <span className="workspace-session-name">{label}</span>
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
        {isSessionJustCompleted(session) && <span className="workspace-session-completion just-completed">刚完成</span>}
      </WandNavigationLink>
      {!manageMode && !confirming && !isArchived && <SessionMoveButton sessionId={session.id}
        taskId={session.workspaceTaskId} className="workspace-session-action"/>}
      {manageMode ? null : confirming ? (
        <span className="workspace-session-confirm">
          <WandIconButton
            className="workspace-session-action confirm"
            title="确认删除会话"
            aria-label={`确认删除会话 ${label}`}
            disabled={busy}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              void onDelete()
                .catch((cause) => {
                  toast(describeError(cause, "无法删除会话。"), "danger");
                })
                .finally(() => {
                  setBusy(false);
                  setConfirming(false);
                });
            }}
          >
            <WandIcon name="trash" size={12}/>
          </WandIconButton>
          <WandIconButton
            className="workspace-session-action cancel"
            title="取消"
            aria-label="取消删除会话"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            <WandIcon name="close" size={12}/>
          </WandIconButton>
        </span>
      ) : (
        <>
          {onArchive && (
            <WandIconButton
              className={classNames("workspace-session-action", isArchived ? "restore" : "archive")}
              title={isArchived ? "恢复会话" : "归档会话"}
              aria-label={`${isArchived ? "恢复" : "归档"}会话 ${label}`}
              disabled={busy}
              onClick={() => runArchive(!isArchived)}
            >
              <WandIcon name={isArchived ? "resume" : "archive"} size={12}/>
            </WandIconButton>
          )}
          <WandIconButton
            className="workspace-session-action delete"
            title="删除会话"
            aria-label={`删除会话 ${label}`}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            <WandIcon name="trash" size={12}/>
          </WandIconButton>
        </>
      )}
    </div>
  );
}

// ── 任务行 ──

/**
 * 「已归档」会话区：与任务的归档同一套逻辑，收起在触发点原位、可展开、可恢复。
 * 归档不是破坏性操作，所以默认不起来；删除仍需二次确认（在 TaskSessionItem 里）。
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
  const [collapsed, toggleCollapsed] = useSidebarCollapsed(storageKey, true);
  const open = !collapsed;
  if (sessions.length === 0) return null;
  return (
    <div className="workspace-archive-fold">
      <button
        type="button"
        className="workspace-archive-fold-head"
        aria-expanded={open}
        aria-controls={id}
        title={open ? `收起${label}` : `展开 ${sessions.length} 个${label}`}
        onClick={toggleCollapsed}
      >
        <WandIcon name="chevron" size={10} className={classNames("workspace-task-chevron", open && "open")}/>
        <WandIcon name="archive" size={11}/>
        <span className="workspace-archive-fold-label">{label}</span>
        <span className="workspace-archive-fold-count">{sessions.length}</span>
      </button>
      <SidebarDisclosure id={id} open={open}>
        <div className="workspace-archive-fold-list">
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
        </div>
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
  const [collapsed, toggleCollapsed] = useSidebarCollapsed(`task.${task.id}`, false);
  // 收起模式默认把终端整块折起来，用户在原位点开的那几条单独记住。
  const [expandedInFoldedMode, toggleExpandedInFoldedMode] = useSidebarCollapsed(`expandedTask.${task.id}`, false);
  // 团队派发的会话默认折起：不常驻在任务下面，点标题行才展开。
  const [teamCollapsed, toggleTeamCollapsed] = useSidebarCollapsed(`team.${task.id}`, true);
  const [teamHistoryCollapsed, toggleTeamHistoryCollapsed] = useSidebarCollapsed(`teamhistory.${task.id}`, true);
  const [dropTarget, setDropTarget] = React.useState(false);
  const [confirming, setConfirming] = React.useState<"archive" | "delete" | false>(false);
  const [taskMenuOpen, setTaskMenuOpen] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState(task.name);
  const [renameError, setRenameError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const isolated = Boolean(task.worktree);
  const isActive = activeTaskId === task.id;
  const activity = taskActivity(task);
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
  const canCollapseSessions = showsTaskSessionDisclosure(totalSessionCount);
  // 收起模式改的是「默认折哪一层」，不是锁死：点开的任务在原位展开，其余保持收起。
  const open = displayMode === "folded"
    ? (canCollapseSessions ? expandedInFoldedMode : isOnlyTask)
    : isTaskSessionsExpanded(collapsed, totalSessionCount, isOnlyTask);
  const toggleSessionsOpen = displayMode === "folded" ? toggleExpandedInFoldedMode : toggleCollapsed;
  const teamOpen = !teamCollapsed;
  const teamHistoryOpen = !teamHistoryCollapsed;
  const teamRunning = teamSplit.live.some(isSessionActive);

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

  if (renaming) {
    return (
      <form noValidate
        className="workspace-task workspace-task-rename"
        aria-busy={busy}
        onSubmit={(event) => { event.preventDefault(); void submitRename(); }}
      >
        {isolated ? (
          <span className="workspace-task-marker isolated" aria-hidden="true">
            <WandIcon name={workspaceTaskIconName(true)} size={12}/>
          </span>
        ) : null}
        <span className="workspace-task-rename-field">
          <input
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
        void onMoveSession(id).then(() => { if (collapsed) toggleCollapsed(); })
          .catch((cause) => toast(describeError(cause, "无法移动会话。"), "danger"))
          .finally(() => setBusy(false));
      }}>
      {dropTarget && <span className="workspace-task-drop-hint">移入此任务 · 运行目录不变</span>}
      <div className={classNames(
        "workspace-task",
        isActive && "active",
        !isolated && "not-isolated",
        manageMode && "managing",
        manageMode && selected && "selected",
      )}>
        <WandNavigationLink
          className="workspace-task-main"
          orientation="vertical"
          size="sm"
          active={isActive}
          aria-pressed={manageMode ? selected : undefined}
          title={`${task.name}\n${task.worktree?.path ?? task.cwd}`}
          render={<button type="button" onClick={manageMode ? (onToggleSelect ?? onOpen) : onOpen}/>}
        >
          {manageMode && <ManageCheck checked={selected} label={`选择任务 ${task.name}`}/>}
          {isolated ? (
            <span className="workspace-task-marker isolated" title="隔离 worktree" aria-label="隔离 worktree">
              <WandIcon name={workspaceTaskIconName(true)} size={12}/>
            </span>
          ) : null}
          <span className="workspace-task-name">{task.name}</span>
        </WandNavigationLink>
        {activity ? (
          <span className={classNames("workspace-task-activity", activity)}>
            <span aria-hidden="true"/>{activity === "attention" ? "待处理" : "运行中"}
          </span>
        ) : (
          <time className="workspace-task-time" dateTime={taskRecency(task)} title={taskRecency(task)}>
            {formatTaskRecency(taskRecency(task), now)}
          </time>
        )}
        <span className="workspace-task-meta">
          {canCollapseSessions ? (
            <WandChip
              className="workspace-task-chevron-btn"
              size="sm"
              variant={open ? "secondary" : "soft"}
              aria-label={open ? `收起任务 ${task.name} 的终端` : `展开任务 ${task.name} 的终端`}
              aria-expanded={open}
              aria-controls={sessionsId}
              title={open ? "收起终端" : "展开终端"}
              onClick={toggleCollapsed}
            >
              <span className="workspace-task-count">{totalSessionCount}</span>
              <WandIcon name="chevron" size={10} className={classNames("workspace-task-chevron", open && "open")}/>
            </WandChip>
          ) : null}
        </span>
        {manageMode ? null : !confirming ? (
          <>
            {/* 行内「＋」是常驻的新增会话入口；空任务只有作为唯一任务时才额外显示下方整行按钮。 */}
            <WandIconButton
              className="workspace-task-action add"
              title={`新建会话（${task.name}）`}
              aria-label={`在任务 ${task.name} 中新建会话`}
              disabled={busy}
              onClick={() => onRequestNewSession()}
            >
              <WandIcon name="plus" size={13}/>
            </WandIconButton>
            <WandPopover
              open={taskMenuOpen}
              onOpenChange={setTaskMenuOpen}
              align="end"
              sideOffset={5}
              contentRole="menu"
              ariaLabel={`任务 ${task.name} 的更多操作`}
              className="workspace-task-menu"
              trigger={(
                <WandIconButton
                  className="workspace-task-action more"
                  title="更多任务操作"
                  aria-label={`任务 ${task.name} 的更多操作`}
                  disabled={busy}
                >
                  <WandIcon name="more" size={13}/>
                </WandIconButton>
              )}
            >
              <button
                type="button"
                role="menuitem"
                className="workspace-task-menu-item"
                onClick={() => {
                  setTaskMenuOpen(false);
                  onRequestNewSession();
                }}
              >
                <WandIcon name="plus" size={13}/><span>新建会话</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="workspace-task-menu-item"
                onClick={() => {
                  setTaskMenuOpen(false);
                  setRenameValue(task.name);
                  setRenameError("");
                  setRenaming(true);
                }}
              >
                <WandIcon name="edit" size={13}/>
                <span>重命名任务</span>
              </button>
              <ClearSessionsButton menuItem count={sessionCount} label={`任务「${task.name}」`} onClear={onClearSessions}/>
              <button
                type="button"
                role="menuitem"
                className="workspace-task-menu-item"
                onClick={() => {
                  setTaskMenuOpen(false);
                  setConfirming("archive");
                }}
              >
                <WandIcon name="archive" size={13}/>
                <span>{isolated ? "归档任务（保留 Worktree）" : "归档任务"}</span>
              </button>
              {isolated ? (
                <button
                  type="button"
                  role="menuitem"
                  className="workspace-task-menu-item danger"
                  onClick={() => {
                    setTaskMenuOpen(false);
                    setConfirming("delete");
                  }}
                >
                  <WandIcon name="trash" size={13}/>
                  <span>删除任务并清理 Worktree</span>
                </button>
              ) : null}
            </WandPopover>
          </>
        ) : (
          <span className="workspace-task-confirm">
            <WandIconButton
              className="workspace-task-action confirm"
              title={confirming === "archive" ? "确认归档任务" : "确认删除任务并清理 Worktree"}
              aria-label={confirming === "archive" ? `确认归档任务 ${task.name}` : `确认删除任务 ${task.name}`}
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                try {
                  if (confirming === "archive") await onArchive();
                  else await onDelete();
                } catch (cause) {
                  toast(describeError(cause, confirming === "archive" ? "无法归档任务。" : "无法删除任务。"), "danger");
                } finally {
                  setBusy(false);
                  setConfirming(false);
                }
              }}
            >
              <WandIcon name={confirming === "archive" ? "archive" : "trash"} size={13}/>
            </WandIconButton>
            <WandIconButton
              className="workspace-task-action cancel"
              title="取消"
              aria-label={confirming === "archive" ? "取消归档任务" : "取消删除任务"}
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              <WandIcon name="close" size={13}/>
            </WandIconButton>
          </span>
        )}
      </div>
      {open && totalSessionCount === 0 && !manageMode && <button type="button" className="workspace-task-empty"
        onClick={onRequestNewSession}><WandIcon name="plus" size={12}/>添加会话，或拖入已有会话</button>}
      {totalSessionCount > 0 && (
        <SidebarDisclosure id={sessionsId} open={open}>
          <div className="workspace-task-sessions">
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
              <button
                type="button"
                className="workspace-team-fold-head"
                aria-expanded={teamOpen}
                aria-controls={teamId}
                title={teamOpen ? "收起团队会话" : `展开任务「${task.name}」的 ${teamCount} 个团队会话`}
                onClick={toggleTeamCollapsed}
              >
                <WandIcon name="chevron" size={10} className={classNames("workspace-task-chevron", teamOpen && "open")}/>
                <span className="workspace-team-fold-label">团队会话</span>
                {teamRunning ? (
                  <span className="workspace-task-activity running"><span aria-hidden="true"/>运行中</span>
                ) : null}
                <span className="workspace-team-fold-count">{teamCount}</span>
              </button>
              <SidebarDisclosure id={teamId} open={teamOpen}>
                <div className="workspace-team-fold-list">
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
                      <div className="workspace-team-history-head">
                        <button
                          type="button"
                          className="workspace-team-fold-head is-nested"
                          aria-expanded={teamHistoryOpen}
                          aria-controls={teamHistoryId}
                          title={teamHistoryOpen ? "收起已结束的团队会话" : `展开 ${teamSplit.history.length} 个已结束的团队会话`}
                          onClick={toggleTeamHistoryCollapsed}
                        >
                          <WandIcon name="chevron" size={10} className={classNames("workspace-task-chevron", teamHistoryOpen && "open")}/>
                          <span className="workspace-team-fold-label">已结束</span>
                          <span className="workspace-team-fold-count">{teamSplit.history.length}</span>
                        </button>
                        <ClearSessionsButton
                          count={teamSplit.history.length}
                          label={`任务「${task.name}」已结束的团队会话`}
                          detail={`将删除这一轮协作留下的 ${teamSplit.history.length} 个成员会话，你自己的会话和任务都会保留。`}
                          onClear={() => onClearTeamHistory(teamSplit.history.map((session) => session.id))}
                        />
                      </div>
                      <SidebarDisclosure id={teamHistoryId} open={teamHistoryOpen}>
                        <div className="workspace-team-fold-list">
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
                        </div>
                      </SidebarDisclosure>
                    </div>
                  )}
                </div>
              </SidebarDisclosure>
            </div>
          )}

          </div>
        </SidebarDisclosure>
      )}
      {archivedSessions.length > 0 && (
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
    </div>
  );
}

function ClearSessionsButton({ count, label, onClear, menuItem = false, detail }: {
  count: number;
  label: string;
  onClear(): Promise<void>;
  menuItem?: boolean;
  /** 覆盖确认文案的第二行；默认说明会连正在运行的会话一起删。 */
  detail?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const unit = detail ? "会话" : "终端";
  if (count === 0) return null;
  return (
    <WandPopover
      open={open}
      onOpenChange={(next) => { if (!busy) setOpen(next); }}
      align="end"
      ariaLabel={`清空${label}的${unit}`}
      className="workspace-clear-popover"
      trigger={(
        menuItem ? (
          <button type="button" role="menuitem"
            className="workspace-task-menu-item danger" title={`清空${label}的 ${count} 个${unit}`}
            aria-label={`清空${label}的 ${count} 个${unit}`}>
            <WandIcon name="terminal" size={13}/>
            <span>清空{unit}（{count}）</span>
          </button>
        ) : (
          <WandIconButton
            className="workspace-row-action clear"
            title={`清空${label}的 ${count} 个${unit}`}
            aria-label={`清空${label}的 ${count} 个${unit}`}>
            <WandIcon name="terminal" size={13}/>
          </WandIconButton>
        )
      )}
    >
      <strong>清空{label}的{unit}？</strong>
      <p>{detail ?? `将删除全部 ${count} 个终端，包括正在运行的会话。任务和项目会保留。`}</p>
      <div className="workspace-clear-popover-actions">
        <WandButton kind="ghost" size="small" disabled={busy} onClick={() => setOpen(false)}>取消</WandButton>
        <WandButton kind="danger" size="small" disabled={busy} onClick={async () => {
          if (busy) return;
          setBusy(true);
          try {
            await onClear();
            setOpen(false);
          } catch (cause) {
            toast(describeError(cause, "无法清空终端。"), "danger");
          } finally {
            setBusy(false);
          }
        }}>{busy ? "正在清空…" : "确认清空"}</WandButton>
      </div>
    </WandPopover>
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
  const [collapsed, toggleCollapsed] = useSidebarCollapsed(`project.${group.workspaceId}`);
  const [looseCollapsed, toggleLooseCollapsed] = useSidebarCollapsed(`loose.${group.workspaceId}`);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [renamingDirectory, setRenamingDirectory] = React.useState(false);
  const [directoryNameValue, setDirectoryNameValue] = React.useState(group.workspaceName);
  const [directoryNameError, setDirectoryNameError] = React.useState("");
  const [directoryRenameBusy, setDirectoryRenameBusy] = React.useState(false);
  const tasksId = React.useId();
  const looseArchivedId = React.useId();
  const open = preview || isDirectoryExpanded(collapsed, directoryCount);
  const looseOpen = !looseCollapsed;
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
    if (activeTaskId === task.id) runtime()?.closeWorkspace();
    toast(`已归档任务「${task.name}」，可在任务看板的归档任务中恢复。`, "info");
    await onTasksChanged();
  };

  const handleDeleteTask = async (task: TaskSummary) => {
    await httpWorkspacesRepository.deleteTask(task.id, true);
    await runtime()?.refreshSessions();
    if (activeTaskId === task.id) runtime()?.closeWorkspace();
    toast(`已删除任务「${task.name}」`, "info");
    await onTasksChanged();
  };

  const handleDeleteDirectory = async () => {
    if (!canDelete || deleting) return;
    setDeleting(true);
    try {
      await httpWorkspacesRepository.remove(group.workspaceId, true);
      await runtime()?.refreshSessions();
      if (activeWorkspaceId === group.workspaceId) runtime()?.closeWorkspace();
      toast(`已删除目录「${group.workspaceName}」`, "info");
      await onTasksChanged();
    } catch (cause) {
      toast(describeError(cause, "无法删除目录。"), "danger");
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
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

  // 会话归档与任务归档同一套逻辑：软处理（不杀终端）、可恢复，7 天后由保留期清理。
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

  return (
    <section
      className={classNames(
        "workspace-item",
        group.global && "workspace-global-tasks",
        open && "is-open",
        group.synthetic && "is-synthetic",
        activeWorkspaceId === group.workspaceId && "active-workspace",
      )}
    >
      {renamingDirectory ? (
        <form noValidate
          className="workspace-row-rename"
          aria-busy={directoryRenameBusy}
          onSubmit={(event) => { event.preventDefault(); void submitDirectoryRename(); }}
        >
          <WandIcon name="folder" size={15} className="workspace-row-folder"/>
          <span className="workspace-task-rename-field">
            <input
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
      {!preview && <div className={classNames("workspace-row", renamingDirectory && "is-renaming")}>
        <WandNavigationLink
          className="workspace-row-main"
          orientation="vertical"
          size="md"
          aria-expanded={manageMode ? undefined : open}
          aria-pressed={manageMode ? groupSelected : undefined}
          aria-controls={tasksId}
          title={group.global ? "这些历史任务尚未指定工作区，可在任务看板中选择工作区。" : group.workspaceCwd}
          render={<button type="button" onClick={manageMode ? () => onToggleGroup?.(group) : toggleCollapsed}/>}
        >
          {manageMode && <ManageCheck checked={groupSelected} label={`选择目录 ${group.workspaceName}`}/>}
          {/* 目录行保留文件夹图标：它是「这一行是工作目录」的唯一视觉标记。 */}
          <WandIcon name="folder" size={15} className="workspace-row-folder"/>
          <span className="workspace-row-label">
            <span className="workspace-row-name">
              <span className="workspace-row-title">{group.workspaceName}</span>
              {group.synthetic ? <span className="workspace-row-flag">未归档</span> : null}
            </span>
          </span>
          {taskCount > 0 ? (
            <span className="workspace-row-count" aria-label={`${taskCount} 项任务`}>
              {taskCount}
            </span>
          ) : null}
          {!manageMode && <WandIcon name="chevron" size={11} className={classNames("workspace-row-chevron", open && "open")}/>}
        </WandNavigationLink>
        {manageMode || group.global ? null : <span className="workspace-row-actions">
          {!group.synthetic && (
            <WandIconButton
              className="workspace-row-action add"
              title={`在 ${group.workspaceName} 新建任务`}
              aria-label={`在${group.global ? "独立任务" : "目录"} ${group.workspaceName} 新建任务`}
              onClick={(event) => {
                event.stopPropagation();
                workspacesController.open(group.global ? undefined : group.workspaceCwd);
              }}
            >
              <WandIcon name="plus" size={14}/>
            </WandIconButton>
          )}
          <WandPopover
            open={menuOpen}
            onOpenChange={(next) => { if (!deleting) { setMenuOpen(next); setConfirmingDelete(false); } }}
            align="end"
            contentRole="menu"
            ariaLabel={`目录 ${group.workspaceName} 的更多操作`}
            className="workspace-task-menu"
            trigger={(
              <WandIconButton className="workspace-row-action more"
                title="更多目录操作" aria-label={`目录 ${group.workspaceName} 的更多操作`}>
                <WandIcon name="more" size={14}/>
              </WandIconButton>
            )}
          >
          <div className="workspace-menu-context" title={group.workspaceCwd}>{shortenWorkspacePath(group.workspaceCwd)}</div>
          {canRenameDirectory ? (
            <button
              type="button"
              role="menuitem"
              className="workspace-task-menu-item"
              title={`重命名目录 ${group.workspaceName}`}
              aria-label={`重命名目录 ${group.workspaceName}`}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                setDirectoryNameValue(group.workspaceName);
                setDirectoryNameError("");
                setRenamingDirectory(true);
              }}
            >
              <WandIcon name="edit" size={13}/><span>重命名目录</span>
            </button>
          ) : null}
          <ClearSessionsButton
            menuItem
            count={new Set([...group.tasks.flatMap((task) => task.sessions.map((session) => session.id)),
              ...group.standaloneSessions.map((session) => session.id)]).size}
            label={`目录「${group.workspaceName}」`}
            onClear={async () => {
              const context = workspaceContextStore.getSnapshot();
              const activeTask = group.tasks.find((task) => task.id === context.taskId) ?? null;
              const ids = [...group.tasks.flatMap((task) => task.sessions.map((session) => session.id)),
                ...group.standaloneSessions.map((session) => session.id)];
              await handleDeleteSessions(ids, activeTask, `已清空目录「${group.workspaceName}」的终端`);
            }}
          />
          {group.tasks.some((task) => task.worktree) && (
            <button
              type="button"
              role="menuitem"
              className="workspace-task-menu-item"
              title="查看并合并 Worktree"
              aria-label={`${group.workspaceName} 的 Worktree 合并视图`}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                setWorktreeDialogOpen(true);
              }}
            >
              <WandIcon name="merge" size={13}/><span>查看并合并 Worktree</span>
            </button>
          )}
          {canDelete && !confirmingDelete ? (
            <button
              type="button"
              role="menuitem"
              className="workspace-task-menu-item danger"
              title={`删除目录 ${group.workspaceName}`}
              aria-label={`删除目录 ${group.workspaceName}`}
              disabled={deleting}
              onClick={(event) => {
                event.stopPropagation();
                setConfirmingDelete(true);
              }}
            >
              <WandIcon name="trash" size={13}/><span>删除目录</span>
            </button>
          ) : null}
          {canDelete && confirmingDelete ? (
            <div className="workspace-menu-confirm">
              <p>删除「{group.workspaceName}」及其全部任务、终端和任务 Worktree？</p>
              <button
                type="button"
                className="workspace-task-menu-item danger"
                title="确认删除目录及其任务"
                aria-label={`确认删除目录 ${group.workspaceName}`}
                disabled={deleting}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDeleteDirectory();
                }}
              >
                <WandIcon name="trash" size={13}/><span>{deleting ? "正在删除…" : "确认删除目录"}</span>
              </button>
              <button
                type="button"
                className="workspace-task-menu-item"
                title="取消删除"
                aria-label="取消删除目录"
                disabled={deleting}
                onClick={(event) => {
                  event.stopPropagation();
                  setConfirmingDelete(false);
                }}
              >
                <WandIcon name="close" size={13}/><span>取消</span>
              </button>
            </div>
          ) : null}
          </WandPopover>
        </span>}
      </div>}
      <SidebarDisclosure id={tasksId} open={open}>
        <div className="workspace-tasks">
          {taskCount === 0 && group.standaloneSessions.length === 0 && !group.synthetic && (
            <WandButton kind="ghost" size="small" className="workspaces-empty-action"
              onClick={() => { onOpenDialog?.(); workspacesController.open(group.global ? undefined : group.workspaceCwd); }}>
              <WandIcon name="plus" slot="start" size={13}/><span>创建第一个任务</span>
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
            <details
              className="workspace-loose-sessions"
              open={looseOpen}
              onToggle={(event) => {
                if (event.currentTarget.open === looseOpen) return;
                toggleLooseCollapsed();
              }}
            >
              <summary>未分组会话（{group.standaloneSessions.length}）</summary>
              <div className="workspace-loose-session-list">
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
            </details>
          )}
          {group.archivedSessions && group.archivedSessions.length > 0 && (
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
        </div>
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
  onExpand(): void;
}) {
  if (loading && groups.length === 0) {
    return <div className="sidebar-collapsed-tree-state" aria-label="正在加载项目">…</div>;
  }
  if (error && groups.length === 0) {
    return <div className="sidebar-collapsed-tree-state error" title={error} aria-label={error}>!</div>;
  }
  return (
    <div className="sidebar-collapsed-rail" aria-label="项目目录">
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
          onClick={() => {
            if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) onExpand();
          }}
        >
          <WandIcon name="folder" size={18}/>
        </WandIconButton>
      ))}
    </div>
  );
}
export function WorkspacesPanel({
  selectedSessionId = null,
  sessionTitles = null,
  extraGroups = null,
  compact = false,
  directoryId,
  peekDirectoryId,
  onExpand,
  onNavigate,
  onOpenDialog,
  searchQuery = "",
  onSearchChange,
}: {
  selectedSessionId?: string | null;
  /** 实时会话标题（WS 已生成的命令摘要），覆盖轮询列表里的旧 title。 */
  sessionTitles?: Readonly<Record<string, string>> | null;
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
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
} = {}) {
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
  const groups = sourceGroups;
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
  const [displayMode, cycleDisplayMode, setDisplayMode] = useSidebarDisplayMode();
  const searchedGroups = filterSidebarGroups(
    directoryId === undefined ? groups : groups.filter((group) => group.workspaceId === directoryId),
    directoryId === undefined ? searchQuery : "",
    sessionTitles ?? {},
  );
  // 只看活动：没有会话在动的任务整条不显示（正在看的那条始终保留）。
  const visibleGroups = displayMode === "active" && directoryId === undefined
    ? filterActiveGroups(searchedGroups, selectedSessionId)
    : searchedGroups;

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
  // 任务行「＋」的 Agent 选择器：先记下目标任务，确认后在该任务目录内新建会话。
  const [pendingNewSessionTask, setPendingNewSessionTask] = React.useState<TaskSummary | null>(null);
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
  const searchVisible = searchOpen || Boolean(searchQuery);
  const clearManageFeedbackTimer = React.useCallback(() => {
    if (manageFeedbackTimer.current === null) return;
    window.clearTimeout(manageFeedbackTimer.current);
    manageFeedbackTimer.current = null;
  }, []);
  React.useEffect(() => clearManageFeedbackTimer, [clearManageFeedbackTimer]);
  React.useEffect(() => {
    if (searchVisible) {
      searchInputRef.current?.focus();
      searchWasVisible.current = true;
      return;
    }
    if (!searchWasVisible.current) return;
    searchWasVisible.current = false;
    searchButtonRef.current?.focus();
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
    }
    rt.selectSession(session.id);
  }, [onNavigate, openTask, sourceGroups]);

  const newSessionInTask = React.useCallback(async (
    group: TaskDirectoryGroup,
    task: TaskSummary,
    target: WorkspaceSessionTarget,
    kind: WorkspaceSessionKind,
    model: string,
    employeeId?: string,
  ) => {
    const rt = runtime();
    if (!rt) throw new Error("工作空间运行环境尚未就绪，请刷新页面后重试。");
    // 先等任务上下文/布局恢复完成，再建会话：否则恢复流程会用旧快照
    // 覆盖新会话的选中态（切片6 #6 竞态）。
    await Promise.resolve(openTask(group, task));
    await rt.newTaskSession({
      workspaceId: task.workspaceId,
      taskId: task.id,
      cwd: task.cwd,
      target,
      kind,
      model: model || undefined,
      employeeId,
    });
    toast(employeeId ? "已开始员工对话" : target === "shell" ? "已在该任务中新建空白终端" : "已在该任务中新建会话", "success");
    await reload();
  }, [openTask, reload]);

  const sessionRefresh = React.useRef(true);
  const { employees } = useSiliconEmployees();
  // 最近对话：目录树里的全部会话拍平后按归属分组（口径见 sidebar-recent.ts），
  // 搜索与「在跑」档在同一个入口过滤，再用同一份结果渲染。
  const recentEntries = React.useMemo(() => collectRecentEntries(sourceGroups), [sourceGroups]);
  const treeTaskCount = React.useMemo(
    () => visibleGroups.reduce((total, group) => total + group.tasks.length, 0),
    [visibleGroups],
  );
  const visibleRecentEntries = React.useMemo(() => filterRecentEntries(recentEntries, {
    query: searchQuery,
    employees,
    activeOnly: displayMode === "active" && directoryId === undefined,
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

  if (compact) {
    return (
      <section className="workspaces-panel workspaces-panel-compact" aria-label="对话与项目目录">
        <CompactDirectoryRail
          groups={visibleGroups}
          loading={loading}
          error={error}
          activeWorkspaceId={activeWorkspaceId}
          peekDirectoryId={peekDirectoryId}
          onExpand={() => onExpand?.()}
        />
      </section>
    );
  }

  return (
    <section className="workspaces-panel" aria-label="对话与任务">
        {loading && groups.length === 0 ? (
        <div className="workspaces-panel-state">正在加载任务…</div>
      ) : (
        <>
          {manageMode ? (
            <div className="sidebar-manage-bar" role="toolbar" aria-label="批量操作">
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
            </div>
          ) : directoryId === undefined ? (
            <>
            <div className={classNames("sidebar-list-heading", searchVisible && "is-searching")}>
              <h2 aria-hidden={searchVisible || undefined}>对话与任务</h2>
              <div className="sidebar-search-expand" id={searchId} inert={!searchVisible || undefined}>
                <WandInput
                  ref={searchInputRef}
                  className="sidebar-search-input"
                  type="search"
                  value={searchQuery}
                  placeholder="搜索联系人、任务或会话"
                  aria-label="搜索联系人、任务或会话"
                  tabIndex={searchVisible ? 0 : -1}
                  clearable
                  startSlot={<WandIcon name="search" size={14}/>}
                  onClear={() => onSearchChange?.("")}
                  onChange={(event) => onSearchChange?.(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    onSearchChange?.("");
                    setSearchOpen(false);
                  }}
                />
              </div>
              <div className="sidebar-list-actions">
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
                ><WandIcon name={searchVisible ? "close" : "search"} size={15}/></WandIconButton>
                <WandIconButton
                  className="sidebar-manage-toggle"
                  title="批量管理"
                  aria-label="多选任务和终端"
                  onClick={() => {
                    setManageMode(true);
                    setSelection(EMPTY_SIDEBAR_MANAGE_SELECTION);
                    setConfirmingManage(false);
                  }}
                ><WandIcon name="check" size={15}/></WandIconButton>
              </div>
            </div>
            <SidebarRecentSection
              entries={visibleRecentEntries}
              employees={employees}
              displayMode={displayMode}
              onSelectMode={setDisplayMode}
              liveTitles={sessionTitles ?? {}}
              selectedSessionId={selectedSessionId}
              now={now}
              onOpen={(entry) => openSession(entry.group, entry.session)}
              onStartConversation={() => onNavigate?.()}
            />
            <div className="sidebar-section-head sidebar-section-head-tree">
              <h3 className="sidebar-section-title">任务与工作区</h3>
              <span className="sidebar-section-count">{treeTaskCount} 个任务</span>
            </div>
            </>
          ) : null}
          {searchQuery && visibleGroups.length === 0 && visibleRecentEntries.length === 0 ? (
            <div className="sidebar-search-empty">没有找到匹配的联系人、任务或会话。</div>
          ) : null}
          {!searchQuery || visibleGroups.length > 0 ? (
            <div className="sidebar-results" aria-label="目录">
            {visibleGroups.length > 0 ? (
            <div className="workspaces-list" aria-label="目录">
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
                    onRequestNewSessionInTask={(task) => { onOpenDialog?.(); setPendingNewSessionTask(task); }}
                    onTasksChanged={reload}
                    onOpenDialog={onOpenDialog}
                  />
                ))}
            </div>
          ) : (
            <div className="workspaces-section-empty">
              {displayMode === "active" ? (
                <>
                  <span>现在没有在运行或等你处理的会话。</span>
                  <WandButton kind="ghost" size="small" className="workspaces-empty-action"
                    onClick={cycleDisplayMode}>
                    <WandIcon name="eye" slot="start" size={13}/><span>显示全部任务</span>
                  </WandButton>
                </>
              ) : (
                <>
                  <span>按目录查看任务，任务下面是执行过的会话。</span>
                  <WandButton kind="ghost" size="small" className="workspaces-empty-action" aria-label="新建任务"
                    onClick={() => { onOpenDialog?.(); workspacesController.open(); }}>
                    <WandIcon name="plus" slot="start" size={13}/><span>开始一个任务</span>
                  </WandButton>
                </>
              )}
            </div>
          )}
            </div>
          ) : null}
        </>
      )}
      {manageMode || directoryId !== undefined ? null : extraGroups}
      {pendingNewSessionTask !== null ? (
        <WorkspaceAgentDialog
          open
          key={pendingNewSessionTask.id}
          onConfirm={(target, kind, model, employeeId) => {
            const task = pendingNewSessionTask;
            const group = groups.find((candidate) => candidate.tasks.some((item) => item.id === task.id));
            setPendingNewSessionTask(null);
            if (!task || !group) return;
            void newSessionInTask(group, task, target, kind, model, employeeId).catch((cause) => {
              toast(describeError(cause, "无法在任务中新建会话。"), "danger");
            });
          }}
          onDismiss={() => setPendingNewSessionTask(null)}
        />
      ) : null}
    </section>
  );
}
