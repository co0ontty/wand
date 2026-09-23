import { getDefaultModelForProvider } from "./config.js";
import {
  discoverCliSystemAiConfigs,
  mergeSystemAiConfigs,
  systemAiProfiles,
} from "./system-ai.js";
import type { SessionProvider, SessionSnapshot, SystemAiConfig, WandConfig } from "./types.js";
import { inferProviderFromCommand, inferProviderFromRunner, isSessionProvider } from "./session-provider.js";

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
  if (isSessionProvider(snapshot.provider)) return snapshot.provider;
  const structuredProvider = snapshot.structuredState?.provider;
  if (isSessionProvider(structuredProvider)) return structuredProvider;

  const runner = snapshot.runner ?? snapshot.structuredState?.runner;
  return inferProviderFromRunner(runner) ?? inferProviderFromCommand(snapshot.command) ?? "claude";
}

function normalizeModel(value: string | null | undefined): string | undefined {
  const model = value?.trim();
  return model && model !== "default" ? model : undefined;
}

function usableSystemAi(config: SystemAiConfig): SystemAiConfig | undefined {
  if (!systemAiProfiles(config, true).length) return undefined;
  return { ...config, enabled: true };
}

/** Build the provider-specific settings used by session-adjacent AI actions. */
export function resolveSessionAiContext(
  snapshot: Pick<
    SessionSnapshot,
    "provider" | "structuredState" | "runner" | "command" | "selectedModel" | "thinkingEffort"
  >,
  config: Pick<WandConfig, "defaultModel" | "defaultCodexModel" | "defaultOpenCodeModel" | "defaultGrokModel" | "defaultQoderModel" | "defaultPiModel" | "defaultThinkingEffort" | "inheritEnv">,
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

/** Build the source order for Wand-owned AI features such as titles. */
export function resolveSystemAiContext(
  snapshot: Parameters<typeof resolveSessionAiContext>[0],
  config: Parameters<typeof resolveSessionAiContext>[1]
    & Pick<WandConfig, "systemAi" | "systemAiCli" | "systemAiModel">,
): SessionAiContext {
  const sessionContext = resolveSessionAiContext(snapshot, config);
  if (config.systemAi?.enabled) {
    const directApi = usableSystemAi(config.systemAi);
    return directApi ? { ...sessionContext, systemAi: directApi } : sessionContext;
  }
  // Older installations without a system AI CLI preference still follow the
  // current session. A chosen CLI must never inherit another provider's model.
  if (!isSessionProvider(config.systemAiCli)) return sessionContext;
  return {
    ...sessionContext,
    provider: config.systemAiCli,
    model: normalizeModel(config.systemAiModel)
      ?? normalizeModel(getDefaultModelForProvider(config, config.systemAiCli)),
    thinkingEffort: config.defaultThinkingEffort,
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
    | "defaultQoderModel"
    | "defaultPiModel"
    | "defaultThinkingEffort"
    | "inheritEnv"
    | "commitAiSource"
    | "systemAi"
  >,
  discoverApis: typeof discoverCliSystemAiConfigs = discoverCliSystemAiConfigs,
): SessionAiContext {
  const sessionContext = resolveSessionAiContext(snapshot, config);
  if (config.commitAiSource !== "api") return sessionContext;
  const directApi = mergeSystemAiConfigs(
    config.systemAi,
    discoverApis(sessionContext.provider),
  );
  return {
    ...sessionContext,
    ...(directApi ? { systemAi: directApi } : {}),
  };
}
