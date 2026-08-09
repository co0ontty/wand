import type {
  CreateWorkspaceRequest,
  CreateWorkspaceTaskRequest,
  LayoutNode,
  TaskWindowLayout,
  NewProjectDefaults,
  RecentPath,
  UpdateWorkspaceRequest,
  UpdateWorkspaceTaskRequest,
  Workspace,
  WorkspaceDetail,
  WorkspaceProvider,
  WorkspaceTask,
  WorkspaceTaskDetail,
  WorkspaceWorktreeOverview,
  WorkspaceWorktreeReview,
  WorkspaceWorktreeState,
  WorkspacesRepository,
} from "./types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const PROVIDERS: ReadonlySet<string> = new Set([
  "claude", "codex", "opencode", "grok", "qoder", "pi",
]);

function parseProvider(value: unknown): WorkspaceProvider | undefined {
  return typeof value === "string" && PROVIDERS.has(value) ? (value as WorkspaceProvider) : undefined;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function worktreeState(value: unknown): WorkspaceWorktreeState {
  return value === "dirty" || value === "conflict" || value === "empty" || value === "unavailable"
    ? value
    : "ready";
}

function normalizeWorkspaceWorktree(value: unknown): WorkspaceWorktreeReview | null {
  const item = record(value);
  const taskId = text(item.taskId).trim();
  const branch = text(item.branch).trim();
  const worktreePath = text(item.path).trim();
  if (!taskId || !branch || !worktreePath) return null;
  const commits = Array.isArray(item.commits) ? item.commits.flatMap((candidate) => {
    const commit = record(candidate);
    const hash = text(commit.hash).trim();
    if (!hash) return [];
    return [{
      hash,
      shortHash: text(commit.shortHash, hash.slice(0, 7)),
      subject: text(commit.subject),
    }];
  }) : [];
  return {
    taskId,
    taskName: text(item.taskName, branch),
    taskStatus: item.taskStatus === "done" ? "done" : "active",
    branch,
    path: worktreePath,
    baseRef: text(item.baseRef),
    state: worktreeState(item.state),
    actionable: item.actionable === true,
    reason: text(item.reason),
    aheadCount: finiteCount(item.aheadCount),
    hasUncommittedChanges: item.hasUncommittedChanges === true,
    hasConflicts: item.hasConflicts === true,
    commits,
  };
}

export function normalizeWorkspaceWorktreeOverview(value: unknown): WorkspaceWorktreeOverview {
  const result = record(value);
  return {
    workspaceId: text(result.workspaceId),
    repoRoot: text(result.repoRoot),
    targetBranch: text(result.targetBranch),
    worktrees: Array.isArray(result.worktrees)
      ? result.worktrees.map(normalizeWorkspaceWorktree).filter((item): item is WorkspaceWorktreeReview => item !== null)
      : [],
  };
}

async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || body.error) {
    throw new Error(typeof body.error === "string" ? body.error : `请求失败 (HTTP ${response.status})`);
  }
  return body as T;
}

function normalizePaths(value: unknown): RecentPath[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): RecentPath | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      if (typeof record.path !== "string" || !record.path.trim()) return null;
      const path = record.path;
      return {
        path,
        name: text(record.name, path.split("/").filter(Boolean).at(-1) ?? path),
      };
    })
    .filter((item): item is RecentPath => item !== null);
}

export class HttpWorkspacesRepository implements WorkspacesRepository {
  constructor(private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init)) {}

  async list(): Promise<Workspace[]> {
    const body = await readJson<unknown>(await this.fetchImpl("/api/workspaces", { credentials: "same-origin" }));
    if (Array.isArray(body)) return body as Workspace[];
    const wrapped = body as { workspaces?: Workspace[] };
    return wrapped.workspaces ?? [];
  }

  async get(id: string): Promise<WorkspaceDetail> {
    return readJson<WorkspaceDetail>(await this.fetchImpl(`/api/workspaces/${encodeURIComponent(id)}`, {
      credentials: "same-origin",
    }));
  }

  async create(request: CreateWorkspaceRequest): Promise<Workspace> {
    return readJson<Workspace>(await this.fetchImpl("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(request),
    }));
  }

  async update(id: string, patch: UpdateWorkspaceRequest): Promise<Workspace> {
    return readJson<Workspace>(await this.fetchImpl(`/api/workspaces/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(patch),
    }));
  }

  async remove(id: string, cascade = false): Promise<void> {
    await readJson(await this.fetchImpl(
      `/api/workspaces/${encodeURIComponent(id)}${cascade ? "?cascade=1" : ""}`,
      { method: "DELETE", credentials: "same-origin" },
    ));
  }

  async saveLayout(id: string, layout: LayoutNode | null): Promise<LayoutNode | null> {
    const body = await readJson<{ layout: LayoutNode | null }>(await this.fetchImpl(`/api/workspaces/${encodeURIComponent(id)}/layout`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ layout }),
    }));
    return body.layout ?? null;
  }

  // ── 任务 ──

  async listTasks(workspaceId: string): Promise<WorkspaceTask[]> {
    const body = await readJson<unknown>(await this.fetchImpl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/tasks`,
      { credentials: "same-origin" },
    ));
    return Array.isArray(body) ? (body as WorkspaceTask[]) : [];
  }

  async createTask(workspaceId: string, request: CreateWorkspaceTaskRequest): Promise<WorkspaceTaskDetail> {
    return readJson<WorkspaceTaskDetail>(await this.fetchImpl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/tasks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(request),
      },
    ));
  }

  async getTask(taskId: string): Promise<WorkspaceTaskDetail> {
    return readJson<WorkspaceTaskDetail>(await this.fetchImpl(
      `/api/workspace-tasks/${encodeURIComponent(taskId)}`,
      { credentials: "same-origin" },
    ));
  }

  async updateTask(taskId: string, patch: UpdateWorkspaceTaskRequest): Promise<WorkspaceTask> {
    return readJson<WorkspaceTask>(await this.fetchImpl(
      `/api/workspace-tasks/${encodeURIComponent(taskId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(patch),
      },
    ));
  }

  async deleteTask(taskId: string, cascade = false): Promise<void> {
    await readJson(await this.fetchImpl(
      `/api/workspace-tasks/${encodeURIComponent(taskId)}${cascade ? "?cascade=1" : ""}`,
      { method: "DELETE", credentials: "same-origin" },
    ));
  }

  async saveTaskLayout(taskId: string, layout: TaskWindowLayout | null): Promise<TaskWindowLayout | null> {
    const body = await readJson<{ layout: TaskWindowLayout | null }>(await this.fetchImpl(
      `/api/workspace-tasks/${encodeURIComponent(taskId)}/layout`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ layout }),
      },
    ));
    return body.layout ?? null;
  }

  async listWorktrees(
    workspaceId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkspaceWorktreeOverview> {
    const body = await readJson<unknown>(await this.fetchImpl(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/worktrees`,
      { credentials: "same-origin", signal: options.signal },
    ));
    return normalizeWorkspaceWorktreeOverview(body);
  }

  async deleteSessions(sessionIds: readonly string[]): Promise<void> {
    const ids = [...new Set(sessionIds.filter((id) => typeof id === "string" && id.trim().length > 0))];
    if (ids.length === 0) return;
    const body = await readJson<{ failed?: string[] }>(await this.fetchImpl("/api/sessions/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ sessionIds: ids }),
    }));
    if (Array.isArray(body.failed) && body.failed.length > 0) {
      throw new Error(`有 ${body.failed.length} 个终端无法关闭。`);
    }
  }
}

/** 加载新建项目默认值：默认 provider + 默认 cwd + 最近目录。镜像 new-session 的 load()。 */
export async function loadNewProjectDefaults(
  fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  options: { signal?: AbortSignal } = {},
): Promise<NewProjectDefaults> {
  const [configRes, recentRes] = await Promise.all([
    fetchImpl("/api/config", { credentials: "same-origin", signal: options.signal }),
    fetchImpl("/api/recent-paths", { credentials: "same-origin", signal: options.signal }),
  ]);
  const config = await readJson(configRes);
  let recentPaths: RecentPath[] = [];
  if (recentRes.ok) {
    try {
      recentPaths = normalizePaths(await recentRes.json());
    } catch {
      recentPaths = [];
    }
  }
  return {
    defaultProvider: parseProvider(config.defaultProvider) ?? "claude",
    defaultCwd: text(config.defaultCwd),
    recentPaths,
  };
}

/** 路径自动补全。镜像 new-session 的 suggestPaths()。 */
export async function suggestWorkspacePaths(
  query: string,
  fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  options: { signal?: AbortSignal } = {},
): Promise<RecentPath[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const response = await fetchImpl(`/api/path-suggestions?q=${encodeURIComponent(trimmed)}`, {
    credentials: "same-origin",
    signal: options.signal,
  });
  if (!response.ok) return [];
  return normalizePaths(await response.json());
}

export const httpWorkspacesRepository = new HttpWorkspacesRepository();
