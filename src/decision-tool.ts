import type { DecisionCardSummary } from "./types.js";

/** Presentation-only recognition of actual local-decision invocations, never an execution policy. */
interface DecisionToolLike {
  type?: string;
  name?: string;
  input?: Record<string, unknown>;
  semantic?: { kind?: string };
}

/** core 会话里决策是进程内工具（`src/core-runner.ts`）；CLI 会话是命令行调用。 */
export const DECISION_TOOL_NAME = "decision_evaluate";

/** Small shell lexer: quoted examples are one argument, not executable commands; heredoc bodies are data. */
function commandWords(source: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote = "";
  const pushWord = (): void => { if (word) words.push(word); word = ""; };
  const pushCommand = (): void => { pushWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\" && quote !== "'" && i + 1 < source.length) {
      if (source[i + 1] !== "\n") word += source[i + 1];
      i++;
    } else if (quote) {
      if (c === quote) quote = ""; else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "#" && !word) {
      while (i < source.length && source[i] !== "\n") i++;
      pushCommand();
    } else if (c === "<" && source[i + 1] === "<") {
      pushCommand();
      break;
    } else if (c === ";" || c === "|" || c === "&" || c === "\n") {
      pushCommand();
    } else if (/\s/.test(c)) {
      pushWord();
    } else word += c;
  }
  pushCommand();
  return commands;
}

function isDecisionCommand(words: string[], depth = 0): boolean {
  if (depth > 2 || !words.length) return false;
  const base = (value: string): string => value.replace(/\\/g, "/").split("/").at(-1)!.toLowerCase();
  // Prefix assignments and common harmless launch wrappers don't change the called program.
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || ["env", "command"].includes(words[0]!))) words = words.slice(1);
  const executable = base(words[0] ?? "");
  if (["sh", "bash", "zsh"].includes(executable)) {
    const index = words.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));
    return index >= 0 && commandWords(words[index + 1] ?? "").some((command) => isDecisionCommand(command, depth + 1));
  }
  if (["curl", "curl.exe"].includes(executable)) {
    return words.slice(1).some((word) => /^(?:https?:\/\/|\$\{?WAND_DECISION_URL\}?\/)/.test(word)
      && /\/api\/decisions\/evaluate(?:[?#]|$)/.test(word));
  }
  const stdin = words.indexOf("--stdin");
  if (stdin < 0) return false;
  if (["wand", "wand.cmd", "wand.exe"].includes(executable)) return words[1] === "decide";
  if (!["node", "node.exe", "$wand_decision_node", "${wand_decision_node}"].includes(executable)) return false;
  return words.slice(1, stdin).some((word, index) => {
    const path = word.replace(/\\/g, "/");
    if (/(?:^|\/)wand-decision\/scripts\/decide\.mjs$/.test(path)) return true;
    const cli = /(?:^|\/)wand\/(?:dist\/cli\.js|src\/cli\.ts)$/.test(path)
      || /^\$\{?WAND_DECISION_CLI\}?$/.test(path);
    return cli && words[index + 2] === "decide";
  });
}

export function isDecisionToolCall(block: DecisionToolLike): boolean {
  if (block.semantic?.kind === "decision") return true;
  if (block.type && block.type !== "tool_use") return false;
  const operation = (block.name ?? "").toLowerCase().split(/__|[/.]/).at(-1) ?? "";
  // core（进程内 harness）把决策暴露成真工具，不是命令行调用。
  if (operation === DECISION_TOOL_NAME) return true;
  if (!["bash", "exec", "exec_command", "command_execution", "shell_command", "terminal", "run_command", "run_shell_command"].includes(operation)) return false;
  const input = block.input ?? {};
  const command = input.command ?? input.cmd;
  if (Array.isArray(command) && command.every((word) => typeof word === "string")) return isDecisionCommand(command);
  if (typeof command !== "string" || command.length > 65536
    || !/decide|\/api\/decisions\/evaluate/.test(command)) return false;
  return commandWords(command).some((words) => isDecisionCommand(words));
}

// ── 缩略卡投影 ────────────────────────────────────────────────────────────────
//
// 决策卡收起时也要能看出「问了什么、答了什么」。展示数据统一由服务端从这里派生，
// Web 与 Android 只渲染同一份字段，不各自解析原始 command / 结果 JSON。
// 边界：只读、有界、可重复（同样的入参与结果必须得到同样的摘要），
// 数据来源本来就随这次调用全量传输，摘要不扩大暴露面。

const PREVIEW_MAX = 64;
const OUTCOME_MAX = 160;
const LABEL_MAX = 180;
const ANSWER_ID_MAX = 24;
const ANSWER_VALUE_MAX = 24;
const SCAN_MAX = 32768;
const MAX_CANDIDATES = 8;
const MODE_HINTS: Record<DecisionMode, string> = {
  choice: "选择", score: "评分", noul: "是非判断", mixed: "混合判断",
};
const GENERIC_HINT = "选择 / 评分 / 是非判断";

type DecisionMode = NonNullable<DecisionCardSummary["mode"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 折叠空白并截断：摘要永远单行、有界。 */
function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

function modeOf(types: Iterable<string>): DecisionMode | undefined {
  const unique = new Set(types);
  if (!unique.size) return undefined;
  return unique.size > 1 ? "mixed" : [...unique][0] as DecisionMode;
}

/** 工具结果文本：字符串原样，结构化内容取 text 分片。 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join("\n");
}

/** heredoc 正文（`<<'JSON'` … `JSON`）：Skill 的标准调用形态把请求体放在这里。 */
function heredocBody(source: string): string | null {
  const match = /<<-?\s*(['"]?)([A-Za-z0-9_]+)\1[^\n]*\n/.exec(source);
  if (!match) return null;
  const delimiter = match[2]!;
  const lines = source.slice(match.index + match[0].length).split("\n");
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() === delimiter || body.length > 2000) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text || null;
}

/** 从一个 `{` 开始做引号感知的配对扫描，失败返回 null（宁可没有摘要也不猜）。 */
function braceSpan(source: string, start: number): string | null {
  let depth = 0;
  let quote = "";
  for (let i = start; i < source.length && i - start <= SCAN_MAX; i++) {
    const char = source[i]!;
    if (quote) {
      if (char === "\\") { i++; continue; }
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"') { quote = char; continue; }
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

/** 命令里的候选 JSON 文本：heredoc 正文优先，再扫内联对象。 */
function jsonCandidates(source: string): string[] {
  const candidates: string[] = [];
  const heredoc = heredocBody(source);
  if (heredoc) candidates.push(heredoc);
  for (let i = 0; i < source.length && candidates.length < MAX_CANDIDATES; i++) {
    if (source[i] !== "{") continue;
    const span = braceSpan(source, i);
    if (!span) break;
    if (!candidates.includes(span)) candidates.push(span);
    i += span.length - 1;
  }
  return candidates;
}

function decisionCommands(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const command = input.command ?? input.cmd;
  if (typeof command === "string") return [command];
  if (Array.isArray(command)) return command.filter((word): word is string => typeof word === "string");
  return [];
}

/** 请求侧要点：被判定内容摘要 + 题数 + 模式。请求体读不出时整块省略。 */
function requestDigest(input: Record<string, unknown> | undefined): Pick<DecisionCardSummary, "mode" | "questions" | "preview"> | null {
  if (!input) return null;
  // core 进程内工具：questions 直接是字段（JSON 字符串），state 也在同一层。
  if (typeof input.questions === "string") {
    try {
      const parsed = JSON.parse(input.questions) as unknown;
      const digest = bodyDigest({ state: input.state, questions: parsed });
      if (digest) return digest;
    } catch {
      // questions 坏了不影响从 state 给出被判定内容摘要。
    }
    const stateOnly = statePreview(input.state);
    return Object.keys(stateOnly).length ? stateOnly : null;
  }
  for (const source of decisionCommands(input)) {
    for (const candidate of jsonCandidates(source)) {
      let value: unknown;
      try { value = JSON.parse(candidate); } catch { continue; }
      const digest = bodyDigest(value);
      if (digest) return digest;
    }
  }
  return null;
}

/** 决策请求体 → 摘要要点；读不出题目就返回 null（宁可没有摘要也不猜）。 */
function bodyDigest(value: unknown): Pick<DecisionCardSummary, "mode" | "questions" | "preview"> | null {
  if (!isRecord(value) || !isRecord(value.questions)) return null;
  const questions = Object.entries(value.questions);
  if (!questions.length) return null;
  const types: string[] = [];
  let recognized = 0;
  for (const [, raw] of questions) {
    if (!isRecord(raw)) continue;
    if (raw.type === "choice" || raw.type === "score" || raw.type === "noul") { types.push(raw.type); recognized++; }
  }
  if (!recognized) return null;
  return {
    mode: modeOf(types),
    questions: questions.length,
    ...statePreview(value.state),
  };
}

function statePreview(state: unknown): { preview?: string } {
  if (typeof state === "string") {
    const preview = collapse(state, PREVIEW_MAX);
    return preview ? { preview } : {};
  }
  if (Array.isArray(state)) return state.length ? { preview: `${state.length} 项输入` } : {};
  if (isRecord(state)) {
    const fields = Object.keys(state).length;
    return fields ? { preview: `${fields} 字段输入` } : {};
  }
  return {};
}

function percent(probability: unknown): string {
  return typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1
    ? ` ${Math.round(probability * 100)}%` : "";
}

function probabilityOf(probabilities: unknown, key: string): unknown {
  return isRecord(probabilities) ? probabilities[key] : undefined;
}

/** 单题结论：`id=选项 84%` / `id=档位 70%` / `id=P(true) 96%`，读不出该题就不编。 */
function answerOutcome(id: string, answer: Record<string, unknown>): string | null {
  const name = collapse(id, ANSWER_ID_MAX);
  if (!name) return null;
  if (answer.type === "choice" && typeof answer.choice === "string") {
    const choice = collapse(answer.choice, ANSWER_VALUE_MAX);
    return choice ? `${name}=${choice}${percent(probabilityOf(answer.probabilities, answer.choice))}` : null;
  }
  if (answer.type === "score" && typeof answer.score === "number" && Number.isFinite(answer.score)) {
    // score 是期望档位（连续值），不是某一档的概率：显示 期望/满分 + 就近档位说明，
    // 不拿单档概率冒充结论（本地模型的概率不是正确率）。
    const levels = isRecord(answer.legend) ? Object.keys(answer.legend).length
      : isRecord(answer.probabilities) ? Object.keys(answer.probabilities).length : 0;
    const value = answer.score.toFixed(2);
    const scale = levels > 1 ? `${value}/${levels - 1}` : value;
    const legend = levels ? (isRecord(answer.legend) ? answer.legend[String(Math.round(answer.score))] : undefined) : undefined;
    const hint = typeof legend === "string" && legend.trim() ? `（${collapse(legend, ANSWER_VALUE_MAX)}）` : "";
    return `${name}=${scale}${hint}`;
  }
  if (answer.type === "noul" && typeof answer.noul === "number") {
    return `${name}=P(true)${percent(answer.noul)}`;
  }
  return null;
}

/** 结果侧结论：只在真的解析出 answers 时给出，失败/非决策输出/截断内容一律省略。 */
function resultDigest(content: unknown): Pick<DecisionCardSummary, "mode" | "questions" | "outcome"> | null {
  const text = toolResultText(content).trim();
  if (!text || text.length > 256 * 1024) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isRecord(value) || !isRecord(value.answers)) return null;
  const answers = Object.entries(value.answers);
  if (!answers.length) return null;
  const types: string[] = [];
  const items: string[] = [];
  for (const [id, raw] of answers) {
    if (!isRecord(raw)) continue;
    if (raw.type === "choice" || raw.type === "score" || raw.type === "noul") types.push(raw.type);
    const outcome = answerOutcome(id, raw);
    if (outcome) items.push(outcome);
  }
  const mode = modeOf(types);
  if (!items.length && !mode) return null;
  return {
    mode,
    questions: answers.length,
    ...(items.length ? { outcome: collapse(items.join(" · "), OUTCOME_MAX) } : {}),
  };
}

/**
 * 卡头副标题：结论优先（窄屏先被省略的是被判定内容，不是答案），再题数、再要点的有界拼接；
 * 两边都缺数据时退化为模式提示，客户端因此不需要自带一套决策文案。
 * 状态词（运行中/完成/失败）不在这里，由客户端按自己的状态源渲染。
 */
export function decisionCardSummary(
  input: Record<string, unknown> | undefined,
  result: { content?: unknown; is_error?: boolean } | null | undefined,
): DecisionCardSummary {
  const request = requestDigest(input);
  const resultFields = result && !result.is_error ? resultDigest(result.content) : null;
  const mode = request?.mode ?? resultFields?.mode;
  const questions = request?.questions ?? resultFields?.questions;
  const parts = [resultFields?.outcome, questions ? `${questions} 题` : undefined, request?.preview]
    .filter((part): part is string => !!part);
  const label = parts.length ? collapse(parts.join(" · "), LABEL_MAX)
    : (mode ? MODE_HINTS[mode] : GENERIC_HINT);
  return {
    ...(mode ? { mode } : {}),
    ...(questions ? { questions } : {}),
    ...(request?.preview ? { preview: request.preview } : {}),
    ...(resultFields?.outcome ? { outcome: resultFields.outcome } : {}),
    label,
  };
}
