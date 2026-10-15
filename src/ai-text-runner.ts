import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { appendDiagnosticTail,MAX_AI_TEXT_BYTES } from "./bounded-process-output.js";
import { QuickCommitError } from "./command-error.js";
import { registerTemporaryChild } from "./managed-temp.js";
import { abortableEmployeeText,prepareEmployeeTextCandidate,type EmployeeTextDeps } from "./employee-text.js";
import { buildChildEnv } from "./env-utils.js";
import { getGitErrorMessage } from "./git-utils.js";
import { buildLanguageDirective } from "./language-prompt.js";
import { candidateInstalled, isSessionProvider } from "./session-provider.js";
import { asRecord } from "./structured-content.js";
import {
  composeSystemFallback,systemPromptFlag,thinkingEffortToClaudeCliEffort,
  thinkingEffortToCodexReasoningEffort,thinkingEffortToGrokEffort,thinkingEffortToOpenCodeVariant,
  thinkingEffortToPiLevel,
  thinkingEffortToQoderEffort
} from "./structured-provider-common.js";
import type { AiTextRequest,SessionProvider,SessionSnapshot } from "./types.js";

export { QuickCommitError } from "./command-error.js";
const CLAUDE_MESSAGE_TIMEOUT_MS = 60_000;
const CODEX_MESSAGE_TIMEOUT_MS = 60_000;

/** Neutral one-shot text execution. Tool-running Git fallback never uses the retry chain. */
export function defaultProvider(provider: SessionProvider | undefined): SessionProvider {
  return isSessionProvider(provider) ? provider : "claude";
}

export interface QuickCommitAiOptions {
  modelGroups?: import("./model-groups.js").ModelGroup[];
  provider?: SessionProvider;
  model?: string | null;
  thinkingEffort?: SessionSnapshot["thinkingEffort"];
  inheritEnv?: boolean;
  /** 内置「系统运维」员工的角色设定：作为系统提示前缀注入。 */
  opsPersona?: string;
  /** 员工候选链（按顺序）；未设置时只用 provider/model 这一次调用。 */
  cliCandidates?: import("./types.js").AiCliCandidate[];
  /** SDK 使用当前实例配置与现有免费分组服务，不创建其他执行渠道。 */
  employeeText?: EmployeeTextDeps;
  /** 系统应用必须经员工渠道；没有可用候选时直接失败，不退回默认 provider。 */
  employeeChannelOnly?: boolean;
  /** 整条候选链的时间上限；默认 CLI_CHAIN_BUDGET_MS。第一条消息里的调用要短得多。 */
  budgetMs?: number;
  signal?: AbortSignal;
}

type CliAiTextOptions = QuickCommitAiOptions & { deadline?: number };

function cliTextTimeoutMs(defaultMs: number, opts: CliAiTextOptions): number {
  return opts.deadline === undefined ? defaultMs : Math.min(defaultMs, Math.max(1, opts.deadline - Date.now()));
}

/**
 * 一次性 Claude 文本生成（commit message / tag / 提示词优化…）。
 *
 * 直接 spawn 本机 `claude -p`，与 PTY / 结构化会话同源：认证、模型、`~/.claude`
 * 配置完全一致。对齐原来 SDK 时代的行为：
 *   - `--tools ""` 关掉全部工具：纯文本生成不需要工具，也避免一次性短调用顺手读文件；
 *   - `--no-session-persistence`：不污染 `~/.claude/projects/` 的会话历史；
 *   - `--strict-mcp-config`（不给 --mcp-config）：跳过用户配置的 MCP，省启动时间与 token。
 * 语言指令与任务规则都走 `--append-system-prompt`，任务自己的输出格式排在后面。
 */
async function callClaudeText(
  request: AiTextRequest,
  cwd: string,
  language: string | undefined,
  opts: CliAiTextOptions,
): Promise<string> {
  const args = ["-p", "--output-format", "text", "--tools", "", "--no-session-persistence", "--strict-mcp-config"];
  const languageDirective = language ? buildLanguageDirective(language) : "";
  const systemPrompt = [languageDirective, (request.system ?? "").trim()].filter(Boolean).join("\n\n");
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  const model = opts.model?.trim();
  if (model && model !== "default") args.push("--model", model);
  const effort = thinkingEffortToClaudeCliEffort(opts.thinkingEffort ?? "off");
  if (effort) args.push("--effort", effort);
  const stdout = await runCliText("claude", args, request.prompt, {
    cwd,
    timeoutMs: cliTextTimeoutMs(CLAUDE_MESSAGE_TIMEOUT_MS, opts),
    inheritEnv: opts.inheritEnv, signal: opts.signal,
  });
  const text = stdout.trim();
  if (!text) throw new QuickCommitError("Claude 返回了空的 commit message。", "EMPTY_AI_MESSAGE");
  return text;
}

function stripFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export function normalizeAiText(raw: string): string {
  return stripFences(raw).replace(/^["'`]+|["'`]+$/g, "").trim();
}

/** Read explicit protocol failures, not error-looking prose that could be legitimate output. */
function cliProtocolErrorText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(cliProtocolErrorText).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["message", "error", "errors", "data", "result"]) {
    const text = cliProtocolErrorText(record[key]);
    if (text) return text;
  }
  return "";
}

/** A zero process exit does not imply a successful model response. */
function assertCliProtocolSucceeded(stdout: string, provider: SessionProvider): void {
  let failure: string | null = null;
  const failed = (value: unknown): string => cliProtocolErrorText(value) || `${provider} CLI execution failed`;
  for (const line of stdout.split(/\r?\n/)) {
    let event: Record<string, unknown> | null;
    try { event = asRecord(JSON.parse(line)); } catch { continue; }
    if (!event) continue;
    if (provider === "codex") {
      if (event.type === "error" || event.type === "turn.failed") failure = failed(event);
      if (event.type === "turn.completed") failure = null;
    } else if (provider === "qoder" && event.type === "result") {
      failure = event.is_error === true || event.subtype !== "success" ? failed(event) : null;
    } else if (provider === "pi") {
      const messages = event.type === "agent_end" && Array.isArray(event.messages)
        ? event.messages
        : event.type === "message_end" || event.type === "turn_end" ? [event.message] : [];
      for (const raw of messages) {
        const message = asRecord(raw);
        if (message?.role !== "assistant") continue;
        failure = message.stopReason === "error" || message.stopReason === "aborted"
          ? failed(message.errorMessage) : null;
      }
    } else if ((provider === "grok" || provider === "opencode") && event.type === "error") {
      failure = failed(event);
    }
  }
  if (failure) throw new QuickCommitError(`${provider} CLI 失败：${failure}`, "CLAUDE_CLI_FAILED");
}

function extractCodexText(stdout: string): string {
  assertCliProtocolSucceeded(stdout, "codex");
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

function extractOpenCodeText(stdout: string): string {
  assertCliProtocolSucceeded(stdout, "opencode");
  const texts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { type?: string; part?: { text?: unknown } };
      if (parsed.type === "text" && typeof parsed.part?.text === "string" && parsed.part.text.trim()) {
        texts.push(parsed.part.text.trim());
      }
    } catch {
      // ignore diagnostics mixed into stdout
    }
  }
  return texts.join("\n").trim();
}

function extractGrokText(stdout: string): string {
  assertCliProtocolSucceeded(stdout, "grok");
  let text = "";
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { type?: string; data?: unknown };
      if (parsed.type === "text" && typeof parsed.data === "string") text += parsed.data;
    } catch {
      // ignore diagnostics mixed into stdout
    }
  }
  return text.trim();
}

function extractQoderText(stdout: string): string {
  assertCliProtocolSucceeded(stdout, "qoder");
  let resultText = "";
  const assistantTexts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string;
        subtype?: string;
        result?: unknown;
        message?: { content?: unknown };
      };
      if (parsed.type === "result" && parsed.subtype === "success" && typeof parsed.result === "string") {
        resultText = parsed.result;
        continue;
      }
      if (parsed.type !== "assistant" || !Array.isArray(parsed.message?.content)) continue;
      for (const block of parsed.message.content) {
        if (
          block
          && typeof block === "object"
          && (block as { type?: unknown }).type === "text"
          && typeof (block as { text?: unknown }).text === "string"
        ) {
          assistantTexts.push((block as { text: string }).text);
        }
      }
    } catch {
      // ignore diagnostics mixed into stdout
    }
  }
  return (resultText || assistantTexts.join("\n")).trim();
}

function extractPiText(stdout: string): string {
  assertCliProtocolSucceeded(stdout, "pi");
  let text = "";
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
      if (event.type !== "message_end" || event.message?.role !== "assistant" || !Array.isArray(event.message.content)) continue;
      text = event.message.content
        .filter((block): block is { type: "text"; text: string } => !!block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
        .map((block) => block.text)
        .join("\n");
    } catch { /* ignore non-protocol stdout */ }
  }
  return text.trim();
}

export function buildPiTextArgs(request: AiTextRequest, opts: QuickCommitAiOptions, allowTools = false): string[] {
  const args = ["--mode", "json", "--print", "--no-session"];
  if (!allowTools) args.push("--no-tools");
  const model = opts.model?.trim();
  if (model && model !== "default") args.push("--model", model);
  const level = thinkingEffortToPiLevel(opts.thinkingEffort ?? "off");
  if (level) args.push("--thinking", level);
  args.push(...systemPromptArgsFrom("pi", request.system));
  args.push(request.prompt);
  return args;
}

export function buildGrokTextArgs(request: AiTextRequest, opts: QuickCommitAiOptions, allowTools = false): string[] {  const args = ["--no-auto-update", "-p", request.prompt, "--output-format", "streaming-json"];
  const model = opts.model?.trim();
  if (model && model !== "default") args.push("--model", model);
  const effort = thinkingEffortToGrokEffort(opts.thinkingEffort ?? "off");
  if (effort) args.push("--effort", effort);
  args.push(...systemPromptArgsFrom("grok", request.system));
  if (allowTools) args.push("--always-approve");
  else args.push("--tools", "", "--disallowed-tools",
    "run_terminal_cmd,read_file,search_replace,grep,list_dir,web_search,web_fetch,todo_write,task,Agent",
    "--deny", "MCPTool", "--disable-web-search", "--no-subagents");
  return args;
}

export function buildQoderTextArgs(request: AiTextRequest, opts: QuickCommitAiOptions, allowTools = false): string[] {
  const args = ["-p", request.prompt, "--output-format", "stream-json", "--no-session-persistence"];
  const model = opts.model?.trim();
  if (model && model !== "default") args.push("--model", model);
  const effort = thinkingEffortToQoderEffort(opts.thinkingEffort ?? "off");
  if (effort) args.push("--reasoning-effort", effort);
  args.push(...systemPromptArgsFrom("qoder", request.system));
  if (allowTools) args.push("--permission-mode", "bypass_permissions");
  else args.push("--tools", "", "--strict-mcp-config");
  return args;
}

/** provider 自己的系统提示开关 + 规则文本；没有开关的 provider 返回空。 */
export function systemPromptArgsFrom(provider: SessionProvider, system: string): string[] {
  const text = system?.trim();
  if (!text) return [];
  const flag = systemPromptFlag(provider);
  return flag ? [flag, text] : [];
}

/** 没有系统提示开关的 provider（codex / opencode）：规则只能并进内容前面。 */
export function contentWithSystemPrompt(provider: SessionProvider, request: AiTextRequest): string {
  return systemPromptFlag(provider) ? request.prompt : composeSystemFallback(request.system, request.prompt);
}

export function runCliText(
  command: string,
  args: string[],
  prompt: string,
  opts: { cwd: string; timeoutMs: number; inheritEnv?: boolean; signal?: AbortSignal; env?: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv; temporaryDirectory?: string; onChildClose?: () => void },
): Promise<string> {
  opts.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const baseEnv = buildChildEnv(opts.inheritEnv !== false);
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ? opts.env(baseEnv) : baseEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (opts.temporaryDirectory) {
      try { registerTemporaryChild(opts.temporaryDirectory, child.pid); }
      catch {
        child.on("error", () => {});
        child.once("close", () => { reject(new Error("AI text temporary lease unavailable")); });
        child.kill("SIGKILL"); return;
      }
    }
    let stdout = "";
    let stdoutBytes = 0;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stderr = "";
    let settled = false;
    const cancelled = (): void => {
      if (settled) return;
      settled = true; clearTimeout(timeout); child.kill("SIGTERM");
      reject(opts.signal?.reason ?? new Error("AI 文本请求已取消。"));
    };
    const cleanup = (): void => { clearTimeout(timeout); opts.signal?.removeEventListener("abort", cancelled); };
    const timeout = setTimeout(() => {
      settled = true;
      opts.signal?.removeEventListener("abort", cancelled);
      child.kill("SIGTERM");
      reject(new QuickCommitError(`${command} 调用超时。`, "CLAUDE_TIMEOUT"));
    }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", cancelled, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_AI_TEXT_BYTES) {
        settled = true; cleanup(); child.kill("SIGTERM");
        reject(new QuickCommitError("AI 文本输出超过 4 MiB 上限，未使用截断结果。", "CLAUDE_CLI_FAILED"));
        return;
      }
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!settled) stderr = appendDiagnosticTail(stderr, stderrDecoder.write(chunk));
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      const code = error.code === "ENOENT" ? "CLAUDE_CLI_MISSING" : "CLAUDE_CLI_FAILED";
      reject(new QuickCommitError(error.code === "ENOENT" ? `未找到 ${command} CLI。` : `${command} CLI 失败：${error.message}`, code));
    });
    child.on("close", (code) => {
      cleanup();
      opts.onChildClose?.();
      if (settled) return;
      settled = true;
      stdout += stdoutDecoder.end();
      stderr = appendDiagnosticTail(stderr, stderrDecoder.end());
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new QuickCommitError(`${command} CLI 失败：${(stderr || stdout).trim() || `exit ${code}`}`, "CLAUDE_CLI_FAILED"));
    });
    // A CLI may exit before reading stdin (e.g. invalid credentials/argv).
    // The writable stream emits EPIPE independently of ChildProcess.error;
    // without a listener that becomes an uncaught exception after callers
    // have already finished their turn or closed storage.
    //
    // A closed stdin is only a delivery failure when we actually had prompt
    // bytes to send. Arg-driven providers (e.g. `pi`) are called with an empty
    // prompt, so the child may close stdin before we end the stream; treating
    // that as failure made the same run succeed or fail at random.
    const expectsStdin = prompt.length > 0;
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (settled || !expectsStdin) return;
      settled = true;
      cleanup();
      child.kill("SIGTERM");
      reject(new QuickCommitError(`${command} CLI stdin failed: ${error.code ?? "write error"}`, "CLAUDE_CLI_FAILED"));
    });
    child.stdin?.end(prompt);
  });
}

async function callCodexText(request: AiTextRequest, cwd: string, opts: CliAiTextOptions): Promise<string> {
  // Quick commit is an internal one-shot request, not a user conversation. Keep
  // Codex from persisting it into ~/.codex/sessions, where Wand would otherwise
  // surface the generated prompt as a recoverable session.
  const args = ["exec", "--ephemeral", "--json", "--color", "never", "--skip-git-repo-check", "--sandbox", "read-only"];
  const model = opts.model?.trim();
  if (model && model !== "default") args.push("--model", model);
  const reasoningEffort = thinkingEffortToCodexReasoningEffort(opts.thinkingEffort ?? "off");
  if (reasoningEffort) args.push("-c", `model_reasoning_effort=${reasoningEffort}`);
  args.push("-");
  const stdout = await runCliText("codex", args, contentWithSystemPrompt("codex", request), {
    cwd,
    timeoutMs: cliTextTimeoutMs(CODEX_MESSAGE_TIMEOUT_MS, opts),
    inheritEnv: opts.inheritEnv, signal: opts.signal,
  });
  const text = extractCodexText(stdout);
  if (!text) {
    throw new QuickCommitError("Codex 返回了空的 commit message。", "EMPTY_AI_MESSAGE");
  }
  return text;
}

async function callOpenCodeText(request: AiTextRequest, cwd: string, opts: CliAiTextOptions): Promise<string> {
  const agent = `wand-text-${randomUUID()}`;
  const args = ["run", "--format", "json", "--pure", "--agent", agent];
  const model = opts.model?.trim();
  if (model && model !== "default") args.push("--model", model);
  const variant = thinkingEffortToOpenCodeVariant(opts.thinkingEffort ?? "off");
  if (variant) args.push("--variant", variant);
  const stdout = await runCliText("opencode", args, contentWithSystemPrompt("opencode", request), {
    cwd,
    timeoutMs: cliTextTimeoutMs(CODEX_MESSAGE_TIMEOUT_MS, opts),
    inheritEnv: opts.inheritEnv, signal: opts.signal,
    // A dedicated per-invocation agent and scalar deny replace rather than merge
    // wildcard/specific allow rules. Preserve inherited provider/model config.
    env: base => {
      const configured = base.OPENCODE_CONFIG_CONTENT ? JSON.parse(base.OPENCODE_CONFIG_CONTENT) : {};
      if (!configured || typeof configured !== "object" || Array.isArray(configured)) throw new Error("OpenCode 内联配置无效。");
      return { ...base, OPENCODE_PERMISSION: JSON.stringify("deny"), OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...configured, permission: "deny", autoupdate: false, share: "disabled",
        agent: { ...configured.agent, [agent]: { mode: "primary", permission: "deny", prompt: "Return only the requested text. Do not use tools." } },
      }) };
    },
  });
  const text = extractOpenCodeText(stdout);
  if (!text) throw new QuickCommitError("OpenCode 返回了空的 commit message。", "EMPTY_AI_MESSAGE");
  return text;
}

async function callGrokText(request: AiTextRequest, cwd: string, opts: CliAiTextOptions): Promise<string> {
  const stdout = await runCliText("grok", buildGrokTextArgs(request, opts), "", {
    cwd,
    timeoutMs: cliTextTimeoutMs(CODEX_MESSAGE_TIMEOUT_MS, opts),
    inheritEnv: opts.inheritEnv, signal: opts.signal,
  });
  const text = extractGrokText(stdout);
  if (!text) throw new QuickCommitError("Grok 返回了空的 commit message。", "EMPTY_AI_MESSAGE");
  return text;
}

async function callQoderText(request: AiTextRequest, cwd: string, opts: CliAiTextOptions): Promise<string> {
  const stdout = await runCliText("qodercli", buildQoderTextArgs(request, opts), "", {
    cwd,
    timeoutMs: cliTextTimeoutMs(CODEX_MESSAGE_TIMEOUT_MS, opts),
    inheritEnv: opts.inheritEnv, signal: opts.signal,
  });
  const text = extractQoderText(stdout);
  if (!text) throw new QuickCommitError("Qoder 返回了空的 commit message。", "EMPTY_AI_MESSAGE");
  return text;
}

async function callPiText(request: AiTextRequest, cwd: string, opts: CliAiTextOptions): Promise<string> {
  const stdout = await runCliText("pi", buildPiTextArgs(request, opts), "", {
    cwd, timeoutMs: cliTextTimeoutMs(CODEX_MESSAGE_TIMEOUT_MS, opts), inheritEnv: opts.inheritEnv, signal: opts.signal,
  });
  const text = extractPiText(stdout);
  if (!text) throw new QuickCommitError("Pi 返回了空的 commit message。", "EMPTY_AI_MESSAGE");
  return text;
}

export async function callCliAiText(request: AiTextRequest, cwd: string, language: string, opts: CliAiTextOptions): Promise<string> {
  const provider = defaultProvider(opts.provider);
  if (provider === "codex") {
    return callCodexText(request, cwd, opts);
  }
  if (provider === "opencode") return callOpenCodeText(request, cwd, opts);
  if (provider === "grok") return callGrokText(request, cwd, opts);
  if (provider === "qoder") return callQoderText(request, cwd, opts);
  if (provider === "pi") return callPiText(request, cwd, opts);
  return callClaudeText(request, cwd, language, opts);
}

/**
 * 多候选降级时给整条链的时间上限。原生客户端的请求宽限约 180s，
 * 候选再多也不能把整个请求拖死；单次仍受各自 CLI 超时保护。
 */
const CLI_CHAIN_BUDGET_MS = 150_000;

/** 角色设定走系统提示前缀；任务自己的输出格式与约束必须排在后面。 */
export function withOpsPersona(request: AiTextRequest, persona?: string): AiTextRequest {
  const trimmed = (persona ?? "").trim();
  if (!trimmed) return request;
  const task = (request.system ?? "").trim();
  return { ...request, system: task ? `${trimmed}\n\n${task}` : trimmed };
}

/** 链上的每条候选变成一次普通的 CLI 文本调用参数。 */
function candidateOptions(base: QuickCommitAiOptions, candidate: import("./types.js").AiCliCandidate): QuickCommitAiOptions {
  return {
    ...base,
    provider: candidate.provider,
    model: candidate.model ?? null,
    thinkingEffort: candidate.thinkingEffort ?? base.thinkingEffort ?? undefined,
  };
}

/** 没有候选链时，把当前 provider/model 当作唯一的候选。 */
function singleCandidate(opts: QuickCommitAiOptions): import("./types.js").AiCliCandidate {
  return {
    provider: defaultProvider(opts.provider),
    model: opts.model ?? undefined,
    thinkingEffort: opts.thinkingEffort ?? undefined,
  };
}

/**
 * 按顺序尝试候选：跳过没安装的 CLI，协议与输出校验均成功才返回。
 * 只有一条候选时保持原行为（错误原样抛出，不摘要）。
 * 仅用于一次性文本生成；执行工具的任务不能使用这条无条件重试路径。
 */
async function callTextCandidates<T>(
  request: AiTextRequest,
  cwd: string,
  language: string,
  opts: QuickCommitAiOptions,
  parseOutput: (raw: string) => T,
): Promise<T> {
  opts.signal?.throwIfAborted();
  const { resolveModelGroupModels } = await import("./model-groups.js");
  const modelGroups = opts.modelGroups ?? opts.employeeText?.config.modelGroups;
  const seen = new Set<string>();
  const chain = (opts.cliCandidates?.length ? opts.cliCandidates : [singleCandidate(opts)])
    .flatMap((candidate) => resolveModelGroupModels(modelGroups, candidate.provider, candidate.model,
      { preferDefault: !candidate.model || candidate.model === "default" })
      .map((model) => ({ ...candidate, model: model || undefined })))
    .filter(candidate => {
      const key = JSON.stringify([candidate.provider, candidate.engine ?? "cli", candidate.model ?? "", candidate.thinkingEffort ?? opts.thinkingEffort]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  if (opts.employeeChannelOnly && !opts.cliCandidates?.length) {
    throw new QuickCommitError("系统员工没有可用的执行候选。", "AI_FALLBACK_FAILED");
  }
  const deadline = Date.now() + Math.max(1, opts.budgetMs ?? CLI_CHAIN_BUDGET_MS);
  const call = async (candidate: import("./types.js").AiCliCandidate): Promise<string> => {
    if (candidate.engine !== "sdk") return callCliAiText(request, cwd, language, { ...candidateOptions(opts, candidate), deadline });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new QuickCommitError("Wand Agent 调用超时。", "CLAUDE_TIMEOUT")), Math.max(1, deadline - Date.now()));
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
    try {
      const generate = await abortableEmployeeText(prepareEmployeeTextCandidate({
        ...opts.employeeText,
        config: { ...opts.employeeText?.config, defaultCwd: cwd, inheritEnv: opts.inheritEnv ?? opts.employeeText?.config.inheritEnv, modelGroups },
      }, { ...candidate, model: candidate.model ?? "default", thinkingEffort: candidate.thinkingEffort ?? opts.thinkingEffort ?? "off", mode: "default", kind: "structured" }, request, signal), signal);
      signal.throwIfAborted();
      return await abortableEmployeeText(generate(), signal);
    } finally { clearTimeout(timer); }
  };
  if (chain.length === 1) return parseOutput(await call(chain[0]!));

  const installed = chain.filter((candidate) => candidateInstalled(candidate));
  const attempts = installed.length ? installed : chain;
  const errors: string[] = [];
  for (const candidate of attempts) {
    opts.signal?.throwIfAborted();
    if (Date.now() >= deadline) {
      errors.push("已超过等待上限");
      break;
    }
    try {
      const text = await call(candidate);
      const result = await parseOutput(text);
      if (candidate !== attempts[0]) {
        console.info(`[SystemAi] 候选 ${chain.indexOf(candidate) + 1}/${chain.length} (${candidate.provider}) 成功`);
      }
      return result;
    } catch (error) {
      opts.signal?.throwIfAborted();
      errors.push(`${candidate.provider}: ${getGitErrorMessage(error)}`);
      // 不记录提示词、路径、CLI 原始响应或可能带鉴权信息的错误正文。
      const code = error instanceof QuickCommitError ? error.code : "INVALID_AI_RESULT";
      console.warn(`[SystemAi] 候选 ${chain.indexOf(candidate) + 1}/${chain.length} (${candidate.provider}) 失败: ${code}`);
    }
  }
  throw new QuickCommitError(`所有执行候选均失败：${errors.join("；")}`, "AI_FALLBACK_FAILED");
}

/**
 * Run a lightweight AI request through the system employee's configured chain.
 * provider 与引擎由候选决定；SDK 与 CLI 均保留各自适配和身份。
 * parseOutput 在候选链内解析/校验结果；失败后继续下一条，而非提前宣布成功。
 */
export function callConfiguredAiText(
  request: AiTextRequest,
  cwd: string,
  language: string,
  opts: QuickCommitAiOptions,
): Promise<string>;
export function callConfiguredAiText<T>(
  request: AiTextRequest,
  cwd: string,
  language: string,
  opts: QuickCommitAiOptions,
  parseOutput: (raw: string) => T,
): Promise<T>;
export async function callConfiguredAiText(
  request: AiTextRequest,
  cwd: string,
  language: string,
  opts: QuickCommitAiOptions,
  parseOutput: (raw: string) => unknown = (raw) => raw,
): Promise<unknown> {
  return callTextCandidates(withOpsPersona(request, opts.opsPersona), cwd, language, opts, parseOutput);
}

