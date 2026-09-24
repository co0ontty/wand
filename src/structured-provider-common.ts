import type { SessionProvider, SessionRunner, SessionSnapshot, StructuredSessionState, WandConfig } from "./types.js";

const NATIVE_THINKING_EFFORT = /^(claude|codex|opencode|grok|qoder|pi):[a-z0-9][a-z0-9_-]{0,31}$/;

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
  return runner === "pi-cli-json";
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
