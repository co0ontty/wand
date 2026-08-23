// 侧栏「任务」面板 —— 唯一的会话入口。任务是一级容器（目录级归属 + 可选
// worktree 隔离），会话归属任务：展开任务即可见其会话，行内「+」直接在任务
// 目录新建会话，无需再选目录。未绑定任务的旧会话以「未分组会话」归入所在
// 目录组，不会失联。

import * as React from "react";

import { workspacesController, workspacesStore } from "./controller";
import { httpWorkspacesRepository } from "./repository";
import { workspaceContextStore } from "./workspace-context";
import { WorkspaceAgentDialog } from "./workspace-agent-dialog";
import { WorkspaceWorktreeDialog } from "./workspace-worktree-dialog";
import type {
  OpenWorkspaceTaskPayload,
  TaskDirectoryGroup,
  TaskSummary,
  Workspace,
  WorkspaceSessionTarget,
  WorkspaceSessionSummary,
} from "./types";
import { classNames } from "../ui/class-names";
import { WandIcon, workspaceTaskIconName } from "../ui";
import { ProviderLogo } from "../provider-logo";
import { workspaceSessionLabel } from "./session-order";

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
  active,
  onOpen,
}: {
  session: WorkspaceSessionSummary;
  index: number;
  active: boolean;
  onOpen(): void;
}) {
  return (
    <div
      className={classNames("workspace-session", active && "active")}
      role="button"
      tabIndex={0}
      aria-current={active ? "true" : undefined}
      title={session.cwd || session.title || session.id}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
    >
      <span className="workspace-session-mark" aria-hidden="true">
        <ProviderLogo provider={session.provider}/>
      </span>
      <span className="workspace-session-name">{workspaceSessionLabel(session, index)}</span>
      {session.sessionKind === "pty" && (
        <span className="workspace-session-kind">终端</span>
      )}
    </div>
  );
}

// ── 任务行 ──

function TaskItem({
  task,
  activeTaskId,
  activeSessionId,
  onOpen,
  onOpenSession,
  onRequestNewSession,
  onClearSessions,
  onRename,
  onDelete,
}: {
  task: TaskSummary;
  activeTaskId: string | null;
  activeSessionId: string | null;
  onOpen(): void;
  onOpenSession(session: WorkspaceSessionSummary): void;
  /** 请求在该任务中新建会话；由上层弹出 Agent 选择器后回调。 */
  onRequestNewSession(): void;
  /** 批量结束并删除该任务的全部会话（batch-delete）。 */
  onClearSessions(): Promise<void>;
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
        <span className="workspace-task-marker"><WandIcon name={workspaceTaskIconName(isolated)} size={13}/></span>
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
    <div className={classNames("workspace-task-group", isActive && "active")}>
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
          aria-label={open ? `收起任务 ${task.name} 的会话` : `展开任务 ${task.name} 的会话`}
          aria-expanded={open}
          title={open ? "收起" : "展开会话"}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((current) => !current);
          }}
        >
          <WandIcon name="chevron" size={11} className={classNames("workspace-task-chevron", open && "open")}/>
        </button>
        <span className="workspace-task-marker"><WandIcon name={workspaceTaskIconName(isolated)} size={13}/></span>
        <span className="workspace-task-name">{task.name}</span>
        <span className="workspace-task-meta">
          <span className={classNames("workspace-task-badge", isolated ? "isolated" : "shared")}>
            {isolated ? "隔离" : "共享"}
          </span>
          {sessionCount > 0 && (
            <span className="workspace-task-count" aria-label={`${sessionCount} 个会话`}>{sessionCount}</span>
          )}
        </span>
        {!confirming && (
          <>
            <button
              type="button"
              className="workspace-task-action add"
              title={`在「${task.name}」中新建会话`}
              aria-label={`在任务 ${task.name} 中新建会话`}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                setOpen(true);
                onOpen();
                onRequestNewSession();
              }}
            >
              <WandIcon name="chat" size={13}/>
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
          {sessionCount > 0 && !clearConfirming && (
            <button
              type="button"
              className="workspace-clear-sessions"
              onClick={(event) => { event.stopPropagation(); setClearConfirming(true); }}
            >
              清空会话（{sessionCount}）
            </button>
          )}
          {sessionCount > 0 && clearConfirming && (
            <div className="workspace-clear-sessions-confirm">
              <span>删除全部 {sessionCount} 个会话？</span>
              <button
                type="button"
                disabled={busy}
                onClick={async (event) => {
                  event.stopPropagation();
                  setBusy(true);
                  try {
                    await onClearSessions();
                    setClearConfirming(false);
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
          {sessionCount === 0 ? (
            <div className="workspace-tasks-empty">还没有会话。点击「＋」在这个任务里新建。</div>
          ) : (
            task.sessions.map((session, index) => (
              <TaskSessionItem
                key={session.id}
                session={session}
                index={index}
                active={activeSessionId === session.id}
                onOpen={() => onOpenSession(session)}
              />
            ))
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
  const [open, setOpen] = React.useState(activeWorkspaceId === group.workspaceId);
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

  const totalSessions = group.tasks.reduce((sum, task) => sum + task.sessions.length, 0)
    + group.standaloneSessions.length;

  return (
    <section className={classNames("workspace-item", activeWorkspaceId === group.workspaceId && "active-workspace")}>
      <div className="workspace-row">
        <button
          type="button"
          className="workspace-row-main"
          aria-expanded={open}
          title={group.workspaceCwd}
          onClick={() => setOpen((current) => !current)}
        >
          <WandIcon name="chevron" size={12}/>
          <WandIcon name="folder" size={14}/>
          <span className="workspace-row-label">
            <span className="workspace-row-name">{group.workspaceName}</span>
            <span className="workspace-row-cwd">{group.workspaceCwd}</span>
          </span>
          <span className="workspace-row-count" aria-label={`${totalSessions} 个会话`}>{totalSessions}</span>
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
              activeTaskId={activeTaskId}
              activeSessionId={activeSessionId}
              onOpen={() => onActiveTaskOpen(group, task)}
              onOpenSession={(session) => onOpenSession(group, session)}
              onRequestNewSession={() => onRequestNewSessionInTask(task)}
              onClearSessions={async () => {
                const ids = task.sessions.map((session) => session.id);
                if (ids.length === 0) return;
                await httpWorkspacesRepository.deleteSessions(ids);
                await runtime()?.refreshSessions();
                toast(`已清空任务「${task.name}」的 ${ids.length} 个会话`, "info");
                await onTasksChanged();
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
                    active={activeSessionId === session.id}
                    onOpen={() => onOpenSession(group, session)}
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

  const newSessionInTask = React.useCallback(async (group: TaskDirectoryGroup, task: TaskSummary, target: WorkspaceSessionTarget) => {
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
          任务归属目录，之后在任务里新建会话无需再选目录。
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
        会话归属于任务；任务归属于目录。隔离任务使用独立 git worktree。
      </div>
      {pendingNewSessionTask !== null ? (
        <WorkspaceAgentDialog
          open
          key={pendingNewSessionTask.id}
          onConfirm={(target) => {
            const task = pendingNewSessionTask;
            const group = groups.find((candidate) => candidate.tasks.some((item) => item.id === task.id));
            setPendingNewSessionTask(null);
            if (!task || !group) return;
            void newSessionInTask(group, task, target).catch((cause) => {
              toast(presentError(cause, "无法在任务中新建会话。"), "danger");
            });
          }}
          onDismiss={() => setPendingNewSessionTask(null)}
        />
      ) : null}
    </div>
  );
}
