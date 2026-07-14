import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { SessionSnapshot, WorktreeMergeCheckResult, WorktreeMergeResult } from "./types.js";
import { runGit, runGitAsync, getGitErrorMessage } from "./git-utils.js";

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
  /** Primarily exposed for bounded request handling and deterministic tests. */
  gitTimeoutMs?: number;
}

interface WorktreeMergeOptions extends WorktreeOperationOptions {
  targetBranch?: string;
}


const WORKTREE_MERGE_ERROR_CODES = {
  MISSING: "WORKTREE_MISSING",
  DIRTY: "WORKTREE_DIRTY",
  TARGET_MISSING: "TARGET_BRANCH_MISSING",
  NOTHING_TO_MERGE: "NOTHING_TO_MERGE",
  CONFLICT: "WORKTREE_MERGE_CONFLICT",
  CLEANUP_FAILED: "WORKTREE_CLEANUP_FAILED",
} as const;

export class WorktreeMergeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly result?: Partial<WorktreeMergeResult>
  ) {
    super(message);
    this.name = "WorktreeMergeError";
  }
}

interface MergeContext {
  repoRoot: string;
  worktreePath: string;
  sourceBranch: string;
  targetBranch: string;
  gitTimeoutMs: number;
}

interface CheckedMergeContext extends MergeContext {
  aheadCount: number;
}

interface CheckoutState {
  branch: string | null;
  head: string;
}

const DEFAULT_WORKTREE_GIT_TIMEOUT_MS = 30_000;

function resolveGitTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_WORKTREE_GIT_TIMEOUT_MS;
}

function runWorktreeGit(args: string[], cwd: string, timeoutMs: number): string {
  return runGit(args, cwd, { timeout: timeoutMs });
}

function sanitizeBranchSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "session";
}

function getCurrentBranch(repoRoot: string, timeoutMs = DEFAULT_WORKTREE_GIT_TIMEOUT_MS): string {
  const branch = runWorktreeGit(["branch", "--show-current"], repoRoot, timeoutMs);
  return branch || "master";
}


function refExists(repoRoot: string, ref: string, timeoutMs = DEFAULT_WORKTREE_GIT_TIMEOUT_MS): boolean {
  try {
    runWorktreeGit(["rev-parse", "--verify", ref], repoRoot, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

function getRepoRootFromWorktree(worktreePath: string, timeoutMs = DEFAULT_WORKTREE_GIT_TIMEOUT_MS): string {
  const repoRoot = runWorktreeGit(["rev-parse", "--show-toplevel"], worktreePath, timeoutMs);
  if (!repoRoot || !existsSync(repoRoot)) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.MISSING, "Worktree 仓库根目录不存在。", {
      cleanupDone: false,
      conflict: false,
    });
  }
  return repoRoot;
}

function ensureWorktreePath(worktree: NonNullable<SessionSnapshot["worktree"]>): string {
  const worktreePath = path.resolve(worktree.path);
  if (!existsSync(worktreePath)) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.MISSING, "Worktree 目录不存在，可能已被手动删除。", {
      cleanupDone: false,
      conflict: false,
    });
  }
  return worktreePath;
}

function getMainRepoRoot(repoRoot: string, timeoutMs = DEFAULT_WORKTREE_GIT_TIMEOUT_MS): string {
  const commonDir = runWorktreeGit(["rev-parse", "--git-common-dir"], repoRoot, timeoutMs);
  if (commonDir) {
    const maybeRoot = path.resolve(repoRoot, commonDir, "..");
    if (existsSync(maybeRoot)) {
      return maybeRoot;
    }
  }
  return repoRoot;
}

export function getDefaultBaseBranch(repoRoot: string, timeoutMs = DEFAULT_WORKTREE_GIT_TIMEOUT_MS): string {
  try {
    const symbolicRef = runWorktreeGit(["symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot, timeoutMs);
    const match = symbolicRef.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match && match[1]) {
      return match[1];
    }
  } catch {
    // ignore and fallback below
  }

  const candidates = ["master", "main", getCurrentBranch(repoRoot, timeoutMs)];
  for (const candidate of candidates) {
    if (candidate && refExists(repoRoot, candidate, timeoutMs)) {
      return candidate;
    }
  }
  return "master";
}

function getMainRepoContext(options: WorktreeMergeOptions): MergeContext {
  const gitTimeoutMs = resolveGitTimeout(options.gitTimeoutMs);
  const worktreePath = ensureWorktreePath(options.worktree);
  const worktreeRepoRoot = getRepoRootFromWorktree(worktreePath, gitTimeoutMs);
  const repoRoot = getMainRepoRoot(worktreeRepoRoot, gitTimeoutMs);
  const sourceBranch = options.worktree.branch;
  if (!refExists(repoRoot, sourceBranch, gitTimeoutMs)) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.MISSING, "Worktree 分支不存在，可能已被手动删除。", {
      cleanupDone: false,
      conflict: false,
    });
  }
  const targetBranch = options.targetBranch?.trim() || getDefaultBaseBranch(repoRoot, gitTimeoutMs);
  if (!refExists(repoRoot, targetBranch, gitTimeoutMs)) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.TARGET_MISSING, `目标分支不存在：${targetBranch}`, {
      cleanupDone: false,
      conflict: false,
      targetBranch,
    });
  }
  return { repoRoot, worktreePath, sourceBranch, targetBranch, gitTimeoutMs };
}

function hasUncommittedChanges(worktreePath: string, timeoutMs = DEFAULT_WORKTREE_GIT_TIMEOUT_MS): boolean {
  const worktreeRepoRoot = getRepoRootFromWorktree(worktreePath, timeoutMs);
  return runWorktreeGit(["status", "--porcelain"], worktreeRepoRoot, timeoutMs).length > 0;
}

function getAheadCount(repoRoot: string, targetBranch: string, sourceBranch: string, timeoutMs = DEFAULT_WORKTREE_GIT_TIMEOUT_MS): number {
  const count = runWorktreeGit(["rev-list", "--count", `${targetBranch}..${sourceBranch}`], repoRoot, timeoutMs);
  return Number.parseInt(count || "0", 10) || 0;
}

function checkConflicts(repoRoot: string, targetBranch: string, sourceBranch: string, timeoutMs = DEFAULT_WORKTREE_GIT_TIMEOUT_MS): boolean {
  try {
    runWorktreeGit(["merge-tree", targetBranch, sourceBranch], repoRoot, timeoutMs);
    return false;
  } catch {
    return true;
  }
}

function ensureMergeableContext(options: WorktreeMergeOptions): CheckedMergeContext {
  const context = getMainRepoContext(options);
  if (hasUncommittedChanges(context.worktreePath, context.gitTimeoutMs)) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.DIRTY, "Worktree 中仍有未提交改动，请先提交后再合并。", {
      sourceBranch: context.sourceBranch,
      targetBranch: context.targetBranch,
      repoRoot: context.repoRoot,
      cleanupDone: false,
      conflict: false,
    });
  }
  const aheadCount = getAheadCount(context.repoRoot, context.targetBranch, context.sourceBranch, context.gitTimeoutMs);
  if (aheadCount <= 0) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.NOTHING_TO_MERGE, "当前 worktree 没有可合并到主分支的新提交。", {
      sourceBranch: context.sourceBranch,
      targetBranch: context.targetBranch,
      repoRoot: context.repoRoot,
      cleanupDone: false,
      conflict: false,
    });
  }
  return { ...context, aheadCount };
}

function buildCheckResult(
  context: MergeContext,
  aheadCount: number,
  hasDirtyChanges: boolean,
  hasConflicts: boolean
): WorktreeMergeCheckResult {
  const ok = !hasDirtyChanges && aheadCount > 0 && !hasConflicts;
  return {
    ok,
    sourceBranch: context.sourceBranch,
    targetBranch: context.targetBranch,
    worktreePath: context.worktreePath,
    repoRoot: context.repoRoot,
    hasUncommittedChanges: hasDirtyChanges,
    aheadCount,
    hasConflicts,
    recommendedAction: hasConflicts ? "resolve-conflict" : aheadCount > 0 ? "merge" : "noop",
    reason: hasDirtyChanges
      ? "Worktree 中仍有未提交改动。"
      : aheadCount <= 0
        ? "当前 worktree 没有可合并的新提交。"
        : hasConflicts
          ? "检测到潜在冲突，请先处理。"
          : undefined,
  };
}

function getHeadCommit(repoRoot: string, timeoutMs = DEFAULT_WORKTREE_GIT_TIMEOUT_MS): string {
  return runWorktreeGit(["rev-parse", "HEAD"], repoRoot, timeoutMs);
}

function captureCheckoutState(context: MergeContext): CheckoutState {
  let branch: string | null = null;
  try {
    branch = runWorktreeGit(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      context.repoRoot,
      context.gitTimeoutMs
    ) || null;
  } catch {
    // A detached HEAD is a valid state and must be restored as such.
  }
  return {
    branch,
    head: getHeadCommit(context.repoRoot, context.gitTimeoutMs),
  };
}

function isMergeInProgress(repoRoot: string, timeoutMs: number): boolean {
  try {
    runWorktreeGit(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], repoRoot, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

function describeRollbackError(label: string, error: unknown): string {
  const detail = getGitErrorMessage(error);
  return detail ? `${label}：${detail}` : label;
}

function rollbackFailedMerge(
  context: MergeContext,
  originalState: CheckoutState,
  targetHead: string
): string[] {
  const errors: string[] = [];
  // The merge itself may have used a deliberately short request timeout. Give
  // the local, non-networked recovery commands enough time to complete.
  const recoveryTimeoutMs = Math.max(context.gitTimeoutMs, 1_000);
  const attempt = (label: string, action: () => void): void => {
    try {
      action();
    } catch (error) {
      errors.push(describeRollbackError(label, error));
    }
  };

  if (isMergeInProgress(context.repoRoot, recoveryTimeoutMs)) {
    attempt("git merge --abort 失败", () => {
      runWorktreeGit(["merge", "--abort"], context.repoRoot, recoveryTimeoutMs);
    });
  }

  // A timeout can happen after Git has created the merge commit (for example,
  // in a long-running post-merge hook), in which case MERGE_HEAD is already
  // gone. Reset the target branch explicitly before restoring the old checkout.
  let currentBranch: string | null = null;
  try {
    currentBranch = runWorktreeGit(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      context.repoRoot,
      recoveryTimeoutMs
    ) || null;
  } catch {
    // Detached HEAD, or a transient repository error handled by validation.
  }

  if (currentBranch === context.targetBranch) {
    attempt("恢复目标分支 HEAD 失败", () => {
      const currentHead = getHeadCommit(context.repoRoot, recoveryTimeoutMs);
      if (currentHead !== targetHead) {
        runWorktreeGit(["reset", "--merge", targetHead], context.repoRoot, recoveryTimeoutMs);
      }
    });
  }

  if (originalState.branch) {
    attempt("恢复原分支失败", () => {
      const branch = runWorktreeGit(
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        context.repoRoot,
        recoveryTimeoutMs
      );
      if (branch !== originalState.branch) {
        runWorktreeGit(["checkout", "--quiet", originalState.branch!], context.repoRoot, recoveryTimeoutMs);
      }
    });
    attempt("恢复原分支 HEAD 失败", () => {
      const currentHead = getHeadCommit(context.repoRoot, recoveryTimeoutMs);
      if (currentHead !== originalState.head) {
        runWorktreeGit(["reset", "--merge", originalState.head], context.repoRoot, recoveryTimeoutMs);
      }
    });
  } else {
    attempt("恢复 detached HEAD 失败", () => {
      const branch = runWorktreeGit(["branch", "--show-current"], context.repoRoot, recoveryTimeoutMs);
      const currentHead = getHeadCommit(context.repoRoot, recoveryTimeoutMs);
      if (branch || currentHead !== originalState.head) {
        runWorktreeGit(["checkout", "--quiet", "--detach", originalState.head], context.repoRoot, recoveryTimeoutMs);
      }
    });
  }

  if (isMergeInProgress(context.repoRoot, recoveryTimeoutMs)) {
    errors.push("恢复后仓库仍存在未完成的 merge");
  }
  attempt("校验目标分支 HEAD 失败", () => {
    const restoredTargetHead = runWorktreeGit(
      ["rev-parse", context.targetBranch],
      context.repoRoot,
      recoveryTimeoutMs
    );
    if (restoredTargetHead !== targetHead) {
      throw new Error(`期望 ${targetHead}，实际 ${restoredTargetHead}`);
    }
  });
  attempt("校验原 checkout 状态失败", () => {
    const restored = captureCheckoutState({ ...context, gitTimeoutMs: recoveryTimeoutMs });
    if (restored.branch !== originalState.branch || restored.head !== originalState.head) {
      throw new Error(
        `期望 ${originalState.branch ?? "detached"}@${originalState.head}，` +
        `实际 ${restored.branch ?? "detached"}@${restored.head}`
      );
    }
  });

  return errors;
}

function cleanupMergedWorktree(context: MergeContext): boolean {
  runWorktreeGit(["worktree", "remove", context.worktreePath], context.repoRoot, context.gitTimeoutMs);
  runWorktreeGit(["branch", "-d", context.sourceBranch], context.repoRoot, context.gitTimeoutMs);
  return true;
}

export function getWorktreeMergeErrorCode(error: unknown): string | undefined {
  return error instanceof WorktreeMergeError ? error.code : undefined;
}

export function checkSessionWorktreeMergeability(options: WorktreeMergeOptions): WorktreeMergeCheckResult {
  const context = getMainRepoContext(options);
  const hasDirtyChanges = hasUncommittedChanges(context.worktreePath, context.gitTimeoutMs);
  const aheadCount = getAheadCount(
    context.repoRoot,
    context.targetBranch,
    context.sourceBranch,
    context.gitTimeoutMs
  );
  const hasConflicts = !hasDirtyChanges && aheadCount > 0
    ? checkConflicts(context.repoRoot, context.targetBranch, context.sourceBranch, context.gitTimeoutMs)
    : false;
  return buildCheckResult(context, aheadCount, hasDirtyChanges, hasConflicts);
}

export function cleanupSessionWorktree(options: WorktreeOperationOptions): boolean {
  const context = getMainRepoContext(options);
  return cleanupMergedWorktree(context);
}

export function mergeSessionWorktree(options: WorktreeMergeOptions): WorktreeMergeResult {
  const context = ensureMergeableContext(options);
  const hasConflicts = checkConflicts(
    context.repoRoot,
    context.targetBranch,
    context.sourceBranch,
    context.gitTimeoutMs
  );
  if (hasConflicts) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.CONFLICT, "合并检测到冲突，请先手动处理。", {
      sourceBranch: context.sourceBranch,
      targetBranch: context.targetBranch,
      repoRoot: context.repoRoot,
      cleanupDone: false,
      conflict: true,
    });
  }

  const originalState = captureCheckoutState(context);
  const targetHead = runWorktreeGit(
    ["rev-parse", context.targetBranch],
    context.repoRoot,
    context.gitTimeoutMs
  );
  if (isMergeInProgress(context.repoRoot, context.gitTimeoutMs)) {
    throw new WorktreeMergeError(
      WORKTREE_MERGE_ERROR_CODES.CONFLICT,
      "主工作区已有未完成的 merge，请先处理后再合并 worktree。",
      {
        sourceBranch: context.sourceBranch,
        targetBranch: context.targetBranch,
        repoRoot: context.repoRoot,
        cleanupDone: false,
        conflict: true,
      }
    );
  }

  try {
    runWorktreeGit(["checkout", context.targetBranch], context.repoRoot, context.gitTimeoutMs);
    runWorktreeGit(
      ["merge", "--no-ff", "--no-edit", "--no-gpg-sign", context.sourceBranch],
      context.repoRoot,
      context.gitTimeoutMs
    );
  } catch (error) {
    const message = getGitErrorMessage(error);
    const rollbackErrors = rollbackFailedMerge(context, originalState, targetHead);
    const rollbackMessage = rollbackErrors.length > 0
      ? `\n自动恢复主工作区时仍有问题：${rollbackErrors.join("；")}`
      : "\n主工作区已恢复到合并前状态。";
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.CONFLICT, `${message || "合并失败，可能存在冲突。"}${rollbackMessage}`, {
      sourceBranch: context.sourceBranch,
      targetBranch: context.targetBranch,
      repoRoot: context.repoRoot,
      cleanupDone: false,
      conflict: true,
    });
  }

  const mergedAt = new Date().toISOString();
  const mergeCommit = getHeadCommit(context.repoRoot, context.gitTimeoutMs);
  try {
    cleanupMergedWorktree(context);
    return {
      ok: true,
      sourceBranch: context.sourceBranch,
      targetBranch: context.targetBranch,
      repoRoot: context.repoRoot,
      mergeCommit,
      mergedAt,
      cleanupDone: true,
      conflict: false,
    };
  } catch (error) {
    throw new WorktreeMergeError(
      WORKTREE_MERGE_ERROR_CODES.CLEANUP_FAILED,
      getGitErrorMessage(error) || "已合并，但清理 worktree 失败。",
      {
        sourceBranch: context.sourceBranch,
        targetBranch: context.targetBranch,
        repoRoot: context.repoRoot,
        mergeCommit,
        mergedAt,
        cleanupDone: false,
        conflict: false,
      }
    );
  }
}

function runWorktreeGitAsync(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return runGitAsync(args, cwd, { timeout: timeoutMs });
}

async function refExistsAsync(repoRoot: string, ref: string, timeoutMs: number): Promise<boolean> {
  try {
    await runWorktreeGitAsync(["rev-parse", "--verify", ref], repoRoot, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function getRepoRootFromWorktreeAsync(worktreePath: string, timeoutMs: number): Promise<string> {
  const repoRoot = await runWorktreeGitAsync(["rev-parse", "--show-toplevel"], worktreePath, timeoutMs);
  if (!repoRoot || !existsSync(repoRoot)) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.MISSING, "Worktree 仓库根目录不存在。", {
      cleanupDone: false,
      conflict: false,
    });
  }
  return repoRoot;
}

async function getMainRepoRootAsync(repoRoot: string, timeoutMs: number): Promise<string> {
  const commonDir = await runWorktreeGitAsync(["rev-parse", "--git-common-dir"], repoRoot, timeoutMs);
  if (commonDir) {
    const maybeRoot = path.resolve(repoRoot, commonDir, "..");
    if (existsSync(maybeRoot)) return maybeRoot;
  }
  return repoRoot;
}

async function getDefaultBaseBranchAsync(repoRoot: string, timeoutMs: number): Promise<string> {
  try {
    const symbolicRef = await runWorktreeGitAsync(["symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot, timeoutMs);
    const match = symbolicRef.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) return match[1];
  } catch { /* use local branches */ }
  let current = "master";
  try { current = await runWorktreeGitAsync(["branch", "--show-current"], repoRoot, timeoutMs) || "master"; } catch { /* fallback */ }
  for (const candidate of ["master", "main", current]) {
    if (candidate && await refExistsAsync(repoRoot, candidate, timeoutMs)) return candidate;
  }
  return "master";
}

async function getMainRepoContextAsync(options: WorktreeMergeOptions): Promise<MergeContext> {
  const gitTimeoutMs = resolveGitTimeout(options.gitTimeoutMs);
  const worktreePath = ensureWorktreePath(options.worktree);
  const worktreeRepoRoot = await getRepoRootFromWorktreeAsync(worktreePath, gitTimeoutMs);
  const repoRoot = await getMainRepoRootAsync(worktreeRepoRoot, gitTimeoutMs);
  const sourceBranch = options.worktree.branch;
  if (!await refExistsAsync(repoRoot, sourceBranch, gitTimeoutMs)) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.MISSING, "Worktree 分支不存在，可能已被手动删除。", {
      cleanupDone: false,
      conflict: false,
    });
  }
  const targetBranch = options.targetBranch?.trim() || await getDefaultBaseBranchAsync(repoRoot, gitTimeoutMs);
  if (!await refExistsAsync(repoRoot, targetBranch, gitTimeoutMs)) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.TARGET_MISSING, `目标分支不存在：${targetBranch}`, {
      cleanupDone: false,
      conflict: false,
      targetBranch,
    });
  }
  return { repoRoot, worktreePath, sourceBranch, targetBranch, gitTimeoutMs };
}

async function checkConflictsAsync(context: MergeContext): Promise<boolean> {
  try {
    await runWorktreeGitAsync(["merge-tree", context.targetBranch, context.sourceBranch], context.repoRoot, context.gitTimeoutMs);
    return false;
  } catch {
    return true;
  }
}

async function captureCheckoutStateAsync(context: MergeContext): Promise<CheckoutState> {
  let branch: string | null = null;
  try {
    branch = await runWorktreeGitAsync(["symbolic-ref", "--quiet", "--short", "HEAD"], context.repoRoot, context.gitTimeoutMs) || null;
  } catch { /* detached HEAD */ }
  return {
    branch,
    head: await runWorktreeGitAsync(["rev-parse", "HEAD"], context.repoRoot, context.gitTimeoutMs),
  };
}

async function isMergeInProgressAsync(repoRoot: string, timeoutMs: number): Promise<boolean> {
  try {
    await runWorktreeGitAsync(["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], repoRoot, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function rollbackFailedMergeAsync(
  context: MergeContext,
  originalState: CheckoutState,
  targetHead: string,
): Promise<string[]> {
  const errors: string[] = [];
  const timeoutMs = Math.max(context.gitTimeoutMs, 1_000);
  const attempt = async (label: string, action: () => Promise<void>): Promise<void> => {
    try { await action(); } catch (error) { errors.push(describeRollbackError(label, error)); }
  };

  if (await isMergeInProgressAsync(context.repoRoot, timeoutMs)) {
    await attempt("git merge --abort 失败", async () => {
      await runWorktreeGitAsync(["merge", "--abort"], context.repoRoot, timeoutMs);
    });
  }

  let currentBranch: string | null = null;
  try {
    currentBranch = await runWorktreeGitAsync(["symbolic-ref", "--quiet", "--short", "HEAD"], context.repoRoot, timeoutMs) || null;
  } catch { /* detached */ }
  if (currentBranch === context.targetBranch) {
    await attempt("恢复目标分支 HEAD 失败", async () => {
      const currentHead = await runWorktreeGitAsync(["rev-parse", "HEAD"], context.repoRoot, timeoutMs);
      if (currentHead !== targetHead) await runWorktreeGitAsync(["reset", "--merge", targetHead], context.repoRoot, timeoutMs);
    });
  }

  if (originalState.branch) {
    await attempt("恢复原分支失败", async () => {
      const branch = await runWorktreeGitAsync(["symbolic-ref", "--quiet", "--short", "HEAD"], context.repoRoot, timeoutMs);
      if (branch !== originalState.branch) await runWorktreeGitAsync(["checkout", "--quiet", originalState.branch!], context.repoRoot, timeoutMs);
    });
    await attempt("恢复原分支 HEAD 失败", async () => {
      const currentHead = await runWorktreeGitAsync(["rev-parse", "HEAD"], context.repoRoot, timeoutMs);
      if (currentHead !== originalState.head) await runWorktreeGitAsync(["reset", "--merge", originalState.head], context.repoRoot, timeoutMs);
    });
  } else {
    await attempt("恢复 detached HEAD 失败", async () => {
      const branch = await runWorktreeGitAsync(["branch", "--show-current"], context.repoRoot, timeoutMs);
      const head = await runWorktreeGitAsync(["rev-parse", "HEAD"], context.repoRoot, timeoutMs);
      if (branch || head !== originalState.head) {
        await runWorktreeGitAsync(["checkout", "--quiet", "--detach", originalState.head], context.repoRoot, timeoutMs);
      }
    });
  }

  if (await isMergeInProgressAsync(context.repoRoot, timeoutMs)) errors.push("恢复后仓库仍存在未完成的 merge");
  await attempt("校验目标分支 HEAD 失败", async () => {
    const restored = await runWorktreeGitAsync(["rev-parse", context.targetBranch], context.repoRoot, timeoutMs);
    if (restored !== targetHead) throw new Error(`期望 ${targetHead}，实际 ${restored}`);
  });
  await attempt("校验原 checkout 状态失败", async () => {
    const restored = await captureCheckoutStateAsync({ ...context, gitTimeoutMs: timeoutMs });
    if (restored.branch !== originalState.branch || restored.head !== originalState.head) {
      throw new Error(`期望 ${originalState.branch ?? "detached"}@${originalState.head}，实际 ${restored.branch ?? "detached"}@${restored.head}`);
    }
  });
  return errors;
}

async function cleanupMergedWorktreeAsync(context: MergeContext): Promise<boolean> {
  await runWorktreeGitAsync(["worktree", "remove", context.worktreePath], context.repoRoot, context.gitTimeoutMs);
  await runWorktreeGitAsync(["branch", "-d", context.sourceBranch], context.repoRoot, context.gitTimeoutMs);
  return true;
}

/** Async HTTP-facing worktree check; commands remain deliberately serial. */
export async function checkSessionWorktreeMergeabilityAsync(options: WorktreeMergeOptions): Promise<WorktreeMergeCheckResult> {
  const context = await getMainRepoContextAsync(options);
  const dirty = (await runWorktreeGitAsync(["status", "--porcelain"], context.worktreePath, context.gitTimeoutMs)).length > 0;
  const aheadCount = Number.parseInt(
    await runWorktreeGitAsync(["rev-list", "--count", `${context.targetBranch}..${context.sourceBranch}`], context.repoRoot, context.gitTimeoutMs) || "0",
    10,
  ) || 0;
  const conflicts = !dirty && aheadCount > 0 ? await checkConflictsAsync(context) : false;
  return buildCheckResult(context, aheadCount, dirty, conflicts);
}

export async function cleanupSessionWorktreeAsync(options: WorktreeOperationOptions): Promise<boolean> {
  return cleanupMergedWorktreeAsync(await getMainRepoContextAsync(options));
}

/** Async HTTP-facing merge with serial, non-cancellable rollback. */
export async function mergeSessionWorktreeAsync(options: WorktreeMergeOptions): Promise<WorktreeMergeResult> {
  const context = await getMainRepoContextAsync(options);
  const dirty = (await runWorktreeGitAsync(["status", "--porcelain"], context.worktreePath, context.gitTimeoutMs)).length > 0;
  if (dirty) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.DIRTY, "Worktree 中仍有未提交改动，请先提交后再合并。", {
      sourceBranch: context.sourceBranch, targetBranch: context.targetBranch, repoRoot: context.repoRoot, cleanupDone: false, conflict: false,
    });
  }
  const aheadCount = Number.parseInt(
    await runWorktreeGitAsync(["rev-list", "--count", `${context.targetBranch}..${context.sourceBranch}`], context.repoRoot, context.gitTimeoutMs) || "0",
    10,
  ) || 0;
  if (aheadCount <= 0) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.NOTHING_TO_MERGE, "当前 worktree 没有可合并到主分支的新提交。", {
      sourceBranch: context.sourceBranch, targetBranch: context.targetBranch, repoRoot: context.repoRoot, cleanupDone: false, conflict: false,
    });
  }
  if (await checkConflictsAsync(context)) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.CONFLICT, "合并检测到冲突，请先手动处理。", {
      sourceBranch: context.sourceBranch, targetBranch: context.targetBranch, repoRoot: context.repoRoot, cleanupDone: false, conflict: true,
    });
  }

  const originalState = await captureCheckoutStateAsync(context);
  const targetHead = await runWorktreeGitAsync(["rev-parse", context.targetBranch], context.repoRoot, context.gitTimeoutMs);
  if (await isMergeInProgressAsync(context.repoRoot, context.gitTimeoutMs)) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.CONFLICT, "主工作区已有未完成的 merge，请先处理后再合并 worktree。", {
      sourceBranch: context.sourceBranch, targetBranch: context.targetBranch, repoRoot: context.repoRoot, cleanupDone: false, conflict: true,
    });
  }
  try {
    await runWorktreeGitAsync(["checkout", context.targetBranch], context.repoRoot, context.gitTimeoutMs);
    await runWorktreeGitAsync(["merge", "--no-ff", "--no-edit", "--no-gpg-sign", context.sourceBranch], context.repoRoot, context.gitTimeoutMs);
  } catch (error) {
    const rollbackErrors = await rollbackFailedMergeAsync(context, originalState, targetHead);
    const rollbackMessage = rollbackErrors.length > 0
      ? `\n自动恢复主工作区时仍有问题：${rollbackErrors.join("；")}`
      : "\n主工作区已恢复到合并前状态。";
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.CONFLICT, `${getGitErrorMessage(error) || "合并失败，可能存在冲突。"}${rollbackMessage}`, {
      sourceBranch: context.sourceBranch, targetBranch: context.targetBranch, repoRoot: context.repoRoot, cleanupDone: false, conflict: true,
    });
  }

  const mergedAt = new Date().toISOString();
  const mergeCommit = await runWorktreeGitAsync(["rev-parse", "HEAD"], context.repoRoot, context.gitTimeoutMs);
  try {
    await cleanupMergedWorktreeAsync(context);
    return {
      ok: true, sourceBranch: context.sourceBranch, targetBranch: context.targetBranch, repoRoot: context.repoRoot,
      mergeCommit, mergedAt, cleanupDone: true, conflict: false,
    };
  } catch (error) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.CLEANUP_FAILED, getGitErrorMessage(error) || "已合并，但清理 worktree 失败。", {
      sourceBranch: context.sourceBranch, targetBranch: context.targetBranch, repoRoot: context.repoRoot,
      mergeCommit, mergedAt, cleanupDone: false, conflict: false,
    });
  }
}

export function prepareSessionWorktree(options: WorktreeSetupOptions): WorktreeSetupResult {
  const resolvedCwd = path.resolve(options.cwd);
  const repoRoot = runGit(["rev-parse", "--show-toplevel"], resolvedCwd);

  if (!repoRoot || !existsSync(repoRoot)) {
    throw new Error("当前目录不在 git 仓库中，无法启用 worktree 模式。");
  }

  const baseBranch = getCurrentBranch(repoRoot);
  const branchSuffix = sanitizeBranchSegment(options.sessionId.split("-")[0] || options.sessionId);
  const branchName = `wand/${sanitizeBranchSegment(baseBranch)}-${branchSuffix}`;
  const worktreesRoot = path.join(repoRoot, ".wand-worktrees");
  const worktreePath = path.join(worktreesRoot, branchName.replace(/\//g, "-"));

  mkdirSync(worktreesRoot, { recursive: true });
  runGit(["worktree", "add", "-b", branchName, worktreePath, "HEAD"], repoRoot);

  return {
    cwd: worktreePath,
    worktreeEnabled: true,
    worktree: {
      branch: branchName,
      path: worktreePath,
    },
  };
}
