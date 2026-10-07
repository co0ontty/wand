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
function explicitMention(prompt: string, name: string): "included" | "excluded" | null {
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

const MATCH_INSTRUCTIONS = "Which skill fits the task?";

/** Keep the task separate from skill marketing text; the small model overweights long descriptions. */
function shortlistQuestions(name: string): Record<string, DecisionQuestion> {
  return {
    forward: { type: "choice", instructions: MATCH_INSTRUCTIONS, criteria: { match: name, none: "None" } },
    reverse: { type: "choice", instructions: MATCH_INSTRUCTIONS, criteria: { none: "None", match: name } },
  };
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

/** Read-only matching. Results never modify settings, connect MCP, or authorize an operation. */
export async function recommendPiResources(input: {
  prompt: string; candidates: PiResourceSelection; catalog: PiResourceCatalog;
  evaluate: PiResourceEvaluator; caller: string; signal?: AbortSignal;
}): Promise<PiResourceRecommendation> {
  const resources: PiResourceRecommendation["resources"] = [];
  const task = resourceTask(input.prompt, input.catalog);
  let calls = 0;
  for (const kind of ["skills", "mcpServers"] as const) {
    for (const id of input.candidates[kind]) {
      if (input.signal?.aborted) throw new DecisionError("CANCELLED", "推荐已取消。", 499);
      const item: PiResourceItem | undefined = input.catalog[kind].find((resource) => resource.id === id);
      if (!item) throw new DecisionError("RESOURCE_MISSING", "候选资源已移除，请重新打开设置面板。");
      const mention = explicitMention(input.prompt, item.name);
      if (mention) {
        resources.push({ id, kind, status: mention === "included" ? "recommended" : "unmatched", source: "explicit" });
        continue;
      }
      // Transport type is not a description of a server's capabilities. Never connect for discovery.
      if (!task || kind === "mcpServers" || item.description.length > 1000) {
        resources.push({ id, kind, status: "unassessed", source: "local" });
        continue;
      }
      let result: DecisionResult;
      try {
        calls++;
        const shortlist = await input.evaluate({ state: task, questions: shortlistQuestions(item.name) },
          input.caller, input.signal);
        const forward = matchProbability(shortlist, "forward");
        const reverse = matchProbability(shortlist, "reverse");
        if (forward < 0.8 || reverse < 0.8) {
          resources.push({ id, kind, status: forward <= 0.2 && reverse <= 0.2 ? "unmatched" : "uncertain", source: "local" });
          continue;
        }
        if (input.signal?.aborted) throw new DecisionError("CANCELLED", "推荐已取消。", 499);
        // A name match alone cannot load a skill. Confirm against its complete description.
        calls++;
        result = await input.evaluate({
          state: { task, resource: { name: item.name, description: item.description } },
          questions: { relevant: { type: "noul", instructions: "Does this skill match the task?" } },
        }, input.caller, input.signal);
      } catch (error) {
        if (error instanceof DecisionError && ["CONTEXT_LIMIT", "QUESTION_LIMIT", "OPTIONS_COLLAPSED"].includes(error.code)) {
          resources.push({ id, kind, status: "unassessed", source: "local" });
          continue;
        }
        throw error;
      }
      const relevant = result.answers.relevant?.noul;
      if (typeof relevant !== "number" || !Number.isFinite(relevant) || relevant < 0 || relevant > 1) {
        throw new DecisionError("INVALID_RESULT", "本地模型返回无效判断，原选择未改变。", 502);
      }
      const status = relevant >= 0.8 ? "recommended" : relevant <= 0.2 ? "unmatched" : "uncertain";
      resources.push({ id, kind, status, source: "local" });
    }
  }
  const selection: PiResourceSelection = { skills: [], mcpServers: [] };
  for (const resource of resources) if (resource.status === "recommended") selection[resource.kind].push(resource.id);
  return { selection, resources, calls, experimental: true };
}
