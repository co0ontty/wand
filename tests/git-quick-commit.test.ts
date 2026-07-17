import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { getGitStatusAsync, runPush, runQuickCommit, runQuickCommitWithFallback } from "../src/git-quick-commit.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-b", "master");
  git(path, "config", "user.name", "Wand Test");
  git(path, "config", "user.email", "wand-test@example.com");
}

function setupParentWithSubmodule(root: string, subRemote: string): {
  parent: string;
  parentRemote: string;
  submodule: string;
} {
  const parent = join(root, "parent");
  const parentRemote = join(root, "parent.git");
  const submodule = join(parent, "client");

  initRepo(parent);
  initRepo(submodule);
  writeFileSync(join(submodule, "client.txt"), "client\n");
  git(submodule, "add", "client.txt");
  git(submodule, "commit", "-m", "client commit");
  git(submodule, "remote", "add", "origin", subRemote);

  writeFileSync(join(parent, ".gitmodules"), [
    "[submodule \"client\"]",
    "\tpath = client",
    `\turl = ${subRemote}`,
    "",
  ].join("\n"));
  git(parent, "add", ".gitmodules", "client");
  git(parent, "commit", "-m", "record client");
  git(root, "init", "--bare", parentRemote);
  git(parent, "remote", "add", "origin", parentRemote);

  return { parent, parentRemote, submodule };
}

function remoteHasRef(remote: string, ref: string): boolean {
  return git(tmpdir(), "ls-remote", remote, ref).length > 0;
}

test("runPush does not publish the parent when a submodule push fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-quick-commit-failure-"));
  try {
    const missingSubRemote = join(root, "missing-client.git");
    const { parent, parentRemote } = setupParentWithSubmodule(root, missingSubRemote);
    git(parent, "tag", "v1.0.0");

    const result = await runPush({
      cwd: parent,
      pushCommits: true,
      pushTags: true,
      submodule: true,
      tagName: "v1.0.0",
    });

    assert.equal(result.ok, false);
    assert.equal(result.pushedCommits, false);
    assert.equal(result.pushedTags, false);
    assert.match(result.error ?? "", /submodule client 推送失败/);
    assert.equal(remoteHasRef(parentRemote, "refs/heads/master"), false);
    assert.equal(remoteHasRef(parentRemote, "refs/tags/v1.0.0"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runQuickCommit keeps a new parent commit and tag local when a submodule push fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-quick-commit-transaction-"));
  try {
    const missingSubRemote = join(root, "missing-client.git");
    const { parent, parentRemote, submodule } = setupParentWithSubmodule(root, missingSubRemote);
    writeFileSync(join(submodule, "client.txt"), "updated client\n");

    const result = await runQuickCommit({
      cwd: parent,
      language: "中文",
      autoMessage: false,
      customMessage: "update client",
      tag: "v1.1.0",
      push: true,
      submodule: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.pushed, false);
    assert.match(result.pushError ?? "", /submodule client 推送失败/);
    assert.deepEqual(result.submoduleCommits?.map((commit) => commit.path), ["client"]);
    assert.equal(remoteHasRef(parentRemote, "refs/heads/master"), false);
    assert.equal(remoteHasRef(parentRemote, "refs/tags/v1.1.0"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPush publishes the parent after the submodule is available remotely", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-quick-commit-success-"));
  try {
    const subRemote = join(root, "client.git");
    mkdirSync(subRemote, { recursive: true });
    git(root, "init", "--bare", subRemote);
    const { parent, parentRemote, submodule } = setupParentWithSubmodule(root, subRemote);
    git(parent, "tag", "v1.0.0");
    git(submodule, "tag", "v1.0.0");

    const result = await runPush({
      cwd: parent,
      pushCommits: true,
      pushTags: true,
      submodule: true,
      tagName: "v1.0.0",
    });

    assert.equal(result.ok, true);
    assert.equal(result.pushedCommits, true);
    assert.equal(result.pushedTags, true);
    assert.equal(remoteHasRef(subRemote, "refs/heads/master"), true);
    assert.equal(remoteHasRef(subRemote, "refs/tags/v1.0.0"), true);
    assert.equal(remoteHasRef(parentRemote, "refs/heads/master"), true);
    assert.equal(remoteHasRef(parentRemote, "refs/tags/v1.0.0"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runQuickCommit pushes a clean but unpublished declared submodule", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-quick-commit-clean-submodule-"));
  try {
    const subRemote = join(root, "client.git");
    mkdirSync(subRemote, { recursive: true });
    git(root, "init", "--bare", subRemote);
    const { parent, parentRemote } = setupParentWithSubmodule(root, subRemote);
    writeFileSync(join(parent, "parent.txt"), "parent update\n");

    const result = await runQuickCommit({
      cwd: parent,
      language: "中文",
      autoMessage: false,
      customMessage: "update parent",
      push: true,
      submodule: true,
    });

    assert.equal(result.pushed, true);
    assert.equal(result.pushError, undefined);
    assert.equal(result.submoduleCommits, undefined);
    assert.equal(remoteHasRef(subRemote, "refs/heads/master"), true);
    assert.equal(remoteHasRef(parentRemote, "refs/heads/master"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getGitStatusAsync returns repository state without blocking timers", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-git-status-async-"));
  try {
    initRepo(root);
    writeFileSync(join(root, "tracked.txt"), "initial\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "initial");
    writeFileSync(join(root, "tracked.txt"), "changed\n");

    let timerObserved = false;
    const timer = setTimeout(() => { timerObserved = true; }, 0);
    const status = await getGitStatusAsync(root);
    clearTimeout(timer);

    assert.equal(timerObserved, true);
    assert.equal(status.isGit, true);
    assert.equal(status.branch, "master");
    assert.equal(status.modifiedCount, 1);
    assert.equal(status.files?.[0]?.path, "tracked.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude quick-commit fallback grants only git Bash commands without bypassing permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-quick-commit-claude-permissions-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const argsFile = join(root, "claude-args");
  try {
    initRepo(repo);
    mkdirSync(bin);
    writeFileSync(join(repo, "tracked.txt"), "before\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-m", "initial");
    writeFileSync(join(repo, "tracked.txt"), "after\n");

    const hooks = join(repo, ".git", "hooks");
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(join(bin, "claude"), [
      "#!/bin/sh",
      'printf \'%s\\n\' "$@" > "$WAND_CLAUDE_ARGS_FILE"',
      "git commit --no-verify -m 'fallback commit' >/dev/null",
      "printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ok\"}'",
    ].join("\n"), { mode: 0o755 });

    const previousPath = process.env.PATH;
    const previousArgsFile = process.env.WAND_CLAUDE_ARGS_FILE;
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    process.env.WAND_CLAUDE_ARGS_FILE = argsFile;
    try {
      const result = await runQuickCommitWithFallback({
        cwd: repo,
        language: "English",
        provider: "claude",
        autoMessage: false,
        customMessage: "built-in commit",
      });
      const args = readFileSync(argsFile, "utf8").trim().split("\n");

      assert.equal(result.commit.message, "fallback commit");
      assert.equal(args.includes("--permission-mode"), false);
      assert.equal(args.includes("bypassPermissions"), false);
      assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 4), [
        "--tools",
        "Bash",
        "--allowedTools",
        "Bash(git *)",
      ]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousArgsFile === undefined) delete process.env.WAND_CLAUDE_ARGS_FILE;
      else process.env.WAND_CLAUDE_ARGS_FILE = previousArgsFile;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
