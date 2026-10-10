import { isAbsolute } from "node:path";

export const DECISION_MAX_BYTES = 32 * 1024;
export const DECISION_MAX_QUESTIONS = 8;
export const DECISION_MAX_OPTIONS = 8;
export const DECISION_CHECKPOINT = "aac6fef/laya-multilingual-mlx";

export interface LocalDecisionConfig {
  enabled: boolean;
  pythonPath: string;
  modelPath: string;
}

export function parseLocalDecisionConfig(value: unknown): LocalDecisionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本地决策配置无效。");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["enabled", "pythonPath", "modelPath"].includes(key))
    || typeof input.enabled !== "boolean" || typeof input.pythonPath !== "string" || typeof input.modelPath !== "string"
    || (input.pythonPath !== "" && !isAbsolute(input.pythonPath)) || (input.modelPath !== "" && !isAbsolute(input.modelPath))) {
    throw new Error("本地决策需有效的启用状态及受信任的绝对路径。");
  }
  return { enabled: input.enabled, pythonPath: input.pythonPath, modelPath: input.modelPath };
}

export interface DecisionQuestion {
  type: "choice" | "score" | "noul";
  instructions: string;
  criteria?: Record<string, string> | string[];
}
export interface DecisionRequest {
  state: string | unknown[] | Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
}
export interface DecisionResult {
  model: string;
  answers: Record<string, Record<string, unknown>>;
  usage: { input_tokens: number; output_tokens: number; truncated?: boolean; available?: boolean };
  experimental: true;
  runtime: "laya-mlx" | "decision-expert";
  executor?: { employeeId: string; candidate: number; source: "local" | "free-group" | "cli" | "sdk" };
}

export class DecisionError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = "DecisionError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max;
}
function invalid(): never {
  throw new DecisionError("INVALID_REQUEST", "需要有界 state 与 1–8 道 choice/score/noul 问题；每题指令最多500字符，选项2–8项。");
}
function jsonDepth(value: unknown, depth = 0): void {
  if (depth > 8) invalid();
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) jsonDepth(child, depth + 1);
  } else if (typeof value === "number" && !Number.isFinite(value)) invalid();
}

export function parseDecisionRequest(value: unknown): DecisionRequest {
  if (!record(value) || Object.keys(value).some((key) => key !== "state" && key !== "questions")) invalid();
  if (!(text(value.state, 16000) || Array.isArray(value.state) || record(value.state))) invalid();
  jsonDepth(value);
  if (Buffer.byteLength(JSON.stringify(value)) > DECISION_MAX_BYTES) {
    throw new DecisionError("REQUEST_TOO_LARGE", "决策请求超过32KiB。", 413);
  }
  if (!record(value.questions)) invalid();
  const entries = Object.entries(value.questions);
  if (!entries.length || entries.length > DECISION_MAX_QUESTIONS) invalid();
  const questions: Record<string, DecisionQuestion> = Object.create(null);
  for (const [id, raw] of entries) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)
      || !record(raw) || !text(raw.instructions, 500)
      || Object.keys(raw).some((key) => !["type", "instructions", "criteria"].includes(key))) invalid();
    const { type, instructions, criteria } = raw;
    if (type === "choice") {
      const options = Array.isArray(criteria)
        ? criteria.map((label) => [label, label])
        : record(criteria) ? Object.entries(criteria) : [];
      if (options.length < 2 || options.length > DECISION_MAX_OPTIONS
        || options.some(([label, description]) => !text(label, 80) || !text(description, 300)
          || ["__proto__", "constructor", "prototype"].includes(label as string))
        || new Set(options.map(([label]) => label)).size !== options.length) invalid();
      questions[id] = { type, instructions, criteria: Object.fromEntries(options) };
    } else if (type === "score") {
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > DECISION_MAX_OPTIONS
        || !criteria.every((level) => text(level, 300))) invalid();
      questions[id] = { type, instructions, criteria: [...criteria] };
    } else if (type === "noul") {
      if (criteria !== undefined && (!record(criteria) || Object.keys(criteria).some((key) => !["true", "false"].includes(key))
        || !Object.values(criteria).every((description) => text(description, 300)))) invalid();
      questions[id] = { type, instructions, ...(criteria === undefined ? {} : { criteria: { ...(criteria as Record<string, string>) } }) };
    } else invalid();
  }
  // Detach the accepted input from caller mutations while it waits in the queue.
  return JSON.parse(JSON.stringify({ state: value.state, questions })) as DecisionRequest;
}

export function parseDecisionResult(raw: unknown, request: DecisionRequest,
  identity: { model: string; runtime: DecisionResult["runtime"] } = { model: DECISION_CHECKPOINT, runtime: "laya-mlx" }): DecisionResult {
  const fail = (): never => { throw new DecisionError("INVALID_RESULT", "决策引擎返回了无效结果。", 502); };
  if (!record(raw) || !record(raw.answers) || !record(raw.usage)) return fail();
  const answers = raw.answers;
  if (Object.keys(answers).length !== Object.keys(request.questions).length) return fail();
  const probability = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = answers[id];
    if (!record(answer) || answer.type !== question.type) return fail();
    if (question.type === "noul") {
      if (!probability(answer.noul)) return fail();
    } else {
      const labels = question.type === "choice" ? Object.keys(question.criteria!) : (question.criteria as string[]).map((_, i) => String(i));
      if (!record(answer.probabilities) || Object.keys(answer.probabilities).length !== labels.length
        || labels.some((label) => !probability((answer.probabilities as Record<string, unknown>)[label]))
        || Math.abs(Object.values(answer.probabilities).reduce<number>((sum, n) => sum + (n as number), 0) - 1) > 0.002) return fail();
      if (question.type === "choice" && (typeof answer.choice !== "string" || !labels.includes(answer.choice))) return fail();
      if (question.type === "score" && (typeof answer.score !== "number" || !Number.isFinite(answer.score)
        || answer.score < 0 || answer.score > labels.length - 1)) return fail();
    }
    for (const field of ["confidence", "answer_confidence"]) {
      if (answer[field] !== undefined && !probability(answer[field])) return fail();
    }
  }
  if (!Number.isSafeInteger(raw.usage.input_tokens) || (raw.usage.input_tokens as number) < 0
    || (identity.runtime === "laya-mlx" && (raw.usage.input_tokens as number) > DECISION_MAX_QUESTIONS * 1024)
    || !Number.isSafeInteger(raw.usage.output_tokens) || (raw.usage.output_tokens as number) < 0
    || (identity.runtime === "laya-mlx" && raw.usage.output_tokens !== 0) || raw.usage.truncated !== false) return fail();
  return { model: identity.model, answers: answers as DecisionResult["answers"],
    usage: raw.usage as DecisionResult["usage"], experimental: true, runtime: identity.runtime };
}
