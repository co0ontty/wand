import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { GitStatusFileEntry, GitStatusResult, QuickCommitResult } from "./types.js";

const GIT_TIMEOUT_MS = 1500;
const GIT_PUSH_TIMEOUT_MS = 30_000;
const MAX_FILE_ENTRIES = 200;
const CLAUDE_MESSAGE_TIMEOUT_MS = 30_000;
const MAX_DIFF_FOR_AI = 100_000;

interface GitCommandError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number | null;
  code?: string;
}

function runGit(args: string[], cwd: string, timeoutMs: number = GIT_TIMEOUT_MS): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function runGitAllowEmpty(args: string[], cwd: string, timeoutMs: number = GIT_TIMEOUT_MS): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function getGitErrorMessage(error: unknown): string {
  const e = error as GitCommandError;
  if (e?.stderr && typeof e.stderr === "string") return e.stderr.trim() || e.message || "git 命令失败";
  if (e?.message) return e.message;
  return String(error);
}

function unquotePath(raw: string): string {
  if (raw.startsWith("\"") && raw.endsWith("\"")) {
    return raw.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return raw;
}

function makeEntry(path: string, status: string, sub: string | undefined): GitStatusFileEntry {
  if (sub && sub.length === 4 && sub[0] === "S") {
    return {
      path,
      status,
      isSubmodule: true,
      submoduleState: {
        commitChanged: sub[1] === "C",
        hasTrackedChanges: sub[2] === "M",
        hasUntracked: sub[3] === "U",
      },
    };
  }
  return { path, status };
}

function parsePorcelainV2(raw: string): GitStatusFileEntry[] {
  const out: GitStatusFileEntry[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const head = line[0];
    if (head === "1") {
      const parts = line.split(" ");
      if (parts.length < 9) continue;
      const status = parts[1];
      const sub = parts[2];
      const path = unquotePath(parts.slice(8).join(" "));
      out.push(makeEntry(path, status, sub));
    } else if (head === "2") {
      const parts = line.split(" ");
      if (parts.length < 10) continue;
      const status = parts[1];
      const sub = parts[2];
      const rest = parts.slice(9).join(" ");
      const tabIdx = rest.indexOf("\t");
      const newPath = unquotePath(tabIdx === -1 ? rest : rest.slice(0, tabIdx));
      out.push(makeEntry(newPath, status, sub));
    } else if (head === "?") {
      out.push({ path: unquotePath(line.slice(2)), status: "??" });
    } else if (head === "!") {
      out.push({ path: unquotePath(line.slice(2)), status: "!!" });
    }
  }
  return out;
}

export function getGitStatus(cwd: string): GitStatusResult {
  if (!cwd || !existsSync(cwd)) {
    return { isGit: false, error: "工作目录不存在。" };
  }

  let isInside: string;
  try {
    isInside = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  } catch {
    return { isGit: false };
  }
  if (isInside !== "true") {
    return { isGit: false };
  }

  let repoRoot: string | undefined;
  try {
    repoRoot = runGit(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    repoRoot = undefined;
  }

  let branch: string;
  try {
    branch = runGit(["branch", "--show-current"], cwd);
  } catch (error) {
    return { isGit: true, repoRoot, error: getGitErrorMessage(error) };
  }
  if (!branch) {
    try {
      branch = `HEAD (${runGit(["rev-parse", "--short", "HEAD"], cwd)})`;
    } catch {
      branch = "HEAD";
    }
  }

  let head: string | undefined;
  let initialCommit = false;
  try {
    head = runGit(["rev-parse", "HEAD"], cwd);
  } catch {
    initialCommit = true;
  }

  let porcelain: string;
  try {
    porcelain = runGitAllowEmpty(["status", "--porcelain=v2", "--untracked-files=all"], cwd);
  } catch (error) {
    return { isGit: true, branch, repoRoot, head, initialCommit, error: getGitErrorMessage(error) };
  }

  const allEntries = parsePorcelainV2(porcelain);
  const files = allEntries.slice(0, MAX_FILE_ENTRIES);

  let latestTag: string | undefined;
  let suggestedNextTag: string | undefined;
  try {
    latestTag = runGit(["describe", "--tags", "--abbrev=0"], cwd);
  } catch {
    latestTag = undefined;
  }
  if (latestTag) {
    suggestedNextTag = bumpPatchTag(latestTag);
  }

  return {
    isGit: true,
    branch,
    modifiedCount: allEntries.length,
    files,
    head,
    repoRoot,
    initialCommit,
    latestTag,
    suggestedNextTag,
  };
}

function bumpPatchTag(tag: string): string {
  const m = tag.match(/^(v?)(\d+)\.(\d+)\.(\d+)(.*)/);
  if (!m) return "";
  const prefix = m[1];
  const major = m[2];
  const minor = m[3];
  const patch = parseInt(m[4], 10) + 1;
  return `${prefix}${major}.${minor}.${patch}`;
}

interface QuickCommitOptions {
  cwd: string;
  language: string;
  autoMessage: boolean;
  customMessage?: string;
  tag?: string;
  autoTag?: boolean;
  push?: boolean;
}

export class QuickCommitError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "QuickCommitError";
  }
}

// ── AI commit message generation ──

function callClaudeText(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      ["-p", "--output-format", "text"],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: CLAUDE_MESSAGE_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          const e = error as GitCommandError;
          if (e.code === "ENOENT") {
            reject(new QuickCommitError("未找到 claude CLI。", "CLAUDE_CLI_MISSING"));
            return;
          }
          if (e.code === "ETIMEDOUT") {
            reject(new QuickCommitError("Claude 生成超时，请手动填写 commit message。", "CLAUDE_TIMEOUT"));
            return;
          }
          const msg = (stderr || "").trim() || e.message || "claude 调用失败";
          reject(new QuickCommitError(`Claude CLI 失败：${msg}`, "CLAUDE_CLI_FAILED"));
          return;
        }
        resolve((stdout || "").trim());
      },
    );
    child.stdin?.end(prompt);
  });
}

async function generateCommitMessage(cwd: string, language: string): Promise<string> {
  let diff: string;
  try {
    diff = runGit(["diff", "--cached", "--submodule=log"], cwd, 5000);
  } catch {
    diff = "";
  }
  if (!diff) {
    try {
      diff = runGit(["diff", "--cached", "--name-only"], cwd, 3000);
    } catch {
      diff = "(no diff available)";
    }
  }
  if (diff.length > MAX_DIFF_FOR_AI) {
    diff = diff.slice(0, MAX_DIFF_FOR_AI) + "\n\n... (diff truncated) ...";
  }
  const lang = language.trim() || "中文";
  const prompt = `阅读以下 git diff，用${lang}写一条简洁的 commit message。要求：祈使句，不超过 50 字，描述「做了什么」。只输出 message 本身，不要引号、不要 Markdown 格式、不要任何额外说明。\n\n${diff}`;
  const raw = await callClaudeText(prompt, cwd);
  const message = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!message) {
    throw new QuickCommitError("Claude 返回了空的 commit message。", "EMPTY_AI_MESSAGE");
  }
  return message;
}

export async function generateCommitMessageOnly(cwd: string, language: string): Promise<string> {
  if (!cwd || !existsSync(cwd)) {
    throw new QuickCommitError("工作目录不存在。", "CWD_MISSING");
  }
  try {
    runGit(["add", "-A"], cwd, 5000);
  } catch {
    // best-effort staging so the diff is complete
  }
  return generateCommitMessage(cwd, language);
}

// ── Direct git operations ──

export async function runQuickCommit(opts: QuickCommitOptions): Promise<QuickCommitResult> {
  const { cwd, language, autoMessage, customMessage, tag, autoTag, push } = opts;

  if (!cwd || !existsSync(cwd)) {
    throw new QuickCommitError("工作目录不存在。", "CWD_MISSING");
  }

  let isInside: string;
  try {
    isInside = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  } catch (error) {
    throw new QuickCommitError(getGitErrorMessage(error), "NOT_A_GIT_REPO");
  }
  if (isInside !== "true") {
    throw new QuickCommitError("当前目录不在 git 仓库内。", "NOT_A_GIT_REPO");
  }

  // Step 1: stage all
  try {
    runGit(["add", "-A"], cwd, 5000);
  } catch (error) {
    throw new QuickCommitError(`git add 失败：${getGitErrorMessage(error)}`, "GIT_ADD_FAILED");
  }

  // Step 2: check if anything to commit
  let stagedFiles: string;
  try {
    stagedFiles = runGitAllowEmpty(["diff", "--cached", "--name-only"], cwd).trim();
  } catch (error) {
    throw new QuickCommitError(getGitErrorMessage(error), "GIT_DIFF_FAILED");
  }
  if (!stagedFiles) {
    throw new QuickCommitError("没有任何改动可以提交。", "NOTHING_TO_COMMIT");
  }

  // Step 3: get commit message
  let message: string;
  if (autoMessage) {
    message = await generateCommitMessage(cwd, language);
  } else {
    message = (customMessage || "").trim();
    if (!message) {
      throw new QuickCommitError("commit message 不能为空。", "EMPTY_MESSAGE");
    }
  }

  // Step 4: commit
  try {
    runGit(["commit", "-m", message], cwd, 10_000);
  } catch (error) {
    throw new QuickCommitError(`git commit 失败：${getGitErrorMessage(error)}`, "GIT_COMMIT_FAILED");
  }

  let commitHash: string;
  try {
    commitHash = runGit(["rev-parse", "--short", "HEAD"], cwd);
  } catch {
    commitHash = "";
  }

  // Step 5: tag
  const makeTag = !!(autoTag || (tag && tag.trim()));
  let tagName = "";
  if (makeTag) {
    if (tag && tag.trim()) {
      tagName = tag.trim();
    } else {
      let latestTag: string | undefined;
      try {
        latestTag = runGit(["describe", "--tags", "--abbrev=0"], cwd);
      } catch {
        latestTag = undefined;
      }
      tagName = bumpPatchTag(latestTag || "v0.0.0");
    }
    if (tagName) {
      try {
        runGit(["tag", tagName], cwd);
      } catch (error) {
        throw new QuickCommitError(`git tag 失败：${getGitErrorMessage(error)}`, "GIT_TAG_FAILED");
      }
    }
  }

  // Step 6: push
  let pushed = false;
  let pushError: string | undefined;
  if (push) {
    try {
      let hasUpstream = false;
      try {
        runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
        hasUpstream = true;
      } catch {
        hasUpstream = false;
      }
      if (hasUpstream) {
        runGit(["push", "--recurse-submodules=on-demand"], cwd, GIT_PUSH_TIMEOUT_MS);
      } else {
        runGit(["push", "-u", "--recurse-submodules=on-demand", "origin", "HEAD"], cwd, GIT_PUSH_TIMEOUT_MS);
      }
      if (tagName) {
        runGit(["push", "origin", `refs/tags/${tagName}`], cwd, GIT_PUSH_TIMEOUT_MS);
      }
      pushed = true;
    } catch (error) {
      pushError = getGitErrorMessage(error);
    }
  }

  return {
    ok: true,
    commit: { hash: commitHash, message },
    tag: tagName ? { name: tagName } : undefined,
    pushed,
    pushError,
  };
}
