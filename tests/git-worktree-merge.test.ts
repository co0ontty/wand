import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  mergeSessionWorktree,
  mergeSessionWorktreeAsync,
  prepareSessionWorktree,
  WorktreeMergeError,
} from "../src/git-worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
    },
  }).trim();
}

function initRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Wand Test");
  git(repo, "config", "user.email", "wand-test@example.com");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git(repo, "add", "shared.txt");
  git(repo, "commit", "-m", "initial");
  return repo;
}

function commitFile(repo: string, relativePath: string, contents: string, message: string): void {
  const filePath = join(repo, relativePath);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, contents);
  git(repo, "add", relativePath);
  git(repo, "commit", "-m", message);
}

function refExists(repo: string, ref: string): boolean {
  try {
    git(repo, "rev-parse", "--quiet", "--verify", ref);
    return true;
  } catch {
    return false;
  }
}

test("mergeSessionWorktree keeps the main checkout untouched when preflight finds conflicts", () => {
  const root = mkdtempSync(join(tmpdir(), "wand-worktree-conflict-"));
  try {
    const repo = initRepo(root);
    const prepared = prepareSessionWorktree({ cwd: repo, sessionId: "conflict-case" });
    commitFile(prepared.cwd, "shared.txt", "source\n", "source change");
    commitFile(repo, "shared.txt", "target\n", "target change");
    const targetHead = git(repo, "rev-parse", "HEAD");

    assert.throws(
      () => mergeSessionWorktree({ worktree: prepared.worktree, targetBranch: "main" }),
      (error: unknown) => {
        assert.ok(error instanceof WorktreeMergeError);
        assert.equal(error.code, "WORKTREE_MERGE_CONFLICT");
        return true;
      }
    );

    assert.equal(git(repo, "branch", "--show-current"), "main");
    assert.equal(git(repo, "rev-parse", "HEAD"), targetHead);
    assert.equal(refExists(repo, "MERGE_HEAD"), false);
    assert.equal(git(repo, "diff", "--name-only", "--diff-filter=U"), "");
    assert.equal(existsSync(prepared.cwd), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mergeSessionWorktree restores branch and HEAD after a merge hook times out", () => {
  const root = mkdtempSync(join(tmpdir(), "wand-worktree-timeout-"));
  try {
    const repo = initRepo(root);
    const prepared = prepareSessionWorktree({ cwd: repo, sessionId: "timeout-case" });
    commitFile(prepared.cwd, "feature.txt", "feature\n", "feature change");

    git(repo, "checkout", "-b", "parking");
    const originalHead = git(repo, "rev-parse", "HEAD");
    const targetHead = git(repo, "rev-parse", "main");
    const hookPath = join(repo, ".git", "hooks", "pre-merge-commit");
    writeFileSync(hookPath, "#!/bin/sh\nsleep 3\n");
    chmodSync(hookPath, 0o755);

    assert.throws(
      () => mergeSessionWorktree({
        worktree: prepared.worktree,
        targetBranch: "main",
        gitTimeoutMs: 1_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof WorktreeMergeError);
        assert.equal(error.code, "WORKTREE_MERGE_CONFLICT");
        assert.match(error.message, /ETIMEDOUT|timed out/i);
        return true;
      }
    );

    assert.equal(git(repo, "branch", "--show-current"), "parking");
    assert.equal(git(repo, "rev-parse", "HEAD"), originalHead);
    assert.equal(git(repo, "rev-parse", "main"), targetHead);
    assert.equal(refExists(repo, "MERGE_HEAD"), false);
    assert.equal(git(repo, "diff", "--name-only", "--diff-filter=U"), "");
    assert.equal(existsSync(prepared.cwd), true);
    assert.equal(refExists(repo, `refs/heads/${prepared.worktree.branch}`), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mergeSessionWorktree preserves successful merge and cleanup semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "wand-worktree-success-"));
  try {
    const repo = initRepo(root);
    const prepared = prepareSessionWorktree({ cwd: repo, sessionId: "success-case" });
    commitFile(prepared.cwd, "feature.txt", "feature\n", "feature change");

    const result = mergeSessionWorktree({ worktree: prepared.worktree, targetBranch: "main" });

    assert.equal(result.ok, true);
    assert.equal(result.cleanupDone, true);
    assert.equal(result.mergeCommit, git(repo, "rev-parse", "HEAD"));
    assert.equal(git(repo, "branch", "--show-current"), "main");
    assert.equal(existsSync(prepared.cwd), false);
    assert.equal(refExists(repo, `refs/heads/${prepared.worktree.branch}`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mergeSessionWorktreeAsync preserves successful merge and serial cleanup semantics", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-worktree-async-success-"));
  try {
    const repo = initRepo(root);
    const prepared = prepareSessionWorktree({ cwd: repo, sessionId: "async-success-case" });
    commitFile(prepared.cwd, "async-feature.txt", "feature\n", "async feature change");

    let timerObserved = false;
    const timer = setTimeout(() => { timerObserved = true; }, 0);
    const result = await mergeSessionWorktreeAsync({ worktree: prepared.worktree, targetBranch: "main" });
    clearTimeout(timer);

    assert.equal(timerObserved, true);
    assert.equal(result.ok, true);
    assert.equal(result.cleanupDone, true);
    assert.equal(result.mergeCommit, git(repo, "rev-parse", "HEAD"));
    assert.equal(existsSync(prepared.cwd), false);
    assert.equal(refExists(repo, `refs/heads/${prepared.worktree.branch}`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
