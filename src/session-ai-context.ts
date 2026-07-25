import { getDefaultModelForProvider } from "./config.js";
import {
  discoverCliSystemAiConfigs,
  mergeSystemAiConfigs,
  systemAiProfiles,
} from "./system-ai.js";
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
    || snapshot.provider === "qoder"
  ) {
    return snapshot.provider;
  }
  if (
    snapshot.structuredState?.provider === "claude"
    || snapshot.structuredState?.provider === "codex"
    || snapshot.structuredState?.provider === "opencode"
    || snapshot.structuredState?.provider === "grok"
    || snapshot.structuredState?.provider === "qoder"
  ) {
    return snapshot.structuredState.provider;
  }

  const runner = snapshot.runner ?? snapshot.structuredState?.runner;
  if (runner === "codex-cli-exec") return "codex";
  if (runner === "opencode-cli-run") return "opencode";
  if (runner === "grok-cli-headless") return "grok";
  if (runner === "qoder-cli-print") return "qoder";
  if (runner === "claude-cli" || runner === "claude-cli-print" || runner === "claude-sdk") return "claude";

  if (/^codex\b/i.test(snapshot.command.trim())) return "codex";
  if (/^opencode\b/i.test(snapshot.command.trim())) return "opencode";
  if (/^grok\b/i.test(snapshot.command.trim())) return "grok";
  if (/^qodercli\b/i.test(snapshot.command.trim())) return "qoder";
  return "claude";
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
  config: Pick<WandConfig, "defaultModel" | "defaultCodexModel" | "defaultOpenCodeModel" | "defaultGrokModel" | "defaultQoderModel" | "defaultThinkingEffort" | "inheritEnv">,
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
  config: Parameters<typeof resolveSessionAiContext>[1] & Pick<WandConfig, "systemAi" | "commitCli" | "commitModel">,
): SessionAiContext {
  const sessionContext = resolveSessionAiContext(snapshot, config);
  const directApi = config.systemAi ? usableSystemAi(config.systemAi) : undefined;
  const cliContext: SessionAiContext = {
    ...sessionContext,
    provider: config.commitCli === "codex" || config.commitCli === "opencode" ? config.commitCli : "claude",
    model: normalizeModel(config.commitModel),
  };
  return directApi && config.systemAi?.enabled ? { ...cliContext, systemAi: directApi } : cliContext;
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
    | "defaultThinkingEffort"
    | "inheritEnv"
    | "commitAiSource"
    | "systemAi"
  >,
  discoverApis: typeof discoverCliSystemAiConfigs = discoverCliSystemAiConfigs,
): SessionAiContext {
  const sessionContext = resolveSessionAiContext(snapshot, config);
  const commitContext: SessionAiContext = {
    ...sessionContext,
    // Commit messages and tags are short classification/summarization tasks.
    // Keep them on the minimum explicit provider effort instead of inheriting
    // an expensive deep/max setting from the conversation.
    thinkingEffort: "standard",
  };
  if (config.commitAiSource !== "api") return commitContext;
  const directApi = mergeSystemAiConfigs(
    config.systemAi,
    discoverApis(commitContext.provider),
  );
  return {
    ...commitContext,
    ...(directApi ? { systemAi: directApi } : {}),
  };
}
