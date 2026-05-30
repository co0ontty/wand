import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { ClaudeRunError, runClaudePrint } from "./claude-sdk-runner.js";
import {
  GitStatusFileEntry,
  GitStatusResult,
  PushResult,
  QuickCommitResult,
  TagHeadResult,
} from "./types.js";

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

export type QuickCommitErrorCode =
  | "CWD_MISSING"
  | "NO_CWD"
  | "NOT_A_GIT_REPO"
  | "NO_COMMIT"
  | "NOTHING_TO_COMMIT"
  | "NOTHING_TO_PUSH"
  | "EMPTY_MESSAGE"
  | "EMPTY_TAG"
  | "EMPTY_AI_MESSAGE"
  | "INVALID_AI_TAG"
  | "TAG_EXISTS"
  | "GIT_ADD_FAILED"
  | "GIT_DIFF_FAILED"
  | "GIT_COMMIT_FAILED"
  | "GIT_TAG_FAILED"
  | "CLAUDE_CLI_MISSING"
  | "CLAUDE_CLI_FAILED"
  | "CLAUDE_TIMEOUT";

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

/** Throws `QuickCommitError` if `cwd` isn't an existing path inside a git work tree. */
function assertGitWorkTree(cwd: string): void {
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
}

/**
 * Resolve the remote to push to. Prefers `branch.<name>.remote` config for the
 * current branch, falls back to `origin`. Never throws.
 */
function resolvePushRemote(cwd: string): string {
  try {
    const branch = runGit(["branch", "--show-current"], cwd);
    if (branch) {
      return runGit(["config", "--get", `branch.${branch}.remote`], cwd) || "origin";
    }
  } catch {
    // ignore — fall through to default
  }
  return "origin";
}

/**
 * Derive a default next-version tag from the latest existing tag by bumping the
 * patch component (preserving an optional `v` prefix). Returns a sane starting
 * version when there's no tag yet, or `undefined` if the latest tag isn't semver-ish.
 */
function computeSuggestedTag(latestTag: string | undefined): string | undefined {
  if (!latestTag) return "v0.1.0";
  const m = latestTag.match(/^(v?)(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return undefined;
  const [, prefix, major, minor, patch] = m;
  return `${prefix}${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
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

  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  let lastCommit: GitStatusResult["lastCommit"];
  if (!initialCommit) {
    try {
      upstream = runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd) || undefined;
    } catch {
      upstream = undefined;
    }
    if (upstream) {
      try {
        const counts = runGit(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], cwd);
        const parts = counts.split(/\s+/).filter(Boolean);
        if (parts.length === 2) {
          const b = Number.parseInt(parts[0], 10);
          const a = Number.parseInt(parts[1], 10);
          if (!Number.isNaN(a)) ahead = a;
          if (!Number.isNaN(b)) behind = b;
        }
      } catch {
        // ignore — counts stay undefined
      }
    }
    try {
      const raw = runGit(["log", "-1", "--pretty=format:%H%x09%h%x09%s"], cwd);
      const parts = raw.split("\t");
      if (parts.length >= 3) {
        lastCommit = { hash: parts[0], shortHash: parts[1], subject: parts.slice(2).join("\t") };
      }
    } catch {
      // ignore
    }
  }

  // NOTE: we intentionally do NOT probe the remote for unpushed tags here.
  // `ls-remote` is a synchronous network call that can block the event loop
  // for seconds. The "unpushed tag" UI chip is best-effort and a separate
  // async endpoint should compute it on demand if reintroduced.

  // Latest tag + a locally-derived next-version suggestion (both git-local, fast).
  let latestTag: string | undefined;
  if (!initialCommit) {
    try {
      latestTag = runGit(["describe", "--tags", "--abbrev=0"], cwd) || undefined;
    } catch {
      latestTag = undefined;
    }
  }
  const suggestedTag = computeSuggestedTag(latestTag);

  return {
    isGit: true,
    branch,
    modifiedCount: allEntries.length,
    files,
    head,
    repoRoot,
    initialCommit,
    upstream,
    ahead,
    behind,
    lastCommit,
    latestTag,
    suggestedTag,
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
  constructor(message: string, public readonly code: QuickCommitErrorCode) {
    super(message);
    this.name = "QuickCommitError";
  }
}

// ── AI commit message generation ──

async function callClaudeText(prompt: string, cwd: string, language?: string): Promise<string> {
  try {
    return await runClaudePrint(prompt, { cwd, timeoutMs: CLAUDE_MESSAGE_TIMEOUT_MS, language });
  } catch (error) {
    if (error instanceof ClaudeRunError) {
      // 把通用 ClaudeRunError 翻译成 quick-commit 自己的错误码 + 中文话术。
      if (error.code === "CLAUDE_TIMEOUT") {
        throw new QuickCommitError(
          "Claude 生成超时，请手动填写 commit message。",
          "CLAUDE_TIMEOUT",
        );
      }
      if (error.code === "CLAUDE_EMPTY_RESULT") {
        throw new QuickCommitError("Claude 返回了空的 commit message。", "EMPTY_AI_MESSAGE");
      }
      throw new QuickCommitError(error.message, error.code);
    }
    throw error;
  }
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
  const raw = await callClaudeText(prompt, cwd, language);
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
  const raw = await callClaudeText(prompt, cwd, language);
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
  const raw = await callClaudeText(prompt, cwd, language);
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

interface PushOutcome {
  pushedCommits: boolean;
  pushedTags: boolean;
  error?: string;
}

interface DoPushOptions {
  cwd: string;
  pushCommits: boolean;
  /**
   * Tag push mode:
   *   - false / undefined: don't push tags
   *   - true: push all local tags (`git push <remote> --tags`)
   *   - string[]: push only these specific tag names (`git push <remote> refs/tags/<name>` per ref)
   */
  pushTags?: boolean | string[];
}

/**
 * Push current branch (with upstream auto-setup) and/or tags.
 * Errors are returned via `error` so callers can present partial-success states.
 */
function doPush(opts: DoPushOptions): PushOutcome {
  const { cwd, pushCommits, pushTags } = opts;
  let pushedCommits = false;
  let pushedTags = false;
  let hasUpstream = false;
  try {
    runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
    hasUpstream = true;
  } catch {
    hasUpstream = false;
  }
  const pushRemote = resolvePushRemote(cwd);

  try {
    if (pushCommits) {
      if (hasUpstream) {
        runGit(["push", "--recurse-submodules=on-demand"], cwd, GIT_PUSH_TIMEOUT_MS);
      } else {
        runGit(["push", "-u", "--recurse-submodules=on-demand", pushRemote, "HEAD"], cwd, GIT_PUSH_TIMEOUT_MS);
      }
      pushedCommits = true;
    }
    if (pushTags) {
      if (Array.isArray(pushTags)) {
        for (const name of pushTags) {
          runGit(["push", pushRemote, `refs/tags/${name}`], cwd, GIT_PUSH_TIMEOUT_MS);
        }
      } else {
        runGit(["push", pushRemote, "--tags"], cwd, GIT_PUSH_TIMEOUT_MS);
      }
      pushedTags = true;
    }
    return { pushedCommits, pushedTags };
  } catch (error) {
    return { pushedCommits, pushedTags, error: getGitErrorMessage(error) };
  }
}

interface TagHeadOptions {
  cwd: string;
  language: string;
  /** Explicit tag name. If empty and `autoTag` is true, ask Claude to generate one. */
  tag?: string;
  autoTag?: boolean;
  /** Push only this tag to its upstream remote after creating it. */
  push?: boolean;
}

export async function runTagHead(opts: TagHeadOptions): Promise<TagHeadResult> {
  const { cwd, language, tag, autoTag, push } = opts;

  assertGitWorkTree(cwd);

  let headHash: string;
  try {
    headHash = runGit(["rev-parse", "HEAD"], cwd);
  } catch {
    throw new QuickCommitError("仓库还没有任何 commit，无法打 tag。", "NO_COMMIT");
  }

  let tagName = (tag || "").trim();
  if (!tagName && autoTag) {
    let headSubject = "";
    try {
      headSubject = runGit(["log", "-1", "--pretty=format:%s"], cwd);
    } catch {
      headSubject = "";
    }
    tagName = await generateTagAfterCommit(cwd, language, headSubject || "");
  }
  if (!tagName) {
    throw new QuickCommitError("请填写 tag 名称，或开启 AI 生成。", "EMPTY_TAG");
  }

  // Refuse to overwrite an existing tag — surface a clear error code.
  try {
    runGit(["rev-parse", "--verify", `refs/tags/${tagName}`], cwd);
    throw new QuickCommitError(`tag \`${tagName}\` 已存在。`, "TAG_EXISTS");
  } catch (error) {
    if (error instanceof QuickCommitError) throw error;
    // not found — good, proceed
  }

  try {
    runGit(["tag", tagName], cwd);
  } catch (error) {
    throw new QuickCommitError(`git tag 失败：${getGitErrorMessage(error)}`, "GIT_TAG_FAILED");
  }

  let pushed = false;
  let pushError: string | undefined;
  if (push) {
    const outcome = doPush({ cwd, pushCommits: false, pushTags: [tagName] });
    pushed = outcome.pushedTags;
    pushError = outcome.error;
  }

  return {
    ok: true,
    tag: { name: tagName, commit: headHash.slice(0, 7) },
    pushed,
    pushError,
  };
}

interface PushOptions {
  cwd: string;
  pushCommits?: boolean;
  pushTags?: boolean;
}

export async function runPush(opts: PushOptions): Promise<PushResult> {
  const { cwd, pushCommits = true, pushTags = false } = opts;
  assertGitWorkTree(cwd);
  if (!pushCommits && !pushTags) {
    throw new QuickCommitError("没有要推送的内容。", "NOTHING_TO_PUSH");
  }

  const outcome = doPush({ cwd, pushCommits, pushTags });
  return {
    ok: !outcome.error,
    pushedCommits: outcome.pushedCommits,
    pushedTags: outcome.pushedTags,
    error: outcome.error,
  };
}

/**
 * 在 commit 父仓库之前，先在每个内部 dirty / untracked 的 submodule 里
 * 执行一次 `git add -A` + `git commit -m <msg>`，让父仓库的 add -A
 * 能正确捕捉到新的 submodule 指针。纯指针变化（仅 commitChanged）的
 * submodule 不会进入这条路径——那种情况父仓库 add 已经够了。
 *
 * 任一 submodule 提交失败都会被收集为非致命错误，不阻塞父仓库继续 commit；
 * 调用方可以在结果里读到具体哪几个 submodule 失败。
 */
function commitDirtySubmodules(parentCwd: string, message: string): { commits: { path: string; hash: string }[]; errors: string[] } {
  const commits: { path: string; hash: string }[] = [];
  const errors: string[] = [];

  let porcelain: string;
  try {
    porcelain = runGitAllowEmpty(["status", "--porcelain=v2", "--untracked-files=all"], parentCwd);
  } catch {
    return { commits, errors };
  }
  const entries = parsePorcelainV2(porcelain);
  for (const entry of entries) {
    if (!entry.isSubmodule) continue;
    const state = entry.submoduleState;
    if (!state) continue;
    // 只有内部脏 / 未跟踪才需要进入子目录提交；纯指针变化父仓库自己就能 add。
    if (!state.hasTrackedChanges && !state.hasUntracked) continue;

    const subCwd = `${parentCwd}/${entry.path}`;
    if (!existsSync(subCwd)) {
      errors.push(`submodule ${entry.path} 路径不存在`);
      continue;
    }
    try {
      runGit(["add", "-A"], subCwd, 5000);
    } catch (error) {
      errors.push(`submodule ${entry.path} add 失败：${getGitErrorMessage(error)}`);
      continue;
    }
    // 子仓 add 之后再判断是否真的有 staged 内容：极端情况下 .gitignore 把所有 dirty
    // 文件都过滤掉了，会得到一个空 diff，此时跳过避免空 commit。
    let staged: string;
    try {
      staged = runGitAllowEmpty(["diff", "--cached", "--name-only"], subCwd).trim();
    } catch {
      staged = "";
    }
    if (!staged) continue;
    try {
      runGit(["commit", "-m", message], subCwd, 10_000);
    } catch (error) {
      errors.push(`submodule ${entry.path} commit 失败：${getGitErrorMessage(error)}`);
      continue;
    }
    let hash = "";
    try { hash = runGit(["rev-parse", "--short", "HEAD"], subCwd); } catch { /* ignore */ }
    commits.push({ path: entry.path, hash });
  }
  return { commits, errors };
}

export async function runQuickCommit(opts: QuickCommitOptions): Promise<QuickCommitResult> {
  const { cwd, language, autoMessage, customMessage, tag, autoTag, push } = opts;

  assertGitWorkTree(cwd);

  // 先 add 一次让我们能在 collectStagedDiff 看到完整改动（包含 submodule 指针），
  // AI 生成 message 时也基于这个 staged diff。
  try {
    runGit(["add", "-A"], cwd, 5000);
  } catch (error) {
    throw new QuickCommitError(`git add 失败：${getGitErrorMessage(error)}`, "GIT_ADD_FAILED");
  }

  let stagedFiles: string;
  try {
    stagedFiles = runGitAllowEmpty(["diff", "--cached", "--name-only"], cwd).trim();
  } catch (error) {
    throw new QuickCommitError(getGitErrorMessage(error), "GIT_DIFF_FAILED");
  }
  // 父仓库本身可能没有 staged 文件，但 submodule 内部有 dirty / untracked——
  // 此时也应该允许走 submodule 提交流程。
  let parentHasStaged = stagedFiles.length > 0;
  let submoduleHasDirty = false;
  try {
    const porcelain = runGitAllowEmpty(["status", "--porcelain=v2", "--untracked-files=all"], cwd);
    submoduleHasDirty = parsePorcelainV2(porcelain).some(
      (e) => e.isSubmodule && (e.submoduleState?.hasTrackedChanges || e.submoduleState?.hasUntracked),
    );
  } catch { /* keep submoduleHasDirty=false */ }
  if (!parentHasStaged && !submoduleHasDirty) {
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

  // 先提交 submodule 内部改动；父仓库随后再 add 一次，picks up 新的 submodule 指针。
  const submoduleOutcome = commitDirtySubmodules(cwd, message);
  if (submoduleOutcome.commits.length > 0) {
    try {
      runGit(["add", "-A"], cwd, 5000);
    } catch (error) {
      throw new QuickCommitError(`父仓库 add submodule 指针失败：${getGitErrorMessage(error)}`, "GIT_ADD_FAILED");
    }
    // 重新评估父仓库是否有 staged 内容：如果 submodule 是新引入的或指针变了，
    // 这里应当为真；如果完全没变就走 commit --allow-empty 路径不合适，直接报错。
    try {
      stagedFiles = runGitAllowEmpty(["diff", "--cached", "--name-only"], cwd).trim();
      parentHasStaged = stagedFiles.length > 0;
    } catch { /* keep stale value */ }
  }

  if (!parentHasStaged) {
    // submodule 都提交了但父仓库还是没有 staged —— 通常意味着 .gitmodules 没动
    // 而 submodule 指针被 ignore（罕见配置）。这种情况返回成功，但用 SUBMODULE_ONLY
    // 的语义；上层 UI 可以决定是否继续 push。这里保持向后兼容，沿用 commit 路径
    // 但用 --allow-empty 会有副作用，干脆抛 NOTHING_TO_COMMIT。
    throw new QuickCommitError(
      submoduleOutcome.commits.length > 0
        ? `已提交 ${submoduleOutcome.commits.length} 个 submodule，但父仓库没有改动可提交。`
        : "没有任何改动可以提交。",
      "NOTHING_TO_COMMIT",
    );
  }

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

  // Tag: explicit `tag` wins; if empty + autoTag, ask Claude; otherwise skip.
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

  let pushed = false;
  let pushError: string | undefined;
  if (push) {
    const outcome = doPush({
      cwd,
      pushCommits: true,
      // Push only the freshly-created tag — avoids surprising users by pushing stale local tags.
      pushTags: tagName ? [tagName] : false,
    });
    pushed = outcome.pushedCommits && (tagName ? outcome.pushedTags : true);
    pushError = outcome.error;
  }

  return {
    ok: true,
    commit: { hash: commitHash, message },
    tag: tagName ? { name: tagName } : undefined,
    pushed,
    pushError,
    submoduleCommits: submoduleOutcome.commits.length > 0 ? submoduleOutcome.commits : undefined,
  };
}
