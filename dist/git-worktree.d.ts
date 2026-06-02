import { SessionSnapshot, WorktreeMergeCheckResult, WorktreeMergeResult } from "./types.js";
interface WorktreeSetupOptions {
    cwd: string;
    sessionId: string;
}
interface WorktreeSetupResult {
    cwd: string;
    worktreeEnabled: boolean;
    worktree: NonNullable<SessionSnapshot["worktree"]>;
}
interface WorktreeOperationOptions {
    worktree: NonNullable<SessionSnapshot["worktree"]>;
}
interface WorktreeMergeOptions extends WorktreeOperationOptions {
    targetBranch?: string;
}
export declare class WorktreeMergeError extends Error {
    readonly code: string;
    readonly result?: Partial<WorktreeMergeResult> | undefined;
    constructor(code: string, message: string, result?: Partial<WorktreeMergeResult> | undefined);
}
export declare function getDefaultBaseBranch(repoRoot: string): string;
export declare function getWorktreeMergeErrorCode(error: unknown): string | undefined;
export declare function checkSessionWorktreeMergeability(options: WorktreeMergeOptions): WorktreeMergeCheckResult;
export declare function cleanupSessionWorktree(options: WorktreeOperationOptions): boolean;
export declare function mergeSessionWorktree(options: WorktreeMergeOptions): WorktreeMergeResult;
export declare function prepareSessionWorktree(options: WorktreeSetupOptions): WorktreeSetupResult;
export {};
