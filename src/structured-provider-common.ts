import type { SessionProvider, SessionRunner, SessionSnapshot, StructuredSessionState } from "./types.js";
import { defaultStructuredRunner, isNativeThinkingEffort, isSessionProvider } from "./provider-catalog.js";
import { shellQuote } from "./shell-quote.js";

export { defaultStructuredRunner } from "./provider-catalog.js";

/**
 * 把会话级系统提示交给 CLI 的开关。Claude / Qoder / Pi 用 `--append-system-prompt`，
 * Grok 用 `--rules`；Codex / OpenCode 没有这个入口，只能退回并入本轮消息。
 * 各 provider 的支持情况由 `--help` 实测得出，新增 provider 前先验。
 */
export function systemPromptFlag(provider: SessionProvider | null | undefined): string | null {
  switch (provider) {
    case "claude":
    case "qoder":
    case "pi":
      return "--append-system-prompt";
    case "grok":
      return "--rules";
    default:
      return null;
  }
}

/** 结构化 runner 的 args：provider 支持时把系统提示当成独立参数传。 */
export function systemPromptArgs(session: Pick<SessionSnapshot, "provider" | "systemPrompt" | "runtimeSystemPrompt">): string[] {
  const text = [session.systemPrompt?.trim(), session.runtimeSystemPrompt?.trim()].filter(Boolean).join("\n\n");
  if (!text) return [];
  const flag = systemPromptFlag(session.provider);
  return flag ? [flag, text] : [];
}

/**
 * provider 没有系统提示通道时的兜底：把它放在本会话第一条消息最前面，并写明它不是用户输入。
 * 只在首轮拼一次：后续轮次的消息已经接在有它的对话历史后面。有通道的 provider 不会走这里。
 */
export function promptWithSystemFallback(
  session: Pick<SessionSnapshot, "provider" | "systemPrompt" | "runtimeSystemPrompt" | "messages">,
  prompt: string,
): string {
  if (systemPromptFlag(session.provider)) return prompt;
  const base = (session.messages?.length ?? 0) <= 1 ? session.systemPrompt?.trim() : "";
  // Knowledge is live per turn, including resumed Codex/OpenCode conversations.
  const text = [base, session.runtimeSystemPrompt?.trim()].filter(Boolean).join("\n\n");
  return text ? composeSystemFallback(text, prompt) : prompt;
}

/** provider 没有系统提示通道时的并接格式：明确标出这不是用户输入。 */
export function composeSystemFallback(systemPrompt: string, prompt: string): string {
  return `以下是本会话的固定要求（来自系统，不是用户输入，优先级高于后面的内容）：\n\n${systemPrompt.trim()}\n\n---\n\n${prompt}`;
}

/** 把系统提示接到 CLI 命令上（provider 支持时）；不支持时原样返回，由调用方并进首条输入。 */
export function commandWithSystemPrompt(
  command: string,
  provider: SessionProvider | null | undefined,
  systemPrompt: string | null | undefined,
): string {
  const text = systemPrompt?.trim();
  if (!text) return command;
  const flag = systemPromptFlag(provider);
  if (!flag || command.includes(flag)) return command;
  return `${command} ${flag} ${shellQuote(text)}`;
}

/** 判断任意值是否为合法的 thinking effort（旧四档，或 `provider:level`）。 */
export function isThinkingEffort(value: unknown): value is NonNullable<SessionSnapshot["thinkingEffort"]> {
  return value === "off"
    || value === "standard"
    || value === "deep"
    || value === "max"
    || isNativeThinkingEffort(value);
}

/** 只取本 provider 的原生档位。别的 CLI 的前缀不能串过去。 */
export function prefixedThinkingEffort(
  provider: SessionProvider,
  effort: SessionSnapshot["thinkingEffort"],
): string | null {
  if (typeof effort !== "string") return null;
  const separator = effort.indexOf(":");
  if (separator <= 0) return null;
  if (effort.slice(0, separator) !== provider) return null;
  const level = effort.slice(separator + 1);
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(level) ? level : null;
}

export function isStructuredRunnerForProvider(provider: SessionProvider, runner: unknown): runner is SessionRunner {
  // "claude-sdk" 是历史值：SDK 执行路径已移除，只在读旧会话时用来识别（见 normalizeStructuredRunner）。
  return isSessionProvider(provider)
    && (runner === defaultStructuredRunner(provider) || provider === "claude" && runner === "claude-sdk");
}

/**
 * 历史值归一：`claude-sdk` 是 SDK 执行路径的遗留会话值（含旧客户端仍会提交的值）。
 * SDK 已移除，读路径把它映射成同一套 `claude -p` 执行，不报错、不丢会话。
 */
export function normalizeStructuredRunner(runner: unknown): unknown {
  return runner === "claude-sdk" ? "claude-cli-print" : runner;
}

export function resolveStructuredRunner(
  provider: SessionProvider,
  requestedRunner: unknown,
): SessionRunner {
  const normalized = normalizeStructuredRunner(requestedRunner);
  const runner = normalized ?? defaultStructuredRunner(provider);
  if (!isStructuredRunnerForProvider(provider, runner)) {
    throw new Error(`runner ${String(runner)} 不支持 provider ${provider}。`);
  }
  return runner === "claude-sdk" ? "claude-cli-print" : runner;
}

export function defaultStructuredState(
  provider: SessionProvider,
  runner: SessionRunner = defaultStructuredRunner(provider),
): StructuredSessionState {
  return {
    provider,
    runner,
    lastError: null,
    inFlight: false,
    activeRequestId: null,
    // 锚点是 inFlight 的派生读数：不在飞的默认态必须显式为 null，而不是 undefined，
    // 这样任何 {...defaultStructuredState(...)} 展开都不会把上一轮的旧锚点带出来。
    turnStartedAt: null,
    lastActivityAt: null,
  };
}

/**
 * 回合锚点的收敛兜底：`inFlight !== true` 时 turnStartedAt / lastActivityAt 一律读成
 * null。写入点已经逐条走 settleTurn()，这里再挡一层历史库残值和重启降级窗口——
 * 否则客户端会在一条早就结束的会话上算出「已运行 N 分钟」。
 */
export function normalizeTurnAnchors(
  state: StructuredSessionState | undefined,
): StructuredSessionState | undefined {
  if (!state || state.inFlight) return state;
  if (state.turnStartedAt === null && state.lastActivityAt === null) return state;
  return { ...state, turnStartedAt: null, lastActivityAt: null };
}

export function normalizeThinkingEffort(value: unknown): SessionSnapshot["thinkingEffort"] {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "off" || normalized === "standard" || normalized === "deep" || normalized === "max") return normalized;
  if (isNativeThinkingEffort(normalized)) return normalized as SessionSnapshot["thinkingEffort"];
  return null;
}

type ThinkingEffortProvider = "claude" | "codex" | "opencode" | "qoder" | "grok" | "pi";

interface ThinkingEffortMapping {
  /** Legacy tiers (standard/deep/max) expressed in this CLI's own level names. */
  legacy: { standard: string; deep: string; max: string };
  /** Result for an unset or "off" effort: null means "send no flag". */
  offValue: string | null;
  /** Normalizes a provider-native level the CLI cannot accept verbatim. */
  native?: (level: string) => string;
}

/**
 * Per-CLI thinking-effort tables. `provider:level` values pass through (after
 * `native`); legacy four-tier values map through `legacy`.
 */
const THINKING_EFFORT_MAPPINGS: Record<ThinkingEffortProvider, ThinkingEffortMapping> = {
  claude: { legacy: { standard: "low", deep: "medium", max: "max" }, offValue: null },
  codex: { legacy: { standard: "low", deep: "medium", max: "xhigh" }, offValue: null },
  opencode: { legacy: { standard: "low", deep: "high", max: "max" }, offValue: null },
  qoder: { legacy: { standard: "low", deep: "high", max: "max" }, offValue: null },
  // Grok's CLI accepts xhigh/high/medium/low only, so "max" (legacy or native) becomes xhigh.
  grok: {
    legacy: { standard: "low", deep: "high", max: "xhigh" },
    offValue: null,
    native: (level) => (level === "max" ? "xhigh" : level),
  },
  pi: { legacy: { standard: "low", deep: "high", max: "max" }, offValue: "off" },
};

function mapThinkingEffort(provider: ThinkingEffortProvider, effort: SessionSnapshot["thinkingEffort"]): string | null {
  const mapping = THINKING_EFFORT_MAPPINGS[provider];
  const native = prefixedThinkingEffort(provider, effort);
  if (native) return mapping.native ? mapping.native(native) : native;
  if (!effort || effort === "off") return mapping.offValue;
  if (effort === "standard") return mapping.legacy.standard;
  if (effort === "deep") return mapping.legacy.deep;
  if (effort === "max") return mapping.legacy.max;
  return null;
}

export function thinkingEffortToClaudeCliEffort(effort: SessionSnapshot["thinkingEffort"]): string | null {
  return mapThinkingEffort("claude", effort);
}

export function thinkingEffortToClaudeSlashEffort(effort: SessionSnapshot["thinkingEffort"]): string {
  return thinkingEffortToClaudeCliEffort(effort) ?? "auto";
}

export function thinkingEffortToCodexReasoningEffort(effort: SessionSnapshot["thinkingEffort"]): string | null {
  return mapThinkingEffort("codex", effort);
}

/** OpenCode `--variant`。旧四档仍是 low/high/max；`opencode:<level>` 原样传递。 */
export function thinkingEffortToOpenCodeVariant(effort: SessionSnapshot["thinkingEffort"]): string | null {
  return mapThinkingEffort("opencode", effort);
}

/** Qoder `--reasoning-effort`。旧四档仍是 low/high/max；`qoder:<level>` 原样传递。 */
export function thinkingEffortToQoderEffort(effort: SessionSnapshot["thinkingEffort"]): string | null {
  return mapThinkingEffort("qoder", effort);
}

/** Grok `--effort`。当前 CLI 不接受 `max`，旧的「最大」和误存的 `grok:max` 都落到 xhigh。 */
export function thinkingEffortToGrokEffort(effort: SessionSnapshot["thinkingEffort"]): string | null {
  return mapThinkingEffort("grok", effort);
}

/** Pi `--thinking`。未设置或 off 时显式传 off。 */
export function thinkingEffortToPiLevel(effort: SessionSnapshot["thinkingEffort"]): string | null {
  return mapThinkingEffort("pi", effort);
}
