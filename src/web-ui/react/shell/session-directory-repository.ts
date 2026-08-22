interface DirectoryManagedSession {
  id: string;
  sessionSource?: string;
  provider?: string;
  sessionKind?: string;
  title?: string;
  description?: string;
  cwd?: string;
  status?: string;
  permissionBlocked?: boolean;
  structuredState?: { inFlight?: boolean } | null;
  startedAt?: string;
  endedAt?: string;
  claudeSessionId?: string;
  titleGenerating?: boolean;
  worktree?: {
    enabled?: boolean;
    branch?: string;
    path?: string;
    mergeStatus?: string;
  } | null;
  worktreeEnabled?: boolean;
  worktreeBranch?: string;
  worktreePath?: string;
  worktreeMergeStatus?: string;
}

export type DirectorySessionEntry = {
  type: "managed";
  key: string;
  sortTimestamp: number;
  session: DirectoryManagedSession;
};

export interface SessionDirectoryNode {
  path: string;
  name: string;
  customName?: string;
  synthetic: boolean;
  directCount: number;
  totalCount: number;
  latestTimestamp: number;
  entries: DirectorySessionEntry[];
  children: SessionDirectoryNode[];
}

export interface SessionDirectoryResponse {
  roots: SessionDirectoryNode[];
  totalSessions: number;
  directoryCount: number;
  revision: string;
  treeRevision?: string;
}

export interface SessionDirectoryRenameResult {
  ok: true;
  path: string;
  name: string | null;
}

type FetchLike = typeof fetch;

export class HttpSessionDirectoryRepository {
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}

  async load(signal?: AbortSignal): Promise<SessionDirectoryResponse> {
    const response = await this.fetchImpl("/api/session-directories", {
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) throw new Error("无法加载会话目录");
    return response.json() as Promise<SessionDirectoryResponse>;
  }

  async rename(
    path: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<SessionDirectoryRenameResult> {
    const response = await this.fetchImpl("/api/session-directories/name", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      signal,
      body: JSON.stringify({ path, name: name.trim() }),
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = null;
    }
    if (!response.ok) {
      const message = value && typeof value === "object" && "error" in value
        && typeof value.error === "string"
        ? value.error
        : `无法更新工作区名称 (HTTP ${response.status})`;
      throw new Error(message);
    }
    const result = value as Partial<SessionDirectoryRenameResult> | null;
    if (result?.ok !== true || typeof result.path !== "string") {
      throw new Error("服务端未返回有效的工作区名称。");
    }
    return {
      ok: true,
      path: result.path,
      name: typeof result.name === "string" ? result.name : null,
    };
  }
}

export const httpSessionDirectoryRepository = new HttpSessionDirectoryRepository();
