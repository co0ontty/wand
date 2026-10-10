import type { SiliconEmployee } from "./ai-team-types.js";
import { abortableEmployeeText, EmployeeCandidateRejected, employeeTextCandidates, prepareEmployeeTextCandidate } from "./employee-text.js";
import type { OpenRouterFreeModelsService } from "./openrouter-free-models.js";
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
      for (const candidate of employeeTextCandidates(employee.agents, this.deps.config)) {
        combined.throwIfAborted();
        const agent = candidate.agent;
        let generate: () => Promise<string>;
        // An unavailable candidate has accepted no user input: continue the configured order.
        try { generate = await this.prepareCandidate(agent, request, combined); }
        catch { combined.throwIfAborted(); continue; }
        combined.throwIfAborted();
        // Only a structured, verified pre-execution refusal permits another candidate.
        let raw: string;
        try { raw = await abortableEmployeeText(generate(), combined); }
        catch (error) {
          combined.throwIfAborted();
          if (error instanceof EmployeeCandidateRejected && error.failure.retryable) continue;
          throw error;
        }
        combined.throwIfAborted();
        return { text: parseSpeechPolishOutput(raw), originalText: text, optimized: true, employeeId: employee.id,
          candidate: candidate.index };
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
      return await abortableEmployeeText((this.deps.prepare ?? ((candidate, input, checked) => prepareEmployeeTextCandidate(this.deps, candidate, input, checked)))(agent, request, checkedSignal), checkedSignal);
    } finally {
      clearTimeout(timer);
    }
  }
  dispose(): void { this.lifetime.abort(); }
}
