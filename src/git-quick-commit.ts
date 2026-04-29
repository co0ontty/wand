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

function buildPrompt(diffStat: string, diff: string, language: string, opts?: { needTag?: boolean; latestTag?: string }): string {
  const lang = language && language.trim() ? language.trim() : "中文";
  const sections: string[] = [];
  if (opts?.needTag) {
    sections.push(`请根据下面的 git diff，用 ${lang} 完成两件事：`);
    sections.push("1. 写一条简洁的 commit message");
    sections.push("2. 建议一个合适的 git tag（语义化版本号）");
    sections.push("");
    sections.push("输出格式（严格两行，不要其他内容）：");
    sections.push("第一行：commit message");
    sections.push("第二行：tag 名（如 v1.2.3）");
    sections.push("");
    sections.push("commit message 要求：不超过 50 字 / 12 单词，使用祈使句");
    sections.push("tag 要求：基于" + (opts.latestTag ? "当前最新 tag " + opts.latestTag + " 递增" : "语义化版本号") + "，根据改动大小决定 bump major/minor/patch");
  } else {
    sections.push(`请根据下面的 git diff，用 ${lang} 写一条简洁的 commit message：`);
    sections.push("- 只输出一行内容，不要解释、不要 Markdown、不要代码块");
    sections.push("- 不超过 50 字 / 12 单词，使用祈使句，描述「做了什么」");
    sections.push("- 不要包含 issue 编号或作者信息");
  }
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

interface CommitInfo {
  message: string;
  tag?: string;
}

async function generateCommitInfo(cwd: string, language: string, opts?: { needTag?: boolean }): Promise<CommitInfo> {
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

  let latestTag: string | undefined;
  if (opts?.needTag) {
    try {
      latestTag = runGit(["describe", "--tags", "--abbrev=0"], cwd);
    } catch {
      latestTag = undefined;
    }
  }

  const prompt = buildPrompt(diffStat, diff, language, { needTag: opts?.needTag, latestTag });
  const raw = await execClaudePrint(prompt);

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  function cleanLine(line: string): string {
    return line
      .replace(/^["'`]+/, "")
      .replace(/["'`]+$/, "")
      .replace(/^[*#>\-]+\s*/, "")
      .replace(/^\d+\.\s*/, "")
      .trim();
  }

  const message = cleanLine(lines[0] || "");
  if (!message) {
    throw new QuickCommitError("Claude 返回的 commit message 为空。", "CLAUDE_EMPTY_OUTPUT");
  }

  let tag: string | undefined;
  if (opts?.needTag && lines.length >= 2) {
    const rawTag = cleanLine(lines[1]);
    if (rawTag && /^[A-Za-z0-9._\-/+]+$/.test(rawTag)) {
      tag = rawTag;
    }
  }

  return { message, tag };
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
  const { cwd, language, autoMessage, customMessage, tag, autoTag } = opts;

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

  const userTag = tag && tag.trim() ? ensureCleanTagName(tag) : undefined;
  if (userTag) {
    let tagAlreadyExists = false;
    try {
      runGit(["rev-parse", "--verify", `refs/tags/${userTag}`], cwd);
      tagAlreadyExists = true;
    } catch {
      tagAlreadyExists = false;
    }
    if (tagAlreadyExists) {
      throw new QuickCommitError(`tag 已存在：${userTag}`, "TAG_EXISTS");
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

  const needClaudeTag = autoTag && !userTag;
  let message: string;
  let claudeTag: string | undefined;

  if (autoMessage) {
    const info = await generateCommitInfo(cwd, language, { needTag: needClaudeTag });
    message = info.message;
    claudeTag = info.tag;
  } else {
    message = (customMessage || "").trim();
    if (!message) {
      throw new QuickCommitError("commit message 不能为空。", "EMPTY_MESSAGE");
    }
    if (needClaudeTag) {
      try {
        const latestTag = runGit(["describe", "--tags", "--abbrev=0"], cwd);
        claudeTag = bumpPatchTag(latestTag) || undefined;
      } catch {
        claudeTag = undefined;
      }
    }
  }

  const finalTag = userTag || claudeTag;
  if (finalTag) {
    let tagAlreadyExists = false;
    try {
      runGit(["rev-parse", "--verify", `refs/tags/${finalTag}`], cwd);
      tagAlreadyExists = true;
    } catch {
      tagAlreadyExists = false;
    }
    if (tagAlreadyExists) {
      throw new QuickCommitError(`tag 已存在：${finalTag}`, "TAG_EXISTS");
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
  if (finalTag) {
    try {
      runGitAllowEmpty(["tag", finalTag], cwd, COMMIT_GIT_TIMEOUT_MS);
      tagResult = { name: finalTag };
    } catch (error) {
      throw new QuickCommitError(`git tag 失败：${getGitErrorMessage(error)}`, "GIT_TAG_FAILED");
    }
  }

  let pushed = false;
  if (opts.push) {
    try {
      const pushArgs = ["push"];
      if (tagResult) pushArgs.push("--tags");
      runGitAllowEmpty(pushArgs, cwd, COMMIT_GIT_TIMEOUT_MS);
      pushed = true;
    } catch (error) {
      throw new QuickCommitError(`git push 失败：${getGitErrorMessage(error)}`, "GIT_PUSH_FAILED");
    }
  }

  return {
    ok: true,
    commit: { hash, message },
    tag: tagResult,
    pushed,
  };
}
