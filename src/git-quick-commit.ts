import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { GitStatusFileEntry, GitStatusResult, QuickCommitResult } from "./types.js";

const GIT_TIMEOUT_MS = 1500;
const MAX_FILE_ENTRIES = 200;
// claude 这次需要走完整 agent 循环（add/commit/可能还有 tag/push），给宽裕一点。
const CLAUDE_AGENT_TIMEOUT_MS = 180_000;

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
  // porcelain v2 行格式：
  //   1 XY sub mH mI mW hH hI path                 -- 普通改动
  //   2 XY sub mH mI mW hH hI X<score> path\torig  -- rename / copy
  //   ? path                                       -- untracked
  //   ! path                                       -- ignored
  //   # ...                                        -- branch / stash header（忽略）
  // sub 字段：4 字符，N....=非 submodule，S<C|.><M|.><U|.> = submodule 详细状态
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

interface PromptInput {
  language: string;
  autoMessage: boolean;
  customMessage?: string;
  makeTag: boolean;
  explicitTag?: string;
  push: boolean;
  latestTag?: string;
}

function buildQuickCommitPrompt(input: PromptInput): string {
  const lang = (input.language || "").trim() || "中文";
  const lines: string[] = [];

  lines.push("你正在帮我做一次快捷 git 提交。请用 Bash 工具按下面的步骤执行 git 命令，所有命令都在当前工作目录下运行。");
  lines.push("");
  lines.push("步骤：");
  lines.push("1. 跑 `git add -A` 把所有改动 stage 起来（包含 submodule 的指针变化）。");
  lines.push("2. 跑 `git diff --cached --name-only`；如果输出为空，说明没有改动可提交，跳到 \"无改动\" 分支。");
  lines.push("3. 跑 `git diff --cached --submodule=log` 阅读 staged 改动（diff 中 submodule 段落会展开成内部 commit 列表，注意据此判断 submodule 升级的语义）。");

  if (input.autoMessage) {
    lines.push(`4. 用 ${lang} 写一条简洁的 commit message：祈使句，不超过 50 字 / 12 单词，描述「做了什么」，不要 issue 编号、不要 Markdown、不要引号包裹。`);
  } else {
    const safe = (input.customMessage || "").replace(/`/g, "\\`");
    lines.push(`4. 使用我提供的 commit message（原样使用，不要修改）：\n   ${safe}`);
  }

  lines.push("5. 跑 `git commit -m \"<message>\"` 完成提交，记下生成的 commit hash（`git rev-parse HEAD`）。");

  if (input.makeTag) {
    if (input.explicitTag) {
      lines.push(`6. 跑 \`git tag ${input.explicitTag}\` 打 tag。如果 tag 已存在，就把错误带回 JSON 不要继续。`);
    } else {
      const base = input.latestTag || "v0.0.0";
      lines.push(`6. 基于最新 tag \`${base}\` 递增一个语义化版本号 tag（默认 patch +1；如果 diff 显示是较大改动，可以升 minor 或 major），然后跑 \`git tag <new-tag>\`。`);
    }
  }

  if (input.push) {
    lines.push(`${input.makeTag ? "7" : "6"}. push 到远端：`);
    lines.push("   - 先跑 `git rev-parse --abbrev-ref @{upstream}` 看当前分支是否有 upstream。");
    lines.push("   - 有 upstream：`git push --recurse-submodules=on-demand`");
    lines.push("   - 没 upstream：`git push -u --recurse-submodules=on-demand origin HEAD`");
    if (input.makeTag) {
      lines.push("   - **注意**：`git push` 不带 refspec 时不会推 tag。如果上一步打了 tag，要再跑 `git push origin refs/tags/<tag>` 单独把 tag 推上去。");
    }
    lines.push("   - 如果 push 失败，把错误信息放到 pushError 字段，但 commit 已成功的事实仍要在 JSON 里保留。");
  }

  lines.push("");
  lines.push("最终回复要求：你的最后一条文本回复**只**输出一行 JSON，不要 Markdown 代码块、不要任何其他说明文字。");
  lines.push("成功格式：");
  lines.push('{"ok":true,"commit":"<hash>","message":"<msg>","tag":"<tag 或空字符串>","pushed":<true|false>,"pushError":"<错误或空字符串>"}');
  lines.push("没有改动可提交时：");
  lines.push('{"ok":false,"errorCode":"NOTHING_TO_COMMIT"}');
  lines.push("其他错误（commit/tag 等失败）：");
  lines.push('{"ok":false,"errorCode":"<短代码>","error":"<可展示给用户的错误>"}');

  return lines.join("\n");
}

interface ClaudeQuickCommitResult {
  ok: boolean;
  commit?: string;
  message?: string;
  tag?: string;
  pushed?: boolean;
  pushError?: string;
  errorCode?: string;
  error?: string;
}

function parseFinalJson(stdout: string): ClaudeQuickCommitResult {
  // 从 stdout 反向找最后一个完整 { ... } 块解析。
  // claude 可能在前面有思考过程，也可能用 ```json 包装；只关心最末尾那个有效 JSON。
  const text = stdout.trim();
  if (!text) {
    throw new QuickCommitError("Claude 没有任何输出。", "CLAUDE_EMPTY_OUTPUT");
  }
  let depth = 0;
  let endIdx = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "}") {
      if (depth === 0) endIdx = i;
      depth++;
    } else if (c === "{") {
      depth--;
      if (depth === 0 && endIdx !== -1) {
        const candidate = text.slice(i, endIdx + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // 这一对不合法，继续往前找
          endIdx = -1;
        }
      }
    }
  }
  throw new QuickCommitError("Claude 返回的内容里没有可解析的 JSON。", "PARSE_FAILED");
}

function execClaudeAgent(cwd: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      [
        "-p",
        "--output-format", "text",
        "--permission-mode", "bypassPermissions",
        // 收紧到 Bash(git *)：claude 只能跑 git 子命令，不能 rm / curl 等。
        "--allowedTools", "Bash(git *)",
      ],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: CLAUDE_AGENT_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          const e = error as GitCommandError;
          if (e.code === "ENOENT") {
            reject(new QuickCommitError("未找到 claude CLI，无法执行快捷提交。", "CLAUDE_CLI_MISSING"));
            return;
          }
          if (e.code === "ETIMEDOUT") {
            reject(new QuickCommitError("Claude 执行超时（180 秒），请稍后再试或手动 commit。", "CLAUDE_TIMEOUT"));
            return;
          }
          const msg = (stderr || "").trim() || e.message || "claude 调用失败";
          reject(new QuickCommitError(`Claude CLI 失败：${msg}`, "CLAUDE_CLI_FAILED"));
          return;
        }
        resolve(stdout || "");
      },
    );
    child.stdin?.end(prompt);
  });
}

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

  if (!autoMessage && !(customMessage || "").trim()) {
    throw new QuickCommitError("commit message 不能为空。", "EMPTY_MESSAGE");
  }

  let latestTag: string | undefined;
  try {
    latestTag = runGit(["describe", "--tags", "--abbrev=0"], cwd);
  } catch {
    latestTag = undefined;
  }

  const prompt = buildQuickCommitPrompt({
    language,
    autoMessage,
    customMessage,
    makeTag: !!(autoTag || (tag && tag.trim())),
    explicitTag: tag && tag.trim() ? tag.trim() : undefined,
    push: !!push,
    latestTag,
  });

  const stdout = await execClaudeAgent(cwd, prompt);
  const result = parseFinalJson(stdout);

  if (!result.ok) {
    if (result.errorCode === "NOTHING_TO_COMMIT") {
      throw new QuickCommitError("没有任何改动可以提交。", "NOTHING_TO_COMMIT");
    }
    throw new QuickCommitError(
      result.error || "快捷提交失败。",
      result.errorCode || "QUICK_COMMIT_FAILED",
    );
  }

  return {
    ok: true,
    commit: result.commit
      ? { hash: String(result.commit), message: String(result.message || "") }
      : undefined,
    tag: result.tag ? { name: String(result.tag) } : undefined,
    pushed: !!result.pushed,
    pushError: result.pushError ? String(result.pushError) : undefined,
  };
}
