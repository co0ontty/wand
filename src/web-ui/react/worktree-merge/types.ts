export type WorktreeMergeIntent = "merge" | "cleanup";

export type WorktreeMergeStatus =
  | "ready"
  | "checking"
  | "merging"
  | "merged"
  | "failed";

export interface WorktreeMergeOpenContext {
  sessionId: string;
  intent: WorktreeMergeIntent;
  sourceBranch?: string;
  worktreePath?: string;
  targetBranch?: string;
  sessionStatus?: string;
  mergeStatus?: WorktreeMergeStatus;
  cleanupPending?: boolean;
}

export interface WorktreeMergeCommit {
  hash: string;
  shortHash: string;
  subject: string;
}

export type WorktreeMergeRecommendedAction = "merge" | "noop" | "resolve-conflict";

export interface WorktreeMergeInspection {
  ok: boolean;
  sourceBranch: string;
  targetBranch: string;
  worktreePath: string;
  repoRoot: string;
  hasUncommittedChanges: boolean;
  aheadCount: number;
  hasConflicts: boolean;
  recommendedAction: WorktreeMergeRecommendedAction;
  reason: string;
  commits: readonly WorktreeMergeCommit[];
}

export interface WorktreeMergeResult {
  ok: boolean;
  sourceBranch: string;
  targetBranch: string;
  repoRoot: string;
  mergeCommit: string;
  mergedAt: string;
  cleanupDone: boolean;
  conflict: boolean;
  errorCode: string;
  reason: string;
}

export interface WorktreeCleanupResult {
  ok: boolean;
}

export interface WorktreeMergeLoadOptions {
  signal?: AbortSignal;
}

/** Remote-owned seam for check, merge, and compensating cleanup. */
export interface WorktreeMergeRepository {
  inspect(
    sessionId: string,
    options?: WorktreeMergeLoadOptions,
  ): Promise<WorktreeMergeInspection>;
  merge(sessionId: string): Promise<WorktreeMergeResult>;
  cleanup(sessionId: string): Promise<WorktreeCleanupResult>;
}

export type WorktreeMergeToastTone = "success" | "error" | "info";

/** Narrow adapter back to the streaming shell; React owns no legacy state or DOM. */
export interface WorktreeMergeRuntimeAdapter {
  onOpen(context: WorktreeMergeOpenContext): void;
  onClose(context: WorktreeMergeOpenContext): void;
  onRepositoryChanged(sessionId: string): void;
  toast(message: string, tone: WorktreeMergeToastTone): void;
}
