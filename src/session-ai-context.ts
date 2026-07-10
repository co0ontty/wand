import { getDefaultModelForProvider } from "./config.js";
import type { SessionProvider, SessionSnapshot, WandConfig } from "./types.js";

export interface SessionAiContext {
  provider: SessionProvider;
  model?: string;
  thinkingEffort: SessionSnapshot["thinkingEffort"];
  inheritEnv?: boolean;
}

/**
 * Resolve the provider from every representation used by current and legacy
 * sessions. Older persisted sessions may not have the top-level provider, but
 * still identify Codex through structuredState, runner, or command.
 */
export function resolveSessionProvider(snapshot: Pick<
  SessionSnapshot,
  "provider" | "structuredState" | "runner" | "command"
>): SessionProvider {
  if (snapshot.provider === "claude" || snapshot.provider === "codex") {
    return snapshot.provider;
  }
  if (snapshot.structuredState?.provider === "claude" || snapshot.structuredState?.provider === "codex") {
    return snapshot.structuredState.provider;
  }

  const runner = snapshot.runner ?? snapshot.structuredState?.runner;
  if (runner === "codex-cli-exec") return "codex";
  if (runner === "claude-cli" || runner === "claude-cli-print" || runner === "claude-sdk") return "claude";

  return /^codex\b/i.test(snapshot.command.trim()) ? "codex" : "claude";
}

function normalizeModel(value: string | null | undefined): string | undefined {
  const model = value?.trim();
  return model && model !== "default" ? model : undefined;
}

/** Build the provider-specific settings used by session-adjacent AI actions. */
export function resolveSessionAiContext(
  snapshot: Pick<
    SessionSnapshot,
    "provider" | "structuredState" | "runner" | "command" | "selectedModel" | "thinkingEffort"
  >,
  config: Pick<WandConfig, "defaultModel" | "defaultCodexModel" | "defaultThinkingEffort" | "inheritEnv">,
): SessionAiContext {
  const provider = resolveSessionProvider(snapshot);
  const sessionModel = normalizeModel(snapshot.selectedModel) ?? normalizeModel(snapshot.structuredState?.model);
  const defaultModel = normalizeModel(getDefaultModelForProvider(config, provider));

  return {
    provider,
    model: sessionModel ?? defaultModel,
    thinkingEffort: snapshot.thinkingEffort ?? config.defaultThinkingEffort,
    inheritEnv: config.inheritEnv,
  };
}
