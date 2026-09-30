import { getDefaultModelForProvider } from "./config.js";
import {
  discoverCliSystemAiConfigs,
  mergeSystemAiConfigs,
  systemAiProfiles,
} from "./system-ai.js";
import { providerCliInstalled, isSessionProvider } from "./session-provider.js";
import type { SiliconEmployee } from "./ai-team-types.js";
import { isSystemSiliconEmployee, systemEmployeeCliCandidates } from "./system-employee.js";
import type { SessionProvider, SessionSnapshot, SystemAiConfig, WandConfig } from "./types.js";
import { inferProviderFromCommand, inferProviderFromRunner } from "./session-provider.js";

export interface SessionAiContext {
  provider: SessionProvider;
  model?: string;
  thinkingEffort: SessionSnapshot["thinkingEffort"];
  inheritEnv?: boolean;
  systemAi?: SystemAiConfig;
  /** 内置「系统运维」员工的人设；作为系统提示前缀注入 Wand 自有 AI 调用。 */
  opsPersona?: string;
  /** CLI 降级链（按顺序）。为空时只用 provider/model 这一次调用。 */
  cliCandidates?: import("./types.js").AiCliCandidate[];
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
  systemEmployee?: SiliconEmployee | null,
): SessionAiContext {
  const sessionContext = resolveSessionAiContext(snapshot, config);
  // 候选里的「跟随默认模型」在这里就换成具体的 Wand 默认模型：降级到下一个 provider
  // 时不能拿上一个 provider 的模型，也不能把决定权交给 CLI 自己的默认值。
  const chain = systemEmployeeCliCandidates(systemEmployee).map((candidate) => ({
    ...candidate,
    model: candidate.model ?? normalizeModel(getDefaultModelForProvider(config, candidate.provider)),
  }));
  const owned: SessionAiContext = {
    ...sessionContext,
    ...(chain.length ? { cliCandidates: chain } : {}),
    ...(isSystemSiliconEmployee(systemEmployee) ? { opsPersona: systemEmployee!.prompt } : {}),
  };
  // 内置员工可用时，Wand 自有调用一律按它的候选链：provider/model 取首个已安装的
  // 候选（两条路都一致），整条链留给运行期降级。
  if (chain.length) {
    const preferred = chain.find((candidate) => providerCliInstalled(candidate.provider)) ?? chain[0]!;
    owned.provider = preferred.provider;
    owned.model = preferred.model ?? normalizeModel(getDefaultModelForProvider(config, preferred.provider));
    owned.thinkingEffort = preferred.thinkingEffort ?? config.defaultThinkingEffort;
  }
  if (config.systemAi?.enabled) {
    const directApi = usableSystemAi(config.systemAi);
    return directApi ? { ...owned, systemAi: directApi } : owned;
  }
  if (chain.length) return owned;
  // Older installations without a system AI CLI preference still follow the
  // current session. A chosen CLI must never inherit another provider's model.
  if (!isSessionProvider(config.systemAiCli)) return owned;
  return {
    ...owned,
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
    | "systemAiCli"
    | "systemAiModel"
  >,
  discoverApis: typeof discoverCliSystemAiConfigs = discoverCliSystemAiConfigs,
  systemEmployee?: SiliconEmployee | null,
): SessionAiContext {
  const sessionContext = resolveSystemAiContext(snapshot, config, systemEmployee);
  if (config.commitAiSource !== "api") {
    // 快捷提交的直连来源只看 commitAiSource；系统 AI 的 enabled 不能顺手把它打开。
    const cliContext: SessionAiContext = { ...sessionContext };
    delete cliContext.systemAi;
    return cliContext;
  }
  const directApi = mergeSystemAiConfigs(
    config.systemAi,
    discoverApis(sessionContext.provider),
  );
  return {
    ...sessionContext,
    ...(directApi ? { systemAi: directApi } : {}),
  };
}
