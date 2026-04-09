import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

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

interface GitCommandError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number | null;
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
}

interface CheckedMergeContext extends MergeContext {
  aheadCount: number;
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sanitizeBranchSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "session";
}

function getCurrentBranch(repoRoot: string): string {
  const branch = runGit(["branch", "--show-current"], repoRoot);
  return branch || "master";
}

function isGitCommandError(error: unknown): error is GitCommandError {
  return error instanceof Error;
}

function getGitCommandMessage(error: unknown): string {
  if (isGitCommandError(error)) {
    return error.stderr?.trim() || error.stdout?.trim() || error.message;
  }
  return String(error);
}

function refExists(repoRoot: string, ref: string): boolean {
  try {
    runGit(["rev-parse", "--verify", ref], repoRoot);
    return true;
  } catch {
    return false;
  }
}

function getRepoRootFromWorktree(worktreePath: string): string {
  const repoRoot = runGit(["rev-parse", "--show-toplevel"], worktreePath);
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

function getMainRepoRoot(repoRoot: string): string {
  const commonDir = runGit(["rev-parse", "--git-common-dir"], repoRoot);
  if (commonDir) {
    const maybeRoot = path.resolve(repoRoot, commonDir, "..");
    if (existsSync(maybeRoot)) {
      return maybeRoot;
    }
  }
  return repoRoot;
}

export function getDefaultBaseBranch(repoRoot: string): string {
  try {
    const symbolicRef = runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot);
    const match = symbolicRef.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match && match[1]) {
      return match[1];
    }
  } catch {
    // ignore and fallback below
  }

  const candidates = ["master", "main", getCurrentBranch(repoRoot)];
  for (const candidate of candidates) {
    if (candidate && refExists(repoRoot, candidate)) {
      return candidate;
    }
  }
  return "master";
}

function getMainRepoContext(options: WorktreeMergeOptions): MergeContext {
  const worktreePath = ensureWorktreePath(options.worktree);
  const worktreeRepoRoot = getRepoRootFromWorktree(worktreePath);
  const repoRoot = getMainRepoRoot(worktreeRepoRoot);
  const sourceBranch = options.worktree.branch;
  if (!refExists(repoRoot, sourceBranch)) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.MISSING, "Worktree 分支不存在，可能已被手动删除。", {
      cleanupDone: false,
      conflict: false,
    });
  }
  const targetBranch = options.targetBranch?.trim() || getDefaultBaseBranch(repoRoot);
  if (!refExists(repoRoot, targetBranch)) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.TARGET_MISSING, `目标分支不存在：${targetBranch}`, {
      cleanupDone: false,
      conflict: false,
      targetBranch,
    });
  }
  return { repoRoot, worktreePath, sourceBranch, targetBranch };
}

function hasUncommittedChanges(worktreePath: string): boolean {
  const worktreeRepoRoot = getRepoRootFromWorktree(worktreePath);
  return runGit(["status", "--porcelain"], worktreeRepoRoot).length > 0;
}

function getAheadCount(repoRoot: string, targetBranch: string, sourceBranch: string): number {
  const count = runGit(["rev-list", "--count", `${targetBranch}..${sourceBranch}`], repoRoot);
  return Number.parseInt(count || "0", 10) || 0;
}

function checkConflicts(repoRoot: string, targetBranch: string, sourceBranch: string): boolean {
  try {
    runGit(["merge-tree", targetBranch, sourceBranch], repoRoot);
    return false;
  } catch {
    return true;
  }
}

function ensureMergeableContext(options: WorktreeMergeOptions): CheckedMergeContext {
  const context = getMainRepoContext(options);
  if (hasUncommittedChanges(context.worktreePath)) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.DIRTY, "Worktree 中仍有未提交改动，请先提交后再合并。", {
      sourceBranch: context.sourceBranch,
      targetBranch: context.targetBranch,
      repoRoot: context.repoRoot,
      cleanupDone: false,
      conflict: false,
    });
  }
  const aheadCount = getAheadCount(context.repoRoot, context.targetBranch, context.sourceBranch);
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

function getHeadCommit(repoRoot: string): string {
  return runGit(["rev-parse", "HEAD"], repoRoot);
}

function cleanupMergedWorktree(context: MergeContext): boolean {
  runGit(["worktree", "remove", context.worktreePath], context.repoRoot);
  runGit(["branch", "-d", context.sourceBranch], context.repoRoot);
  return true;
}

export function getWorktreeMergeErrorCode(error: unknown): string | undefined {
  return error instanceof WorktreeMergeError ? error.code : undefined;
}

export function checkSessionWorktreeMergeability(options: WorktreeMergeOptions): WorktreeMergeCheckResult {
  const context = getMainRepoContext(options);
  const hasDirtyChanges = hasUncommittedChanges(context.worktreePath);
  const aheadCount = getAheadCount(context.repoRoot, context.targetBranch, context.sourceBranch);
  const hasConflicts = !hasDirtyChanges && aheadCount > 0
    ? checkConflicts(context.repoRoot, context.targetBranch, context.sourceBranch)
    : false;
  return buildCheckResult(context, aheadCount, hasDirtyChanges, hasConflicts);
}

export function cleanupSessionWorktree(options: WorktreeOperationOptions): boolean {
  const context = getMainRepoContext({ worktree: options.worktree });
  return cleanupMergedWorktree(context);
}

export function mergeSessionWorktree(options: WorktreeMergeOptions): WorktreeMergeResult {
  const context = ensureMergeableContext(options);
  const hasConflicts = checkConflicts(context.repoRoot, context.targetBranch, context.sourceBranch);
  if (hasConflicts) {
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.CONFLICT, "合并检测到冲突，请先手动处理。", {
      sourceBranch: context.sourceBranch,
      targetBranch: context.targetBranch,
      repoRoot: context.repoRoot,
      cleanupDone: false,
      conflict: true,
    });
  }

  try {
    runGit(["checkout", context.targetBranch], context.repoRoot);
    runGit(["merge", "--no-ff", "--no-edit", context.sourceBranch], context.repoRoot);
  } catch (error) {
    const message = getGitCommandMessage(error);
    throw new WorktreeMergeError(WORKTREE_MERGE_ERROR_CODES.CONFLICT, message || "合并失败，可能存在冲突。", {
      sourceBranch: context.sourceBranch,
      targetBranch: context.targetBranch,
      repoRoot: context.repoRoot,
      cleanupDone: false,
      conflict: true,
    });
  }

  const mergedAt = new Date().toISOString();
  const mergeCommit = getHeadCommit(context.repoRoot);
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
      getGitCommandMessage(error) || "已合并，但清理 worktree 失败。",
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
