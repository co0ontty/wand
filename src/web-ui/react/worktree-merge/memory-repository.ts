import type {
  WorktreeCleanupResult,
  WorktreeMergeInspection,
  WorktreeMergeLoadOptions,
  WorktreeMergeRepository,
  WorktreeMergeResult,
} from "./types";

export type WorktreeMergeOperation = "inspect" | "merge" | "cleanup";

export interface MemoryWorktreeMergeSeed {
  inspection: WorktreeMergeInspection;
  mergeResult: WorktreeMergeResult;
  cleanupResult?: WorktreeCleanupResult;
  errors?: Partial<Record<WorktreeMergeOperation, Error>>;
}

/** Deterministic second adapter at the repository seam. */
export class MemoryWorktreeMergeRepository implements WorktreeMergeRepository {
  readonly calls: Array<{ operation: WorktreeMergeOperation; sessionId: string }> = [];

  constructor(public seed: MemoryWorktreeMergeSeed) {}

  private result<T>(operation: WorktreeMergeOperation, sessionId: string, value: T): T {
    this.calls.push({ operation, sessionId });
    const error = this.seed.errors?.[operation];
    if (error) throw error;
    return structuredClone(value);
  }

  async inspect(
    sessionId: string,
    options: WorktreeMergeLoadOptions = {},
  ): Promise<WorktreeMergeInspection> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return this.result("inspect", sessionId, this.seed.inspection);
  }

  async merge(sessionId: string): Promise<WorktreeMergeResult> {
    return this.result("merge", sessionId, this.seed.mergeResult);
  }

  async cleanup(sessionId: string): Promise<WorktreeCleanupResult> {
    return this.result("cleanup", sessionId, this.seed.cleanupResult ?? { ok: true });
  }
}
