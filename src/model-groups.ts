import { isSessionProvider, SESSION_PROVIDERS, type SessionProvider } from "./provider-catalog.js";
import { OPENROUTER_FREE_GROUP, OPENROUTER_FREE_PROVIDER, OPENROUTER_FREE_SELECTOR,
  isOpenRouterFreeSelector } from "./openrouter-free-selection.js";

/** Stable identities, not names, are saved in sessions/employees/default model preferences. */
export interface ModelGroup {
  id: string;
  provider: SessionProvider;
  name: string;
  /** First is preferred; later entries are pre-execution fallbacks, never replay after acceptance. */
  models: string[];
}

export const MODEL_GROUP_PREFIX = "wand-model-group/";
/**
 * 「智能分配」：不是一个分组，而是一条只能在真实提示词到手后结算的选择。
 * 结构化会话的第一轮、终端会话带首条输入创建时才解析成本次真正使用的分组；
 * 没有提示词的同步场景（构建命令行、一次性文本调用）退化成默认分组。
 */
export const AUTO_ASSIGN_SELECTOR = "wand-auto-assign/auto";
export const AUTO_ASSIGN_LABEL = "智能分配";
export const FREE_MODEL_GROUP_ID = "openrouter-free";
export const MODEL_GROUP_MAX_PER_PROVIDER = 32;
export const MODEL_GROUP_MAX_MEMBERS = 32;
export const DEFAULT_MODEL_GROUP_NAMES = ["默认分组", "默认", "default"] as const;
const GROUP_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isModelGroupSelector(value: string | null | undefined): boolean {
  return value?.startsWith(MODEL_GROUP_PREFIX) === true;
}

export function isAutoAssignSelector(value: string | null | undefined): boolean {
  return value?.trim() === AUTO_ASSIGN_SELECTOR;
}

/** 「智能分配」在只拿到选择器、拿不到提示词时的等价写法：按默认分组解析。 */
function modelSelectorWithoutAutoAssign(selector: string | null | undefined): string {
  const value = selector?.trim() ?? "";
  return isAutoAssignSelector(value) ? "" : value;
}

export function modelGroupSelector(group: Pick<ModelGroup, "id" | "provider">): string {
  return group.id === FREE_MODEL_GROUP_ID && group.provider === "pi"
    ? OPENROUTER_FREE_SELECTOR : `${MODEL_GROUP_PREFIX}${group.provider}/${group.id}`;
}

export function normalizeModelGroups(value: unknown): ModelGroup[] {
  if (!Array.isArray(value) || value.length > MODEL_GROUP_MAX_PER_PROVIDER * SESSION_PROVIDERS.length + 1) {
    throw new Error("模型分组必须是有界数组。");
  }
  const identities = new Set<string>();
  const names = new Set<string>();
  const counts = new Map<string, number>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("模型分组格式无效。");
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!GROUP_ID.test(id) || !isSessionProvider(row.provider)) throw new Error("模型分组标识或工具无效。");
    const provider = row.provider;
    if (!name || name.length > 40 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("分组名称需为 1–40 个字符。");
    const free = id === FREE_MODEL_GROUP_ID;
    if (free && (provider !== "pi" || name !== OPENROUTER_FREE_GROUP)) throw new Error("免费分组的工具与名称不可修改。");
    if (!free && provider === "pi" && name === OPENROUTER_FREE_GROUP) throw new Error("免费分组是内置分组，请直接调整它的顺序。");
    const identity = `${provider}/${id}`;
    const named = `${provider}/${name}`;
    if (identities.has(identity) || names.has(named)) throw new Error("同一工具的分组标识或名称不能重复。");
    identities.add(identity); names.add(named);
    const count = (counts.get(provider) ?? 0) + (free ? 0 : 1);
    if (count > MODEL_GROUP_MAX_PER_PROVIDER) throw new Error(`每个工具最多 ${MODEL_GROUP_MAX_PER_PROVIDER} 个分组。`);
    counts.set(provider, count);
    if (!Array.isArray(row.models) || (!free && !row.models.length)
      || row.models.length > (free ? 128 : MODEL_GROUP_MAX_MEMBERS)) {
      throw new Error(`分组需包含 1–${MODEL_GROUP_MAX_MEMBERS} 个模型；免费分组可留空使用自动顺序。`);
    }
    const models = row.models.map((model) => {
      const trimmed = typeof model === "string" ? model.trim() : "";
      if (!trimmed || trimmed === "default" || trimmed.length > 256 || /[\s\x00-\x1f\x7f]/.test(trimmed)
        || isModelGroupSelector(trimmed) || isAutoAssignSelector(trimmed)
        || trimmed === OPENROUTER_FREE_SELECTOR || trimmed.startsWith("-")) {
        throw new Error("组内必须是具体模型 ID，不能嵌套分组或使用默认值。");
      }
      if (isOpenRouterFreeSelector(trimmed) && provider !== "pi") throw new Error("免费模型仅属于 Pi。");
      if (free && !trimmed.startsWith(`${OPENROUTER_FREE_PROVIDER}/`)) throw new Error("免费分组只能包含免费池中的模型。");
      return trimmed;
    });
    if (new Set(models).size !== models.length) throw new Error("同一分组中的模型不能重复。");
    return { id, provider, name, models };
  });
}

/** Names are exact and provider-scoped; stable selectors keep working after a rename. */
export function findModelGroup(
  groups: readonly ModelGroup[] | undefined, provider: SessionProvider, selector?: string | null,
  options: { preferDefault?: boolean } = {},
): ModelGroup | undefined {
  const candidates = (groups ?? []).filter((entry) => entry.provider === provider);
  const value = modelSelectorWithoutAutoAssign(selector);
  if (isModelGroupSelector(value) || value === OPENROUTER_FREE_SELECTOR) {
    return candidates.find((entry) => modelGroupSelector(entry) === value);
  }
  if (value && value !== "default") {
    const named = candidates.find((entry) => entry.name === value);
    if (named || !options.preferDefault) return named;
  }
  const named = DEFAULT_MODEL_GROUP_NAMES.map((name) => candidates.find((entry) => entry.name === name))
    .find((entry) => entry !== undefined);
  return named ?? candidates.find((entry) => entry.id !== FREE_MODEL_GROUP_ID) ?? candidates[0];
}

/** A configured group wins; do not silently replace a deleted configured group. */
export function defaultModelGroupSelector(
  groups: readonly ModelGroup[] | undefined, provider: SessionProvider, configured?: string | null,
): string | undefined {
  const value = configured?.trim();
  // 智能分配是明确选择，必须原样带到会话上，由第一轮提示词结算。
  if (isModelGroupSelector(value) || value === OPENROUTER_FREE_SELECTOR || isAutoAssignSelector(value)) return value;
  const group = findModelGroup(groups, provider, value, { preferDefault: true });
  return group ? modelGroupSelector(group) : undefined;
}

/** Native default is one executable candidate, not an empty candidate chain. */
export function resolveModelGroupModels(
  groups: readonly ModelGroup[] | undefined, provider: SessionProvider, selector: string | null | undefined,
  options: { preferDefault?: boolean } = {},
): string[] {
  const value = modelSelectorWithoutAutoAssign(selector);
  if (value === OPENROUTER_FREE_SELECTOR) {
    if (provider !== "pi") throw new Error("免费分组仅属于 Pi。");
    return [value];
  }
  const group = findModelGroup(groups, provider, value, options);
  if (group?.id === FREE_MODEL_GROUP_ID) return [OPENROUTER_FREE_SELECTOR];
  if (group) {
    if (!group.models.length) throw new Error("所选模型分组已删除、为空或不属于当前工具，请重新选择。");
    return [...group.models];
  }
  if (isModelGroupSelector(value)) throw new Error("所选模型分组已删除、为空或不属于当前工具，请重新选择。");
  return [value === "default" ? "" : value];
}

export function freeModelOrder(groups: readonly ModelGroup[] | undefined): string[] {
  return groups?.find((entry) => entry.id === FREE_MODEL_GROUP_ID && entry.provider === "pi")?.models ?? [];
}

/** Used for free pools: saved priority first; newly verified models append, vanished models are skipped. */
export function orderModelIds(ids: readonly string[], preferred: readonly string[]): string[] {
  const available = new Set(ids);
  return [...new Set([...preferred.filter((id) => available.has(id)), ...ids])];
}
