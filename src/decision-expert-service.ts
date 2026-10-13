import { DECISION_EXPERT_ID, DECISION_EXPERT_KEY, DECISION_EXPERT_NAME, WAND_LOCAL_DECISION_MODEL } from "./decision-expert-identity.js";
import { decisionHardware, type DecisionHardwareAssessment } from "./decision-hardware.js";
import { DECISION_CANDIDATE_TIMEOUT_MS, DecisionError, parseDecisionRequest, parseDecisionResult, type DecisionRequest, type DecisionResult } from "./decision-types.js";
import type { DecisionService } from "./decision-service.js";
import type { SiliconEmployee } from "./ai-team-types.js";
import { isOpenRouterFreeSelector, type OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import { abortableEmployeeText, employeeTextCandidates, prepareEmployeeTextCandidate } from "./employee-text.js";
import type { AiTextRequest, WandConfig } from "./types.js";
import type { WandTaskAgent } from "./task-types.js";

interface DecisionExpertDeps {
  employee(): SiliconEmployee | null;
  local: Pick<DecisionService, "status" | "evaluate">;
  free: Pick<OpenRouterFreeModelsService, "status" | "resolveForCall">;
  config: WandConfig;
  hardware?: () => DecisionHardwareAssessment;
  /** Budget per saved slot; expanded group members share it, not later slots. */
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
      hardware, employeeId: employee?.id ?? DECISION_EXPERT_ID, employeeName: employee?.name ?? DECISION_EXPERT_NAME,
      notice: !hardware.suitable ? hardware.message : !local.enabled || !local.configured
        ? `本地决策未就绪，可初始化 LAYA 或配置「${DECISION_EXPERT_NAME}」的工具与模型调用链。` : null };
  }
  async evaluate(value: unknown, caller: string, signal?: AbortSignal): Promise<DecisionResult> {
    const request = parseDecisionRequest(value), employee = this.deps.employee();
    if (!employee || employee.systemKey !== DECISION_EXPERT_KEY) throw new DecisionError("UNAVAILABLE", `请先配置「${DECISION_EXPERT_NAME}」员工调用链。`, 503);
    if (signal?.aborted) throw new DecisionError("CANCELLED", "决策已取消。", 499);
    if (this.active >= 8) throw new DecisionError("BUSY", `${DECISION_EXPERT_NAME}的决策队列已满，请稍后重试。`, 429);
    this.active += 1;
    const cancelled = (): void => {
      if (signal?.aborted) throw new DecisionError("CANCELLED", `${employee.name}的决策请求已取消。`, 499);
    };
    const candidates = employeeTextCandidates(employee.agents, this.deps.config);
    const failures: string[] = [];
    let executed = false, sawTimeout = false, otherExecutionFailure = false;
    const prompt: AiTextRequest = {
      system: `${employee.prompt}\n只输出JSON对象 {"answers":{...}}。对每题保留type；choice给choice和所有criteria的probabilities(总和1)，score给score和以0开始索引的probabilities(总和1)，noul给0到1的noul。不得执行操作或增加候选。概率是实验性辅助而非授权。`,
      prompt: JSON.stringify(request),
    };
    try {
      for (const { agent, index: candidate } of candidates) {
        cancelled();
        const deadline = new AbortController();
        const members = candidates.filter(entry => entry.index === candidate).length;
        const timer = setTimeout(() => deadline.abort(new DecisionError("TIMEOUT", "候选决策超时。", 504)),
          Math.max(1, Math.floor((this.deps.timeoutMs ?? DECISION_CANDIDATE_TIMEOUT_MS) / members)));
        const attempt = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
        let stage: "availability" | "execution" | "result" = "availability";
        try {
          if (agent.model === WAND_LOCAL_DECISION_MODEL) {
            const hardware = (this.deps.hardware ?? decisionHardware)(), local = this.deps.local.status();
            if (agent.provider !== "pi" || agent.engine !== "sdk" || agent.kind !== "structured"
              || !hardware.suitable || !local.enabled || !local.configured || !local.supported) {
              throw new DecisionError("UNAVAILABLE", "LAYA 不可用。", 503);
            }
            stage = "execution"; executed = true;
            const localResult = await abortableEmployeeText(this.deps.local.evaluate(request, caller, attempt), attempt);
            stage = "result";
            const result = parseDecisionResult(localResult, request, { model: localResult.model, runtime: "laya-mlx" });
            cancelled(); attempt.throwIfAborted();
            return { ...result, executor: { employeeId: employee.id, candidate, source: "local" } };
          }
          let run: () => Promise<{ answers: unknown; inputTokens: number; outputTokens: number; model: string; available?: boolean }>;
          if (this.deps.generate) {
            run = () => this.deps.generate!(agent, request, employee, attempt);
          } else {
            const availability = new AbortController();
            const checkTimer = setTimeout(() => availability.abort(new Error("候选可用性检查超时。")), 8000);
            const check = AbortSignal.any([attempt, availability.signal]);
            let generate: () => Promise<string>;
            let usage: { inputTokens: number; outputTokens: number; model: string } | undefined;
            try {
              generate = await abortableEmployeeText((this.deps.prepare ?? ((next, text, checkedSignal) => prepareEmployeeTextCandidate({
                config: this.deps.config, free: this.deps.free, onUsage: value => { usage = value; },
              }, next, text, checkedSignal)))(agent, prompt, check), check);
            } finally { clearTimeout(checkTimer); }
            run = async () => {
              const raw = await abortableEmployeeText(generate(), attempt);
              stage = "result";
              if (raw.length > 32768) throw new Error("决策结果超过32KiB。");
              const body = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
              return { answers: body?.answers, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
                model: usage?.model ?? agent.model, available: !!usage };
            };
          }
          stage = "execution"; executed = true;
          const generated = await abortableEmployeeText(run(), attempt);
          stage = "result";
          const result = parseDecisionResult({ answers: generated.answers, usage: { input_tokens: generated.inputTokens, output_tokens: generated.outputTokens, truncated: false } },
            request, { model: generated.model, runtime: "decision-expert" });
          cancelled(); attempt.throwIfAborted();
          if (generated.available === false) result.usage.available = false;
          return { ...result, executor: { employeeId: employee.id, candidate,
            source: isOpenRouterFreeSelector(agent.model) ? "free-group" : agent.engine === "sdk" ? "sdk" : "cli" } };
        } catch (error) {
          cancelled();
          const timedOut = deadline.signal.aborted || error instanceof DecisionError && error.code === "TIMEOUT";
          sawTimeout ||= timedOut;
          otherExecutionFailure ||= !timedOut && stage !== "availability";
          failures.push(`候选${candidate + 1}：${timedOut ? "超时" : stage === "availability" ? "不可用" : stage === "result" ? "结果无效" : "调用失败"}`);
          // Explicit decision-only fallback: no tools or task replay, and no unconfigured models.
          // Even unknown delivery / malformed answers advance; only caller cancellation stops the chain.
        } finally { clearTimeout(timer); deadline.abort(); }
      }
      cancelled();
      const timedOut = sawTimeout && !otherExecutionFailure;
      const code = timedOut ? "TIMEOUT" : executed ? "EXECUTION_FAILED" : "CONFIGURATION_REQUIRED";
      throw new DecisionError(code, `${employee.name}已尝试全部配置的决策候选，均未成功${failures.length ? `（${failures.join("；").slice(0, 2048)}）` : ""}；请检查该员工调用链。`, timedOut ? 504 : 503);
    } finally { this.active -= 1; }
  }
}
