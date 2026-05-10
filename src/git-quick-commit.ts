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
  /** When `tag` is empty, ask Claude to generate one based on the diff + commit message. */
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

function collectStagedDiff(cwd: string): string {
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
  return diff;
}

async function generateCommitMessage(cwd: string, language: string): Promise<string> {
  const diff = collectStagedDiff(cwd);
  const lang = language.trim() || "中文";
  const prompt = `阅读以下 git diff，用${lang}写一条简洁的 commit message。要求：祈使句，不超过 50 字，描述「做了什么」。只输出 message 本身，不要引号、不要 Markdown 格式、不要任何额外说明。\n\n${diff}`;
  const raw = await callClaudeText(prompt, cwd);
  const message = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!message) {
    throw new QuickCommitError("Claude 返回了空的 commit message。", "EMPTY_AI_MESSAGE");
  }
  return message;
}

export interface GenerateCommitMessageResult {
  message: string;
  /** AI-suggested next tag derived from the staged diff and the latest existing tag. */
  suggestedTag?: string;
}

function tryParseJson(raw: string): { message?: unknown; tag?: unknown } | null {
  let text = raw.trim();
  // Strip ```json … ``` or ``` … ``` fences if Claude wrapped the response
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // Find the first balanced-looking JSON object substring
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sanitizeSuggestedTag(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!cleaned) return undefined;
  // Accept common semver-ish forms (v1.2.3, 1.2.3, v1.2.3-rc.1, v1.2.3+build.5)
  if (!/^v?\d+\.\d+\.\d+([.\-+][0-9A-Za-z.\-+]*)?$/.test(cleaned)) return undefined;
  return cleaned;
}

async function generateCommitMessageWithTag(
  cwd: string,
  language: string,
): Promise<GenerateCommitMessageResult> {
  const diff = collectStagedDiff(cwd);
  let latestTag: string | undefined;
  try {
    latestTag = runGit(["describe", "--tags", "--abbrev=0"], cwd) || undefined;
  } catch {
    latestTag = undefined;
  }
  const lang = language.trim() || "中文";
  const tagHint = latestTag
    ? `当前最新 tag 是 \`${latestTag}\`，请基于它给出下一个版本号（保持原有前缀风格，例如有 \`v\` 就保留 \`v\`）。`
    : `仓库还没有任何 tag，请直接给一个起始版本号（建议 \`v0.0.1\` / \`v0.1.0\` / \`v1.0.0\` 之一，按改动幅度选择）。`;
  const prompt = `阅读以下 git diff，完成两件事：
1. 用${lang}写一条简洁的 commit message（祈使句，不超过 50 字，描述「做了什么」）。
2. 根据改动幅度推荐下一个语义化版本 tag（破坏性变更 → 升 major；新增功能 → 升 minor；修复 / 文档 / 重构 / 维护 → 升 patch）。${tagHint}

请严格输出**单行 JSON 对象**，不要 Markdown 代码块、不要任何解释文字、不要多余引号。格式：
{"message":"...","tag":"v1.2.3"}

git diff:
${diff}`;
  const raw = await callClaudeText(prompt, cwd);
  const parsed = tryParseJson(raw);

  let message: string;
  let suggestedTag: string | undefined;
  if (parsed && typeof parsed.message === "string") {
    message = parsed.message.replace(/^["'`]+|["'`]+$/g, "").trim();
    suggestedTag = sanitizeSuggestedTag(parsed.tag);
  } else {
    // Fallback: treat whole output as message, no tag suggestion
    message = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
    suggestedTag = undefined;
  }
  if (!message) {
    throw new QuickCommitError("Claude 返回了空的 commit message。", "EMPTY_AI_MESSAGE");
  }

  return { message, suggestedTag };
}

export async function generateCommitMessageOnly(
  cwd: string,
  language: string,
): Promise<GenerateCommitMessageResult> {
  if (!cwd || !existsSync(cwd)) {
    throw new QuickCommitError("工作目录不存在。", "CWD_MISSING");
  }
  try {
    runGit(["add", "-A"], cwd, 5000);
  } catch {
    // best-effort staging so the diff is complete
  }
  return generateCommitMessageWithTag(cwd, language);
}

/**
 * Ask Claude for a single tag string. Called from `runQuickCommit` after the commit has
 * already landed, so we look at `git show HEAD` and use `HEAD~1` for the previous tag.
 */
async function generateTagAfterCommit(
  cwd: string,
  language: string,
  commitMessage: string,
): Promise<string> {
  let diff: string;
  try {
    diff = runGit(["show", "HEAD", "--no-color", "--submodule=log"], cwd, 5000);
  } catch {
    diff = "";
  }
  if (!diff) {
    try {
      diff = runGit(["show", "HEAD", "--name-only"], cwd, 3000);
    } catch {
      diff = "(no diff available)";
    }
  }
  if (diff.length > MAX_DIFF_FOR_AI) {
    diff = diff.slice(0, MAX_DIFF_FOR_AI) + "\n\n... (diff truncated) ...";
  }

  let latestTag: string | undefined;
  try {
    // We just made a commit, so look for the most recent tag reachable from HEAD~1.
    latestTag = runGit(["describe", "--tags", "--abbrev=0", "HEAD~1"], cwd) || undefined;
  } catch {
    latestTag = undefined;
  }

  const lang = language.trim() || "中文";
  const tagHint = latestTag
    ? `当前最新 tag 是 \`${latestTag}\`，请基于它给出下一个版本号（保持原有前缀风格，例如有 \`v\` 就保留 \`v\`）。`
    : `仓库还没有任何 tag，请给一个起始版本号（建议 \`v0.0.1\` / \`v0.1.0\` / \`v1.0.0\` 之一，按改动幅度选择）。`;
  const prompt = `根据以下 commit message 和 git diff 推荐一个语义化版本 tag（破坏性变更 → 升 major；新增功能 → 升 minor；修复 / 文档 / 重构 / 维护 → 升 patch）。${tagHint}

请用${lang}思考但严格输出**单行 JSON 对象**，不要 Markdown 代码块、不要任何解释文字、不要多余引号。格式：
{"tag":"v1.2.3"}

commit message：${commitMessage}

git diff：
${diff}`;
  const raw = await callClaudeText(prompt, cwd);
  const parsed = tryParseJson(raw);
  let suggested: string | undefined;
  if (parsed && typeof parsed.tag === "string") {
    suggested = sanitizeSuggestedTag(parsed.tag);
  } else {
    suggested = sanitizeSuggestedTag(raw);
  }
  if (!suggested) {
    throw new QuickCommitError("AI 没有给出合法的 tag，请手动填写。", "INVALID_AI_TAG");
  }
  return suggested;
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
  // - explicit `tag` wins
  // - if `tag` is empty and `autoTag` is on, ask Claude to generate one
  // - otherwise no tag
  let tagName = (tag || "").trim();
  if (!tagName && autoTag) {
    tagName = await generateTagAfterCommit(cwd, language, message);
  }
  if (tagName) {
    try {
      runGit(["tag", tagName], cwd);
    } catch (error) {
      throw new QuickCommitError(`git tag 失败：${getGitErrorMessage(error)}`, "GIT_TAG_FAILED");
    }
  }

  // Step 6: push
  let pushed = false;
  let pushError: string | undefined;
  if (push) {
    try {
      let hasUpstream = false;
      let pushRemote = "origin";
      try {
        runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
        hasUpstream = true;
        try {
          const currentBranch = runGit(["branch", "--show-current"], cwd);
          if (currentBranch) {
            pushRemote = runGit(["config", "--get", `branch.${currentBranch}.remote`], cwd) || "origin";
          }
        } catch {
          pushRemote = "origin";
        }
      } catch {
        hasUpstream = false;
      }
      if (hasUpstream) {
        runGit(["push", "--recurse-submodules=on-demand"], cwd, GIT_PUSH_TIMEOUT_MS);
      } else {
        runGit(["push", "-u", "--recurse-submodules=on-demand", pushRemote, "HEAD"], cwd, GIT_PUSH_TIMEOUT_MS);
      }
      runGit(["push", pushRemote, "--tags"], cwd, GIT_PUSH_TIMEOUT_MS);
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
