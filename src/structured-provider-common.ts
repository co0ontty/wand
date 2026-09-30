import type { SessionProvider, SessionRunner, SessionSnapshot, StructuredSessionState, WandConfig } from "./types.js";
import { shellQuote } from "./shell-quote.js";

const NATIVE_THINKING_EFFORT = /^(claude|codex|opencode|grok|qoder|pi):[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * 把会话级系统提示交给 CLI 的开关。Claude / Qoder / Pi 用 `--append-system-prompt`，
 * Grok 用 `--rules`；Codex / OpenCode / Gemini 没有这个入口，只能退回并入本轮消息
 * （Gemini 只有 `GEMINI_SYSTEM_MD`，那是整体替换而非追加）。
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
export function systemPromptArgs(session: Pick<SessionSnapshot, "provider" | "systemPrompt">): string[] {
  const text = session.systemPrompt?.trim();
  if (!text) return [];
  const flag = systemPromptFlag(session.provider);
  return flag ? [flag, text] : [];
}

/**
 * provider 没有系统提示通道时的兜底：把它放在本会话第一条消息最前面，并写明它不是用户输入。
 * 只在首轮拼一次：后续轮次的消息已经接在有它的对话历史后面。有通道的 provider 不会走这里。
 */
export function promptWithSystemFallback(
  session: Pick<SessionSnapshot, "provider" | "systemPrompt" | "messages">,
  prompt: string,
): string {
  const text = session.systemPrompt?.trim();
  if (!text || systemPromptFlag(session.provider)) return prompt;
  if ((session.messages?.length ?? 0) > 1) return prompt;
  return composeSystemFallback(text, prompt);
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
    || (typeof value === "string" && NATIVE_THINKING_EFFORT.test(value));
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
  if (provider === "claude") return runner === "claude-sdk" || runner === "claude-cli-print";
  if (provider === "codex") return runner === "codex-cli-exec";
  if (provider === "opencode") return runner === "opencode-cli-run";
  if (provider === "grok") return runner === "grok-cli-headless";
  if (provider === "qoder") return runner === "qoder-cli-print";
  if (provider === "pi") return runner === "pi-cli-json";
  return runner === "gemini-cli-json";
}

export function defaultStructuredRunner(
  provider: SessionProvider,
  configuredClaudeRunner: WandConfig["structuredRunner"] = "cli",
): SessionRunner {
  if (provider === "codex") return "codex-cli-exec";
  if (provider === "opencode") return "opencode-cli-run";
  if (provider === "grok") return "grok-cli-headless";
  if (provider === "qoder") return "qoder-cli-print";
  if (provider === "pi") return "pi-cli-json";
  if (provider === "gemini") return "gemini-cli-json";
  return configuredClaudeRunner === "sdk" ? "claude-sdk" : "claude-cli-print";
}

export function resolveStructuredRunner(
  provider: SessionProvider,
  requestedRunner: unknown,
  configuredClaudeRunner: WandConfig["structuredRunner"] = "cli",
): SessionRunner {
  const runner = requestedRunner ?? defaultStructuredRunner(provider, configuredClaudeRunner);
  if (!isStructuredRunnerForProvider(provider, runner)) {
    throw new Error(`runner ${String(runner)} 不支持 provider ${provider}。`);
  }
  return runner;
}

export function defaultStructuredState(
  provider: SessionProvider,
  runner = defaultStructuredRunner(provider),
): StructuredSessionState {
  return { provider, runner, lastError: null, inFlight: false, activeRequestId: null };
}

export function normalizeThinkingEffort(value: unknown): SessionSnapshot["thinkingEffort"] {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "off" || normalized === "standard" || normalized === "deep" || normalized === "max") return normalized;
  if (NATIVE_THINKING_EFFORT.test(normalized)) return normalized as SessionSnapshot["thinkingEffort"];
  return null;
}

export function thinkingEffortToSdkBudget(effort: SessionSnapshot["thinkingEffort"]): number {
  const native = prefixedThinkingEffort("claude", effort) ?? effort;
  if (native === "standard" || native === "low") return 4096;
  if (native === "deep" || native === "medium" || native === "high") return 16000;
  if (native === "max" || native === "xhigh" || native === "ultra") return 31999;
  return 0;
}

export function thinkingEffortToClaudeCliEffort(
  effort: SessionSnapshot["thinkingEffort"],
): string | null {
  const native = prefixedThinkingEffort("claude", effort);
  if (native) return native;
  if (effort === "standard") return "low";
  if (effort === "deep") return "medium";
  if (effort === "max") return "max";
  return null;
}

export function thinkingEffortToClaudeSlashEffort(effort: SessionSnapshot["thinkingEffort"]): string {
  return thinkingEffortToClaudeCliEffort(effort) ?? "auto";
}

export function thinkingEffortToCodexReasoningEffort(effort: SessionSnapshot["thinkingEffort"]): string | null {
  const native = prefixedThinkingEffort("codex", effort);
  if (native) return native;
  if (effort === "standard") return "low";
  if (effort === "deep") return "medium";
  if (effort === "max") return "xhigh";
  return null;
}

function thinkingEffortToNamedLevels(
  provider: SessionProvider,
  effort: SessionSnapshot["thinkingEffort"],
  legacy: { standard: string; deep: string; max: string },
): string | null {
  const native = prefixedThinkingEffort(provider, effort);
  if (native) return native;
  if (!effort || effort === "off") return null;
  if (effort === "standard") return legacy.standard;
  if (effort === "deep") return legacy.deep;
  if (effort === "max") return legacy.max;
  return null;
}

/** OpenCode `--variant`。旧四档仍是 low/high/max；`opencode:<level>` 原样传递。 */
export function thinkingEffortToOpenCodeVariant(effort: SessionSnapshot["thinkingEffort"]): string | null {
  return thinkingEffortToNamedLevels("opencode", effort, { standard: "low", deep: "high", max: "max" });
}

/** Qoder `--reasoning-effort`。旧四档仍是 low/high/max；`qoder:<level>` 原样传递。 */
export function thinkingEffortToQoderEffort(effort: SessionSnapshot["thinkingEffort"]): string | null {
  return thinkingEffortToNamedLevels("qoder", effort, { standard: "low", deep: "high", max: "max" });
}

/**
 * Grok `--effort`。当前 CLI 接受 xhigh/high/medium/low，不接受 `max`，
 * 所以旧的「最大」和误存的 `grok:max` 都落到 xhigh。
 */
export function thinkingEffortToGrokEffort(effort: SessionSnapshot["thinkingEffort"]): string | null {
  const native = prefixedThinkingEffort("grok", effort);
  if (native) return native === "max" ? "xhigh" : native;
  if (!effort || effort === "off") return null;
  if (effort === "standard") return "low";
  if (effort === "deep") return "high";
  if (effort === "max") return "xhigh";
  return null;
}

export function thinkingEffortToPiLevel(effort: SessionSnapshot["thinkingEffort"]): string | null {
  const native = prefixedThinkingEffort("pi", effort);
  if (native) return native;
  if (!effort || effort === "off") return "off";
  if (effort === "standard") return "low";
  if (effort === "deep") return "high";
  if (effort === "max") return "max";
  return null;
}
