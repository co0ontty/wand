/**
 * 「智能分配」的结算：把选择器 + 第一条提示词变成这一次真正使用的模型分组。
 *
 * 顺序固定，每一步都可解释：
 *   1. 该工具只有一个分组 → 直接用它（不需要判断）；
 *   2. 系统运维员工的一次性文本调用（有窗口上限）：实测命中率明显高于本地模型，
 *      而且只输出一个分组名，所以放在第一位；
 *   3. 拿不到 AI 结论（没接入/超时/说不清）时，用本地决策模型（`localDecision`，
 *      离线、毫秒级）在最多 4 个候选里选一个，并且必须**同一道题正反两种选项顺序
 *      结论一致**才算数——这个离线模型有明确位置偏好（总挑最后一个选项）；
 *   4. 都拿不到结论 → 用该工具的默认分组。
 *
 * 这里只做有界选择，不执行任何工具、不改会话历史、不写配置。
 */
import type { DecisionResult } from "./decision-types.js";
import { getErrorMessage } from "./error-utils.js";
import { callConfiguredAiText, type QuickCommitAiOptions } from "./git-quick-commit.js";
import { findModelGroup, modelGroupSelector, type ModelGroup } from "./model-groups.js";
import type { SessionProvider } from "./provider-catalog.js";
import type { AiTextRequest } from "./types.js";

/** 本地决策一次最多比较多少个分组；候选更多就只信 AI 回退（更短的提示才稳）。 */
const AUTO_ASSIGN_CHOICE_MAX = 4;
/** 选项里嵌入的任务提示词上限（决策模型总窗口只有 1024 token）。 */
const AUTO_ASSIGN_STATE_MAX = 600;
/** 拿不准就别乱换：任一轮低于这个概率视为「没有明确偏好」，回落默认分组。 */
const AUTO_ASSIGN_MIN_PROBABILITY = 0.4;
/** AI 回退窗口：第一条消息不能为了选分组等到 CLI 链跑满 150s。 */
const AUTO_ASSIGN_AI_BUDGET_MS = 15_000;
const AUTO_ASSIGN_AI_PROMPT_MAX = 1200;

export interface AutoAssignRequest {
  provider: SessionProvider;
  /** 第一条真实用户提示词；空串表示拿不到提示词，只能回落默认分组。 */
  prompt: string;
  groups: readonly ModelGroup[] | undefined;
  /** 本地决策入口：生产用 DecisionService.evaluate，测试注入替身。 */
  evaluate?: (value: unknown, caller: string, signal?: AbortSignal) => Promise<DecisionResult>;
  /** 系统运维员工的一次性文本调用上下文；没给就不做 AI 回退。 */
  ai?: QuickCommitAiOptions;
  /** AI 回退的实际调用入口（测试注入替身）；默认走系统运维员工的 CLI 候选链。 */
  aiCall?: (request: AiTextRequest, options: QuickCommitAiOptions) => Promise<string>;
  cwd?: string;
  language?: string;
  signal?: AbortSignal;
}

export interface AutoAssignResult {
  /** 本次实际使用的分组选择器；空串表示没有可用分组，仍用工具自己的默认模型。 */
  selector: string;
  group: ModelGroup | null;
  strategy: "only" | "local" | "ai" | "default";
  /** 决策模型给出的概率（选中项的 P）；仅作参考。 */
  probability?: number;
  calls: number;
}

/** 该工具可分配的分组：顺序即配置顺序，「默认分组」是自然回落项。 */
function candidatesOf(groups: readonly ModelGroup[] | undefined, provider: SessionProvider): ModelGroup[] {
  return (groups ?? []).filter((group) => group.provider === provider);
}

/** 压平空白：提示词、分组名都要先变成单行再截断。 */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstModelText(group: ModelGroup): string {
  const first = group.models[0]?.trim();
  if (!first) return "免费池自动顺序";
  return first.split("/").pop()?.trim() || first;
}

/** 分组名可能很长；选项文本必须短，否则决策 worker 直接拒绝这道题。 */
function shortLabel(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim() || "分组";
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

function uniqueLabels(groups: readonly ModelGroup[], max: number): string[] {
  const used = new Set<string>();
  return groups.map((group) => {
    const base = shortLabel(group.name, max);
    let label = base;
    for (let suffix = 2; used.has(label) && suffix < 100; suffix++) label = `${base.slice(0, Math.max(1, max - 4))}·${suffix}`;
    used.add(label);
    return label;
  });
}

function defaultGroupOf(groups: readonly ModelGroup[] | undefined, provider: SessionProvider): ModelGroup | null {
  return findModelGroup(groups, provider, "") ?? null;
}

function resultForGroup(group: ModelGroup | null, strategy: AutoAssignResult["strategy"], calls: number,
  probability?: number): AutoAssignResult {
  return {
    selector: group ? modelGroupSelector(group) : "",
    group,
    strategy,
    calls,
    ...(probability === undefined ? {} : { probability }),
  };
}

/**
 * 本地决策：一次「多选一」，并要求正反两种选项顺序给出同一个分组才算结论。
 * 拿不准（选中项概率过低 / 两种顺序不一致）返回 null，交给下一层。
 */
async function decideLocally(
  evaluate: NonNullable<AutoAssignRequest["evaluate"]>,
  prompt: string,
  candidates: readonly ModelGroup[],
  signal?: AbortSignal,
): Promise<{ group: ModelGroup; probability: number; calls: number } | null> {
  if (candidates.length > AUTO_ASSIGN_CHOICE_MAX) return null;
  const task = collapseWhitespace(prompt).slice(0, AUTO_ASSIGN_STATE_MAX);
  const askOnce = async (order: readonly ModelGroup[]): Promise<{ group: ModelGroup; probability: number } | null> => {
    const labels = uniqueLabels(order, 24);
    const criteria: Record<string, string> = {};
    for (const [index, group] of order.entries()) {
      criteria[labels[index]!] = `首选 ${shortLabel(firstModelText(group), 20)}`;
    }
    const result = await evaluate({
      state: task,
      questions: { group: { type: "choice", instructions: "按任务类型选一个最合适的模型分组", criteria } },
    }, "auto-assign", signal);
    const answer = result.answers?.group as { choice?: unknown; probabilities?: Record<string, number> } | undefined;
    const choice = typeof answer?.choice === "string" ? answer.choice : "";
    const index = labels.indexOf(choice);
    if (index < 0) return null;
    const probability = Number(answer?.probabilities?.[choice] ?? 0);
    if (!Number.isFinite(probability) || probability < AUTO_ASSIGN_MIN_PROBABILITY) return null;
    return { group: order[index]!, probability };
  };
  const forward = await askOnce(candidates);
  if (!forward) return null;
  const reverse = await askOnce([...candidates].reverse());
  if (!reverse || reverse.group.id !== forward.group.id) return null;
  return { group: forward.group, probability: Math.min(forward.probability, reverse.probability), calls: 2 };
}

/** AI 输出的分组名 → 候选分组。名称必须能唯一对上，否则抛错（让候选链继续，而不是猜）。 */
export function parseGroupChoice(raw: string, candidates: readonly ModelGroup[], names: readonly string[]): ModelGroup {
  const flat = collapseWhitespace(raw);
  const exact = candidates.find((_group, index) => flat === names[index]);
  if (exact) return exact;
  const matched = candidates.filter((group) => flat.includes(group.name));
  if (matched.length === 1) return matched[0]!;
  throw new Error("AI 没有给出可识别的分组名。");
}

/** AI 回退：让系统运维员工的 CLI 候选链只输出一个分组名。 */
async function decideWithAi(
  request: AutoAssignRequest,
  candidates: readonly ModelGroup[],
): Promise<{ group: ModelGroup | null; calls: number } | null> {
  const ai = request.ai;
  if (!ai) return null;
  const call = request.aiCall;
  // 与 core runner 同一条单测安全约定：测试里没注入替身就不发真实 CLI 请求。
  if (!call && process.env.NODE_TEST_CONTEXT) return null;
  const names = uniqueLabels(candidates, 40);
  const list = candidates
    .map((group, index) => `- ${names[index]}：首选 ${firstModelText(group)}（共 ${group.models.length} 个模型）`)
    .join("\n");
  const task = collapseWhitespace(request.prompt).slice(0, AUTO_ASSIGN_AI_PROMPT_MAX);
  const system = "你要在若干个模型分组里为一次任务挑一个最合适的。只输出分组名本身，不要解释、不要标点、不要 Markdown。";
  const message = `任务提示词：\n${task}\n\n可选模型分组：\n${list}\n\n只输出上面列出的分组名之一；都不合适就输出 -。`;
  const text = call
    ? await call({ system, prompt: message }, ai)
    : await callConfiguredAiText({ system, prompt: message }, request.cwd ?? process.cwd(), request.language ?? "",
      { ...ai, budgetMs: AUTO_ASSIGN_AI_BUDGET_MS }, (raw) => String(raw).trim());
  const flat = collapseWhitespace(text);
  if (!flat || flat === "-" || flat === "无") return { group: null, calls: 1 };
  return { group: parseGroupChoice(flat, candidates, names), calls: 1 };
}

/**
 * 把「智能分配」结算成本次使用的分组。任何失败都退化成默认分组，绝不抛错：
 * 第一条消息不能因为选分组失败而被挡住。
 */
export async function resolveAutoAssign(request: AutoAssignRequest): Promise<AutoAssignResult> {
  const candidates = candidatesOf(request.groups, request.provider);
  if (!candidates.length) return resultForGroup(null, "default", 0);
  if (candidates.length === 1) return resultForGroup(candidates[0]!, "only", 0);
  const prompt = request.prompt?.trim() ?? "";
  if (prompt) {
    let aiCalls = 0;
    if (request.ai) {
      try {
        const decided = await decideWithAi(request, candidates);
        aiCalls = decided?.calls ?? 1;
        if (decided?.group) return resultForGroup(decided.group, "ai", aiCalls);
      } catch (error) {
        aiCalls = 1;
        console.warn(`[AutoAssign] 系统员工未能给出分组：${getErrorMessage(error)}`);
      }
    }
    if (request.evaluate) {
      try {
        const local = await decideLocally(request.evaluate, prompt, candidates, request.signal);
        if (local) return resultForGroup(local.group, "local", local.calls + aiCalls, local.probability);
      } catch (error) {
        console.warn(`[AutoAssign] 本地决策未能给出分组：${getErrorMessage(error)}`);
      }
    }
  }
  return resultForGroup(defaultGroupOf(request.groups, request.provider), "default", 0);
}
