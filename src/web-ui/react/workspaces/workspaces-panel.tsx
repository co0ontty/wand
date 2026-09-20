import * as React from "react";

import { workspacesController, workspacesStore } from "./controller";
import { httpWorkspacesRepository } from "./repository";
import { workspaceContextStore } from "./workspace-context";
import { WorkspaceAgentDialog } from "./workspace-agent-dialog";
import { WorkspaceWorktreeDialog } from "./workspace-worktree-dialog";
import { closeSessionPane } from "./window-layout";
import type {
  OpenWorkspaceTaskPayload,
  TaskDirectoryGroup,
  TaskSummary,
  WorkspaceSessionKind,
  WorkspaceSessionTarget,
  WorkspaceSessionSummary,
} from "./types";
import { classNames } from "../ui/class-names";
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
import { SessionProviderMark } from "./session-mark";
import { listSessionLabel, withLiveSessionTitle } from "./session-order";
import { SidebarDisclosure, useSidebarCollapsed } from "./sidebar-disclosure";
import {
  formatTaskRecency,
  sidebarSelection,
  taskActivity,
  taskRecency,
} from "./sidebar-task-meta";
import { filterSidebarGroups } from "./sidebar-search";
import {
  isDirectoryExpanded,
  isTaskSessionsExpanded,
  showsTaskSessionDisclosure,
} from "./task-tree";
import { findSessionTask } from "./session-task-lookup";
import { subscribeTaskChanges } from "../task-changes";
import { draggedSessionId, isSessionDrag, startSessionDrag } from "./session-drag";
import { SessionMoveButton } from "./session-move-button";
import {
  EMPTY_SIDEBAR_MANAGE_SELECTION,
  collectManagedIds,
  describeManagedAction,
  describeManagedResult,
  isManagedGroupSelected,
  managedSelectionIsDestructive,
  pruneManagedSelection,
  sidebarManageCount,
  toggleManagedGroup,
  toggleManagedSession,
  toggleManagedTask,
  type SidebarManageSelection,
} from "./sidebar-manage";
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

export function workspacePathLeaf(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) || normalized || path;
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
      if (!page.unchanged) setGroups(page.groups);
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

// ── 会话行（任务内 / 未分组的会话共用）──

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
  parentNames,
  liveTitle,
  active,
  manageMode = false,
  selected = false,
  onToggleSelect,
  onOpen,
  onDelete,
}: {
  session: WorkspaceSessionSummary;
  index: number;
  parentNames?: readonly string[];
  liveTitle?: string;
  active: boolean;
  manageMode?: boolean;
  selected?: boolean;
  onToggleSelect?(): void;
  onOpen(): void;
  onDelete(): Promise<void>;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const labeled = withLiveSessionTitle(session, liveTitle, parentNames);
  const label = listSessionLabel(labeled, index, parentNames);
  const activate = manageMode ? (onToggleSelect ?? onOpen) : onOpen;

  return (
    <div className={classNames(
      "workspace-session",
      active && "active",
      confirming && "confirming",
      manageMode && "managing",
      manageMode && selected && "selected",
    )}
      data-session-id={session.id}
      draggable={!manageMode && !busy}
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
        title={session.cwd || session.title || session.id}
        render={<button type="button" onClick={activate}/>}
      >
        {manageMode && <ManageCheck checked={selected} label={`选择终端 ${label}`}/>}
        <span className="workspace-session-mark" aria-hidden="true">
          <SessionProviderMark session={session}/>
        </span>
        <span className="workspace-session-name">{label}</span>
        {session.sessionKind === "pty" && (
          <span className="workspace-session-kind">终端</span>
        )}
      </WandNavigationLink>
      {!manageMode && !confirming && <SessionMoveButton sessionId={session.id}
        taskId={session.workspaceTaskId} className="workspace-session-action"/>}
      {manageMode ? null : confirming ? (
        <span className="workspace-session-confirm">
          <WandIconButton
            className="workspace-session-action confirm"
            title="确认删除终端"
            aria-label={`确认删除终端 ${label}`}
            disabled={busy}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              void onDelete()
                .catch((cause) => {
                  toast(describeError(cause, "无法删除终端。"), "danger");
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
            aria-label="取消删除终端"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            <WandIcon name="close" size={12}/>
          </WandIconButton>
        </span>
      ) : (
        <WandIconButton
          className="workspace-session-action delete"
          title="删除终端"
          aria-label={`删除终端 ${label}`}
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          <WandIcon name="trash" size={12}/>
        </WandIconButton>
      )}
    </div>
  );
}

// ── 任务行 ──

function TaskItem({
  task,
  now,
  parentNames,
  liveTitles,
  activeTaskId,
  activeSessionId,
  manageMode = false,
  selected = false,
  selectedSessionIds,
  onToggleSelect,
  onToggleSession,
  onOpen,
  onOpenSession,
  onRequestNewSession,
  onClearSessions,
  onDeleteSession,
  onRename,
  onArchive,
  onDelete,
  onMoveSession,
}: {
  task: TaskSummary;
  now: number;
  parentNames: readonly string[];
  liveTitles?: Readonly<Record<string, string>>;
  activeTaskId: string | null;
  activeSessionId: string | null;
  manageMode?: boolean;
  selected?: boolean;
  selectedSessionIds?: ReadonlySet<string>;
  onToggleSelect?(): void;
  onToggleSession?(sessionId: string): void;
  onOpen(): void;
  onOpenSession(session: WorkspaceSessionSummary): void;
  /** 请求在该任务中新建会话；由上层弹出 Agent 选择器后回调。 */
  onRequestNewSession(): void;
  /** 批量结束并删除该任务的全部会话（batch-delete）。 */
  onClearSessions(): Promise<void>;
  onDeleteSession(session: WorkspaceSessionSummary): Promise<void>;
  onRename(name: string): Promise<void>;
  /** 归档（软删除）：终端与 worktree 都保留，只从侧栏隐藏并进入看板归档。 */
  onArchive(): Promise<void>;
  /** 硬删除；只有隔离任务还留着它，用来清理 worktree。 */
  onDelete(): Promise<void>;
  onMoveSession(sessionId: string): Promise<void>;
}) {
  const [collapsed, toggleCollapsed] = useSidebarCollapsed(`task.${task.id}`, false);
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

  const sessionCount = task.sessions.length;
  const canCollapseSessions = showsTaskSessionDisclosure(sessionCount);
  const open = isTaskSessionsExpanded(collapsed, sessionCount);

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
              <span className="workspace-task-count">{sessionCount}</span>
              <WandIcon name="chevron" size={10} className={classNames("workspace-task-chevron", open && "open")}/>
            </WandChip>
          ) : null}
        </span>
        {manageMode ? null : !confirming ? (
          <>
            {/* 任务已有会话时，行内「＋」是唯一常驻的新增会话入口（空任务用下方整行按钮）。 */}
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
      {sessionCount === 0 && !manageMode && <button type="button" className="workspace-task-empty"
        onClick={onRequestNewSession}><WandIcon name="plus" size={12}/>添加会话，或拖入已有会话</button>}
      {sessionCount > 0 && (
        <SidebarDisclosure id={sessionsId} open={open}>
          <div className="workspace-task-sessions">
          {task.sessions.map((session, index) => (
            <TaskSessionItem
              key={session.id}
              session={session}
              index={index}
              parentNames={[...parentNames, task.name]}
              liveTitle={liveTitles?.[session.id]}
              active={activeSessionId === session.id}
              manageMode={manageMode}
              selected={selectedSessionIds?.has(session.id) ?? false}
              onToggleSelect={() => onToggleSession?.(session.id)}
              onOpen={() => onOpenSession(session)}
              onDelete={() => onDeleteSession(session)}
            />
          ))}

          </div>
        </SidebarDisclosure>
      )}
    </div>
  );
}

function ClearSessionsButton({ count, label, onClear, menuItem = false }: {
  count: number;
  label: string;
  onClear(): Promise<void>;
  menuItem?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  if (count === 0) return null;
  return (
    <WandPopover
      open={open}
      onOpenChange={(next) => { if (!busy) setOpen(next); }}
      align="end"
      ariaLabel={`清空${label}的终端`}
      className="workspace-clear-popover"
      trigger={(
        menuItem ? (
          <button type="button" role="menuitem"
            className="workspace-task-menu-item danger" title={`清空${label}的 ${count} 个终端`}
            aria-label={`清空${label}的 ${count} 个终端`}>
            <WandIcon name="terminal" size={13}/>
            <span>清空终端（{count}）</span>
          </button>
        ) : (
          <WandIconButton
            className="workspace-row-action clear"
            title={`清空${label}的 ${count} 个终端`}
            aria-label={`清空${label}的 ${count} 个终端`}>
            <WandIcon name="terminal" size={13}/>
          </WandIconButton>
        )
      )}
    >
      <strong>清空{label}的终端？</strong>
      <p>将删除全部 {count} 个终端，包括正在运行的会话。任务和项目会保留。</p>
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
  selection,
  onToggleTask,
  onToggleGroup,
  onToggleSession,
  onActiveTaskOpen,
  onOpenSession,
  onRequestNewSessionInTask,
  onTasksChanged,
  onNavigate,
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
  selection?: SidebarManageSelection;
  onToggleTask?(taskId: string): void;
  onToggleGroup?(group: TaskDirectoryGroup): void;
  onToggleSession?(sessionId: string): void;
  onActiveTaskOpen(group: TaskDirectoryGroup, task: TaskSummary): void;
  onOpenSession(group: TaskDirectoryGroup, session: WorkspaceSessionSummary): void;
  onRequestNewSessionInTask(task: TaskSummary): void;
  onTasksChanged(): Promise<void>;
  onNavigate?: () => void;
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

  const handleStartMergeAgent = async (prompt: string) => {
    const rt = runtime();
    if (!rt) throw new Error("工作空间运行环境尚未就绪，请刷新页面后重试。");
    await rt.startWorktreeMergeAgent({
      workspaceId: group.workspaceId,
      cwd: group.workspaceCwd,
      prompt,
    });
    rt.toast(`已启动 Agent，准备合并所选 Worktree 到项目默认分支。`, "success");
  };

  const handleDeleteSessions = async (sessionIds: readonly string[], task: TaskSummary | null, label: string) => {
    await removeSessions(sessionIds, task);
    toast(label, "info");
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
              onClick={() => { onNavigate?.(); workspacesController.open(group.global ? undefined : group.workspaceCwd); }}>
              <WandIcon name="plus" slot="start" size={13}/><span>创建第一个任务</span>
            </WandButton>
          )}
          {group.tasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              now={now}
              parentNames={[group.workspaceName]}
              liveTitles={liveTitles}
              activeTaskId={activeTaskId}
              activeSessionId={activeSessionId}
              manageMode={manageMode}
              selected={selection?.taskIds.includes(task.id) ?? false}
              selectedSessionIds={selection ? new Set(selection.sessionIds) : undefined}
              onToggleSelect={() => onToggleTask?.(task.id)}
              onToggleSession={onToggleSession}
              onOpen={() => onActiveTaskOpen(group, task)}
              onOpenSession={(session) => onOpenSession(group, session)}
              onRequestNewSession={() => onRequestNewSessionInTask(task)}
              onClearSessions={async () => {
                const ids = task.sessions.map((session) => session.id);
                await handleDeleteSessions(ids, task, `已清空任务「${task.name}」的 ${ids.length} 个终端`);
              }}
              onDeleteSession={async (session) => {
                const label = listSessionLabel(
                  withLiveSessionTitle(session, liveTitles?.[session.id], [group.workspaceName, task.name]),
                  task.sessions.indexOf(session),
                  [group.workspaceName, task.name],
                );
                await handleDeleteSessions([session.id], task, `已删除终端「${label}」`);
              }}
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
                    parentNames={[group.workspaceName]}
                    liveTitle={liveTitles?.[session.id]}
                    active={activeSessionId === session.id}
                    manageMode={manageMode}
                    selected={selection?.sessionIds.includes(session.id) ?? false}
                    onToggleSelect={() => onToggleSession?.(session.id)}
                    onOpen={() => onOpenSession(group, session)}
                    onDelete={() => handleDeleteSessions(
                      [session.id],
                      null,
                      `已删除终端「${listSessionLabel(
                        withLiveSessionTitle(session, liveTitles?.[session.id], [group.workspaceName]),
                        index,
                        [group.workspaceName],
                      )}」`,
                    )}
                  />
                ))}
              </div>
            </details>
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
  const visibleGroups = filterSidebarGroups(
    directoryId === undefined ? groups : groups.filter((group) => group.workspaceId === directoryId),
    directoryId === undefined ? searchQuery : "",
    sessionTitles ?? {},
  );

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
  const [searchOpen, setSearchOpen] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const searchButtonRef = React.useRef<HTMLButtonElement>(null);
  const searchId = React.useId();
  const searchVisible = searchOpen || Boolean(searchQuery);
  React.useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);
  const [selection, setSelection] = React.useState<SidebarManageSelection>(EMPTY_SIDEBAR_MANAGE_SELECTION);
  const [confirmingManageDelete, setConfirmingManageDelete] = React.useState(false);
  const [manageBusy, setManageBusy] = React.useState(false);
  const prunedSelection = pruneManagedSelection(selection, visibleGroups);
  const selectedCount = sidebarManageCount(prunedSelection);
  // 归档不是破坏性操作；只有选中了终端（真的会结束进程）才用危险样式。
  const manageActionTone = managedSelectionIsDestructive(prunedSelection) ? "danger" : "secondary";
  const visibleManaged = collectManagedIds(visibleGroups);
  const allVisibleSelected = selectedCount > 0
    && prunedSelection.taskIds.length === visibleManaged.taskIds.length
    && prunedSelection.sessionIds.length === visibleManaged.sessionIds.length;
  const exitManageMode = React.useCallback(() => {
    setManageMode(false);
    setSelection(EMPTY_SIDEBAR_MANAGE_SELECTION);
    setConfirmingManageDelete(false);
  }, []);

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
    });
    toast(target === "shell" ? "已在该任务中新建空白终端" : "已在该任务中新建会话", "success");
    await reload();
  }, [openTask, reload]);

  const sessionRefresh = React.useRef(true);
  React.useEffect(() => {
    if (sessionRefresh.current) {
      sessionRefresh.current = false;
      return;
    }
    setRefreshTick((n) => n + 1);
  }, [selectedSessionId, activeTaskId]);

  // 批量操作里任务是归档（终端继续跑），只有显式选中的终端才真删除。
  const applyManagedSelection = async (): Promise<void> => {
    if (manageBusy) return;
    const resolved = prunedSelection;
    if (sidebarManageCount(resolved) === 0) return;
    setManageBusy(true);
    try {
      for (const taskId of resolved.taskIds) {
        await httpWorkspacesRepository.archiveTask(taskId);
        if (activeTaskId === taskId) runtime()?.closeWorkspace();
      }
      if (resolved.sessionIds.length > 0) {
        const ownedTask = sourceGroups
          .flatMap((group) => group.tasks)
          .find((task) => task.sessions.some((session) => resolved.sessionIds.includes(session.id))) ?? null;
        await removeSessions(resolved.sessionIds, ownedTask);
      } else {
        await runtime()?.refreshSessions();
      }
      toast(`已${describeManagedResult(resolved)}`, "info");
      exitManageMode();
      await reload();
    } catch (cause) {
      toast(describeError(cause, "无法处理所选任务。"), "danger");
    } finally {
      setManageBusy(false);
      setConfirmingManageDelete(false);
    }
  };

  if (compact) {
    return (
      <section className="workspaces-panel workspaces-panel-compact" aria-label="项目目录">
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
    <section className="workspaces-panel" aria-label="任务">
        {loading && groups.length === 0 ? (
        <div className="workspaces-panel-state">正在加载任务…</div>
      ) : error && groups.length === 0 ? (
        <div className="workspaces-panel-state error" role="alert">
          <span>{error}</span>
          <WandButton kind="ghost" size="small" className="workspaces-empty-action" onClick={() => void reload()}>重新加载</WandButton>
        </div>
      ) : (
        <>
          {manageMode ? (
            <div className="sidebar-manage-bar" role="toolbar" aria-label="批量操作">
              <span className="sidebar-manage-count">{selectedCount > 0 ? `已选择 ${selectedCount} 项` : "点选任务或终端"}</span>
              <WandButton
                className="sidebar-manage-action"
                kind="ghost"
                size="small"
                disabled={manageBusy}
                onClick={() => {
                  setSelection(allVisibleSelected ? EMPTY_SIDEBAR_MANAGE_SELECTION : visibleManaged);
                  setConfirmingManageDelete(false);
                }}
              >
                {allVisibleSelected ? "取消全选" : "全选"}
              </WandButton>
              {confirmingManageDelete ? (
                <>
                  <WandButton className="sidebar-manage-action" kind="ghost" size="small" disabled={manageBusy} onClick={() => setConfirmingManageDelete(false)}>返回</WandButton>
                  <WandButton
                    className={classNames("sidebar-manage-action", manageActionTone === "danger" && "danger")}
                    kind={manageActionTone}
                    size="small"
                    disabled={manageBusy || selectedCount === 0}
                    onClick={() => { void applyManagedSelection(); }}
                  >
                    {manageBusy ? "正在处理…" : `确认${describeManagedAction(prunedSelection)}`}
                  </WandButton>
                </>
              ) : (
                <WandButton
                  className={classNames("sidebar-manage-action", manageActionTone === "danger" && "danger")}
                  kind={manageActionTone}
                  size="small"
                  disabled={manageBusy || selectedCount === 0}
                  onClick={() => setConfirmingManageDelete(true)}
                >
                  {describeManagedAction(prunedSelection)}
                </WandButton>
              )}
              <WandButton className="sidebar-manage-action" kind="ghost" size="small" disabled={manageBusy} onClick={exitManageMode}>完成</WandButton>
            </div>
          ) : directoryId === undefined ? (
            <>
            <div className="sidebar-list-heading">
              <h2>项目与任务</h2>
              <div className="sidebar-list-actions">
                <WandIconButton
                  ref={searchButtonRef}
                  title={searchVisible ? "收起搜索" : "搜索任务或会话"}
                  aria-label={searchVisible ? "收起搜索" : "搜索任务或会话"}
                  aria-expanded={searchVisible}
                  aria-controls={searchVisible ? searchId : undefined}
                  onClick={() => {
                    if (searchVisible) onSearchChange?.("");
                    setSearchOpen(!searchVisible);
                  }}
                ><WandIcon name="search" size={15}/></WandIconButton>
                <WandIconButton
                  className="sidebar-manage-toggle"
                  title="批量管理"
                  aria-label="多选任务和终端"
                  onClick={() => {
                    setManageMode(true);
                    setSelection(EMPTY_SIDEBAR_MANAGE_SELECTION);
                    setConfirmingManageDelete(false);
                  }}
                ><WandIcon name="check" size={15}/></WandIconButton>
              </div>
            </div>
            {searchVisible && <div className="sidebar-toolbar" id={searchId}>
              <WandInput
                ref={searchInputRef}
                className="sidebar-search-input"
                type="search"
                value={searchQuery}
                placeholder="搜索任务或会话"
                aria-label="搜索任务或会话"
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
                  searchButtonRef.current?.focus();
                }}
              />
            </div>}
            </>
          ) : null}
          {searchQuery && visibleGroups.length === 0 ? (
            <div className="sidebar-search-empty">没有找到匹配的任务或会话。</div>
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
                    activeWorkspaceId={activeWorkspaceId}
                    activeTaskId={activeTaskId}
                    activeSessionId={selectedSessionId}
                    manageMode={manageMode}
                    selection={prunedSelection}
                    onToggleTask={(taskId) => setSelection((current) => toggleManagedTask(current, taskId))}
                    onToggleGroup={(selectedGroup) => {
                      setSelection((current) => toggleManagedGroup(current, selectedGroup));
                      setConfirmingManageDelete(false);
                    }}
                    onToggleSession={(sessionId) => setSelection((current) => toggleManagedSession(current, sessionId))}
                    onActiveTaskOpen={openTask}
                    onOpenSession={openSession}
                    onRequestNewSessionInTask={(task) => { onNavigate?.(); setPendingNewSessionTask(task); }}
                    onTasksChanged={reload}
                    onNavigate={onNavigate}
                  />
                ))}
            </div>
          ) : (
            <div className="workspaces-section-empty">
              <span>按目录查看任务，任务下面是执行过的会话。</span>
              <WandButton kind="ghost" size="small" className="workspaces-empty-action" aria-label="新建任务"
                onClick={() => { onNavigate?.(); workspacesController.open(); }}>
                <WandIcon name="plus" slot="start" size={13}/><span>开始一个任务</span>
              </WandButton>
            </div>
          )}
            </div>
          ) : null}
        </>
      )}
      {error && groups.length > 0 && (
        <div className="workspaces-panel-state error" role="status">
          列表暂未同步，正在显示上次结果。
          <WandButton kind="ghost" size="small" className="workspaces-empty-action" onClick={() => void reload()}>重试</WandButton>
        </div>
      )}
      {manageMode || directoryId !== undefined ? null : extraGroups}
      {pendingNewSessionTask !== null ? (
        <WorkspaceAgentDialog
          open
          key={pendingNewSessionTask.id}
          onConfirm={(target, kind) => {
            const task = pendingNewSessionTask;
            const group = groups.find((candidate) => candidate.tasks.some((item) => item.id === task.id));
            setPendingNewSessionTask(null);
            if (!task || !group) return;
            void newSessionInTask(group, task, target, kind).catch((cause) => {
              toast(describeError(cause, "无法在任务中新建会话。"), "danger");
            });
          }}
          onDismiss={() => setPendingNewSessionTask(null)}
        />
      ) : null}
    </section>
  );
}
