import type { SessionProvider, SessionRunner, SessionSnapshot, StructuredSessionState, WandConfig } from "./types.js";

export function isStructuredRunnerForProvider(provider: SessionProvider, runner: unknown): runner is SessionRunner {
  if (provider === "claude") return runner === "claude-sdk" || runner === "claude-cli-print";
  if (provider === "codex") return runner === "codex-cli-exec";
  if (provider === "opencode") return runner === "opencode-cli-run";
  if (provider === "grok") return runner === "grok-cli-headless";
  return runner === "qoder-cli-print";
}

export function defaultStructuredRunner(
  provider: SessionProvider,
  configuredClaudeRunner: WandConfig["structuredRunner"] = "cli",
): SessionRunner {
  if (provider === "codex") return "codex-cli-exec";
  if (provider === "opencode") return "opencode-cli-run";
  if (provider === "grok") return "grok-cli-headless";
  if (provider === "qoder") return "qoder-cli-print";
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
  if (/^codex:[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized)) return normalized as SessionSnapshot["thinkingEffort"];
  return null;
}

export function thinkingEffortToSdkBudget(effort: SessionSnapshot["thinkingEffort"]): number {
  if (effort === "standard") return 4096;
  if (effort === "deep") return 16000;
  if (effort === "max") return 31999;
  return 0;
}

export function thinkingEffortToClaudeCliEffort(effort: SessionSnapshot["thinkingEffort"]): string | null {
  if (effort === "standard") return "low";
  if (effort === "deep") return "medium";
  if (effort === "max") return "max";
  return null;
}

export function thinkingEffortToClaudeSlashEffort(effort: SessionSnapshot["thinkingEffort"]): string {
  return thinkingEffortToClaudeCliEffort(effort) ?? "auto";
}

export function thinkingEffortToCodexReasoningEffort(effort: SessionSnapshot["thinkingEffort"]): string | null {
  if (typeof effort === "string" && effort.startsWith("codex:")) return effort.slice("codex:".length) || null;
  if (effort === "standard") return "low";
  if (effort === "deep") return "medium";
  if (effort === "max") return "xhigh";
  return null;
}

export function thinkingEffortToOpenCodeVariant(effort: SessionSnapshot["thinkingEffort"]): string | null {
  if (!effort || effort === "off") return null;
  if (effort === "standard") return "low";
  if (effort === "deep") return "high";
  if (effort === "max") return "max";
  return effort.startsWith("codex:") ? effort.slice("codex:".length) || null : null;
}

export function thinkingEffortToGrokEffort(effort: SessionSnapshot["thinkingEffort"]): string | null {
  if (!effort || effort === "off") return null;
  if (effort === "standard") return "low";
  if (effort === "deep") return "high";
  if (effort === "max") return "max";
  return effort.startsWith("codex:") ? effort.slice("codex:".length) || null : null;
}
