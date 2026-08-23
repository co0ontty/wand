// 工作空间（项目）前端类型。镜像 src/types.ts 的 Workspace/LayoutNode/PaneTab，
// 但 provider 联合在浏览器层本地定义（不把服务端 types 拉进浏览器 bundle）。

export type WorkspaceProvider = "claude" | "codex" | "opencode" | "grok" | "qoder" | "pi";

/** A task work window can run an Agent CLI or a bare login shell. */
export type WorkspaceSessionTarget = WorkspaceProvider | "shell";

/** Agent 窗口的运行形态；空白终端固定为 PTY。 */
export type WorkspaceSessionKind = "structured" | "pty";

export type PaneTab =
  | { id: string; kind: "session"; sessionId: string }
  | { id: string; kind: "editor"; path: string }
  | { id: string; kind: "preview"; path: string };

export type LayoutNode =
  | { type: "pane"; tabs: PaneTab[]; active: number }
  | { type: "split"; dir: "h" | "v"; ratio: number; children: [LayoutNode, LayoutNode] };

/** 顶部的一个工作窗口 Tab；其内部可以是单终端，也可以是一棵分屏树。 */
export interface WorkWindowLayout {
  id: string;
  layout: LayoutNode;
  /** 当前接受窗口级操作（移动、标题）的终端/内容标签。 */
  activeTabId?: string;
}

/**
 * 任务级窗口集合。顶部 Tab 只映射这里的 windows；终端进入另一个窗口后，
 * 来源 window 会被移除，终端本身成为目标 window 分屏树里的一个 pane。
 */
export interface TaskWindowLayout {
  type: "windows";
  windows: WorkWindowLayout[];
  activeWindowId: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  defaultProvider?: WorkspaceProvider;
  layout: LayoutNode | null;
  createdAt: string;
  lastOpenedAt: string | null;
  /** Number of task-owned worktrees currently registered under this project. */
  worktreeCount?: number;
  /** Number of sessions bound to this project (including task-owned ones). */
  sessionCount?: number;
}

/** GET /api/workspaces/:id 额外带回该项目下的会话列表。 */
export interface WorkspaceSessionSummary {
  id: string;
  provider?: WorkspaceProvider;
  sessionKind?: string;
  runner?: string;
  title?: string;
  status?: string;
  cwd?: string;
  startedAt?: string;
  workspaceTaskId?: string;
}

export interface WorkspaceDetail extends Workspace {
  sessions: WorkspaceSessionSummary[];
}

// ── 任务（Task = 命名 + 独立 worktree + 一组标签）──

type WorkspaceTaskStatus = "active" | "done";

/** 任务所属 worktree 信息；非 git 目录时为 null（退化为直接在项目目录运行）。 */
interface WorkspaceTaskWorktree {
  branch: string;
  path: string;
  baseRef?: string;
  repoRoot?: string;
}

export interface WorkspaceTask {
  id: string;
  workspaceId: string;
  name: string;
  worktree: WorkspaceTaskWorktree | null;
  layout: TaskWindowLayout | null;
  status: WorkspaceTaskStatus;
  createdAt: string;
  lastOpenedAt: string | null;
}

/** POST/GET 任务路由的返回：在 WorkspaceTask 基础上带回运行期派生字段。 */
export interface WorkspaceTaskDetail extends WorkspaceTask {
  /** 任务实际运行目录（worktree 路径，或非 git 时回退到项目目录）。 */
  cwd: string;
  /** 是否隔离（有独立 worktree）。 */
  isolated: boolean;
  /** 非 git / 基线缺失时的降级提示。 */
  worktreeError?: string;
  /** 该任务下已绑定的会话。 */
  sessions: WorkspaceSessionSummary[];
}

/** GET /api/tasks 聚合行：任务 + 运行期派生字段；目录信息在 TaskDirectoryGroup 上。 */
export type TaskSummary = WorkspaceTaskDetail & {
  /** 使用 maxSessions 截断时的真实会话总数（未截断时等于 sessions.length）。 */
  totalSessions?: number;
};

/**
 * GET /api/tasks 返回的目录组：任务一级容器的分组维度。
 * 未绑定任务的会话以 standaloneSessions 归入所在目录（synthetic 组表示该
 * 目录没有项目实体，仅用于展示，不能在其中建任务）。
 */
export interface TaskDirectoryGroup {
  workspaceId: string;
  workspaceName: string;
  workspaceCwd: string;
  synthetic?: boolean;
  tasks: TaskSummary[];
  standaloneSessions: WorkspaceSessionSummary[];
}

export type WorkspaceWorktreeState = "ready" | "dirty" | "conflict" | "empty" | "unavailable";

interface WorkspaceWorktreeCommit {
  hash: string;
  shortHash: string;
  subject: string;
}

export interface WorkspaceWorktreeReview {
  taskId: string;
  taskName: string;
  taskStatus: WorkspaceTaskStatus;
  branch: string;
  path: string;
  baseRef: string;
  state: WorkspaceWorktreeState;
  actionable: boolean;
  reason: string;
  aheadCount: number;
  hasUncommittedChanges: boolean;
  hasConflicts: boolean;
  commits: readonly WorkspaceWorktreeCommit[];
}

export interface WorkspaceWorktreeOverview {
  workspaceId: string;
  repoRoot: string;
  targetBranch: string;
  worktrees: readonly WorkspaceWorktreeReview[];
}

export interface CreateWorkspaceTaskRequest {
  name: string;
  baseRef?: string;
  /** 显式 false 时跳过独立 worktree，会话直接跑在项目目录；缺省为 true。 */
  worktree?: boolean;
}

export interface UpdateWorkspaceTaskRequest {
  name?: string;
  status?: WorkspaceTaskStatus;
}

export interface CreateWorkspaceRequest {
  name: string;
  cwd: string;
  defaultProvider?: WorkspaceProvider;
}

export interface UpdateWorkspaceRequest {
  name?: string;
  cwd?: string;
  defaultProvider?: WorkspaceProvider | null;
}

export interface RecentPath {
  path: string;
  name: string;
}

export interface NewProjectDefaults {
  defaultProvider: WorkspaceProvider;
  defaultCwd: string;
  defaultSessionKind: WorkspaceSessionKind;
  defaultTaskWorktree: boolean;
  recentPaths: RecentPath[];
}

export interface WorkspacesRepository {
  list(): Promise<Workspace[]>;
  /** 目录分组的任务聚合列表（GET /api/tasks），供侧栏「任务」视图一次拉全。 */
  listTaskGroups(): Promise<TaskDirectoryGroup[]>;
  get(id: string): Promise<WorkspaceDetail>;
  create(request: CreateWorkspaceRequest): Promise<Workspace>;
  update(id: string, patch: UpdateWorkspaceRequest): Promise<Workspace>;
  remove(id: string, cascade?: boolean): Promise<void>;
  saveLayout(id: string, layout: LayoutNode | null): Promise<LayoutNode | null>;
  // 任务
  listTasks(workspaceId: string): Promise<WorkspaceTask[]>;
  createTask(workspaceId: string, request: CreateWorkspaceTaskRequest): Promise<WorkspaceTaskDetail>;
  getTask(taskId: string): Promise<WorkspaceTaskDetail>;
  updateTask(taskId: string, patch: UpdateWorkspaceTaskRequest): Promise<WorkspaceTask>;
  deleteTask(taskId: string, cascade?: boolean): Promise<void>;
  saveTaskLayout(taskId: string, layout: TaskWindowLayout | null): Promise<TaskWindowLayout | null>;
  /** Project-level review data used by the multi-worktree merge Agent launcher. */
  listWorktrees(workspaceId: string, options?: { signal?: AbortSignal }): Promise<WorkspaceWorktreeOverview>;
  /** 关闭工作窗口 / 终端时批量结束并删除其底层会话。 */
  deleteSessions(sessionIds: readonly string[]): Promise<void>;
}

/** 打开任务时传给宿主的载荷：足够启动一个绑定到该任务的会话。 */
export interface OpenWorkspaceTaskPayload {
  workspaceId: string;
  workspaceName: string;
  taskId: string;
  taskName: string;
  cwd: string;
  provider?: WorkspaceProvider;
}

/** 标签栏「+ 新建会话」时传给宿主：在同一任务 worktree 内再起一个绑定会话。 */
export interface NewTaskSessionPayload {
  workspaceId: string;
  taskId: string;
  cwd: string;
  target: WorkspaceSessionTarget;
  kind?: WorkspaceSessionKind;
}

interface StartWorkspaceMergeAgentPayload {
  workspaceId: string;
  cwd: string;
  provider?: WorkspaceProvider;
  prompt: string;
}

export interface WorkspacesRuntimeAdapter {
  /** 对话框打开/关闭的副作用钩子（关其它覆盖层等）。 */
  onOpen(): void;
  onClose(): void;
  /** 当前有效工作目录，作为新建项目目录的默认值。 */
  effectiveCwd(): string;
  /** 项目创建成功后：设为活动工作空间（打开工作空间窗口）。 */
  openWorkspace(workspace: Workspace): void;
  /** 关闭当前工作空间 / 任务上下文。 */
  closeWorkspace(): void;
  /** 删除任务 / 项目后立即刷新会话列表，清掉已删除会话的选中态。 */
  refreshSessions(): void | Promise<unknown>;
  /** 选中并打开一个已有会话（项目里的独立会话与会话列表共用同一条记录）。 */
  selectSession(sessionId: string): void;
  /**
   * 点击任务：只恢复任务上下文与已有会话；空任务保持欢迎页。
   * 返回 Promise 时表示详情恢复完成；调用方若紧接着要在该任务里建会话，
   * 必须先 await，避免恢复流程用旧快照覆盖新会话的选中态。
   */
  openTask(payload: OpenWorkspaceTaskPayload): void | Promise<void>;
  /** 标签栏「+」：在该任务 worktree 再起一个绑定会话（返回 promise 以便标签栏刷新）。 */
  newTaskSession(payload: NewTaskSessionPayload): void | Promise<unknown>;
  /** Start one managed Agent at the project checkout to merge selected task worktrees. */
  startWorktreeMergeAgent(payload: StartWorkspaceMergeAgentPayload): void | Promise<unknown>;
  /** 工作窗口 / 分屏布局变更后回写持久化 + 更新活动上下文。 */
  saveTaskLayout(layout: TaskWindowLayout | null): void | Promise<unknown>;
  /** 确认并关闭底层会话；取消或失败时返回 false，调用方不得移除布局。 */
  closeTaskSessions(sessionIds: readonly string[], scope: "window" | "terminal"): Promise<boolean>;
  /** 在指定容器内为某会话挂一个池终端实例（分屏窗格内容）。幂等。 */
  mountSessionTerminal(sessionId: string, container: HTMLElement): boolean;
  /** 释放某会话的池终端实例（窗格卸载 / 标签关闭）。 */
  unmountSessionTerminal(sessionId: string): void;
  /** 读取 / 更新单个池终端的独立缩放比例。 */
  getSessionTerminalScale(sessionId: string): number;
  setSessionTerminalScale(sessionId: string, scale: number): number;
  /** 释放全部池终端（退出工作空间窗口）。 */
  disposeAllSessionTerminals(): void;
  toast(message: string, tone?: "info" | "success" | "warning" | "danger"): void;
}
