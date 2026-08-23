// 侧栏「任务」面板 —— 唯一的会话入口。视觉层级是：
// 目录（分组元数据）→ 任务（一级容器）→ 终端/会话。
// 展开任务可看到其终端，行内「+」在任务目录新建会话；每条终端可单独关闭删除。
// 未绑定任务的旧会话以「未分组会话」归入所在目录组，不会失联。

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
import { WandIcon, workspaceTaskIconName } from "../ui";
import { ProviderLogo } from "../provider-logo";
import { listSessionLabel, workspaceSessionLabel } from "./session-order";

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

function taskRecency(task: TaskSummary): string {
  return task.lastOpenedAt ?? task.createdAt;
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

  const reload = React.useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    setLoading(true);
    try {
      const items = await httpWorkspacesRepository.listTaskGroups();
      if (generation === generationRef.current) {
        setGroups(items);
        setError("");
      }
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

function TaskSessionItem({
  session,
  index,
  parentNames,
  active,
  onOpen,
  onDelete,
}: {
  session: WorkspaceSessionSummary;
  index: number;
  parentNames?: readonly string[];
  active: boolean;
  onOpen(): void;
  onDelete(): Promise<void>;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const label = listSessionLabel(session, index, parentNames);

  return (
    <div className={classNames("workspace-session", active && "active", confirming && "confirming")}>
      <button
        type="button"
        className="workspace-session-main"
        aria-current={active ? "true" : undefined}
        title={session.cwd || session.title || session.id}
        onClick={onOpen}
      >
        <span className="workspace-session-mark" aria-hidden="true">
          <ProviderLogo provider={session.provider}/>
        </span>
        <span className="workspace-session-name">{label}</span>
        {session.sessionKind === "pty" && (
          <span className="workspace-session-kind">终端</span>
        )}
      </button>
      {confirming ? (
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
  parentNames,
  activeTaskId,
  activeSessionId,
  onOpen,
  onOpenSession,
  onRequestNewSession,
  onClearSessions,
  onDeleteSession,
  onRename,
  onDelete,
}: {
  task: TaskSummary;
  parentNames: readonly string[];
  activeTaskId: string | null;
  activeSessionId: string | null;
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
  const [open, setOpen] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [clearConfirming, setClearConfirming] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState(task.name);
  const [renameError, setRenameError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const isolated = Boolean(task.worktree);
  const isActive = activeTaskId === task.id;

  React.useEffect(() => {
    if (isActive) setOpen(true);
  }, [isActive]);

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
        <span className={classNames("workspace-task-marker", isolated ? "isolated" : "shared")}>
          <WandIcon name={workspaceTaskIconName(isolated)} size={12}/>
        </span>
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

  const sessionCount = task.sessions.length;

  return (
    <div className={classNames("workspace-task-group", isActive && "active", open && "is-open")}>
      <div
        className={classNames("workspace-task", isActive && "active", !isolated && "not-isolated")}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-current={isActive ? "true" : undefined}
        title={task.worktree ? task.worktree.path : `无 worktree（在 ${task.cwd} 直接运行）`}
        onClick={() => { setOpen(true); onOpen(); }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setOpen(true);
          onOpen();
        }}
      >
        <button
          type="button"
          className="workspace-task-chevron-btn"
          aria-label={open ? `收起任务 ${task.name} 的终端` : `展开任务 ${task.name} 的终端`}
          aria-expanded={open}
          title={open ? "收起" : "展开终端"}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((current) => !current);
          }}
        >
          <WandIcon name="chevron" size={11} className={classNames("workspace-task-chevron", open && "open")}/>
        </button>
        <span className={classNames("workspace-task-marker", isolated ? "isolated" : "shared")}>
          <WandIcon name={workspaceTaskIconName(isolated)} size={12}/>
        </span>
        <span className="workspace-task-name">{task.name}</span>
        <span className="workspace-task-meta">
          <span className={classNames("workspace-task-badge", isolated ? "isolated" : "shared")}>
            {isolated ? "隔离" : "共享"}
          </span>
          {sessionCount > 0 && (
            <span className="workspace-task-count" aria-label={`${sessionCount} 个终端`}>{sessionCount}</span>
          )}
        </span>
        {!confirming && (
          <>
            <button
              type="button"
              className="workspace-task-action add"
              title={`在「${task.name}」中新建终端`}
              aria-label={`在任务 ${task.name} 中新建终端`}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                setOpen(true);
                onOpen();
                onRequestNewSession();
              }}
            >
              <WandIcon name="plus" size={13}/>
            </button>
            <button
              type="button"
              className="workspace-task-action edit"
              title="重命名任务"
              aria-label={`重命名任务 ${task.name}`}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                setRenameValue(task.name);
                setRenameError("");
                setRenaming(true);
              }}
            >
              <WandIcon name="edit" size={13}/>
            </button>
          </>
        )}
        {!confirming ? (
          <button
            type="button"
            className="workspace-task-action delete"
            title={isolated ? "删除任务（清理 worktree）" : "删除任务"}
            aria-label={`删除任务 ${task.name}`}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              setConfirming(true);
            }}
          >
            <WandIcon name="trash" size={13}/>
          </button>
        ) : (
          <span className="workspace-task-confirm" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="workspace-task-action confirm"
              title="确认删除"
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                try {
                  await onDelete();
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
              title="取消"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              <WandIcon name="close" size={13}/>
            </button>
          </span>
        )}
      </div>
      {open && (
        <div className="workspace-task-sessions">
          {sessionCount === 0 ? (
            <div className="workspace-tasks-empty">还没有终端。点右侧「＋」在这个任务里新建。</div>
          ) : (
            task.sessions.map((session, index) => (
              <TaskSessionItem
                key={session.id}
                session={session}
                index={index}
                parentNames={[...parentNames, task.name]}
                active={activeSessionId === session.id}
                onOpen={() => onOpenSession(session)}
                onDelete={() => onDeleteSession(session)}
              />
            ))
          )}
          {sessionCount > 1 && !clearConfirming && (
            <button
              type="button"
              className="workspace-clear-sessions"
              onClick={(event) => { event.stopPropagation(); setClearConfirming(true); }}
            >
              清空全部终端（{sessionCount}）
            </button>
          )}
          {sessionCount > 1 && clearConfirming && (
            <div className="workspace-clear-sessions-confirm">
              <span>删除全部 {sessionCount} 个终端？</span>
              <button
                type="button"
                disabled={busy}
                onClick={async (event) => {
                  event.stopPropagation();
                  setBusy(true);
                  try {
                    await onClearSessions();
                    setClearConfirming(false);
                  } catch (cause) {
                    toast(presentError(cause, "无法清空终端。"), "danger");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                确认清空
              </button>
              <button type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); setClearConfirming(false); }}>
                取消
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 目录分组 ──

function TaskGroupSection({
  group,
  activeWorkspaceId,
  activeTaskId,
  activeSessionId,
  onActiveTaskOpen,
  onOpenSession,
  onRequestNewSessionInTask,
  onTasksChanged,
}: {
  group: TaskDirectoryGroup;
  activeWorkspaceId: string | null;
  activeTaskId: string | null;
  activeSessionId: string | null;
  onActiveTaskOpen(group: TaskDirectoryGroup, task: TaskSummary): void;
  onOpenSession(group: TaskDirectoryGroup, session: WorkspaceSessionSummary): void;
  onRequestNewSessionInTask(task: TaskSummary): void;
  onTasksChanged(): Promise<void>;
}) {
  const [open, setOpen] = React.useState(true);
  const [looseOpen, setLooseOpen] = React.useState(false);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = React.useState(false);

  React.useEffect(() => {
    if (activeWorkspaceId === group.workspaceId) setOpen(true);
  }, [activeWorkspaceId, group.workspaceId]);

  const handleDeleteTask = async (task: TaskSummary) => {
    await httpWorkspacesRepository.deleteTask(task.id, true);
    await runtime()?.refreshSessions();
    if (activeTaskId === task.id) runtime()?.closeWorkspace();
    toast(`已删除任务「${task.name}」`, "info");
    await onTasksChanged();
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
  const sessionTotal = group.tasks.reduce((sum, task) => sum + task.sessions.length, 0)
    + group.standaloneSessions.length;
  const pathCaption = shortenWorkspacePath(group.workspaceCwd);
  const showPath = Boolean(pathCaption) && pathCaption !== group.workspaceName;

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
          title={group.workspaceCwd}
          onClick={() => setOpen((current) => !current)}
        >
          <WandIcon name="chevron" size={11} className={classNames("workspace-row-chevron", open && "open")}/>
          <span className="workspace-row-icon" aria-hidden="true">
            <WandIcon name="folder" size={13}/>
          </span>
          <span className="workspace-row-label">
            <span className="workspace-row-name">
              <span className="workspace-row-title">{group.workspaceName}</span>
              {group.synthetic ? <span className="workspace-row-flag">未归档</span> : null}
            </span>
            {showPath ? <span className="workspace-row-cwd">{pathCaption}</span> : null}
          </span>
          <span
            className="workspace-row-count"
            aria-label={`${taskCount} 个任务，${sessionTotal} 个终端`}
          >
            {taskCount}
            <span className="workspace-row-count-label">任务</span>
          </span>
        </button>
        <span className="workspace-row-actions">
          {!group.synthetic && (
            <button
              type="button"
              className="workspace-row-action add"
              title={`在 ${group.workspaceName} 新建任务`}
              aria-label={`在目录 ${group.workspaceName} 新建任务`}
              onClick={(event) => {
                event.stopPropagation();
                workspacesController.open(group.workspaceCwd);
              }}
            >
              <WandIcon name="plus" size={14}/>
            </button>
          )}
          {group.tasks.some((task) => task.worktree) && (
            <button
              type="button"
              className="workspace-row-action worktrees"
              title="查看并合并 Worktree"
              aria-label={`${group.workspaceName} 的 Worktree 合并视图`}
              onClick={(event) => {
                event.stopPropagation();
                setWorktreeDialogOpen(true);
              }}
            >
              <WandIcon name="merge" size={13}/>
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="workspace-tasks">
          {[...group.tasks].sort((left, right) => taskRecency(right).localeCompare(taskRecency(left))).map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              parentNames={[group.workspaceName]}
              activeTaskId={activeTaskId}
              activeSessionId={activeSessionId}
              onOpen={() => onActiveTaskOpen(group, task)}
              onOpenSession={(session) => onOpenSession(group, session)}
              onRequestNewSession={() => onRequestNewSessionInTask(task)}
              onClearSessions={async () => {
                const ids = task.sessions.map((session) => session.id);
                await handleDeleteSessions(ids, task, `已清空任务「${task.name}」的 ${ids.length} 个终端`);
              }}
              onDeleteSession={async (session) => {
                const label = workspaceSessionLabel(session, task.sessions.indexOf(session));
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
          {group.tasks.length === 0 && (
            <div className="workspace-tasks-empty">这个目录还没有任务。</div>
          )}
          {group.standaloneSessions.length > 0 && (
            <details
              className="workspace-loose-sessions"
              open={looseOpen}
              onToggle={(event) => setLooseOpen(event.currentTarget.open)}
            >
              <summary>未分组会话（{group.standaloneSessions.length}）</summary>
              <div className="workspace-loose-session-list">
                {group.standaloneSessions.map((session, index) => (
                  <TaskSessionItem
                    key={session.id}
                    session={session}
                    index={index}
                    parentNames={[group.workspaceName]}
                    active={activeSessionId === session.id}
                    onOpen={() => onOpenSession(group, session)}
                    onDelete={() => handleDeleteSessions(
                      [session.id],
                      null,
                      `已删除终端「${workspaceSessionLabel(session, index)}」`,
                    )}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
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

// ── 面板根 ──

export function WorkspacesPanel({
  selectedSessionId = null,
  extraGroups = null,
}: {
  selectedSessionId?: string | null;
  /** 侧栏附加分组（原生历史 / 自动化等），渲染在任务列表之后。 */
  extraGroups?: React.ReactNode;
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
  // 活动高亮统一读 workspaceContextStore（主区标签栏与这里共用同一来源，
  // 关闭工作区窗口时这里也会同步取消高亮）。
  const activeContext = React.useSyncExternalStore(
    workspaceContextStore.subscribe,
    workspaceContextStore.getSnapshot,
    workspaceContextStore.getServerSnapshot,
  );
  const activeWorkspaceId = activeContext.workspaceId;
  const activeTaskId = activeContext.taskId;

  // 任务行「＋」的 Agent 选择器：先记下目标任务，确认后在该任务目录内新建会话。
  const [pendingNewSessionTask, setPendingNewSessionTask] = React.useState<TaskSummary | null>(null);

  const openTask = React.useCallback((group: TaskDirectoryGroup, task: TaskSummary): unknown => {
    const rt = runtime();
    if (!rt) {
      toast("工作空间运行环境尚未就绪，请刷新页面后重试。", "warning");
      return undefined;
    }
    const payload: OpenWorkspaceTaskPayload = {
      workspaceId: group.workspaceId,
      workspaceName: group.workspaceName,
      taskId: task.id,
      taskName: task.name,
      cwd: task.cwd,
    };
    // 可能返回恢复完成的 Promise；调用方按需 await（见 newSessionInTask）。
    return rt.openTask(payload);
  }, []);

  const openSession = React.useCallback((group: TaskDirectoryGroup, session: WorkspaceSessionSummary) => {
    const rt = runtime();
    if (!rt) {
      toast("工作空间运行环境尚未就绪，请刷新页面后重试。", "warning");
      return;
    }
    if (!group.synthetic) {
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
  }, []);

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

  const hasContent = groups.some((group) => group.tasks.length > 0 || group.standaloneSessions.length > 0);

  return (
    <div className="workspaces-panel" aria-label="任务列表">
      {loading && groups.length === 0 ? (
        <div className="workspaces-panel-state">正在加载任务…</div>
      ) : error && groups.length === 0 ? (
        <div className="workspaces-panel-state error">{error}</div>
      ) : !hasContent ? (
        <div className="workspaces-panel-empty">
          <strong>还没有任务</strong><br/>
          任务归属目录，之后在任务里新建终端无需再选目录。
          <button
            type="button"
            className="btn btn-primary btn-sm workspaces-empty-new-task"
            aria-label="新建任务"
            onClick={() => workspacesController.open()}
          >
            ＋ 新建任务
          </button>
        </div>
      ) : (
        <div className="workspaces-list">
          {groups.map((group) => (
            <TaskGroupSection
              key={group.workspaceId}
              group={group}
              activeWorkspaceId={activeWorkspaceId}
              activeTaskId={activeTaskId}
              activeSessionId={selectedSessionId}
              onActiveTaskOpen={openTask}
              onOpenSession={openSession}
              onRequestNewSessionInTask={(task) => setPendingNewSessionTask(task)}
              onTasksChanged={reload}
            />
          ))}
        </div>
      )}
      {extraGroups}
      <div className="workspaces-panel-hint">
        目录只是分组；点开任务可管理其中的终端。
      </div>
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
    </div>
  );
}
