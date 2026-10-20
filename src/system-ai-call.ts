import type { AiCliCandidate, AiTextRequest } from "./types.js";

/** Reserved server-owned provenance. These are real one-shot calls, not resumable conversations. */
export const SYSTEM_AI_CALL_PREFIX = "system-ai:";
export const SYSTEM_AI_READ_ONLY = "这是系统调用记录，只能查看日志，不能继续发送或恢复执行。";

export function isSystemAiCall(session: { automationId?: unknown } | null | undefined): boolean {
  return typeof session?.automationId === "string" && session.automationId.startsWith(SYSTEM_AI_CALL_PREFIX);
}

export const SYSTEM_AI_PURPOSES = {
  "system-text": "系统文本生成",
  "session-title": "会话标题生成",
  "task-title": "任务标题生成",
  "task-organize": "旧版任务标题归类",
  "conversation-organize-job": "会话自动归类作业",
  "conversation-organize": "会话内容任务规划",
  "conversation-summary": "长会话内容摘要",
  "prompt-optimize": "提示词优化",
  "git-commit": "提交说明生成",
  "git-tag": "版本说明生成",
  "git-fallback": "提交执行兜底",
  "model-auto-assign": "模型分组选择",
  "user-memory": "短期习惯分析",
  "employee-draft": "员工招聘草稿",
  "decision": "有界决策",
} as const;
export type SystemAiPurpose = keyof typeof SYSTEM_AI_PURPOSES;

/** Audit provenance is broader than disposable auxiliary history. Classify new purposes explicitly. */
const SYSTEM_AI_HISTORY_SCOPES = {
  "system-text": "unspecified",
  "session-title": "auxiliary",
  "task-title": "auxiliary",
  "task-organize": "auxiliary",
  "conversation-organize-job": "auxiliary",
  "conversation-organize": "auxiliary",
  "conversation-summary": "auxiliary",
  "prompt-optimize": "auxiliary",
  "git-commit": "auxiliary",
  "git-tag": "auxiliary",
  "git-fallback": "auxiliary",
  "model-auto-assign": "auxiliary",
  "user-memory": "auxiliary",
  "employee-draft": "auxiliary",
  "decision": "agent-call",
} as const satisfies Record<SystemAiPurpose, "auxiliary" | "agent-call" | "unspecified">;

export const SYSTEM_AI_AUXILIARY_PURPOSES = (Object.keys(SYSTEM_AI_HISTORY_SCOPES) as SystemAiPurpose[])
  .filter(purpose => SYSTEM_AI_HISTORY_SCOPES[purpose] === "auxiliary");

/** Unknown/unspecified history and agent decisions are protected, even with system-ai provenance. */
export function isRetainableSystemAiCall(session: { automationId?: unknown } | null | undefined): boolean {
  if (!isSystemAiCall(session)) return false;
  const remainder = (session!.automationId as string).slice(SYSTEM_AI_CALL_PREFIX.length);
  const separator = remainder.indexOf(":");
  if (separator <= 0 || separator === remainder.length - 1) return false;
  const purpose = remainder.slice(0, separator);
  return Object.prototype.hasOwnProperty.call(SYSTEM_AI_HISTORY_SCOPES, purpose)
    && SYSTEM_AI_HISTORY_SCOPES[purpose as SystemAiPurpose] === "auxiliary";
}

export interface AiCallTrace {
  readonly sessionId: string;
  candidateStarted(candidate: AiCliCandidate): void;
  localStarted(model: string): void;
  candidateSkipped(candidate: AiCliCandidate, reason: string): void;
  candidateFailed(candidate: AiCliCandidate, error: unknown, phase: "availability" | "execution" | "result"): void;
  candidateSucceeded(raw: string, parsed: unknown): void;
  usageReported(usage: { inputTokens: number; outputTokens: number; model: string }): void;
  applicationResult(value: unknown): void;
  complete(): void;
  fail(error: unknown, cancelled?: boolean): void;
}
export interface AiCallTraceFactory {
  start(purpose: SystemAiPurpose, request: AiTextRequest, cwd: string): AiCallTrace;
}

/** Audit failure is not a provider refusal and must never trigger another paid candidate. */
export class AiCallTraceError extends Error {
  constructor() { super("系统调用日志无法保存，已停止后续模型调用。"); this.name = "AiCallTraceError"; }
}
