import { DECISION_EXPERT_ID, DECISION_EXPERT_KEY, WAND_LOCAL_DECISION_MODEL } from "./decision-expert-identity.js";
import { decisionHardware, type DecisionHardwareAssessment } from "./decision-hardware.js";
import { DecisionError, parseDecisionRequest, parseDecisionResult, type DecisionRequest, type DecisionResult } from "./decision-types.js";
import type { DecisionService } from "./decision-service.js";
import type { SiliconEmployee } from "./ai-team-types.js";
import { isOpenRouterFreeSelector, OPENROUTER_FREE_ROUTING, type OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import { freeModelOrder } from "./model-groups.js";
import type { WandConfig } from "./types.js";
import type { WandTaskAgent } from "./task-types.js";
import { normalizeContext } from "@earendil-works/pi-ai";

interface DecisionExpertDeps {
  employee(): SiliconEmployee | null;
  local: Pick<DecisionService, "status" | "evaluate">;
  free: Pick<OpenRouterFreeModelsService, "status" | "resolveForCall">;
  config: Pick<WandConfig, "modelGroups">;
  hardware?: () => DecisionHardwareAssessment;
  timeoutMs?: number;
  /** Tests may inject a free, no-tool structured generator; production never silently swaps engine. */
  generate?: (agent: WandTaskAgent, request: DecisionRequest, employee: SiliconEmployee, signal?: AbortSignal) => Promise<{ answers: unknown; inputTokens: number; outputTokens: number; model: string }>;
}

/** Dedicated bounded employee evaluator. LAYA is not sent to a chat provider as a fake model ID. */
export class DecisionExpertService {
  private active = 0;
  constructor(private readonly deps: DecisionExpertDeps) {}
  status() {
    const local = this.deps.local.status(), employee = this.deps.employee(), free = this.deps.free.status();
    const hardware = (this.deps.hardware ?? decisionHardware)();
    const backup = employee?.agents.some(agent => agent.provider === "pi" && agent.engine === "sdk" && agent.kind === "structured" && isOpenRouterFreeSelector(agent.model)) && free.configured && free.modelCount > 0;
    const primary = employee?.agents.some(agent => agent.provider === "pi" && agent.engine === "sdk" && agent.kind === "structured" && agent.model === WAND_LOCAL_DECISION_MODEL);
    return { enabled: !!employee, supported: true, configured: !!employee && ((!!primary && hardware.suitable && local.supported && local.enabled && local.configured) || !!backup),
      state: local.state, queued: this.active, completed: local.completed, failed: local.failed, experimental: true as const,
      hardware, employeeId: employee?.id ?? DECISION_EXPERT_ID, employeeName: employee?.name ?? "决策专家",
      notice: !hardware.suitable ? hardware.message : !local.enabled || !local.configured ? "本地决策未就绪，可初始化 LAYA 或配置「决策专家」员工调用链使用备用免费分组。" : null };
  }
  async evaluate(value: unknown, caller: string, signal?: AbortSignal): Promise<DecisionResult> {
    const request = parseDecisionRequest(value), employee = this.deps.employee();
    if (!employee || employee.systemKey !== DECISION_EXPERT_KEY) throw new DecisionError("UNAVAILABLE", "请先配置「决策专家」员工调用链。", 503);
    if (signal?.aborted) throw new DecisionError("CANCELLED", "决策已取消。", 499);
    if (this.active >= 8) throw new DecisionError("BUSY", "决策专家队列已满，请稍后重试。", 429);
    this.active += 1;
    const deadline = new AbortController();
    const timeout = new DecisionError("TIMEOUT", "决策专家请求超时，请稍后重试或调整该员工调用链。", 504);
    const timer = setTimeout(() => deadline.abort(timeout), this.deps.timeoutMs ?? 45_000);
    signal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      const hardware = (this.deps.hardware ?? decisionHardware)();
      for (let candidate = 0; candidate < employee.agents.length; candidate += 1) {
        const agent = employee.agents[candidate]!;
        if (agent.model === WAND_LOCAL_DECISION_MODEL) {
          if (agent.provider !== "pi" || agent.engine !== "sdk" || agent.kind !== "structured") throw new DecisionError("CONFIGURATION_REQUIRED", "本地 LAYA 候选需使用 Wand 决策执行入口；请核对「决策专家」调用链。", 503);
          const local = this.deps.local.status();
          if (!hardware.suitable || !local.enabled || !local.configured || !local.supported) continue;
          try {
            const result = await this.deps.local.evaluate(request, caller, signal);
            return { ...result, executor: { employeeId: employee.id, candidate, source: "local" } };
          } catch (error) {
            if (deadline.signal.aborted) throw timeout;
            if (signal?.aborted || (error instanceof DecisionError && ["CANCELLED", "INVALID_REQUEST", "RATE_LIMIT", "BUSY"].includes(error.code))) throw error;
            // This is read-only inference, never a replay of a tool/task side effect.
            continue;
          }
        }
        if (!isOpenRouterFreeSelector(agent.model)) {
          // A missing free pool never authorizes using an arbitrary/paid provider behind the user's back.
          throw new DecisionError("CONFIGURATION_REQUIRED", "此建议仅允许已配置的本地决策或 Wand 免费分组；请核对「决策专家」调用链与费用边界。", 503);
        }
        if (agent.provider !== "pi" || agent.engine !== "sdk") throw new DecisionError("CONFIGURATION_REQUIRED", "建议的免费分组候选需使用 Wand Agent；不会用另一引擎冒充，请配置「决策专家」调用链。", 503);
        try {
          const generated = await (this.deps.generate ?? this.generate.bind(this))(agent, request, employee, signal);
          const result = parseDecisionResult({ answers: generated.answers, usage: { input_tokens: generated.inputTokens, output_tokens: generated.outputTokens, truncated: false } },
            request, { model: generated.model, runtime: "decision-expert" });
          return { ...result, executor: { employeeId: employee.id, candidate, source: "free-group" } };
        } catch (error) {
          if (deadline.signal.aborted) throw timeout;
          if (signal?.aborted) throw new DecisionError("CANCELLED", "决策专家请求已取消。", 499);
          // Once a free model request was sent, don't silently repeat it via another candidate.
          throw new DecisionError("CONFIGURATION_REQUIRED", "决策专家免费分组调用失败或结果无效，请同步免费分组并配置该员工调用链。", 503);
        }
      }
      throw new DecisionError("CONFIGURATION_REQUIRED", !hardware.suitable ? hardware.message : "决策专家没有当前可用的候选；请初始化 LAYA 或配置该员工备用调用链。", 503);
    } finally { clearTimeout(timer); this.active -= 1; }
  }
  private async generate(agent: WandTaskAgent, request: DecisionRequest, employee: SiliconEmployee, signal?: AbortSignal) {
    const order = freeModelOrder(this.deps.config.modelGroups);
    const checked = await this.deps.free.resolveForCall(agent.model, signal, order.length ? { allowedSelectors: order } : {});
    const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-completions");
    const model = checked.model;
    const message = await streamSimple(model as Parameters<typeof streamSimple>[0], normalizeContext({
      systemPrompt: `${employee.prompt}\n只输出JSON对象 {"answers":{...}}。对每题保留type；choice给choice和所有criteria的probabilities(总和1)，score给score和以0开始索引的probabilities(总和1)，noul给0到1的noul。不得输出工具调用、执行操作或增加候选。概率是实验性辅助而非授权。`,
      messages: [{ role: "user", content: JSON.stringify(request), timestamp: Date.now() }], tools: [],
    }), { apiKey: checked.apiKey, signal, maxTokens: Math.min(4096, model.maxTokens), toolChoice: "none",
      onPayload: payload => ({ ...(payload as Record<string, unknown>), provider: OPENROUTER_FREE_ROUTING }) }).result();
    if (message.stopReason === "error" || message.stopReason === "aborted" || message.content.some(part => part.type === "toolCall")) throw new Error("Decision expert failed");
    const text = message.content.filter(part => part.type === "text").map(part => part.text).join("").trim();
    if (text.length > 32768) throw new Error("Decision expert output too large");
    const body = JSON.parse(text);
    return { answers: body.answers, inputTokens: message.usage.input, outputTokens: message.usage.output, model: `${model.provider}/${model.id}` };
  }
}
