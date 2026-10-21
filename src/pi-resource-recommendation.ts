import { DecisionError, type DecisionQuestion, type DecisionResult } from "./decision-types.js";
import { isPiSettingsDraft, patchPiResourceSelection, type PiResourceCatalog, type PiResourceItem,
  type PiResourceRecommendation, type PiResourceSelection } from "./pi-session-settings.js";

export const PI_RECOMMEND_MAX_CANDIDATES = 24;
export const PI_RECOMMEND_MAX_PROMPT = 1200;
export type PiResourceEvaluator = (value: unknown, caller: string, signal?: AbortSignal) => Promise<DecisionResult>;

export function parsePiRecommendationRequest(raw: unknown): { prompt: string; candidates: PiResourceSelection } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DecisionError("INVALID_REQUEST", "请提供当前提示词和候选资源。");
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "prompt" && key !== "candidates")
    || typeof body.prompt !== "string" || !body.prompt.trim() || isPiSettingsDraft(body.prompt)
    || body.prompt.length > PI_RECOMMEND_MAX_PROMPT) {
    throw new DecisionError("INVALID_REQUEST", "请先输入任务提示词（最多1200字符）；设置命令不能用于推荐。");
  }
  const candidates = patchPiResourceSelection(body.candidates);
  if (!candidates.skills.every((id) => id.startsWith("skill-")) || !candidates.mcpServers.every((id) => id.startsWith("mcp-"))
    || candidates.skills.length + candidates.mcpServers.length > PI_RECOMMEND_MAX_CANDIDATES) {
    throw new DecisionError("CANDIDATE_LIMIT", "一次最多推荐24项资源，请用搜索缩小候选范围。");
  }
  return { prompt: body.prompt.trim(), candidates };
}

/** Literal resource names only; conservative exclusions take priority over inclusion. */
export function explicitMention(prompt: string, name: string): "included" | "excluded" | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const literal = new RegExp(`(^|[^a-zA-Z0-9_-])${escaped}(?=$|[^a-zA-Z0-9_-])`, "i");
  let included = false;
  for (const clause of prompt.split(/[。！？!?；;\n，,]/)) {
    const match = literal.exec(clause);
    if (!match) continue;
    const before = clause.slice(0, match.index + match[1]!.length);
    const after = clause.slice(match.index + match[0].length);
    if (/(?:不要|不用|不使用|不启用|不加载|不连接|排除|禁用|停用|无需|不需要|without|do not|don['’]t|exclude|disable)/i.test(before)
      || /^\s*(?:也|暂时|这次)?\s*(?:不要|不用|不使用|不启用|不加载|不连接|禁用|停用|不需要|disabled|excluded)/i.test(after)) return "excluded";
    included = true;
  }
  return included ? "included" : null;
}

/** Strip only standalone resource switches, never business constraints or the submitted prompt itself. */
function resourceTask(prompt: string, catalog: PiResourceCatalog): string {
  const names = [...catalog.skills, ...catalog.mcpServers].map((item) => item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!names.length) return prompt;
  const name = `(?:${names.join("|")})`;
  const verb = "(?:不要|不用|不使用|不启用|不加载|不连接|排除|禁用|停用|无需|不需要|使用|启用|加载|连接|without|do not use|don't use|exclude|disable|use|enable)";
  const switchOnly = new RegExp(`^(?:(?:也|这次|暂时)\\s*)?${verb}\\s*${name}$|^${name}\\s*(?:(?:也|这次|暂时)\\s*)?${verb}$`, "i");
  const clauses = prompt.split(/[。！？!?；;\n，,]/);
  const task = clauses.filter((clause) => !switchOnly.test(clause.trim()));
  return task.length === clauses.length ? prompt : task.filter((clause) => clause.trim()).join("，").trim();
}

/**
 * Distinguishes conversational flow-control signals (e.g. "继续", "ok", "next", "确认")
 * from substantive task specifications. Flow-control signals in an ongoing turn
 * carry no domain capability requirements and must not trigger semantic skill evaluation.
 */
export function isFlowControlOnly(prompt: string, catalog?: PiResourceCatalog): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return true;
  if (explicitMention(trimmed, "codemode") || explicitMention(trimmed, "code mode")) return false;
  if (catalog) {
    for (const item of [...catalog.skills, ...catalog.mcpServers]) {
      if (explicitMention(trimmed, item.name)) return false;
    }
  }
  const clean = trimmed.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
  if (clean.length > 8) return false;
  const FLOW_SIGNALS = new Set([
    "继续", "接着", "下一步", "确认", "好的", "好的继续", "收到", "收到继续",
    "行", "可以", "好", "走", "开始", "执行", "同意", "好的处理吧", "部署吧",
    "ok", "okay", "continue", "next", "go", "proceed", "yes", "y", "done", "run",
  ]);
  return FLOW_SIGNALS.has(clean);
}

function matchProbability(result: DecisionResult, id: string): number {
  const answer = result.answers[id];
  const probabilities = answer?.probabilities as Record<string, unknown> | undefined;
  const match = probabilities?.match;
  const none = probabilities?.none;
  if (answer?.type !== "choice" || !["match", "none"].includes(String(answer.choice))
    || typeof match !== "number" || typeof none !== "number" || !Number.isFinite(match) || !Number.isFinite(none)
    || match < 0 || match > 1 || none < 0 || none > 1 || Math.abs(match + none - 1) > 0.002
    || (answer.choice === "match" ? match < none : none < match)) {
    throw new DecisionError("INVALID_RESULT", "本地模型返回无效判断，原选择未改变。", 502);
  }
  return match;
}

export interface PiAutomaticCodemodeChoice {
  override?: "off" | "on";
  source: "explicit" | "local" | "uncertain";
}

/** CodeMode is a per-round tool entry choice, never authority to execute its tools. */
export async function decidePiCodemode(input: {
  prompt: string; evaluate: PiResourceEvaluator; caller: string; signal?: AbortSignal;
}): Promise<PiAutomaticCodemodeChoice> {
  if (input.signal?.aborted) throw new DecisionError("CANCELLED", "CodeMode 自动判断已取消。", 499);
  const mention = explicitMention(input.prompt, "codemode") ?? explicitMention(input.prompt, "code mode");
  if (mention === "excluded") return { override: "off", source: "explicit" };
  if (mention === "included" && (/(?:使用|启用|开启|打开|通过|用|enable|use)\s*code\s?mode/i.test(input.prompt)
    || /code\s?mode\s*(?:开启|启用|打开|on\b)/i.test(input.prompt))) return { override: "on", source: "explicit" };
  let result: DecisionResult;
  try {
    result = await input.evaluate({
      state: input.prompt,
      questions: {
        forward: { type: "choice", instructions: "How to run the tools?",
          criteria: { match: "Batch tool calls", none: "Ordinary tool calls" } },
        reverse: { type: "choice", instructions: "How to run the tools?",
          criteria: { none: "Ordinary tool calls", match: "Batch tool calls" } },
      },
    }, input.caller, input.signal);
  } catch (error) {
    if (error instanceof DecisionError && ["CONTEXT_LIMIT", "QUESTION_LIMIT", "OPTIONS_COLLAPSED"].includes(error.code)) {
      return { source: "uncertain" };
    }
    throw error;
  }
  const forward = matchProbability(result, "forward");
  const reverse = matchProbability(result, "reverse");
  if (forward >= 0.8 && reverse >= 0.8) return { override: "on", source: "local" };
  if (forward <= 0.2 && reverse <= 0.2) return { override: "off", source: "local" };
  return { source: "uncertain" };
}

const SKILL_GROUP_SIZE = 4;
const SKILL_GROUPS_PER_REQUEST = 4;
const SKILL_DESCRIPTION_CHARS = 48;
const NO_SKILL = "none";

interface SkillDecisionCandidate {
  item: PiResourceItem;
  option: string;
}
interface SkillDecisionGroup {
  candidates: SkillDecisionCandidate[];
  forwardId: string;
  reverseId: string;
}
interface SkillDecisionPair {
  group: SkillDecisionGroup;
  forward: { choice: string; probabilities: Record<string, number> };
  reverse: { choice: string; probabilities: Record<string, number> };
}

function compactSkillDescription(item: PiResourceItem): string {
  const description = item.description.replace(/\s+/g, " ").trim();
  return `${item.name}: ${Array.from(description).slice(0, SKILL_DESCRIPTION_CHARS).join("")}`;
}

function skillDecisionGroup(items: PiResourceItem[], index: number): SkillDecisionGroup {
  return { candidates: items.map((item, option) => ({ item, option: `s${option}` })),
    forwardId: `g${index}f`, reverseId: `g${index}r` };
}

function skillDecisionCriteria(group: SkillDecisionGroup, reverse: boolean): Record<string, string> {
  const entries = group.candidates.map((candidate) => [candidate.option, compactSkillDescription(candidate.item)] as const);
  entries.push([NO_SKILL, "No installed skill is relevant"]);
  if (reverse) entries.reverse();
  return Object.fromEntries(entries);
}

function skillDecisionQuestions(groups: SkillDecisionGroup[]): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = {};
  for (const group of groups) {
    questions[group.forwardId] = { type: "choice", instructions: "Which installed skill best fits the task?",
      criteria: skillDecisionCriteria(group, false) };
    questions[group.reverseId] = { type: "choice", instructions: "Which installed skill best fits the task?",
      criteria: skillDecisionCriteria(group, true) };
  }
  return questions;
}

function readSkillChoice(result: DecisionResult, id: string, labels: string[]): SkillDecisionPair["forward"] {
  const answer = result.answers[id];
  const probabilities = answer?.probabilities as Record<string, unknown> | undefined;
  const values = labels.map((label) => probabilities?.[label]);
  if (answer?.type !== "choice" || typeof answer.choice !== "string" || !labels.includes(answer.choice)
    || !probabilities || Object.keys(probabilities).length !== labels.length
    || values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    || Math.abs(values.reduce<number>((sum, value) => sum + (value as number), 0) - 1) > 0.002
    || (probabilities[answer.choice] as number) < Math.max(...(values as number[]))) {
    throw new DecisionError("INVALID_RESULT", "决策员工返回无效的 Skills 候选判断，原选择未改变。", 502);
  }
  return { choice: answer.choice, probabilities: probabilities as Record<string, number> };
}

function readSkillPair(result: DecisionResult, group: SkillDecisionGroup): SkillDecisionPair {
  const labels = [...group.candidates.map((candidate) => candidate.option), NO_SKILL];
  return { group, forward: readSkillChoice(result, group.forwardId, labels),
    reverse: readSkillChoice(result, group.reverseId, labels) };
}

function averageSkillScore(pair: SkillDecisionPair, option: string): number {
  return (pair.forward.probabilities[option]! + pair.reverse.probabilities[option]!) / 2;
}

function strongestSkill(pair: SkillDecisionPair): PiResourceItem {
  let winner = pair.group.candidates[0]!;
  let score = -1;
  for (const candidate of pair.group.candidates) {
    const next = averageSkillScore(pair, candidate.option);
    if (next > score) { winner = candidate; score = next; }
  }
  return winner.item;
}

/** Average the two reversed option orders; an exact aggregate tie is not actionable. */
function strongestSkillOption(pair: SkillDecisionPair): string | null {
  let winner: string | null = null;
  let score = -1;
  let tied = false;
  for (const option of [...pair.group.candidates.map((candidate) => candidate.option), NO_SKILL]) {
    const next = averageSkillScore(pair, option);
    if (next > score + Number.EPSILON) { winner = option; score = next; tied = false; }
    else if (Math.abs(next - score) <= Number.EPSILON) tied = true;
  }
  return tied ? null : winner;
}

/** Read-only matching. Bounded system-role decisions rank the candidate set; they never connect MCP or grant authority. */
export async function recommendPiResources(input: {
  prompt: string; candidates: PiResourceSelection; catalog: PiResourceCatalog;
  evaluate: PiResourceEvaluator; caller: string; signal?: AbortSignal;
}): Promise<PiResourceRecommendation> {
  const statuses = new Map<string, PiResourceRecommendation["resources"][number]>();
  const semanticSkills: PiResourceItem[] = [];
  const task = resourceTask(input.prompt, input.catalog);
  let calls = 0;
  for (const kind of ["skills", "mcpServers"] as const) {
    for (const id of input.candidates[kind]) {
      if (input.signal?.aborted) throw new DecisionError("CANCELLED", "推荐已取消。", 499);
      const item = input.catalog[kind].find((resource) => resource.id === id);
      if (!item) throw new DecisionError("RESOURCE_MISSING", "候选资源已移除，请重新打开设置面板。");
      const mention = explicitMention(input.prompt, item.name);
      if (mention) {
        statuses.set(id, { id, kind, status: mention === "included" ? "recommended" : "unmatched", source: "explicit" });
      } else if (!task || kind === "mcpServers" || item.description.length > 1000) {
        // Transport type is not a capability description. Never connect MCP for discovery.
        statuses.set(id, { id, kind, status: "unassessed", source: "local" });
      } else {
        semanticSkills.push(item);
      }
    }
  }

  if (semanticSkills.length) {
    try {
      const groups = Array.from({ length: Math.ceil(semanticSkills.length / SKILL_GROUP_SIZE) }, (_, index) =>
        skillDecisionGroup(semanticSkills.slice(index * SKILL_GROUP_SIZE, (index + 1) * SKILL_GROUP_SIZE), index));
      const pairs: SkillDecisionPair[] = [];
      for (let index = 0; index < groups.length; index += SKILL_GROUPS_PER_REQUEST) {
        if (input.signal?.aborted) throw new DecisionError("CANCELLED", "推荐已取消。", 499);
        const batch = groups.slice(index, index + SKILL_GROUPS_PER_REQUEST);
        calls++;
        const result = await input.evaluate({ state: task, questions: skillDecisionQuestions(batch) }, input.caller, input.signal);
        if (input.signal?.aborted) throw new DecisionError("CANCELLED", "推荐已取消。", 499);
        pairs.push(...batch.map((group) => readSkillPair(result, group)));
      }
      let finalPair: SkillDecisionPair;
      if (pairs.length === 1) {
        finalPair = pairs[0]!;
      } else {
        const finalists = pairs.map(strongestSkill);
        const finalGroup = skillDecisionGroup(finalists, groups.length);
        calls++;
        const result = await input.evaluate({ state: task, questions: skillDecisionQuestions([finalGroup]) },
          input.caller, input.signal);
        if (input.signal?.aborted) throw new DecisionError("CANCELLED", "推荐已取消。", 499);
        finalPair = readSkillPair(result, finalGroup);
      }
      const winner = strongestSkillOption(finalPair);
      const selected = winner && winner !== NO_SKILL
        ? finalPair.group.candidates.find((candidate) => candidate.option === winner)?.item.id : undefined;
      for (const item of semanticSkills) statuses.set(item.id, { id: item.id, kind: "skills",
        status: item.id === selected ? "recommended" : winner === NO_SKILL ? "unmatched" : "uncertain", source: "local" });
    } catch (error) {
      if (!(error instanceof DecisionError) || !["CONTEXT_LIMIT", "QUESTION_LIMIT", "OPTIONS_COLLAPSED"].includes(error.code)) throw error;
      for (const item of semanticSkills) statuses.set(item.id, { id: item.id, kind: "skills", status: "unassessed", source: "local" });
    }
  }

  const resources: PiResourceRecommendation["resources"] = [];
  for (const kind of ["skills", "mcpServers"] as const) {
    for (const id of input.candidates[kind]) resources.push(statuses.get(id)!);
  }
  const selection: PiResourceSelection = { skills: [], mcpServers: [] };
  for (const resource of resources) if (resource.status === "recommended") selection[resource.kind].push(resource.id);
  return { selection, resources, calls, experimental: true };
}
