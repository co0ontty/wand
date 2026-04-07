import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { SessionSnapshot } from "./types.js";

interface WorktreeSetupOptions {
  cwd: string;
  sessionId: string;
}

interface WorktreeSetupResult {
  cwd: string;
  worktreeEnabled: boolean;
  worktree: NonNullable<SessionSnapshot["worktree"]>;
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
