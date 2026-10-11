import { normalizeContext, type AssistantMessage, type ModelThinkingLevel, type ThinkingLevel } from "@earendil-works/pi-ai";
import { coreHarnessRuntime, loadPiAi, resolveCoreModel } from "./harness-engine.js";
import { agentKey } from "./ai-team-types.js";
import { getDefaultModelForProvider } from "./config.js";
import { freeModelOrder, resolveModelGroupModels } from "./model-groups.js";
import { isOpenRouterFreeSelector, OPENROUTER_FREE_ROUTING, type OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import { providerCliInstalled } from "./session-provider.js";
import { thinkingEffortToPiLevel } from "./structured-provider-common.js";
import { classifyStructuredFailure, type ProviderRejectionKind, type StructuredFailure } from "./structured-failure.js";
import type { WandTaskAgent } from "./task-types.js";
import type { AiTextRequest, WandConfig } from "./types.js";

export interface EmployeeTextDeps {
  config: Pick<WandConfig, "harness" | "inheritEnv" | "modelGroups"> & { defaultCwd?: string };
  free?: Pick<OpenRouterFreeModelsService, "resolveForCall">;
  onUsage?: (usage: { inputTokens: number; outputTokens: number; model: string }) => void;
}

/** Expand each configured slot once; equivalent leaves execute once in first occurrence order. */
export function employeeTextCandidates(
  agents: readonly WandTaskAgent[], config: Parameters<typeof getDefaultModelForProvider>[0] & Pick<WandConfig, "modelGroups">,
): Array<{ agent: WandTaskAgent; index: number }> {
  const seen = new Set<string>();
  return agents.flatMap((candidate, index) => {
    let models: string[];
    try {
      const model = candidate.model === "default" || !candidate.model ? getDefaultModelForProvider(config, candidate.provider) : candidate.model;
      models = resolveModelGroupModels(config.modelGroups, candidate.provider, model, { preferDefault: !candidate.model || candidate.model === "default" });
    } catch { return []; } // A removed/empty group has accepted no input and is unavailable.
    return models.flatMap(model => {
      const agent = { ...candidate, model, engine: candidate.engine ?? "cli" };
      const key = agentKey(agent);
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ agent, index }];
    });
  });
}

export async function abortableEmployeeText<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export class EmployeeCandidateRejected extends Error {
  constructor(readonly failure: StructuredFailure) { super("SDK 候选在执行前被拒绝。"); }
}

function sdkText(message: AssistantMessage, status?: number): string {
  if (message.stopReason === "error") {
    const rejection: ProviderRejectionKind | undefined = status === 401 || status === 403 ? "authentication"
      : status === 402 ? "quota" : status === 429 ? "rate-limit" : status === 404 ? "model-unavailable" : undefined;
    const progressed = message.content.length > 0 || Object.values(message.usage.cost).some(value => value > 0)
      || message.usage.input > 0 || message.usage.output > 0;
    const failure = classifyStructuredFailure({ state: { blocks: [], result: "", sessionId: null }, exitCode: 1,
      signal: null, stderr: "", primaryError: "SDK 文字生成失败。", rejection,
      inputAccepted: rejection && !progressed ? false : undefined }, { progress: progressed });
    if (failure?.retryable) throw new EmployeeCandidateRejected(failure);
    throw new Error("SDK文字生成失败。");
  }
  if (message.stopReason === "aborted" || message.content.some(part => part.type === "toolCall")) throw new Error("SDK文字生成失败。");
  return message.content.filter(part => part.type === "text").map(part => part.text).join("");
}

/** Prepare a configured, no-tool adapter before any user input is accepted. */
export async function prepareEmployeeTextCandidate(
  deps: EmployeeTextDeps, agent: WandTaskAgent, request: AiTextRequest, signal: AbortSignal,
): Promise<() => Promise<string>> {
  signal.throwIfAborted();
  const config = deps.config;
  if (agent.engine !== "sdk") {
    if (!providerCliInstalled(agent.provider) || isOpenRouterFreeSelector(agent.model)) throw new Error("CLI候选不可用。");
    const { callCliAiText, assertGeminiTextCapability } = await import("./git-quick-commit.js");
    if (agent.provider === "gemini") assertGeminiTextCapability();
    // One adapter call, never re-enter the candidate chain.
    return async () => {
      signal.throwIfAborted();
      return callCliAiText(request, config.defaultCwd ?? process.cwd(), "", { provider: agent.provider, model: agent.model,
        thinkingEffort: agent.thinkingEffort, inheritEnv: config.inheritEnv, signal, deadline: Date.now() + 20_000 });
    };
  }
  if (agent.provider !== "pi") throw new Error("Wand Agent只支持Pi provider。");
  const context = normalizeContext({ systemPrompt: request.system,
    messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }], tools: [] });
  const reasoning = thinkingEffortToPiLevel(agent.thinkingEffort ?? "off");
  if (isOpenRouterFreeSelector(agent.model)) {
    if (!deps.free) throw new Error("Wand 免费分组尚未连接执行服务。");
    const order = freeModelOrder(config.modelGroups);
    const checked = await deps.free.resolveForCall(agent.model, signal, order.length ? { allowedSelectors: order } : {});
    const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-completions");
    return async () => {
      signal.throwIfAborted();
      let status: number | undefined;
      const message = await streamSimple(checked.model as Parameters<typeof streamSimple>[0], context, { apiKey: checked.apiKey, signal,
        maxRetries: 0, fetch: async (input, init) => { const response = await fetch(input, init); status = response.status; return response; },
        maxTokens: Math.min(4096, checked.model.maxTokens), reasoning: reasoning === "off" ? undefined : reasoning as ThinkingLevel,
        toolChoice: "none", onPayload: payload => ({ ...(payload as Record<string, unknown>), provider: OPENROUTER_FREE_ROUTING }) }).result();
      const text = sdkText(message, status);
      deps.onUsage?.({ inputTokens: message.usage.input, outputTokens: message.usage.output, model: `${checked.model.provider}/${checked.model.id}` });
      return text;
    };
  }
  const resolved = await resolveCoreModel(config.harness, agent.model, { cwd: config.defaultCwd });
  if (!resolved) throw new Error("Wand Agent模型不可用。");
  const runtime = await coreHarnessRuntime(config.harness), pi = await loadPiAi();
  const level = pi.clampThinkingLevel(resolved.model, (reasoning ?? "off") as ModelThinkingLevel);
  return async () => {
    signal.throwIfAborted();
    const message = await runtime.streamSimple(resolved.model, context, { signal, maxRetries: 0, maxTokens: Math.min(4096, resolved.model.maxTokens),
      reasoning: level === "off" ? undefined : level as ThinkingLevel, toolChoice: "none" }).result();
    const text = sdkText(message);
    deps.onUsage?.({ inputTokens: message.usage.input, outputTokens: message.usage.output, model: `${resolved.model.provider}/${resolved.model.id}` });
    return text;
  };
}
