import { normalizeContext, type AssistantMessage, type ModelThinkingLevel, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { SiliconEmployee } from "./ai-team-types.js";
import { agentKey } from "./ai-team-types.js";
import { getDefaultModelForProvider } from "./config.js";
import { callConfiguredAiText } from "./git-quick-commit.js";
import { coreHarnessRuntime, loadPiAi, resolveCoreModel } from "./harness-engine.js";
import { freeModelOrder, resolveModelGroupModels } from "./model-groups.js";
import { isOpenRouterFreeSelector, OPENROUTER_FREE_ROUTING, type OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import { providerCliInstalled } from "./session-provider.js";
import { thinkingEffortToPiLevel } from "./structured-provider-common.js";
import { classifyStructuredFailure, type ProviderRejectionKind, type StructuredFailure } from "./structured-failure.js";
import { SPEECH_POLISHER_ID, SPEECH_POLISHER_KEY } from "./speech-polisher-identity.js";
import type { WandTaskAgent } from "./task-types.js";
import type { AiTextRequest, WandConfig } from "./types.js";

export interface SpeechPolishResult {
  text: string;
  originalText: string;
  optimized: boolean;
  employeeId: string;
  candidate?: number;
  optimizationError?: string;
}
interface SpeechPolisherDeps {
  employee(): SiliconEmployee | null;
  config: WandConfig;
  free: Pick<OpenRouterFreeModelsService, "resolveForCall">;
  /** Test seam: availability checks happen before the returned, no-tool model call. */
  prepare?: (agent: WandTaskAgent, request: AiTextRequest, signal: AbortSignal) => Promise<() => Promise<string>>;
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
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

class CandidateRejected extends Error {
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
    if (failure?.retryable) throw new CandidateRejected(failure);
    throw new Error("SDK文字生成失败。");
  }
  if (message.stopReason === "aborted" || message.content.some(part => part.type === "toolCall")) throw new Error("SDK文字生成失败。");
  return message.content.filter(part => part.type === "text").map(part => part.text).join("");
}

export function parseSpeechPolishOutput(raw: string): string {
  if (raw.length > 32_768) throw new Error("口述整理结果过长。");
  const body = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  if (!body || typeof body.text !== "string" || !body.text.trim() || body.text.length > 8000 || body.text.includes("\0")) {
    throw new Error("口述整理结果无效。");
  }
  return body.text.trim();
}

/** Text-only SDK inference; configured CLIs use the shared one-shot text helper. */
export class SpeechPolisherService {
  private readonly lifetime = new AbortController();
  private active = 0;
  constructor(private readonly deps: SpeechPolisherDeps) {}
  async polish(text: string, signal?: AbortSignal, budgetMs = 45_000): Promise<SpeechPolishResult> {
    const original: SpeechPolishResult = { text, originalText: text, optimized: false, employeeId: SPEECH_POLISHER_ID };
    const employee = this.deps.employee();
    if (!text.trim()) return original;
    if (text.length > 8000 || text.includes("\0")) throw new Error("语音文字无效或超过8000字符。");
    signal?.throwIfAborted();
    if (!employee || employee.systemKey !== SPEECH_POLISHER_KEY || this.active >= 2 || budgetMs < 1000) {
      return { ...original, optimizationError: "口述整理暂不可用，已保留原始转写。" };
    }
    this.active += 1;
    const deadline = AbortSignal.timeout(Math.max(1, budgetMs));
    const combined = AbortSignal.any([this.lifetime.signal, deadline, ...(signal ? [signal] : [])]);
    const request = { system: `${employee.prompt}\n输出一个 JSON 对象：{"text":"整理后的完整文字"}，不加其他字段或说明。`,
      prompt: JSON.stringify({ transcript: text }) };
    try {
      const config = this.deps.config;
      const seen = new Set<string>();
      const candidates = employee.agents.map((agent, index) => ({ agent, index }));
      for (const candidate of candidates) {
        combined.throwIfAborted();
        let models: string[];
        try {
          const selected = candidate.agent.model === "default" ? getDefaultModelForProvider(config, candidate.agent.provider) : candidate.agent.model;
          models = resolveModelGroupModels(config.modelGroups, candidate.agent.provider, selected);
        } catch { continue; }
        for (const model of models) {
          const agent = { ...candidate.agent, model, engine: candidate.agent.engine ?? "cli" };
          const key = agentKey(agent); if (seen.has(key)) continue; seen.add(key);
          let generate: () => Promise<string>;
          // An unavailable candidate has accepted no user input: continue the configured order.
          try { generate = await this.prepareCandidate(agent, request, combined); }
          catch { combined.throwIfAborted(); continue; }
          combined.throwIfAborted();
          // Only a structured, verified pre-execution refusal permits another candidate.
          let raw: string;
          try { raw = await abortable(generate(), combined); }
          catch (error) {
            combined.throwIfAborted();
            if (error instanceof CandidateRejected && error.failure.retryable) continue;
            throw error;
          }
          combined.throwIfAborted();
          return { text: parseSpeechPolishOutput(raw), originalText: text, optimized: true, employeeId: employee.id,
            candidate: candidate.index };
        }
      }
      return { ...original, optimizationError: "口述整理师的候选均不可用，已保留原始转写。" };
    } catch {
      signal?.throwIfAborted();
      this.lifetime.signal.throwIfAborted();
      return { ...original, optimizationError: "口述整理失败或超时，已保留原始转写。" };
    } finally { this.active -= 1; }
  }
  private async prepareCandidate(agent: WandTaskAgent, request: AiTextRequest, signal: AbortSignal): Promise<() => Promise<string>> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("候选可用性检查超时。")), 8000);
    const checkedSignal = AbortSignal.any([signal, deadline.signal]);
    try {
      return await abortable((this.deps.prepare ?? this.prepare.bind(this))(agent, request, checkedSignal), checkedSignal);
    } finally {
      clearTimeout(timer);
    }
  }
  private async prepare(agent: WandTaskAgent, request: AiTextRequest, signal: AbortSignal): Promise<() => Promise<string>> {
    const config = this.deps.config;
    if (agent.engine !== "sdk") {
      if (!providerCliInstalled(agent.provider) || isOpenRouterFreeSelector(agent.model)) throw new Error("CLI候选不可用。");
      return () => callConfiguredAiText(request, config.defaultCwd, "", { provider: agent.provider, model: agent.model,
        thinkingEffort: agent.thinkingEffort, inheritEnv: config.inheritEnv, signal, budgetMs: 20_000,
        cliCandidates: [{ provider: agent.provider, model: agent.model, thinkingEffort: agent.thinkingEffort }], employeeChannelOnly: true });
    }
    if (agent.provider !== "pi") throw new Error("Wand Agent只支持Pi provider。");
    const context = normalizeContext({ systemPrompt: request.system,
      messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }], tools: [] });
    const reasoning = thinkingEffortToPiLevel(agent.thinkingEffort ?? "off");
    if (isOpenRouterFreeSelector(agent.model)) {
      const order = freeModelOrder(config.modelGroups);
      const checked = await this.deps.free.resolveForCall(agent.model, signal, order.length ? { allowedSelectors: order } : {});
      const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-completions");
      return async () => {
        let status: number | undefined;
        const message = await streamSimple(checked.model as Parameters<typeof streamSimple>[0], context, { apiKey: checked.apiKey, signal,
          maxRetries: 0, fetch: async (input, init) => { const response = await fetch(input, init); status = response.status; return response; },
          maxTokens: Math.min(4096, checked.model.maxTokens), reasoning: reasoning === "off" ? undefined : reasoning as ThinkingLevel,
          toolChoice: "none", onPayload: payload => ({ ...(payload as Record<string, unknown>), provider: OPENROUTER_FREE_ROUTING }) }).result();
        return sdkText(message, status);
      };
    }
    const resolved = await resolveCoreModel(config.harness, agent.model, { cwd: config.defaultCwd });
    if (!resolved) throw new Error("Wand Agent模型不可用。");
    const runtime = await coreHarnessRuntime(config.harness), pi = await loadPiAi();
    const level = pi.clampThinkingLevel(resolved.model, (reasoning ?? "off") as ModelThinkingLevel);
    return async () => {
      const message = await runtime.streamSimple(resolved.model, context, { signal, maxRetries: 0, maxTokens: Math.min(4096, resolved.model.maxTokens),
        reasoning: level === "off" ? undefined : level as ThinkingLevel, toolChoice: "none" }).result();
      return sdkText(message);
    };
  }
  dispose(): void { this.lifetime.abort(); }
}
