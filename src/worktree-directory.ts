import path from "node:path";
import { realpathSync } from "node:fs";
import { runGitAsync } from "./git-utils.js";
import { listGitWorktrees } from "./git-worktree-batch.js";
import { resolveWorktreeTargetBranchAsync } from "./git-worktree.js";

import type { DirectoryWorktree } from "./worktree-directory-contract.js";

const contexts = new Map<string, { expires: number; pending: Promise<DirectoryWorktree | null> }>();
export function canonicalWorktreePath(value: string): string {
  try { return realpathSync(value); } catch { return path.resolve(value); }
}

/** Read Git identity, never infer ownership from a directory name or path prefix. */
export function directoryWorktree(cwd: string): Promise<DirectoryWorktree | null> {
  const key = canonicalWorktreePath(cwd);
  const cached = contexts.get(key);
  if (cached && cached.expires > Date.now()) return cached.pending;
  const pending = (async () => {
    try {
      const root = canonicalWorktreePath(await runGitAsync(["rev-parse", "--show-toplevel"], key));
      const worktrees = await listGitWorktrees(root);
      const main = worktrees[0];
      const current = worktrees.find(item => canonicalWorktreePath(item.path) === root);
      if (!main || !current || canonicalWorktreePath(main.path) === root) return null;
      return { name: path.basename(current.path), path: current.path, branch: current.branch, repoRoot: main.path };
    } catch { return null; }
  })();
  // Single flight, including negative results; bound the process-wide cache.
  if (contexts.size >= 256) contexts.delete(contexts.keys().next().value!);
  contexts.set(key, { expires: Date.now() + 15_000, pending });
  return pending;
}

export async function projectWorktreeDirectories<T extends { workspaceId: string; workspaceCwd: string; synthetic?: boolean; global?: boolean }>(groups: T[]): Promise<Array<T & { worktree?: DirectoryWorktree }>> {
  const result: Array<T & { worktree?: DirectoryWorktree }> = [];
  // Keep Git process concurrency bounded even for a large historical directory list.
  for (let offset = 0; offset < groups.length; offset += 4) {
    result.push(...await Promise.all(groups.slice(offset, offset + 4).map(async group => {
      if (group.global || !group.workspaceCwd) return group;
      const worktree = await directoryWorktree(group.workspaceCwd);
      if (!worktree) return group;
      const parent = groups.find(candidate => !candidate.global && !candidate.synthetic
        && canonicalWorktreePath(candidate.workspaceCwd) === canonicalWorktreePath(worktree.repoRoot));
      return { ...group, worktree: { ...worktree, ...(parent ? { parentWorkspaceId: parent.workspaceId } : {}) } };
    })));
  }
  return result;
}

/** Fresh branch and checkout list for review/start. Never changes an existing checkout. */
export async function worktreeMergeContext(cwd: string, requestedTarget?: string) {
  const defaults = await resolveWorktreeTargetBranchAsync(cwd);
  const worktrees = await listGitWorktrees(defaults.repoRoot);
  const branches = (await runGitAsync(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], defaults.repoRoot)).split("\n").filter(Boolean);
  const targetBranch = requestedTarget?.trim() || defaults.targetBranch;
  if (!branches.includes(targetBranch)) throw new Error(`目标分支不存在：${targetBranch}`);
  const targetCwd = worktrees.find(item => item.branch === targetBranch)?.path;
  // An unoccupied local branch can be checked out by the Agent only after checking the main checkout.
  return { ...defaults, targetBranch, defaultBranch: defaults.targetBranch, branches, targetCwd: targetCwd || defaults.repoRoot, targetCheckedOut: Boolean(targetCwd), worktrees };
}


