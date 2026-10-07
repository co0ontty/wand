import { getDefaultModelForProvider } from "./config.js";
import { resolveModelGroupModels, type ModelGroup } from "./model-groups.js";
import { providerCliInstalled, isSessionProvider } from "./session-provider.js";
import type { SiliconEmployee } from "./ai-team-types.js";
import { isSystemSiliconEmployee, systemEmployeeCliCandidates } from "./system-employee.js";
import type { AiCliCandidate, SessionProvider, SessionSnapshot, WandConfig } from "./types.js";
import { inferProviderFromCommand, inferProviderFromRunner } from "./session-provider.js";

export interface SessionAiContext {
  provider: SessionProvider;
  model?: string;
  thinkingEffort: SessionSnapshot["thinkingEffort"];
  inheritEnv?: boolean;
  /** 内置「系统运维」员工的人设；作为系统提示前缀注入 Wand 自有 AI 调用。 */
  opsPersona?: string;
  /** CLI 降级链（按顺序）。为空时只用 provider/model 这一次调用。 */
  cliCandidates?: AiCliCandidate[];
  /** 系统应用必须经员工 CLI 渠道；候选为空时禁止退回当前会话/默认 provider。 */
  employeeChannelOnly?: boolean;
  modelGroups?: ModelGroup[];
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

/** Build the provider-specific settings used by session-adjacent AI actions. */
export function resolveSessionAiContext(
  snapshot: Pick<
    SessionSnapshot,
    "provider" | "structuredState" | "runner" | "command" | "selectedModel" | "thinkingEffort"
  >,
  config: Pick<WandConfig, "defaultModel" | "defaultCodexModel" | "defaultOpenCodeModel" | "defaultGrokModel" | "defaultQoderModel" | "defaultPiModel" | "defaultThinkingEffort" | "inheritEnv" | "modelGroups">,
): SessionAiContext {
  const provider = resolveSessionProvider(snapshot);
  const sessionModel = normalizeModel(snapshot.selectedModel) ?? normalizeModel(snapshot.structuredState?.model);
  const defaultModel = normalizeModel(getDefaultModelForProvider(config, provider));

  return {
    provider,
    model: sessionModel ?? defaultModel,
    thinkingEffort: snapshot.thinkingEffort ?? config.defaultThinkingEffort,
    inheritEnv: config.inheritEnv,
    ...(config.modelGroups?.length ? { modelGroups: config.modelGroups } : {}),
  };
}

/** Build the source order for Wand-owned AI features such as titles. */
export function resolveSystemAiContext(
  snapshot: Parameters<typeof resolveSessionAiContext>[0],
  config: Parameters<typeof resolveSessionAiContext>[1]
    & Pick<WandConfig, "systemAiCli" | "systemAiModel">,
  systemEmployee?: SiliconEmployee | null,
): SessionAiContext {
  const sessionContext = resolveSessionAiContext(snapshot, config);
  // 候选里的「跟随默认模型」在这里就换成具体的 Wand 默认模型：降级到下一个 provider
  // 时不能拿上一个 provider 的模型，也不能把决定权交给 CLI 自己的默认值。
  const chain = systemEmployeeCliCandidates(systemEmployee).flatMap((candidate) =>
    resolveModelGroupModels(config.modelGroups, candidate.provider,
      candidate.model ?? normalizeModel(getDefaultModelForProvider(config, candidate.provider)), {
        preferDefault: !candidate.model || candidate.model === "default",
      })
      .map((model) => ({ ...candidate, model: normalizeModel(model) })));
  const owned: SessionAiContext = {
    ...sessionContext,
    ...(chain.length ? { cliCandidates: chain } : {}),
    ...(systemEmployee ? { employeeChannelOnly: true } : {}),
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
  if (chain.length) return owned;
  if (systemEmployee) return owned;
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
