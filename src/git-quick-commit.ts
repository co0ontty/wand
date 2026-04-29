import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { GitStatusFileEntry, GitStatusResult, QuickCommitResult } from "./types.js";

const GIT_TIMEOUT_MS = 1500;
const COMMIT_GIT_TIMEOUT_MS = 30_000;
const CLAUDE_TIMEOUT_MS = 30_000;
const MAX_DIFF_BYTES = 64 * 1024;
const MAX_STAT_BYTES = 4 * 1024;
const MAX_FILE_ENTRIES = 200;

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

function parsePorcelain(raw: string): GitStatusFileEntry[] {
  // 普通模式（无 -z）每行一条记录："XY <path>"；rename 形式为 "RX old -> new"。
  // 路径含特殊字符时被双引号包围（含 \ 转义），我们只用于展示，简单 unquote 即可。
  const out: GitStatusFileEntry[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.length < 3) continue;
    const status = line.slice(0, 2);
    let pathPart = line.slice(3);
    // rename: "old -> new" → 取 new
    const arrowIdx = pathPart.indexOf(" -> ");
    if (arrowIdx !== -1) pathPart = pathPart.slice(arrowIdx + 4);
    // 去掉外围双引号 + 简单反转义
    if (pathPart.startsWith("\"") && pathPart.endsWith("\"")) {
      pathPart = pathPart.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
    }
    out.push({ path: pathPart, status });
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
    porcelain = runGitAllowEmpty(["status", "--porcelain=v1", "-uall"], cwd);
  } catch (error) {
    return { isGit: true, branch, repoRoot, head, initialCommit, error: getGitErrorMessage(error) };
  }

  const allEntries = parsePorcelain(porcelain);
  const files = allEntries.slice(0, MAX_FILE_ENTRIES);

  return {
    isGit: true,
    branch,
    modifiedCount: allEntries.length,
    files,
    head,
    repoRoot,
    initialCommit,
  };
}

interface QuickCommitOptions {
  cwd: string;
  language: string;
  autoMessage: boolean;
  customMessage?: string;
  tag?: string;
}

export class QuickCommitError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "QuickCommitError";
  }
}

function execClaudePrint(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      ["-p", "--output-format", "text"],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: CLAUDE_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          const e = error as GitCommandError;
          if (e.code === "ENOENT") {
            reject(new QuickCommitError("未找到 claude CLI，无法自动生成 commit message。", "CLAUDE_CLI_MISSING"));
            return;
          }
          const msg = (stderr || "").trim() || e.message || "claude 调用失败";
          reject(new QuickCommitError(`Claude CLI 失败：${msg}`, "CLAUDE_CLI_FAILED"));
          return;
        }
        const text = (stdout || "").trim();
        if (!text) {
          reject(new QuickCommitError("Claude 未返回任何 commit message。", "CLAUDE_EMPTY_OUTPUT"));
          return;
        }
        resolve(text);
      },
    );
    child.stdin?.end(prompt);
  });
}

function buildPrompt(diffStat: string, diff: string, language: string): string {
  const lang = language && language.trim() ? language.trim() : "中文";
  const sections: string[] = [];
  sections.push(`请根据下面的 git diff，用 ${lang} 写一条简洁的 commit message：`);
  sections.push("- 只输出一行内容，不要解释、不要 Markdown、不要代码块");
  sections.push("- 不超过 50 字 / 12 单词，使用祈使句，描述「做了什么」");
  sections.push("- 不要包含 issue 编号或作者信息");
  sections.push("");
  sections.push("=== git diff --stat ===");
  sections.push(diffStat || "(empty)");
  if (diff) {
    sections.push("");
    sections.push("=== git diff ===");
    sections.push(diff);
  }
  return sections.join("\n");
}

async function generateCommitMessage(cwd: string, language: string): Promise<string> {
  let diffStat = "";
  try {
    diffStat = runGit(["diff", "--cached", "--stat"], cwd, COMMIT_GIT_TIMEOUT_MS);
  } catch {
    diffStat = "";
  }
  if (diffStat.length > MAX_STAT_BYTES) {
    diffStat = diffStat.slice(0, MAX_STAT_BYTES) + "\n...(truncated)";
  }

  let diff = "";
  try {
    diff = runGitAllowEmpty(["diff", "--cached"], cwd, COMMIT_GIT_TIMEOUT_MS);
  } catch {
    diff = "";
  }
  if (diff.length > MAX_DIFF_BYTES) {
    diff = "";
  }

  const prompt = buildPrompt(diffStat, diff, language);
  const raw = await execClaudePrint(prompt);

  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) || "";
  const message = firstLine
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .replace(/^[*#>\-]+\s*/, "")
    .trim();
  if (!message) {
    throw new QuickCommitError("Claude 返回的 commit message 为空。", "CLAUDE_EMPTY_OUTPUT");
  }
  return message;
}

function ensureCleanTagName(tag: string): string {
  const trimmed = tag.trim();
  if (!trimmed) {
    throw new QuickCommitError("tag 名不能为空。", "INVALID_TAG");
  }
  if (!/^[A-Za-z0-9._\-/+]+$/.test(trimmed) || trimmed.startsWith("-") || trimmed.includes("..")) {
    throw new QuickCommitError("tag 名包含非法字符。", "INVALID_TAG");
  }
  return trimmed;
}

export async function runQuickCommit(opts: QuickCommitOptions): Promise<QuickCommitResult> {
  const { cwd, language, autoMessage, customMessage, tag } = opts;

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

  const cleanTag = tag && tag.trim() ? ensureCleanTagName(tag) : undefined;
  if (cleanTag) {
    let tagAlreadyExists = false;
    try {
      runGit(["rev-parse", "--verify", `refs/tags/${cleanTag}`], cwd);
      tagAlreadyExists = true;
    } catch {
      tagAlreadyExists = false;
    }
    if (tagAlreadyExists) {
      throw new QuickCommitError(`tag 已存在：${cleanTag}`, "TAG_EXISTS");
    }
  }

  try {
    runGitAllowEmpty(["add", "-A"], cwd, COMMIT_GIT_TIMEOUT_MS);
  } catch (error) {
    throw new QuickCommitError(`git add 失败：${getGitErrorMessage(error)}`, "GIT_ADD_FAILED");
  }

  let staged = "";
  try {
    staged = runGitAllowEmpty(["diff", "--cached", "--name-only"], cwd, COMMIT_GIT_TIMEOUT_MS).trim();
  } catch {
    staged = "";
  }
  if (!staged) {
    throw new QuickCommitError("没有任何改动可以提交。", "NOTHING_TO_COMMIT");
  }

  let message: string;
  if (autoMessage) {
    message = await generateCommitMessage(cwd, language);
  } else {
    message = (customMessage || "").trim();
    if (!message) {
      throw new QuickCommitError("commit message 不能为空。", "EMPTY_MESSAGE");
    }
  }

  try {
    runGitAllowEmpty(["commit", "-m", message], cwd, COMMIT_GIT_TIMEOUT_MS);
  } catch (error) {
    throw new QuickCommitError(`git commit 失败：${getGitErrorMessage(error)}`, "GIT_COMMIT_FAILED");
  }

  let hash = "";
  try {
    hash = runGit(["rev-parse", "HEAD"], cwd);
  } catch {
    hash = "";
  }

  let tagResult: QuickCommitResult["tag"];
  if (cleanTag) {
    try {
      runGitAllowEmpty(["tag", cleanTag], cwd, COMMIT_GIT_TIMEOUT_MS);
      tagResult = { name: cleanTag };
    } catch (error) {
      throw new QuickCommitError(`git tag 失败：${getGitErrorMessage(error)}`, "GIT_TAG_FAILED");
    }
  }

  return {
    ok: true,
    commit: { hash, message },
    tag: tagResult,
  };
}
