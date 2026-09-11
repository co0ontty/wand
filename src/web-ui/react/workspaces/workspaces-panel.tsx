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
import { WandIcon, WandPopover, workspaceTaskIconName } from "../ui";
import { SessionProviderMark } from "./session-mark";
import { listSessionLabel, withLiveSessionTitle } from "./session-order";
import { SidebarDisclosure, useSidebarCollapsed } from "./sidebar-disclosure";
import {
  formatTaskRecency,
  orderSidebarGroups,
  orderSidebarTasks,
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
import {
  COLLAPSED_RAIL_LIMIT,
  EMPTY_SIDEBAR_MANAGE_SELECTION,
  collapsedRailTasks,
  collectManagedIds,
  describeManagedDeletion,
  pruneManagedSelection,
  resolveManagedDeletion,
  sidebarManageCount,
  toggleManagedSession,
  toggleManagedTask,
  type SidebarManageSelection,
} from "./sidebar-manage";

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

function presentError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message || error.message === "Failed to fetch") return fallback;
  return error.message;
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
        setError(presentError(fetchError, "无法加载任务列表。"));
      }
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reload();
    const interval = window.setInterval(() => void reload(), 6_000);
    return () => {
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
    )}>
      <button
        type="button"
        className="workspace-session-main"
        aria-current={active ? "true" : undefined}
        aria-pressed={manageMode ? selected : undefined}
        title={session.cwd || session.title || session.id}
        onClick={activate}
      >
        {manageMode && <ManageCheck checked={selected} label={`选择终端 ${label}`}/>}
        <span className="workspace-session-mark" aria-hidden="true">
          <SessionProviderMark session={session}/>
        </span>
        <span className="workspace-session-name">{label}</span>
        {session.sessionKind === "pty" && (
          <span className="workspace-session-kind">终端</span>
        )}
      </button>
      {manageMode ? null : confirming ? (
        <span className="workspace-session-confirm">
          <button
            type="button"
            className="workspace-session-action confirm"
            title="确认删除终端"
            aria-label={`确认删除终端 ${label}`}
            disabled={busy}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              void onDelete()
                .catch((cause) => {
                  toast(presentError(cause, "无法删除终端。"), "danger");
                })
                .finally(() => {
                  setBusy(false);
                  setConfirming(false);
                });
            }}
          >
            <WandIcon name="trash" size={12}/>
          </button>
          <button
            type="button"
            className="workspace-session-action cancel"
            title="取消"
            aria-label="取消删除终端"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            <WandIcon name="close" size={12}/>
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="workspace-session-action delete"
          title="删除终端"
          aria-label={`删除终端 ${label}`}
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          <WandIcon name="trash" size={12}/>
        </button>
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
  onDelete,
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
  onDelete(): Promise<void>;
}) {
  const [collapsed, toggleCollapsed] = useSidebarCollapsed(`task.${task.id}`, true);
  const [confirming, setConfirming] = React.useState(false);
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
      setRenameError(presentError(renameFailure, "重命名任务失败。"));
    } finally {
      setBusy(false);
    }
  };

  if (renaming) {
    return (
      <form
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
        <button type="submit" className="workspace-task-action confirm" disabled={busy} title="保存任务名称" aria-label="保存任务名称">
          <WandIcon name="check" size={13}/>
        </button>
        <button type="button" className="workspace-task-action cancel" disabled={busy} title="取消重命名" aria-label="取消重命名" onClick={() => setRenaming(false)}>
          <WandIcon name="close" size={13}/>
        </button>
      </form>
    );
  }

  return (
    <div className={classNames(
      "workspace-task-group",
      isActive && "active",
      open && "is-open",
      manageMode && "managing",
      manageMode && selected && "selected",
    )}>
      <div className={classNames(
        "workspace-task",
        isActive && "active",
        !isolated && "not-isolated",
        manageMode && "managing",
        manageMode && selected && "selected",
      )}>
        <button
          type="button"
          className="workspace-task-main"
          aria-current={isActive ? "true" : undefined}
          aria-pressed={manageMode ? selected : undefined}
          title={`${task.name}\n${task.worktree?.path ?? task.cwd}`}
          onClick={manageMode ? (onToggleSelect ?? onOpen) : onOpen}
        >
          {manageMode && <ManageCheck checked={selected} label={`选择任务 ${task.name}`}/>}
          {isolated ? (
            <span className="workspace-task-marker isolated" title="隔离 worktree" aria-label="隔离 worktree">
              <WandIcon name={workspaceTaskIconName(true)} size={12}/>
            </span>
          ) : null}
          <span className="workspace-task-name">{task.name}</span>
        </button>
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
            <button
              type="button"
              className="workspace-task-chevron-btn"
              aria-label={open ? `收起任务 ${task.name} 的终端` : `展开任务 ${task.name} 的终端`}
              aria-expanded={open}
              aria-controls={sessionsId}
              title={open ? "收起终端" : "展开终端"}
              onClick={toggleCollapsed}
            >
              <span className="workspace-task-count">{sessionCount}</span>
              <WandIcon name="chevron" size={10} className={classNames("workspace-task-chevron", open && "open")}/>
            </button>
          ) : null}
        </span>
        {manageMode ? null : !confirming ? (
          <>
            <WandPopover
              open={taskMenuOpen}
              onOpenChange={setTaskMenuOpen}
              align="end"
              sideOffset={5}
              showArrow={false}
              contentRole="menu"
              ariaLabel={`任务 ${task.name} 的更多操作`}
              className="workspace-task-menu"
              trigger={(
                <button
                  type="button"
                  className="workspace-task-action more"
                  title="更多任务操作"
                  aria-label={`任务 ${task.name} 的更多操作`}
                  disabled={busy}
                >
                  <WandIcon name="more" size={13}/>
                </button>
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
                <WandIcon name="plus" size={13}/><span>新建终端</span>
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
                className="workspace-task-menu-item danger"
                onClick={() => {
                  setTaskMenuOpen(false);
                  setConfirming(true);
                }}
              >
                <WandIcon name="trash" size={13}/>
                <span>{isolated ? "删除任务并清理 Worktree" : "删除任务"}</span>
              </button>
            </WandPopover>
          </>
        ) : (
          <span className="workspace-task-confirm">
            <button
              type="button"
              className="workspace-task-action confirm"
              title="确认删除任务"
              aria-label={`确认删除任务 ${task.name}`}
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                try {
                  await onDelete();
                } catch (cause) {
                  toast(presentError(cause, "无法删除任务。"), "danger");
                } finally {
                  setBusy(false);
                  setConfirming(false);
                }
              }}
            >
              <WandIcon name="trash" size={13}/>
            </button>
            <button
              type="button"
              className="workspace-task-action cancel"
              title="取消删除"
              aria-label="取消删除任务"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              <WandIcon name="close" size={13}/>
            </button>
          </span>
        )}
      </div>
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
      showArrow={false}
      ariaLabel={`清空${label}的终端`}
      className="workspace-clear-popover"
      trigger={(
        <button type="button" role={menuItem ? "menuitem" : undefined}
          className={menuItem ? "workspace-task-menu-item danger" : "workspace-row-action clear"} title={`清空${label}的 ${count} 个终端`}
          aria-label={`清空${label}的 ${count} 个终端`}>
          <WandIcon name="terminal" size={13}/>
          {menuItem ? <span>清空终端（{count}）</span> : <WandIcon name="close" size={9}/>}
        </button>
      )}
    >
      <strong>清空{label}的终端？</strong>
      <p>将删除全部 {count} 个终端，包括正在运行的会话。任务和项目会保留。</p>
      <div className="workspace-clear-popover-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setOpen(false)}>取消</button>
        <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={async () => {
          if (busy) return;
          setBusy(true);
          try {
            await onClear();
            setOpen(false);
          } catch (cause) {
            toast(presentError(cause, "无法清空终端。"), "danger");
          } finally {
            setBusy(false);
          }
        }}>{busy ? "正在清空…" : "确认清空"}</button>
      </div>
    </WandPopover>
  );
}

// ── 目录分组 ──

function TaskGroupSection({
  group,
  now,
  directoryCount,
  liveTitles,
  activeWorkspaceId,
  activeTaskId,
  activeSessionId,
  manageMode = false,
  selection,
  onToggleTask,
  onToggleSession,
  onActiveTaskOpen,
  onOpenSession,
  onRequestNewSessionInTask,
  onTasksChanged,
  onNavigate,
}: {
  group: TaskDirectoryGroup;
  now: number;
  directoryCount: number;
  liveTitles?: Readonly<Record<string, string>>;
  activeWorkspaceId: string | null;
  activeTaskId: string | null;
  activeSessionId: string | null;
  manageMode?: boolean;
  selection?: SidebarManageSelection;
  onToggleTask?(taskId: string): void;
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
  const tasksId = React.useId();
  const open = isDirectoryExpanded(collapsed, directoryCount);
  const looseOpen = !looseCollapsed;
  const canDelete = !group.synthetic && !group.global;

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
      toast(`已删除项目「${group.workspaceName}」`, "info");
      await onTasksChanged();
    } catch (cause) {
      toast(presentError(cause, "无法删除项目。"), "danger");
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

  return (
    <section
      className={classNames(
        "workspace-item",
        open && "is-open",
        group.synthetic && "is-synthetic",
        activeWorkspaceId === group.workspaceId && "active-workspace",
      )}
    >
      <div className="workspace-row">
        <button
          type="button"
          className="workspace-row-main"
          aria-expanded={open}
          aria-controls={tasksId}
          title={group.workspaceCwd}
          onClick={toggleCollapsed}
        >
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
          <WandIcon name="chevron" size={11} className={classNames("workspace-row-chevron", open && "open")}/>
        </button>
        <span className="workspace-row-actions">
          {!group.synthetic && (
            <button
              type="button"
              className="workspace-row-action add"
              title={`在 ${group.workspaceName} 新建任务`}
              aria-label={`在项目 ${group.workspaceName} 新建任务`}
              onClick={(event) => {
                event.stopPropagation();
                workspacesController.open(group.workspaceCwd, "task");
              }}
            >
              <WandIcon name="plus" size={14}/>
            </button>
          )}
          <WandPopover
            open={menuOpen}
            onOpenChange={(next) => { if (!deleting) { setMenuOpen(next); setConfirmingDelete(false); } }}
            align="end"
            showArrow={false}
            contentRole="menu"
            ariaLabel={`项目 ${group.workspaceName} 的更多操作`}
            className="workspace-task-menu"
            trigger={(
              <button type="button" className="workspace-row-action more"
                title="更多项目操作" aria-label={`项目 ${group.workspaceName} 的更多操作`}>
                <WandIcon name="more" size={14}/>
              </button>
            )}
          >
          <div className="workspace-menu-context" title={group.workspaceCwd}>{shortenWorkspacePath(group.workspaceCwd)}</div>
          <ClearSessionsButton
            menuItem
            count={new Set([...group.tasks.flatMap((task) => task.sessions.map((session) => session.id)),
              ...group.standaloneSessions.map((session) => session.id)]).size}
            label={`项目「${group.workspaceName}」`}
            onClear={async () => {
              const context = workspaceContextStore.getSnapshot();
              const activeTask = group.tasks.find((task) => task.id === context.taskId) ?? null;
              const ids = [...group.tasks.flatMap((task) => task.sessions.map((session) => session.id)),
                ...group.standaloneSessions.map((session) => session.id)];
              await handleDeleteSessions(ids, activeTask, `已清空项目「${group.workspaceName}」的终端`);
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
              title={`删除项目 ${group.workspaceName}`}
              aria-label={`删除项目 ${group.workspaceName}`}
              disabled={deleting}
              onClick={(event) => {
                event.stopPropagation();
                setConfirmingDelete(true);
              }}
            >
              <WandIcon name="trash" size={13}/><span>删除项目</span>
            </button>
          ) : null}
          {canDelete && confirmingDelete ? (
            <div className="workspace-menu-confirm">
              <p>删除「{group.workspaceName}」及其全部任务、终端和任务 Worktree？</p>
              <button
                type="button"
                className="workspace-task-menu-item danger"
                title="确认删除项目及其任务"
                aria-label={`确认删除项目 ${group.workspaceName}`}
                disabled={deleting}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDeleteDirectory();
                }}
              >
                <WandIcon name="trash" size={13}/><span>{deleting ? "正在删除…" : "确认删除项目"}</span>
              </button>
              <button
                type="button"
                className="workspace-task-menu-item"
                title="取消删除"
                aria-label="取消删除项目"
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
        </span>
      </div>
      <SidebarDisclosure id={tasksId} open={open}>
        <div className="workspace-tasks">
          {taskCount === 0 && group.standaloneSessions.length === 0 && !group.synthetic && (
            <button type="button" className="workspaces-empty-action"
              onClick={() => { onNavigate?.(); workspacesController.open(group.workspaceCwd, "task"); }}>
              <WandIcon name="plus" size={13}/><span>创建第一个任务</span>
            </button>
          )}
          {orderSidebarTasks(group.tasks).map((task) => (
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
              onDelete={() => handleDeleteTask(task)}
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

function CompactTaskRail({
  groups,
  loading,
  error,
  activeTaskId,
  onOpenTask,
  onExpand,
}: {
  groups: readonly TaskDirectoryGroup[];
  loading: boolean;
  error: string;
  activeTaskId: string | null;
  onOpenTask(group: TaskDirectoryGroup, task: TaskSummary): void;
  onExpand(): void;
}) {
  if (loading && groups.length === 0) {
    return <div className="sidebar-collapsed-tree-state" aria-label="正在加载项目">…</div>;
  }
  if (error && groups.length === 0) {
    return <div className="sidebar-collapsed-tree-state error" title={error} aria-label={error}>!</div>;
  }

  const rail = collapsedRailTasks(groups, activeTaskId, COLLAPSED_RAIL_LIMIT);
  if (rail.items.length === 0) {
    return <div className="sidebar-collapsed-rail" aria-label="最近任务"/>;
  }
  return (
    <div className="sidebar-collapsed-rail" aria-label="最近任务">
      {rail.items.map((item) => {
        const group = groups.find((candidate) => candidate.workspaceId === item.workspaceId);
        const title = item.global ? item.task.name : `${item.workspaceName} / ${item.task.name}`;
        return (
          <button
            key={item.task.id}
            type="button"
            className={classNames(
              "sidebar-collapsed-rail-task",
              activeTaskId === item.task.id && "active",
              item.activity && `activity-${item.activity}`,
            )}
            title={title}
            aria-label={item.global ? `打开独立任务 ${item.task.name}` : `打开项目 ${item.workspaceName} 中的任务 ${item.task.name}`}
            aria-current={activeTaskId === item.task.id ? "true" : undefined}
            onClick={() => {
              if (!group) {
                onExpand();
                return;
              }
              onOpenTask(group, item.task);
            }}
          >
            <WandIcon name={workspaceTaskIconName(Boolean(item.task.worktree))} size={15}/>
            {item.activity ? (
              <span className={classNames("sidebar-collapsed-rail-dot", item.activity)} aria-hidden="true"/>
            ) : null}
          </button>
        );
      })}
      {rail.overflow > 0 ? (
        <button
          type="button"
          className="sidebar-collapsed-rail-more"
          title={`还有 ${rail.overflow} 个任务，展开侧栏查看`}
          aria-label={`展开侧栏，还有 ${rail.overflow} 个任务`}
          onClick={onExpand}
        >
          +{rail.overflow > 9 ? "9" : rail.overflow}
        </button>
      ) : null}
    </div>
  );
}
export function WorkspacesPanel({
  selectedSessionId = null,
  sessionTitles = null,
  extraGroups = null,
  compact = false,
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

  const { groups, loading, error, reload } = useTaskGroups(refreshTick);
  const visibleGroups = orderSidebarGroups(filterSidebarGroups(groups, searchQuery, sessionTitles ?? {}));

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

  const [panelCollapsed, togglePanel] = useSidebarCollapsed("projects");
  const [standaloneCollapsed, toggleStandalone] = useSidebarCollapsed("tasks");
  const [globalLooseCollapsed, toggleGlobalLoose] = useSidebarCollapsed("loose.global");
  const [now, setNow] = React.useState(Date.now);
  const projectsId = React.useId();
  const standaloneId = React.useId();
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  // 任务行「＋」的 Agent 选择器：先记下目标任务，确认后在该任务目录内新建会话。
  const [pendingNewSessionTask, setPendingNewSessionTask] = React.useState<TaskSummary | null>(null);
  const [manageMode, setManageMode] = React.useState(false);
  const [selection, setSelection] = React.useState<SidebarManageSelection>(EMPTY_SIDEBAR_MANAGE_SELECTION);
  const [confirmingManageDelete, setConfirmingManageDelete] = React.useState(false);
  const [manageBusy, setManageBusy] = React.useState(false);
  const prunedSelection = pruneManagedSelection(selection, visibleGroups);
  const selectedCount = sidebarManageCount(prunedSelection);
  const visibleManaged = collectManagedIds(visibleGroups);
  const allVisibleSelected = selectedCount > 0
    && prunedSelection.taskIds.length === visibleManaged.taskIds.length
    && prunedSelection.sessionIds.length === visibleManaged.sessionIds.length;
  const selectedSessionIdSet = React.useMemo(
    () => new Set(prunedSelection.sessionIds),
    [prunedSelection.sessionIds],
  );
  const exitManageMode = React.useCallback(() => {
    setManageMode(false);
    setSelection(EMPTY_SIDEBAR_MANAGE_SELECTION);
    setConfirmingManageDelete(false);
  }, []);

  const openTask = React.useCallback((group: TaskDirectoryGroup, task: TaskSummary): unknown => {
    onNavigate?.();
    const rt = runtime();
    if (!rt) {
      toast("工作空间运行环境尚未就绪，请刷新页面后重试。", "warning");
      return undefined;
    }
    const payload: OpenWorkspaceTaskPayload = {
      workspaceId: group.workspaceId,
      workspaceName: group.global ? "" : group.workspaceName,
      taskId: task.id,
      taskName: task.name,
      cwd: task.cwd,
    };
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
    const task = group.tasks.find((item) => item.id === session.workspaceTaskId)
      ?? group.tasks.find((item) => item.sessions.some((entry) => entry.id === session.id));
    if (task) {
      void Promise.resolve(openTask(group, task)).then(() => rt.selectSession(session.id));
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
  }, [onNavigate, openTask]);

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
      workspaceId: group.workspaceId,
      taskId: task.id,
      cwd: task.cwd,
      target,
      kind,
    });
    toast(target === "shell" ? "已在该任务中新建空白终端" : "已在该任务中新建会话", "success");
    await reload();
  }, [openTask, reload]);

  const globalGroup = visibleGroups.find((group) => group.global);
  const projectGroups = visibleGroups.filter((group) => !group.global);
  const standaloneTaskTotal = globalGroup?.tasks.length ?? 0;

  const sessionRefresh = React.useRef(true);
  React.useEffect(() => {
    if (sessionRefresh.current) {
      sessionRefresh.current = false;
      return;
    }
    setRefreshTick((n) => n + 1);
  }, [selectedSessionId, activeTaskId]);

  const deleteManagedSelection = async (): Promise<void> => {
    if (manageBusy) return;
    const resolved = resolveManagedDeletion(prunedSelection, visibleGroups);
    if (sidebarManageCount(resolved) === 0) return;
    setManageBusy(true);
    try {
      for (const taskId of resolved.taskIds) {
        await httpWorkspacesRepository.deleteTask(taskId, true);
        if (activeTaskId === taskId) runtime()?.closeWorkspace();
      }
      if (resolved.sessionIds.length > 0) {
        const ownedTask = visibleGroups
          .flatMap((group) => group.tasks)
          .find((task) => task.sessions.some((session) => resolved.sessionIds.includes(session.id))) ?? null;
        await removeSessions(resolved.sessionIds, ownedTask);
      } else {
        await runtime()?.refreshSessions();
      }
      toast(`已删除${describeManagedDeletion(resolved)}`, "info");
      exitManageMode();
      await reload();
    } catch (cause) {
      toast(presentError(cause, "无法删除所选项目。"), "danger");
    } finally {
      setManageBusy(false);
      setConfirmingManageDelete(false);
    }
  };

  if (compact) {
    return (
      <section className="workspaces-panel workspaces-panel-compact" aria-label="最近任务">
        <CompactTaskRail
          groups={groups}
          loading={loading}
          error={error}
          activeTaskId={activeTaskId}
          onOpenTask={(group, task) => { void openTask(group, task); }}
          onExpand={() => onExpand?.()}
        />
      </section>
    );
  }

  const projectHeading = (
      <div className="workspaces-panel-heading">
        <button
          type="button"
          className="workspaces-panel-heading-toggle"
          aria-expanded={!panelCollapsed}
          aria-controls={projectsId}
          onClick={togglePanel}
        >
          <WandIcon name="chevron" size={11} className={classNames("workspaces-panel-chevron", !panelCollapsed && "open")}/>
          <span>项目</span>
          <span className="workspaces-panel-heading-count">
            {projectGroups.length}
          </span>
        </button>
        <button
          type="button"
          className="workspaces-panel-add"
          onClick={() => { onNavigate?.(); workspacesController.open(undefined, "project"); }}
          aria-label="新建项目"
          title="新建项目"
        >
          <WandIcon name="plus" size={14}/>
        </button>
      </div>
  );

  return (
    <section className="workspaces-panel" aria-label="项目与独立任务">
        {loading && groups.length === 0 ? (
        <div className="workspaces-panel-state">正在加载任务…</div>
      ) : error && groups.length === 0 ? (
        <div className="workspaces-panel-state error" role="alert">
          <span>{error}</span>
          <button type="button" className="workspaces-empty-action" onClick={() => void reload()}>重新加载</button>
        </div>
      ) : (
        <>
          {manageMode ? (
            <div className="sidebar-manage-bar" role="toolbar" aria-label="批量操作">
              <span className="sidebar-manage-count">{selectedCount > 0 ? `已选择 ${selectedCount} 项` : "点选任务或终端"}</span>
              <button
                type="button"
                className="sidebar-manage-action"
                disabled={manageBusy}
                onClick={() => {
                  setSelection(allVisibleSelected ? EMPTY_SIDEBAR_MANAGE_SELECTION : visibleManaged);
                  setConfirmingManageDelete(false);
                }}
              >
                {allVisibleSelected ? "取消全选" : "全选"}
              </button>
              {confirmingManageDelete ? (
                <>
                  <button type="button" className="sidebar-manage-action" disabled={manageBusy} onClick={() => setConfirmingManageDelete(false)}>返回</button>
                  <button
                    type="button"
                    className="sidebar-manage-action danger"
                    disabled={manageBusy || selectedCount === 0}
                    onClick={() => { void deleteManagedSelection(); }}
                  >
                    {manageBusy ? "正在删除…" : "确认删除"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="sidebar-manage-action danger"
                  disabled={manageBusy || selectedCount === 0}
                  onClick={() => setConfirmingManageDelete(true)}
                >
                  删除
                </button>
              )}
              <button type="button" className="sidebar-manage-action" disabled={manageBusy} onClick={exitManageMode}>完成</button>
            </div>
          ) : (
            <div className="sidebar-toolbar">
              <label className="sidebar-search">
                <WandIcon name="hash" size={14}/>
                <input
                  type="search"
                  value={searchQuery}
                  placeholder="搜索任务或会话"
                  aria-label="搜索任务或会话"
                  onChange={(event) => onSearchChange?.(event.currentTarget.value)}
                />
                {searchQuery ? (
                  <button type="button" aria-label="清除搜索" title="清除搜索" onClick={() => onSearchChange?.("")}>
                    <WandIcon name="close" size={12}/>
                  </button>
                ) : null}
              </label>
              <button
                type="button"
                className="sidebar-manage-toggle"
                title="多选任务和终端"
                aria-label="多选任务和终端"
                onClick={() => {
                  setManageMode(true);
                  setSelection(EMPTY_SIDEBAR_MANAGE_SELECTION);
                  setConfirmingManageDelete(false);
                }}
              >
                选择
              </button>
            </div>
          )}
          {searchQuery && visibleGroups.length === 0 ? (
            <div className="sidebar-search-empty">没有找到匹配的任务或会话。</div>
          ) : null}
          {!searchQuery || visibleGroups.length > 0 ? (
            <div className="sidebar-results">
            <section className="workspaces-global-tasks" aria-label="独立任务">
              <div className="workspaces-panel-heading">
                <button type="button" className="workspaces-panel-heading-toggle" title="独立任务，不依赖任何项目"
                  aria-expanded={!standaloneCollapsed} aria-controls={standaloneId}
                  onClick={toggleStandalone}>
                  <WandIcon name="chevron" size={11} className={classNames("workspaces-panel-chevron", !standaloneCollapsed && "open")}/>
                  <span>任务</span>
                  <span className="workspaces-panel-heading-count">{standaloneTaskTotal}</span>
                </button>
                <button type="button" className="workspaces-panel-add" title="新建独立任务" aria-label="新建独立任务"
                  onClick={() => { onNavigate?.(); workspacesController.open(undefined, "task"); }}><WandIcon name="plus" size={14}/></button>
              </div>
              <SidebarDisclosure id={standaloneId} open={!standaloneCollapsed}>
              {globalGroup ? (
              <div className="workspace-tasks is-global">
                {orderSidebarTasks(globalGroup.tasks).map((task) => (
                  <TaskItem
                    key={task.id}
                    task={task}
                    now={now}
                    parentNames={[]}
                    liveTitles={sessionTitles ?? undefined}
                    activeTaskId={activeTaskId}
                    activeSessionId={selectedSessionId}
                    manageMode={manageMode}
                    selected={prunedSelection.taskIds.includes(task.id)}
                    selectedSessionIds={selectedSessionIdSet}
                    onToggleSelect={() => setSelection((current) => toggleManagedTask(current, task.id))}
                    onToggleSession={(sessionId) => setSelection((current) => toggleManagedSession(current, sessionId))}
                    onOpen={() => openTask(globalGroup, task)}
                    onOpenSession={(session) => openSession(globalGroup, session)}
                    onRequestNewSession={() => { onNavigate?.(); setPendingNewSessionTask(task); }}
                    onClearSessions={async () => {
                      const ids = task.sessions.map((session) => session.id);
                      await removeSessions(ids, task);
                      toast(`已清空任务「${task.name}」的 ${ids.length} 个终端`, "info");
                      await reload();
                    }}
                    onDeleteSession={async (session) => {
                      const label = listSessionLabel(
                        withLiveSessionTitle(session, sessionTitles?.[session.id], [task.name]),
                        task.sessions.indexOf(session),
                        [task.name],
                      );
                      await removeSessions([session.id], task);
                      toast(`已删除终端「${label}」`, "info");
                      await reload();
                    }}
                    onRename={async (name) => {
                      const updated = await httpWorkspacesRepository.updateTask(task.id, { name });
                      toast(`已将任务「${task.name}」重命名为「${updated.name}」`, "success");
                      await reload();
                    }}
                    onDelete={async () => {
                      await httpWorkspacesRepository.deleteTask(task.id, true);
                      await runtime()?.refreshSessions();
                      if (activeTaskId === task.id) runtime()?.closeWorkspace();
                      toast(`已删除任务「${task.name}」`, "info");
                      await reload();
                    }}
                  />
                ))}
                {globalGroup.standaloneSessions.length > 0 ? (
                  <details
                    className="workspace-loose-sessions"
                    open={!globalLooseCollapsed}
                    onToggle={(event) => {
                      if (event.currentTarget.open === !globalLooseCollapsed) return;
                      toggleGlobalLoose();
                    }}
                  >
                    <summary>未分组会话（{globalGroup.standaloneSessions.length}）</summary>
                    <div className="workspace-loose-session-list">
                      {globalGroup.standaloneSessions.map((session, index) => (
                        <TaskSessionItem
                          key={session.id}
                          session={session}
                          index={index}
                          parentNames={[]}
                          liveTitle={sessionTitles?.[session.id]}
                          active={selectedSessionId === session.id}
                          manageMode={manageMode}
                          selected={selectedSessionIdSet.has(session.id)}
                          onToggleSelect={() => setSelection((current) => toggleManagedSession(current, session.id))}
                          onOpen={() => openSession(globalGroup, session)}
                          onDelete={async () => {
                            await removeSessions([session.id], null);
                            toast(`已删除终端「${listSessionLabel(
                              withLiveSessionTitle(session, sessionTitles?.[session.id]),
                              index,
                            )}」`, "info");
                            await reload();
                          }}
                        />
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
              ) : null}
              {standaloneTaskTotal === 0 && !globalGroup?.standaloneSessions.length && (
                <div className="workspaces-section-empty">
                  <span>随时开始，不必先建项目。</span>
                  <button type="button" className="workspaces-empty-action" aria-label="新建任务"
                    onClick={() => { onNavigate?.(); workspacesController.open(undefined, "task"); }}>
                    <WandIcon name="plus" size={13}/><span>开始一个任务</span>
                  </button>
                </div>
              )}
              </SidebarDisclosure>
            </section>
          <section className="workspaces-projects" aria-label="项目">
            {projectHeading}
            <SidebarDisclosure id={projectsId} open={!panelCollapsed}>
            {projectGroups.length > 0 ? (
            <div className="workspaces-list">
                {projectGroups.map((group) => (
                  <TaskGroupSection
                    key={group.workspaceId}
                    group={group}
                    now={now}
                    directoryCount={projectGroups.length}
                    liveTitles={sessionTitles ?? undefined}
                    activeWorkspaceId={activeWorkspaceId}
                    activeTaskId={activeTaskId}
                    activeSessionId={selectedSessionId}
                    manageMode={manageMode}
                    selection={prunedSelection}
                    onToggleTask={(taskId) => setSelection((current) => toggleManagedTask(current, taskId))}
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
              <span>把同一目录的任务放在一起。</span>
              <button type="button" className="workspaces-empty-action"
                onClick={() => { onNavigate?.(); workspacesController.open(undefined, "project"); }}>
                <WandIcon name="folder" size={13}/><span>创建第一个项目</span>
              </button>
            </div>
          )}
            </SidebarDisclosure>
          </section>
            </div>
          ) : null}
        </>
      )}
      {error && groups.length > 0 && (
        <div className="workspaces-panel-state error" role="status">
          列表暂未同步，正在显示上次结果。
          <button type="button" className="workspaces-empty-action" onClick={() => void reload()}>重试</button>
        </div>
      )}
      {manageMode ? null : extraGroups}
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
              toast(presentError(cause, "无法在任务中新建会话。"), "danger");
            });
          }}
          onDismiss={() => setPendingNewSessionTask(null)}
        />
      ) : null}
    </section>
  );
}
