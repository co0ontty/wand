import type {
  WorktreeCleanupResult,
  WorktreeMergeCommit,
  WorktreeMergeInspection,
  WorktreeMergeLoadOptions,
  WorktreeMergeRecommendedAction,
  WorktreeMergeRepository,
  WorktreeMergeResult,
} from "./types";

type FetchLike = typeof fetch;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function recommendedAction(value: unknown): WorktreeMergeRecommendedAction {
  return value === "noop" || value === "resolve-conflict" ? value : "merge";
}

function normalizeCommits(value: unknown): WorktreeMergeCommit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.hash !== "string" || !item.hash) return [];
    return [{
      hash: item.hash,
      shortHash: text(item.shortHash, item.hash.slice(0, 7)),
      subject: text(item.subject, text(item.message)),
    }];
  });
}

export function normalizeWorktreeMergeInspection(value: unknown): WorktreeMergeInspection {
  const result = isRecord(value) ? value : {};
  return {
    ok: result.ok === true,
    sourceBranch: text(result.sourceBranch),
    targetBranch: text(result.targetBranch),
    worktreePath: text(result.worktreePath),
    repoRoot: text(result.repoRoot),
    hasUncommittedChanges: result.hasUncommittedChanges === true,
    aheadCount: Math.max(0, finiteNumber(result.aheadCount)),
    hasConflicts: result.hasConflicts === true,
    recommendedAction: recommendedAction(result.recommendedAction),
    reason: text(result.reason),
    commits: normalizeCommits(result.commits),
  };
}

export function normalizeWorktreeMergeResult(value: unknown): WorktreeMergeResult {
  const result = isRecord(value) ? value : {};
  return {
    ok: result.ok === true,
    sourceBranch: text(result.sourceBranch),
    targetBranch: text(result.targetBranch),
    repoRoot: text(result.repoRoot),
    mergeCommit: text(result.mergeCommit),
    mergedAt: text(result.mergedAt),
    cleanupDone: result.cleanupDone === true,
    conflict: result.conflict === true,
    errorCode: text(result.errorCode),
    reason: text(result.reason),
  };
}

export class WorktreeMergeRepositoryError extends Error {
  constructor(
    message: string,
    public readonly code = "",
    public readonly result: WorktreeMergeResult | null = null,
    public readonly status = 0,
  ) {
    super(message);
    this.name = "WorktreeMergeRepositoryError";
  }
}

async function readRecord(response: Response, fallback: string): Promise<JsonRecord> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new WorktreeMergeRepositoryError(`${fallback} (HTTP ${response.status})`, "", null, response.status);
  }
  const record = isRecord(value) ? value : {};
  if (!response.ok || typeof record.error === "string") {
    throw new WorktreeMergeRepositoryError(
      text(record.error, `${fallback} (HTTP ${response.status})`),
      text(record.errorCode),
      isRecord(record.result) ? normalizeWorktreeMergeResult(record.result) : null,
      response.status,
    );
  }
  return record;
}

export class HttpWorktreeMergeRepository implements WorktreeMergeRepository {
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}

  async inspect(
    sessionId: string,
    options: WorktreeMergeLoadOptions = {},
  ): Promise<WorktreeMergeInspection> {
    const response = await this.fetchImpl(
      `/api/sessions/${encodeURIComponent(sessionId)}/worktree/merge/check`,
      { method: "POST", credentials: "same-origin", signal: options.signal },
    );
    const data = await readRecord(response, "无法检查 worktree 合并状态。");
    if (!isRecord(data.result)) throw new WorktreeMergeRepositoryError("服务端未返回合并检查结果。");
    return normalizeWorktreeMergeInspection(data.result);
  }

  async merge(sessionId: string): Promise<WorktreeMergeResult> {
    const response = await this.fetchImpl(
      `/api/sessions/${encodeURIComponent(sessionId)}/worktree/merge`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    const data = await readRecord(response, "无法合并 worktree。");
    if (!isRecord(data.result)) throw new WorktreeMergeRepositoryError("服务端未返回 worktree 合并结果。");
    return normalizeWorktreeMergeResult(data.result);
  }

  async cleanup(sessionId: string): Promise<WorktreeCleanupResult> {
    const response = await this.fetchImpl(
      `/api/sessions/${encodeURIComponent(sessionId)}/worktree/cleanup`,
      { method: "POST", credentials: "same-origin" },
    );
    const data = await readRecord(response, "无法清理 worktree。");
    return { ok: data.ok === true };
  }
}

export const httpWorktreeMergeRepository = new HttpWorktreeMergeRepository();
