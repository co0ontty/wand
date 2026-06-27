import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

import { ClaudeRunError, runClaudePrint } from "./claude-sdk-runner.js";
import { buildChildEnv } from "./env-utils.js";
import { runGit as runGitBase, runGitRaw as runGitRawBase, getGitErrorMessage } from "./git-utils.js";
import { thinkingEffortToClaudeCliEffort, thinkingEffortToCodexReasoningEffort } from "./structured-session-manager.js";
import {
  GitStatusFileEntry,
  GitStatusResult,
  PushResult,
  QuickCommitResult,
  SessionProvider,
  SessionSnapshot,
  TagHeadResult,
} from "./types.js";

const GIT_TIMEOUT_MS = 1500;
const GIT_PUSH_TIMEOUT_MS = 30_000;
const MAX_FILE_ENTRIES = 200;
// AI 生成 message/tag 的超时。SDK 链路 = spawn claude + API 调用（带自动重试），
// 30s 在 API 抖动时不够用，放宽到 60s。
const CLAUDE_MESSAGE_TIMEOUT_MS = 60_000;
const CODEX_MESSAGE_TIMEOUT_MS = 60_000;
const QUICK_COMMIT_CLI_TIMEOUT_MS = 120_000;
const MAX_DIFF_FOR_AI = 100_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

function runGit(args: string[], cwd: string, timeoutMs: number = GIT_TIMEOUT_MS): string {
  return runGitBase(args, cwd, { timeout: timeoutMs, maxBuffer: GIT_MAX_BUFFER });
}

function runGitAllowEmpty(args: string[], cwd: string, timeoutMs: number = GIT_TIMEOUT_MS): string {
  return runGitRawBase(args, cwd, { timeout: timeoutMs, maxBuffer: GIT_MAX_BUFFER });
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

/**
 * 仓库是否声明了 submodule（读 repo 根的 .gitmodules）。不能只看 `git status`——一个
 * clean 的 submodule 不会出现在 status 里，但「是否提供 Submodule 选项」应基于声明而非当前改动。
 */
function repoDeclaresSubmodule(repoRoot: string | undefined): boolean {
  if (!repoRoot) return false;
  const gitmodules = `${repoRoot}/.gitmodules`;
  if (!existsSync(gitmodules)) return false;
  try {
    const out = runGitAllowEmpty(["config", "-f", gitmodules, "--get-regexp", "\\.path$"], repoRoot).trim();
    return out.length > 0;
  } catch {
    return false;
  }
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

  // Latest tag only. Next tag suggestions are intentionally AI-derived from the
  // diff so releases do not silently follow a fixed patch-bump rule.
  let latestTag: string | undefined;
  if (!initialCommit) {
    try {
      latestTag = runGit(["describe", "--tags", "--abbrev=0"], cwd) || undefined;
    } catch {
      latestTag = undefined;
    }
  }

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
    // 供前端决定是否渲染 Submodule 球。status 全量条目（不受 files 的 200 条 slice 影响）
    // 只能看到「有改动」的 submodule，clean submodule 不会出现在 status 里，所以再用
    // .gitmodules 声明兜底——只要仓库声明了 submodule 就提供该选项。
    hasSubmodule: allEntries.some((e) => e.isSubmodule) || repoDeclaresSubmodule(repoRoot),
  };
}

interface QuickCommitOptions {
  cwd: string;
  language: string;
  provider?: SessionProvider;
  model?: string | null;
  thinkingEffort?: SessionSnapshot["thinkingEffort"];
  inheritEnv?: boolean;
  autoMessage: boolean;
  customMessage?: string;
  tag?: string;
  /** When `tag` is empty, ask Claude to generate one based on the diff + commit message. */
  autoTag?: boolean;
  push?: boolean;
  /**
   * 是否把 commit / tag / push 递归进入各 submodule 内部。默认 false：
   * 只处理父仓库自身（含已变化的 submodule 指针），不碰 submodule 内部 dirty。
   */
  submodule?: boolean;
}

interface QuickCommitAiOptions {
  provider?: SessionProvider;
  model?: string | null;
  thinkingEffort?: SessionSnapshot["thinkingEffort"];
  inheritEnv?: boolean;
}

export class QuickCommitError extends Error {
  constructor(message: string, public readonly code: QuickCommitErrorCode) {
    super(message);
    this.name = "QuickCommitError";
  }
}

// ── AI commit message generation ──

async function callClaudeText(prompt: string, cwd: string, language?: string, model?: string | null): Promise<string> {
  try {
    return await runClaudePrint(prompt, { cwd, timeoutMs: CLAUDE_MESSAGE_TIMEOUT_MS, language, model: model ?? undefined });
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

function normalizeProvider(provider: SessionProvider | undefined): SessionProvider {
  return provider === "codex" ? "codex" : "claude";
}

function stripFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function normalizeAiText(raw: string): string {
  return stripFences(raw).replace(/^["'`]+|["'`]+$/g, "").trim();
}

function extractCodexText(stdout: string): string {
  let lastAgentText = "";
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { type?: string; item?: { type?: string; text?: unknown } };
      if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && typeof parsed.item.text === "string") {
        lastAgentText = parsed.item.text;
      }
    } catch {
      // ignore non-JSON diagnostics mixed into stdout
    }
  }
  if (lastAgentText) return lastAgentText.trim();

  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const noise = /^(OpenAI Codex|[-]+$|workdir:|model:|provider:|approval:|sandbox:|reasoning|session id:|user$|codex$|tokens used$|[0-9,]+$)/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!noise.test(lines[i])) return lines[i];
  }
  return "";
}

function runCliText(
  command: string,
  args: string[],
  prompt: string,
  opts: { cwd: string; timeoutMs: number; inheritEnv?: boolean },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: buildChildEnv(opts.inheritEnv !== false),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      reject(new QuickCommitError(`${command} 调用超时。`, "CLAUDE_TIMEOUT"));
    }, opts.timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const code = error.code === "ENOENT" ? "CLAUDE_CLI_MISSING" : "CLAUDE_CLI_FAILED";
      reject(new QuickCommitError(error.code === "ENOENT" ? `未找到 ${command} CLI。` : `${command} CLI 失败：${error.message}`, code));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new QuickCommitError(`${command} CLI 失败：${(stderr || stdout).trim() || `exit ${code}`}`, "CLAUDE_CLI_FAILED"));
    });
    child.stdin?.end(prompt);
  });
}

async function callCodexText(prompt: string, cwd: string, opts: QuickCommitAiOptions): Promise<string> {
  const args = ["exec", "--json", "--color", "never", "--skip-git-repo-check", "--sandbox", "read-only"];
  const model = opts.model?.trim();
  if (model && model !== "default") args.push("--model", model);
  const reasoningEffort = thinkingEffortToCodexReasoningEffort(opts.thinkingEffort ?? "off");
  if (reasoningEffort) args.push("-c", `model_reasoning_effort=${reasoningEffort}`);
  args.push("-");
  const stdout = await runCliText("codex", args, prompt, {
    cwd,
    timeoutMs: CODEX_MESSAGE_TIMEOUT_MS,
    inheritEnv: opts.inheritEnv,
  });
  const text = extractCodexText(stdout);
  if (!text) {
    throw new QuickCommitError("Codex 返回了空的 commit message。", "EMPTY_AI_MESSAGE");
  }
  return text;
}

async function callAiText(prompt: string, cwd: string, language: string, opts: QuickCommitAiOptions): Promise<string> {
  if (normalizeProvider(opts.provider) === "codex") {
    return callCodexText(prompt, cwd, opts);
  }
  return callClaudeText(prompt, cwd, language, opts.model);
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

async function generateCommitMessage(cwd: string, language: string, ai: QuickCommitAiOptions = {}): Promise<string> {
  const diff = collectStagedDiff(cwd);
  const lang = language.trim() || "中文";
  const prompt = `阅读以下 git diff，用${lang}写一条简洁的 commit message。要求：祈使句，不超过 50 字，描述「做了什么」。只输出 message 本身，不要引号、不要 Markdown 格式、不要任何额外说明。\n\n${diff}`;
  const raw = await callAiText(prompt, cwd, language, ai);
  const message = normalizeAiText(raw);
  if (!message) {
    throw new QuickCommitError("AI 返回了空的 commit message。", "EMPTY_AI_MESSAGE");
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
  ai: QuickCommitAiOptions = {},
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
  const raw = await callAiText(prompt, cwd, language, ai);
  const parsed = tryParseJson(raw);

  let message: string;
  let suggestedTag: string | undefined;
  if (parsed && typeof parsed.message === "string") {
    message = normalizeAiText(parsed.message);
    suggestedTag = sanitizeSuggestedTag(parsed.tag);
  } else {
    // Fallback: treat whole output as message, no tag suggestion
    message = normalizeAiText(raw);
    suggestedTag = undefined;
  }
  if (!message) {
    throw new QuickCommitError("AI 返回了空的 commit message。", "EMPTY_AI_MESSAGE");
  }

  return { message, suggestedTag };
}

export async function generateCommitMessageOnly(
  cwd: string,
  language: string,
  ai: QuickCommitAiOptions = {},
): Promise<GenerateCommitMessageResult> {
  if (!cwd || !existsSync(cwd)) {
    throw new QuickCommitError("工作目录不存在。", "CWD_MISSING");
  }
  try {
    runGit(["add", "-A"], cwd, 5000);
  } catch {
    // best-effort staging so the diff is complete
  }
  return generateCommitMessageWithTag(cwd, language, ai);
}

/**
 * Ask Claude for a single tag string. Called from `runQuickCommit` after the commit has
 * already landed, so we look at `git show HEAD` and use `HEAD~1` for the previous tag.
 */
async function generateTagAfterCommit(
  cwd: string,
  language: string,
  commitMessage: string,
  ai: QuickCommitAiOptions = {},
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
  const raw = await callAiText(prompt, cwd, language, ai);
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
  /**
   * 父仓库 push 时对 submodule 的递归策略（默认 `"check"`）：
   *   - `"check"`：父仓库提交的 submodule 指针若指向尚未上远端的 commit 就报错提示，
   *     而不是像旧的 `on-demand` 那样在 submodule detached HEAD 下直接 `fatal` 崩溃。
   *   - `"no"`：完全不递归（submodule 已由 `pushSubmodules` 单独推送过）。
   */
  recurseSubmodules?: "no" | "check";
}

/**
 * Push current branch (with upstream auto-setup) and/or tags.
 * Errors are returned via `error` so callers can present partial-success states.
 */
function doPush(opts: DoPushOptions): PushOutcome {
  const { cwd, pushCommits, pushTags } = opts;
  const recurseFlag = `--recurse-submodules=${opts.recurseSubmodules ?? "check"}`;
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
        runGit(["push", recurseFlag], cwd, GIT_PUSH_TIMEOUT_MS);
      } else {
        runGit(["push", "-u", recurseFlag, pushRemote, "HEAD"], cwd, GIT_PUSH_TIMEOUT_MS);
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
  /** 是否同时把各 submodule 的 HEAD（+ 同名 tag）分别推送到各自远端分支。 */
  submodule?: boolean;
  /** `submodule` + `pushTags` 时，要连带推送到 submodule 的同名 tag。 */
  tagName?: string;
}

export async function runPush(opts: PushOptions): Promise<PushResult> {
  const { cwd, pushCommits = true, pushTags = false, submodule = false, tagName } = opts;
  assertGitWorkTree(cwd);
  if (!pushCommits && !pushTags) {
    throw new QuickCommitError("没有要推送的内容。", "NOTHING_TO_PUSH");
  }

  // 纳入 submodule：逐个把声明的 submodule 的 HEAD 推到各自远端分支（已是最新则 git 自身 no-op）。
  // 这覆盖「先 commit（含 submodule）后补 Push & Close」的场景——此时 submodule 已 clean、
  // status 看不到，但本地可能仍领先远端。父仓库随后用 recurse=no 推送。
  let subPushErrors: string[] = [];
  if (submodule) {
    const { base, infos } = collectSubmodulesForPush(cwd);
    if (infos.length > 0) {
      const subPush = pushSubmodules(base, infos, { pushTags: !!(pushTags && tagName), tagName });
      subPushErrors = subPush.errors;
    }
  }

  const outcome = doPush({ cwd, pushCommits, pushTags, recurseSubmodules: submodule ? "no" : "check" });
  return {
    ok: !outcome.error && subPushErrors.length === 0,
    pushedCommits: outcome.pushedCommits,
    pushedTags: outcome.pushedTags,
    error: outcome.error || (subPushErrors.length ? subPushErrors.join("；") : undefined),
  };
}

/**
 * 一个被提交的 submodule 的记录，携带「分别推送」需要的远端 + 目标分支信息。
 * `path` 相对其父仓库（base）目录。
 */
interface SubmoduleCommitInfo {
  path: string;
  hash: string;
  remote: string;
  branch: string;
}

/**
 * 解析一个 submodule 当前 HEAD 应推到哪个远端分支。submodule 经 `git submodule update`
 * 后通常处于 detached HEAD，不能直接 `git push`，必须显式 `HEAD:<branch>`，否则父仓库
 * `--recurse-submodules=on-demand` 会以「HEAD does not match the named branch」整体失败。
 * 优先取远端默认分支（`<remote>/HEAD` 指向）→ 当前命名分支 → 回退 main/master。
 */
function resolveSubmodulePushBranch(subCwd: string, remote: string): string {
  const prefix = `${remote}/`;
  try {
    const ref = runGit(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], subCwd);
    const name = (ref.startsWith(prefix) ? ref.slice(prefix.length) : ref).trim();
    if (name) return name;
  } catch {
    // ignore — fall through
  }
  try {
    const cur = runGit(["branch", "--show-current"], subCwd);
    if (cur) return cur;
  } catch {
    // ignore
  }
  try {
    runGit(["rev-parse", "--verify", `refs/remotes/${remote}/main`], subCwd);
    return "main";
  } catch {
    return "master";
  }
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
function commitDirtySubmodules(parentCwd: string, message: string): { commits: SubmoduleCommitInfo[]; errors: string[] } {
  const commits: SubmoduleCommitInfo[] = [];
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
    const remote = resolvePushRemote(subCwd);
    const branch = resolveSubmodulePushBranch(subCwd, remote);
    commits.push({ path: entry.path, hash, remote, branch });
  }
  return { commits, errors };
}

/** 对刚提交的 submodule 打上与父仓库同名的 tag。已存在同名 tag 则记为非致命跳过。 */
function tagSubmodules(parentCwd: string, subInfos: SubmoduleCommitInfo[], tagName: string): { tagged: string[]; errors: string[] } {
  const tagged: string[] = [];
  const errors: string[] = [];
  for (const info of subInfos) {
    const subCwd = `${parentCwd}/${info.path}`;
    try {
      runGit(["rev-parse", "--verify", `refs/tags/${tagName}`], subCwd);
      errors.push(`submodule ${info.path} 已存在 tag ${tagName}，跳过`);
      continue;
    } catch {
      // 不存在 → 继续打 tag
    }
    try {
      runGit(["tag", tagName], subCwd);
      tagged.push(info.path);
    } catch (error) {
      errors.push(`submodule ${info.path} 打 tag 失败：${getGitErrorMessage(error)}`);
    }
  }
  return { tagged, errors };
}

/**
 * 对每个 submodule 单独把当前 HEAD 推送到其远端分支（`HEAD:refs/heads/<branch>`），
 * 解决 detached HEAD 无法直接 push 的问题；`pushTags` 时连带把同名 tag 推上去。
 * 单个 submodule 失败收集为非致命错误。
 */
function pushSubmodules(
  parentCwd: string,
  subInfos: SubmoduleCommitInfo[],
  opts: { pushTags?: boolean; tagName?: string },
): { pushed: string[]; errors: string[] } {
  const pushed: string[] = [];
  const errors: string[] = [];
  for (const info of subInfos) {
    const subCwd = `${parentCwd}/${info.path}`;
    if (!existsSync(subCwd)) {
      errors.push(`submodule ${info.path} 路径不存在`);
      continue;
    }
    try {
      runGit(["push", info.remote, `HEAD:refs/heads/${info.branch}`], subCwd, GIT_PUSH_TIMEOUT_MS);
    } catch (error) {
      errors.push(`submodule ${info.path} 推送失败：${getGitErrorMessage(error)}`);
      continue;
    }
    if (opts.pushTags && opts.tagName) {
      try {
        runGit(["push", info.remote, `refs/tags/${opts.tagName}`], subCwd, GIT_PUSH_TIMEOUT_MS);
      } catch (error) {
        errors.push(`submodule ${info.path} 推送 tag 失败：${getGitErrorMessage(error)}`);
      }
    }
    pushed.push(info.path);
  }
  return { pushed, errors };
}

/**
 * 枚举仓库声明的全部 submodule（读 repo 根的 .gitmodules），为「单独 push」准备
 * remote + 目标分支。用于结果面板的 Push & Close：此时 submodule 多已 clean，
 * status 里看不到，但本地 HEAD 可能仍领先远端，需要逐个尝试推送（up-to-date 则 no-op）。
 */
function collectSubmodulesForPush(cwd: string): { base: string; infos: SubmoduleCommitInfo[] } {
  let base: string;
  try {
    base = runGit(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    base = cwd;
  }
  let raw: string;
  try {
    raw = runGitAllowEmpty(["config", "-f", `${base}/.gitmodules`, "--get-regexp", "\\.path$"], base);
  } catch {
    return { base, infos: [] };
  }
  const infos: SubmoduleCommitInfo[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 行格式：submodule.<name>.path <relpath>
    const rel = trimmed.split(/\s+/).slice(1).join(" ").trim();
    if (!rel) continue;
    const subCwd = `${base}/${rel}`;
    if (!existsSync(subCwd)) continue;
    const remote = resolvePushRemote(subCwd);
    const branch = resolveSubmodulePushBranch(subCwd, remote);
    infos.push({ path: rel, hash: "", remote, branch });
  }
  return { base, infos };
}

function buildFallbackPrompt(opts: QuickCommitOptions, priorError: string): string {
  const lang = opts.language.trim() || "中文";
  const messageLine = opts.autoMessage === false
    ? `- 使用这个 commit message：${(opts.customMessage || "").trim()}`
    : `- 先根据当前 staged/unstaged diff 生成一条简洁的 ${lang} commit message（祈使句，不超过 50 字）`;
  const tagLine = opts.tag?.trim()
    ? `- 提交后创建 tag：${opts.tag.trim()}`
    : opts.autoTag
      ? "- 提交后根据改动幅度创建下一个语义化版本 tag"
      : "- 不创建 tag";
  const pushLine = opts.push ? "- 提交完成后推送当前分支；如果创建了 tag，也推送该 tag" : "- 不执行 push";
  const submoduleLine = opts.submodule
    ? "- 如果 submodule 内部也有改动，先在对应 submodule 内 add/commit，再提交父仓库里的 submodule 指针"
    : "- 不进入 submodule 内部提交，只提交父仓库自身已纳入的改动";
  return [
    "你正在作为 Wand 的快捷提交兜底执行器运行。前置的内置快捷提交流程失败了，现在请直接用 CLI 工具完成同一件事。",
    "",
    "约束：",
    "- 只允许执行与 git 快捷提交直接相关的命令，例如 git status、git diff、git add、git commit、git tag、git push、git submodule status。",
    "- 不要修改源代码内容，不要运行测试，不要安装依赖，不要重构文件。",
    "- 如果没有可提交改动，明确说明并停止，不要创建空 commit。",
    "- commit message 和自然语言输出使用 " + lang + "。",
    "",
    "任务：",
    "- 执行 git add -A 纳入当前改动。",
    messageLine,
    tagLine,
    pushLine,
    submoduleLine,
    "",
    `内置流程失败原因：${priorError}`,
    "",
    "完成后只输出一行 JSON：{\"ok\":true,\"message\":\"...\",\"tag\":\"...\"}。失败时输出一行 JSON：{\"ok\":false,\"error\":\"...\"}。",
  ].join("\n");
}

function getHead(cwd: string): string | null {
  try {
    return runGit(["rev-parse", "HEAD"], cwd);
  } catch {
    return null;
  }
}

function getHeadSummary(cwd: string): { hash: string; message: string } {
  try {
    const raw = runGit(["log", "-1", "--pretty=format:%h%x09%s"], cwd);
    const parts = raw.split("\t");
    return { hash: parts[0] ?? "", message: parts.slice(1).join("\t") };
  } catch {
    return { hash: "", message: "" };
  }
}

function getLatestTagAtHead(cwd: string): string | undefined {
  try {
    return runGit(["describe", "--tags", "--exact-match", "HEAD"], cwd) || undefined;
  } catch {
    return undefined;
  }
}

async function runQuickCommitFallbackCli(opts: QuickCommitOptions, priorError: string): Promise<QuickCommitResult> {
  assertGitWorkTree(opts.cwd);
  const beforeHead = getHead(opts.cwd);
  const prompt = buildFallbackPrompt(opts, priorError);
  const provider = normalizeProvider(opts.provider);
  if (provider === "codex") {
    const args = ["exec", "--json", "--color", "never", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];
    const model = opts.model?.trim();
    if (model && model !== "default") args.push("--model", model);
    const reasoningEffort = thinkingEffortToCodexReasoningEffort(opts.thinkingEffort ?? "off");
    if (reasoningEffort) args.push("-c", `model_reasoning_effort=${reasoningEffort}`);
    args.push("-");
    await runCliText("codex", args, prompt, {
      cwd: opts.cwd,
      timeoutMs: QUICK_COMMIT_CLI_TIMEOUT_MS,
      inheritEnv: opts.inheritEnv,
    });
  } else {
    const args = ["-p", "--verbose", "--output-format", "stream-json"];
    const model = opts.model?.trim();
    if (model && model !== "default") args.push("--model", model);
    const claudeEffort = thinkingEffortToClaudeCliEffort(opts.thinkingEffort ?? "off");
    if (claudeEffort) args.push("--effort", claudeEffort);
    args.push("--permission-mode", "bypassPermissions");
    await runCliText("claude", args, prompt, {
      cwd: opts.cwd,
      timeoutMs: QUICK_COMMIT_CLI_TIMEOUT_MS,
      inheritEnv: opts.inheritEnv,
    });
  }

  const afterHead = getHead(opts.cwd);
  if (!afterHead || afterHead === beforeHead) {
    throw new QuickCommitError("CLI 兜底没有创建新的 commit。", "GIT_COMMIT_FAILED");
  }
  const commit = getHeadSummary(opts.cwd);
  const tag = getLatestTagAtHead(opts.cwd);
  return {
    ok: true,
    commit,
    tag: tag ? { name: tag } : undefined,
    pushed: false,
  };
}

function shouldFallbackToCli(error: QuickCommitError): boolean {
  return ![
    "CWD_MISSING",
    "NO_CWD",
    "NOT_A_GIT_REPO",
    "NO_COMMIT",
    "NOTHING_TO_COMMIT",
    "NOTHING_TO_PUSH",
    "EMPTY_MESSAGE",
    "EMPTY_TAG",
    "TAG_EXISTS",
  ].includes(error.code);
}

export async function runQuickCommitWithFallback(opts: QuickCommitOptions): Promise<QuickCommitResult> {
  try {
    return await runQuickCommit(opts);
  } catch (error) {
    if (error instanceof QuickCommitError && shouldFallbackToCli(error)) {
      return runQuickCommitFallbackCli(opts, error.message);
    }
    throw error;
  }
}

export async function runQuickCommit(opts: QuickCommitOptions): Promise<QuickCommitResult> {
  const { cwd, language, autoMessage, customMessage, tag, autoTag, push, submodule } = opts;
  const ai: QuickCommitAiOptions = {
    provider: opts.provider,
    model: opts.model,
    thinkingEffort: opts.thinkingEffort,
    inheritEnv: opts.inheritEnv,
  };

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
  // 默认不纳入 submodule：只有显式 opts.submodule 时，submodule 内部 dirty 才计入「有改动」。
  if (!parentHasStaged && !(submodule && submoduleHasDirty)) {
    if (submoduleHasDirty && !submodule) {
      throw new QuickCommitError(
        "父仓库没有改动；检测到 submodule 内部有改动，拖入 Submodule 球可一起提交。",
        "NOTHING_TO_COMMIT",
      );
    }
    throw new QuickCommitError("没有任何改动可以提交。", "NOTHING_TO_COMMIT");
  }

  let message: string;
  if (autoMessage) {
    message = await generateCommitMessage(cwd, language, ai);
  } else {
    message = (customMessage || "").trim();
    if (!message) {
      throw new QuickCommitError("commit message 不能为空。", "EMPTY_MESSAGE");
    }
  }

  // 仅当用户显式纳入 submodule 时，才进入各 submodule 内部提交其 dirty 改动；
  // 父仓库随后再 add 一次，picks up 新的 submodule 指针。
  let submoduleOutcome: { commits: SubmoduleCommitInfo[]; errors: string[] } = { commits: [], errors: [] };
  if (submodule) {
    submoduleOutcome = commitDirtySubmodules(cwd, message);
    if (submoduleOutcome.commits.length > 0) {
      try {
        runGit(["add", "-A"], cwd, 5000);
      } catch (error) {
        throw new QuickCommitError(`父仓库 add submodule 指针失败：${getGitErrorMessage(error)}`, "GIT_ADD_FAILED");
      }
      // 重新评估父仓库是否有 staged 内容：submodule 指针变了这里应为真。
      try {
        stagedFiles = runGitAllowEmpty(["diff", "--cached", "--name-only"], cwd).trim();
        parentHasStaged = stagedFiles.length > 0;
      } catch { /* keep stale value */ }
    }
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
    tagName = await generateTagAfterCommit(cwd, language, message, ai);
  }
  if (tagName) {
    try {
      runGit(["tag", tagName], cwd);
    } catch (error) {
      throw new QuickCommitError(`git tag 失败：${getGitErrorMessage(error)}`, "GIT_TAG_FAILED");
    }
    // 纳入 submodule 时给刚提交的 submodule 打同名 tag（非致命，失败不阻断父仓库流程）。
    if (submodule && submoduleOutcome.commits.length > 0) {
      tagSubmodules(cwd, submoduleOutcome.commits, tagName);
    }
  }

  let pushed = false;
  let pushError: string | undefined;
  if (push) {
    // 纳入 submodule：先把各 submodule 的 HEAD（+ 同名 tag）分别推到各自远端分支，
    // 解决 detached HEAD 无法被父仓库 on-demand 递归推送的问题；父仓库随后用
    // recurse=no 单独推（submodule 已就绪）。否则父仓库用 recurse=check 做安全校验。
    const includeSub = !!submodule && submoduleOutcome.commits.length > 0;
    let subPushErrors: string[] = [];
    if (includeSub) {
      const subPush = pushSubmodules(cwd, submoduleOutcome.commits, { pushTags: !!tagName, tagName });
      subPushErrors = subPush.errors;
    }
    const outcome = doPush({
      cwd,
      pushCommits: true,
      // Push only the freshly-created tag — avoids surprising users by pushing stale local tags.
      pushTags: tagName ? [tagName] : false,
      recurseSubmodules: includeSub ? "no" : "check",
    });
    pushed = outcome.pushedCommits && (tagName ? outcome.pushedTags : true) && subPushErrors.length === 0;
    pushError = outcome.error || (subPushErrors.length ? subPushErrors.join("；") : undefined);
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
