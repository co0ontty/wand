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
  "speech-polish": "口述文字整理",
} as const;
export type SystemAiPurpose = keyof typeof SYSTEM_AI_PURPOSES;

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
