import { DECISION_EXPERT_ID, DECISION_EXPERT_KEY, WAND_LOCAL_DECISION_MODEL } from "./decision-expert-identity.js";
import { decisionHardware, type DecisionHardwareAssessment } from "./decision-hardware.js";
import { DecisionError, parseDecisionRequest, parseDecisionResult, type DecisionRequest, type DecisionResult } from "./decision-types.js";
import type { DecisionService } from "./decision-service.js";
import type { SiliconEmployee } from "./ai-team-types.js";
import { isOpenRouterFreeSelector, type OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import { abortableEmployeeText, EmployeeCandidateRejected, employeeTextCandidates, prepareEmployeeTextCandidate } from "./employee-text.js";
import type { AiTextRequest, WandConfig } from "./types.js";
import type { WandTaskAgent } from "./task-types.js";

interface DecisionExpertDeps {
  employee(): SiliconEmployee | null;
  local: Pick<DecisionService, "status" | "evaluate">;
  free: Pick<OpenRouterFreeModelsService, "status" | "resolveForCall">;
  config: WandConfig;
  hardware?: () => DecisionHardwareAssessment;
  timeoutMs?: number;
  /** A prepared adapter has accepted no input yet. Tests never call real models. */
  prepare?: (agent: WandTaskAgent, request: AiTextRequest, signal: AbortSignal) => Promise<() => Promise<string>>;
  /** Compatibility seam for existing bounded evaluator fixtures. */
  generate?: (agent: WandTaskAgent, request: DecisionRequest, employee: SiliconEmployee, signal?: AbortSignal) => Promise<{ answers: unknown; inputTokens: number; outputTokens: number; model: string }>;
}

/** Bounded decisions use the employee's ordered adapters; LAYA stays a local evaluator. */
export class DecisionExpertService {
  private active = 0;
  constructor(private readonly deps: DecisionExpertDeps) {}
  status() {
    const local = this.deps.local.status(), employee = this.deps.employee(), free = this.deps.free.status();
    const hardware = (this.deps.hardware ?? decisionHardware)();
    const configured = !!employee?.agents.some(agent => {
      if (agent.model === WAND_LOCAL_DECISION_MODEL) return agent.provider === "pi" && agent.engine === "sdk"
        && hardware.suitable && local.supported && local.enabled && local.configured;
      if (isOpenRouterFreeSelector(agent.model)) return agent.provider === "pi" && agent.engine === "sdk" && free.configured && free.modelCount > 0;
      return agent.kind === "structured";
    });
    return { enabled: !!employee, supported: true, configured, state: local.state, queued: this.active,
      completed: local.completed, failed: local.failed, experimental: true as const,
      hardware, employeeId: employee?.id ?? DECISION_EXPERT_ID, employeeName: employee?.name ?? "决策专家",
      notice: !hardware.suitable ? hardware.message : !local.enabled || !local.configured
        ? "本地决策未就绪，可初始化 LAYA 或配置「决策专家」的工具与模型调用链。" : null };
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
    const prompt: AiTextRequest = {
      system: `${employee.prompt}\n只输出JSON对象 {"answers":{...}}。对每题保留type；choice给choice和所有criteria的probabilities(总和1)，score给score和以0开始索引的probabilities(总和1)，noul给0到1的noul。不得执行操作或增加候选。概率是实验性辅助而非授权。`,
      prompt: JSON.stringify(request),
    };
    try {
      const hardware = (this.deps.hardware ?? decisionHardware)();
      for (const { agent, index: candidate } of employeeTextCandidates(employee.agents, this.deps.config)) {
        signal.throwIfAborted();
        if (agent.model === WAND_LOCAL_DECISION_MODEL) {
          if (agent.provider !== "pi" || agent.engine !== "sdk" || agent.kind !== "structured") continue;
          const local = this.deps.local.status();
          if (!hardware.suitable || !local.enabled || !local.configured || !local.supported) continue;
          try {
            const result = await abortableEmployeeText(this.deps.local.evaluate(request, caller, signal), signal);
            return { ...result, executor: { employeeId: employee.id, candidate, source: "local" } };
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof DecisionError && ["CANCELLED", "INVALID_REQUEST", "RATE_LIMIT", "BUSY"].includes(error.code)) throw error;
            // Existing LAYA fallback is read-only inference, never tool/task replay.
            continue;
          }
        }
        let run: () => Promise<{ answers: unknown; inputTokens: number; outputTokens: number; model: string; available?: boolean }>;
        if (this.deps.generate) {
          run = () => this.deps.generate!(agent, request, employee, signal);
        } else {
          const availability = new AbortController();
          const checkTimer = setTimeout(() => availability.abort(new Error("候选可用性检查超时。")), 8000);
          const check = AbortSignal.any([signal, availability.signal]);
          let generate: () => Promise<string>;
          let usage: { inputTokens: number; outputTokens: number; model: string } | undefined;
          try {
            generate = await abortableEmployeeText((this.deps.prepare ?? ((next, text, checkedSignal) => prepareEmployeeTextCandidate({
              config: this.deps.config, free: this.deps.free, onUsage: value => { usage = value; },
            }, next, text, checkedSignal)))(agent, prompt, check), check);
          } catch { signal.throwIfAborted(); continue; }
          finally { clearTimeout(checkTimer); }
          run = async () => {
            const raw = await abortableEmployeeText(generate(), signal);
            if (raw.length > 32768) throw new Error("决策结果超过32KiB。");
            const body = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
            return { answers: body?.answers, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
              model: usage?.model ?? agent.model, available: !!usage };
          };
        }
        try {
          const generated = await abortableEmployeeText(run(), signal);
          signal.throwIfAborted();
          const result = parseDecisionResult({ answers: generated.answers, usage: { input_tokens: generated.inputTokens, output_tokens: generated.outputTokens, truncated: false } },
            request, { model: generated.model, runtime: "decision-expert" });
          if (generated.available === false) result.usage.available = false;
          return { ...result, executor: { employeeId: employee.id, candidate,
            source: isOpenRouterFreeSelector(agent.model) ? "free-group" : agent.engine === "sdk" ? "sdk" : "cli" } };
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof EmployeeCandidateRejected && error.failure.retryable) continue;
          // Accepted/unknown delivery and invalid results never silently repeat a request.
          throw new DecisionError("EXECUTION_FAILED", "决策专家候选调用失败或结果无效，未自动重放；请检查该员工调用链。", 503);
        }
      }
      throw new DecisionError("CONFIGURATION_REQUIRED", "决策专家没有当前可用的候选；请检查已配置工具、模型或初始化 LAYA。", 503);
    } catch (error) {
      if (deadline.signal.aborted) throw timeout;
      if (signal.aborted) throw new DecisionError("CANCELLED", "决策专家请求已取消。", 499);
      throw error;
    } finally { clearTimeout(timer); this.active -= 1; }
  }
}
