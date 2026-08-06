import type { UiNativeHistoryProvider } from "./ui-store";

export interface DirectoryManagedSession {
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

export interface DirectoryHistorySession {
  claudeSessionId: string;
  provider?: UiNativeHistoryProvider;
  cwd?: string;
  firstUserMessage?: string;
  timestamp?: string;
  mtimeMs?: number;
}

export type DirectorySessionEntry =
  | { type: "managed"; key: string; sortTimestamp: number; session: DirectoryManagedSession }
  | { type: "recoverable"; key: string; sortTimestamp: number; history: DirectoryHistorySession };

export interface SessionDirectoryNode {
  path: string;
  name: string;
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
}

export const httpSessionDirectoryRepository = new HttpSessionDirectoryRepository();
