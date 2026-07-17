import { getDefaultModelForProvider } from "./config.js";
import type { SessionProvider, SessionSnapshot, SystemAiConfig, WandConfig } from "./types.js";

export interface SessionAiContext {
  provider: SessionProvider;
  model?: string;
  thinkingEffort: SessionSnapshot["thinkingEffort"];
  inheritEnv?: boolean;
  systemAi?: SystemAiConfig;
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
  if (
    snapshot.provider === "claude"
    || snapshot.provider === "codex"
    || snapshot.provider === "opencode"
    || snapshot.provider === "grok"
  ) {
    return snapshot.provider;
  }
  if (
    snapshot.structuredState?.provider === "claude"
    || snapshot.structuredState?.provider === "codex"
    || snapshot.structuredState?.provider === "opencode"
    || snapshot.structuredState?.provider === "grok"
  ) {
    return snapshot.structuredState.provider;
  }

  const runner = snapshot.runner ?? snapshot.structuredState?.runner;
  if (runner === "codex-cli-exec") return "codex";
  if (runner === "opencode-cli-run") return "opencode";
  if (runner === "grok-cli-headless") return "grok";
  if (runner === "claude-cli" || runner === "claude-cli-print" || runner === "claude-sdk") return "claude";

  if (/^codex\b/i.test(snapshot.command.trim())) return "codex";
  if (/^opencode\b/i.test(snapshot.command.trim())) return "opencode";
  if (/^grok\b/i.test(snapshot.command.trim())) return "grok";
  return "claude";
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
  config: Pick<WandConfig, "defaultModel" | "defaultCodexModel" | "defaultOpenCodeModel" | "defaultGrokModel" | "defaultThinkingEffort" | "inheritEnv">,
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

/** Build the AI context for quick-commit actions from their global preferences. */
export function resolveCommitAiContext(
  snapshot: Pick<
    SessionSnapshot,
    "provider" | "structuredState" | "runner" | "command" | "selectedModel" | "thinkingEffort"
  >,
  config: Pick<
    WandConfig,
    | "defaultModel"
    | "defaultCodexModel"
    | "defaultOpenCodeModel"
    | "defaultGrokModel"
    | "defaultThinkingEffort"
    | "inheritEnv"
    | "commitCli"
    | "commitModel"
    | "commitAiSource"
    | "systemAi"
  >,
): SessionAiContext {
  const sessionContext = resolveSessionAiContext(snapshot, config);
  const directApi = config.systemAi ?? {
    enabled: true,
    protocol: "openai" as const,
    baseUrl: "",
    apiKey: "",
    model: "",
  };
  return {
    ...sessionContext,
    provider: config.commitCli === "codex" || config.commitCli === "opencode" ? config.commitCli : "claude",
    model: normalizeModel(config.commitModel),
    ...(config.commitAiSource === "api" ? { systemAi: { ...directApi, enabled: true } } : {}),
  };
}
