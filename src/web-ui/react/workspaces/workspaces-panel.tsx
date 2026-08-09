// 工作空间（项目）> 任务 侧栏面板。列出所有项目，每个项目可展开看其下的任务；
// 任务以独立 worktree 隔离（非 git 目录退化为直接用项目目录）。
// 这里只做「项目 / 任务」的增删与打开；标签 / 分屏布局留到 P2。

import * as React from "react";

import { workspacesController, workspacesStore } from "./controller";
import { httpWorkspacesRepository } from "./repository";
import { workspaceContextStore } from "./workspace-context";
import type {
  OpenWorkspaceTaskPayload,
  Workspace,
  WorkspaceProvider,
  WorkspaceTask,
  WorkspaceTaskDetail,
} from "./types";
import { classNames } from "../ui/class-names";
import { WorkspaceWorktreeDialog } from "./workspace-worktree-dialog";

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

// ── 极简内联图标（避免依赖 shell-sidebar 的私有 Icon）──
function SvgIcon({ name, size = 14 }: { name: "chevron" | "file" | "plus" | "trash" | "check" | "close" | "branch" | "spark"; size?: number }) {
  const common = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "chevron": return <svg {...common}><path d="M6 9l6 6 6-6"/></svg>;
    case "file": return <svg {...common}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
    case "plus": return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
    case "trash": return <svg {...common}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>;
    case "check": return <svg {...common}><path d="M20 6L9 17l-5-5"/></svg>;
    case "close": return <svg {...common}><path d="M6 6l12 12M18 6L6 18"/></svg>;
    case "branch": return <svg {...common}><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-6 2.5-6 6.5"/></svg>;
    case "spark": return <svg {...common}><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/><circle cx="12" cy="12" r="3"/></svg>;
  }
}

// ── 数据 hooks ──

function useWorkspaces(refreshKey: number): {
  workspaces: Workspace[];
  loading: boolean;
  error: string;
  reload: () => void;
} {
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const generationRef = React.useRef(0);
  const abortRef = React.useRef<AbortController | null>(null);

  const reload = React.useCallback(async (showLoading: boolean): Promise<void> => {
    const generation = ++generationRef.current;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    if (showLoading) setLoading(true);
    try {
      const items = await httpWorkspacesRepository.list();
      if (generation === generationRef.current) {
        setWorkspaces(items);
        setError("");
      }
    } catch (fetchError) {
      if (generation === generationRef.current) {
        setError(presentError(fetchError, "无法加载项目列表。"));
      }
    } finally {
      if (generation === generationRef.current) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  React.useEffect(() => {
    void reload(true);
    const interval = window.setInterval(() => void reload(false), 6_000);
    return () => {
      window.clearInterval(interval);
      generationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [reload, refreshKey]);

  return { workspaces, loading, error, reload: () => void reload(false) };
}

function useWorkspaceTasks(workspaceId: string | null): {
  tasks: WorkspaceTask[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
} {
  const [tasks, setTasks] = React.useState<WorkspaceTask[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const generationRef = React.useRef(0);

  const reload = React.useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    const generation = ++generationRef.current;
    setLoading(true);
    try {
      const items = await httpWorkspacesRepository.listTasks(workspaceId);
      if (generation === generationRef.current) {
        setTasks(items);
        setError("");
      }
    } catch (fetchError) {
      if (generation === generationRef.current) {
        setError(presentError(fetchError, "无法加载任务列表。"));
      }
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [workspaceId]);

  React.useEffect(() => {
    setTasks([]);
    setError("");
    if (!workspaceId) return;
    void reload();
  }, [workspaceId, reload]);

  return { tasks, loading, error, reload };
}

// ── 任务行 ──

function TaskItem({
  task,
  active,
  onOpen,
  onDelete,
}: {
  task: WorkspaceTask;
  active: boolean;
  onOpen(): void;
  onDelete(): Promise<void>;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const isolated = Boolean(task.worktree);
  return (
    <div
      className={classNames("workspace-task", active && "active", !isolated && "not-isolated")}
      role="button"
      tabIndex={0}
      aria-current={active ? "true" : undefined}
      title={task.worktree ? task.worktree.path : "无 worktree（在项目目录直接运行）"}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
    >
      <span className="workspace-task-marker"><SvgIcon name={isolated ? "branch" : "file"} size={12}/></span>
      <span className="workspace-task-name">{task.name}</span>
      <span className={classNames("workspace-task-badge", isolated ? "isolated" : "shared")}>
        {isolated ? "隔离" : "共享"}
      </span>
      {!confirming ? (
        <button
          type="button"
          className="workspace-task-action delete"
          title="删除任务（清理 worktree）"
          aria-label={`删除任务 ${task.name}`}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            setConfirming(true);
          }}
        >
          <SvgIcon name="trash" size={13}/>
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
            <SvgIcon name="check" size={13}/>
          </button>
          <button
            type="button"
            className="workspace-task-action cancel"
            title="取消"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            <SvgIcon name="close" size={13}/>
          </button>
        </span>
      )}
    </div>
  );
}

// ── 任务新建（内联重命名）──

function NewTaskForm({
  onCancel,
  onCreate,
}: {
  onCancel(): void;
  onCreate(name: string): Promise<void>;
}) {
  const [value, setValue] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const submit = async () => {
    if (submitting) return;
    const trimmed = value.trim();
    if (!isValidName(trimmed)) {
      setError(trimmed ? "任务名称无效或过长（最多 80 字符）。" : "请输入任务名称。");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onCreate(trimmed);
    } catch (createError) {
      setError(presentError(createError, "创建任务失败。"));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form
      className="workspace-new-task-form"
      aria-busy={submitting}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (!submitting) onCancel();
      }}
    >
      <input
        ref={inputRef}
        className="workspace-new-task-input"
        type="text"
        value={value}
        disabled={submitting}
        placeholder="任务名称（如：修复登录流程）"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={Boolean(error) || undefined}
        onChange={(event) => { setValue(event.currentTarget.value); setError(""); }}
      />
      <button type="submit" className="workspace-new-task-btn save" disabled={submitting} title="创建任务" aria-label="创建任务">
        <SvgIcon name="check" size={14}/>
      </button>
      <button type="button" className="workspace-new-task-btn" disabled={submitting} title="取消" aria-label="取消" onClick={onCancel}>
        <SvgIcon name="close" size={14}/>
      </button>
      {error && <div className="workspace-new-task-error" role="alert">{error}</div>}
    </form>
  );
}

// ── 项目行（含任务列表）──

function WorkspaceItem({
  workspace,
  defaultExpanded,
  activeWorkspaceId,
  activeTaskId,
  onActiveTaskOpen,
  reloadWorkspaces,
}: {
  workspace: Workspace;
  defaultExpanded: boolean;
  activeWorkspaceId: string | null;
  activeTaskId: string | null;
  onActiveTaskOpen(task: WorkspaceTask): void;
  reloadWorkspaces(): void;
}) {
  const [open, setOpen] = React.useState(defaultExpanded);
  const [creating, setCreating] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = React.useState(false);
  const { tasks, loading, error, reload } = useWorkspaceTasks(open ? workspace.id : null);
  const worktreeCount = workspace.worktreeCount
    ?? tasks.filter((task) => task.worktree !== null).length;

  React.useEffect(() => {
    if (defaultExpanded) setOpen(true);
  }, [defaultExpanded]);

  const handleCreate = async (name: string) => {
    const created: WorkspaceTaskDetail = await httpWorkspacesRepository.createTask(workspace.id, { name });
    toast(`已创建任务「${created.name}」${created.isolated ? "（独立 worktree）" : ""}`, "success");
    if (!created.isolated && created.worktreeError) {
      toast(created.worktreeError, "warning");
    }
    setCreating(false);
    await reload();
    reloadWorkspaces();
    // 创建后直接打开该任务（在其 worktree 里启动会话）。
    onActiveTaskOpen(created);
  };

  const handleDeleteTask = async (task: WorkspaceTask) => {
    await httpWorkspacesRepository.deleteTask(task.id, true);
    await runtime()?.refreshSessions();
    if (activeTaskId === task.id) runtime()?.openWorkspace(workspace);
    toast(`已删除任务「${task.name}」`, "info");
    await reload();
    reloadWorkspaces();
  };

  const handleDeleteWorkspace = async () => {
    setDeleting(true);
    try {
      await httpWorkspacesRepository.remove(workspace.id, true);
      await runtime()?.refreshSessions();
      if (activeWorkspaceId === workspace.id) runtime()?.closeWorkspace();
      toast(`已删除项目「${workspace.name}」`, "info");
      setConfirmingDelete(false);
      reloadWorkspaces();
    } catch (deleteError) {
      toast(presentError(deleteError, "删除项目失败。"), "danger");
    } finally {
      setDeleting(false);
    }
  };

  const handleStartMergeAgent = async (prompt: string) => {
    const rt = runtime();
    if (!rt) throw new Error("工作空间运行环境尚未就绪，请刷新页面后重试。");
    await rt.startWorktreeMergeAgent({
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      provider: workspace.defaultProvider,
      prompt,
    });
    rt.openWorkspace(workspace);
    rt.toast(`已启动 Agent，准备合并所选 Worktree 到项目默认分支。`, "success");
  };

  const isActiveWorkspace = activeWorkspaceId === workspace.id;

  return (
    <section className={classNames("workspace-item", isActiveWorkspace && "active-workspace")}>
      <div className="workspace-row">
        <button
          type="button"
          className="workspace-row-main"
          aria-expanded={open}
          title={workspace.cwd}
          onClick={() => setOpen((current) => !current)}
        >
          <SvgIcon name="chevron" size={12}/>
          <SvgIcon name="file" size={14}/>
          <span className="workspace-row-label">
            <span className="workspace-row-name">{workspace.name}</span>
            <span className="workspace-row-cwd">{workspace.cwd}</span>
          </span>
          <span className="workspace-row-count" aria-label={`${tasks.length} 个任务`}>{tasks.length}</span>
        </button>
        <span className="workspace-row-actions">
          <button
            type="button"
            className="workspace-row-action worktrees"
            title={worktreeCount > 0 ? `查看并合并 ${worktreeCount} 个 Worktree` : "暂无 Worktree"}
            aria-label={`${workspace.name} 的 Worktree：${worktreeCount} 个`}
            disabled={worktreeCount === 0}
            onClick={(event) => {
              event.stopPropagation();
              setWorktreeDialogOpen(true);
            }}
          >
            <SvgIcon name="branch" size={13}/>
            <span className="workspace-row-action-label">{worktreeCount}</span>
          </button>
          <button
            type="button"
            className="workspace-row-action add"
            title="新建任务（独立 worktree）"
            aria-label={`在 ${workspace.name} 新建任务`}
            aria-expanded={creating}
            onClick={(event) => { event.stopPropagation(); setCreating(true); setOpen(true); }}
          >
            <SvgIcon name="plus" size={14}/>
            <span className="workspace-row-action-label">{creating ? "填写中" : "新任务"}</span>
          </button>
          {!confirmingDelete ? (
            <button
              type="button"
              className="workspace-row-action delete"
              title="删除项目"
              aria-label={`删除项目 ${workspace.name}`}
              disabled={deleting}
              onClick={(event) => { event.stopPropagation(); setConfirmingDelete(true); }}
            >
              <SvgIcon name="trash" size={13}/>
            </button>
          ) : (
            <span className="workspace-row-confirm" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                className="workspace-row-action confirm"
                title="确认删除"
                disabled={deleting}
                onClick={handleDeleteWorkspace}
              >
                <SvgIcon name="check" size={13}/>
              </button>
              <button
                type="button"
                className="workspace-row-action cancel"
                title="取消"
                disabled={deleting}
                onClick={() => setConfirmingDelete(false)}
              >
                <SvgIcon name="close" size={13}/>
              </button>
            </span>
          )}
        </span>
      </div>
      {open && (
        <div className="workspace-tasks">
          {loading && tasks.length === 0 ? (
            <div className="workspace-tasks-state">正在加载任务…</div>
          ) : error && tasks.length === 0 ? (
            <div className="workspace-tasks-state error">{error}</div>
          ) : (
            <>
              {tasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  active={isActiveWorkspace && activeTaskId === task.id}
                  onOpen={() => onActiveTaskOpen(task)}
                  onDelete={() => handleDeleteTask(task)}
                />
              ))}
              {tasks.length === 0 && !creating && (
                <div className="workspace-tasks-empty">还没有任务，点击「+」新建一个（每个任务独占一个 worktree）。</div>
              )}
            </>
          )}
          {creating && (
            <NewTaskForm onCancel={() => setCreating(false)} onCreate={handleCreate}/>
          )}
        </div>
      )}
      <WorkspaceWorktreeDialog
        open={worktreeDialogOpen}
        workspace={workspace}
        onStartAgent={handleStartMergeAgent}
        onDismiss={() => setWorktreeDialogOpen(false)}
      />
    </section>
  );
}

// ── 面板根 ──

export function WorkspacesPanel() {
  // 订阅控制器：新建项目对话框关闭时刷新列表（创建后立即出现）。
  const controllerSnapshot = React.useSyncExternalStore(
    workspacesStore.subscribe,
    workspacesStore.getSnapshot,
    workspacesStore.getSnapshot,
  );
  const [refreshTick, setRefreshTick] = React.useState(0);
  const lastOpenRef = React.useRef(controllerSnapshot.open);
  React.useEffect(() => {
    // open 从 true → false：对话框刚关，可能新建了项目。
    if (lastOpenRef.current && !controllerSnapshot.open) {
      setRefreshTick((n) => n + 1);
    }
    lastOpenRef.current = controllerSnapshot.open;
  }, [controllerSnapshot.open]);

  const { workspaces, loading, error, reload } = useWorkspaces(refreshTick);
  // 活动高亮统一读 workspaceContextStore（主区标签栏与这里共用同一来源，
  // 关闭工作区窗口时这里也会同步取消高亮）。
  const activeContext = React.useSyncExternalStore(
    workspaceContextStore.subscribe,
    workspaceContextStore.getSnapshot,
    workspaceContextStore.getServerSnapshot,
  );
  const activeWorkspaceId = activeContext.workspaceId;
  const activeTaskId = activeContext.taskId;

  const openTask = React.useCallback((workspace: Workspace, task: WorkspaceTask) => {
    const rt = runtime();
    const cwd = task.worktree?.path ?? workspace.cwd;
    if (rt) {
      const payload: OpenWorkspaceTaskPayload = {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: task.id,
        taskName: task.name,
        cwd,
      };
      if (workspace.defaultProvider) payload.provider = workspace.defaultProvider as WorkspaceProvider;
      rt.openTask(payload);
    } else {
      toast("工作空间运行环境尚未就绪，请刷新页面后重试。", "warning");
    }
  }, []);

  return (
    <div className="workspaces-panel" aria-label="工作空间与任务">
      <div className="workspaces-panel-toolbar">
        <span className="workspaces-panel-title">项目 / 任务</span>
        <button
          type="button"
          className="workspaces-panel-new-project"
          title="新建项目"
          aria-label="新建项目"
          onClick={() => workspacesController.open()}
        >
          <SvgIcon name="plus" size={14}/>
        </button>
      </div>
      {loading && workspaces.length === 0 ? (
        <div className="workspaces-panel-state">正在加载项目…</div>
      ) : error && workspaces.length === 0 ? (
        <div className="workspaces-panel-state error">{error}</div>
      ) : workspaces.length === 0 ? (
        <div className="workspaces-panel-empty">
          <strong>还没有项目</strong><br/>
          点击「新项目」创建一个项目，再在里面添加任务。
        </div>
      ) : (
        <div className="workspaces-list">
          {workspaces.map((workspace) => (
            <WorkspaceItem
              key={workspace.id}
              workspace={workspace}
              defaultExpanded={activeWorkspaceId === workspace.id}
              activeWorkspaceId={activeWorkspaceId}
              activeTaskId={activeTaskId}
              onActiveTaskOpen={(task) => openTask(workspace, task)}
              reloadWorkspaces={reload}
            />
          ))}
        </div>
      )}
      <div className="workspaces-panel-hint">
        每个任务在独立的 git worktree 中运行；非 git 目录则在项目目录直接运行。
      </div>
    </div>
  );
}
