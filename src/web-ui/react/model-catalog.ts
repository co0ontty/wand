/**
 * `/api/models` 的浏览器侧视图。
 *
 * 三处入口共用这一份清单：任务看板的「创建并指派」、新建任务 / 新建工作窗口 / 任务欢迎页的
 * 模型选择。归一化只做一次，避免同一个 payload 在两处解析出不同的下拉项。
 */
import { type ProviderId } from "../provider-identity";
import { requestJson } from "./http-adapter";
import type { WandSelectOption } from "./ui";

export type ModelCatalogProvider = ProviderId;

/** 未加载 / 拉取失败时给空目录，调用方仍要能渲染下拉。 */
export interface WandModelCatalog {
  byProvider: Record<ModelCatalogProvider, WandSelectOption[]>;
  refreshedAt: string;
}

/** 「跟随服务端默认」的哨兵值；选择器与看板派发的 agent.model 共用同一个取值。 */
export const MODEL_CATALOG_DEFAULT_VALUE = "default";

/** 选择器值 → 创建请求里的模型 id：`default` / 空值返回空串，交给服务端默认。 */
export function pickedModelId(model: string | null | undefined): string {
  const value = (model ?? "").trim();
  return value === MODEL_CATALOG_DEFAULT_VALUE ? "" : value;
}

interface ModelEntry {
  id?: unknown;
  label?: unknown;
}

function modelEntryToOption(entry: ModelEntry): WandSelectOption | null {
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) return null;
  const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : id;
  return { value: id, label };
}

/** provider → [模型列表字段, 单值默认字段]；provider 字典序即 UI 顺序。 */
const MODEL_KEYS: ReadonlyArray<readonly [ModelCatalogProvider, string, string]> = [
  ["claude", "models", "defaultModel"],
  ["codex", "codexModels", "defaultCodexModel"],
  ["opencode", "opencodeModels", "defaultOpenCodeModel"],
  ["grok", "grokModels", "defaultGrokModel"],
  ["qoder", "qoderModels", "defaultQoderModel"],
  ["pi", "piModels", "defaultPiModel"],
];

/**
 * 把 `/api/models` 的 payload 归一化成每个 provider 的下拉选项。
 * 模型列表里带 `default` 时直接用；否则补一项「跟随服务端默认」，
 * 这样用户即使只有一个候选模型也能派发，而不会卡在空列表。
 */
export function normalizeWandModelCatalog(payload: unknown): WandModelCatalog {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const defaults = root.defaultModels && typeof root.defaultModels === "object"
    ? root.defaultModels as Record<string, unknown>
    : {};
  const byProvider = {} as Record<ModelCatalogProvider, WandSelectOption[]>;
  for (const [provider, listKey, defaultKey] of MODEL_KEYS) {
    const raw = Array.isArray(root[listKey]) ? root[listKey] as ModelEntry[] : [];
    const options = raw.map(modelEntryToOption).filter((option): option is WandSelectOption => option !== null);
    if (!options.some((option) => option.value === MODEL_CATALOG_DEFAULT_VALUE)) {
      const candidate = typeof defaults[provider] === "string"
        ? defaults[provider] as string
        : typeof root[defaultKey] === "string" ? root[defaultKey] as string : "";
      const fallback = candidate.trim();
      options.unshift({
        value: MODEL_CATALOG_DEFAULT_VALUE,
        label: fallback ? `跟随服务端默认（${fallback}）` : "跟随服务端默认",
      });
    }
    byProvider[provider] = options;
  }
  return {
    byProvider,
    refreshedAt: typeof root.refreshedAt === "string" ? root.refreshedAt : "",
  };
}

/** 目录尚未加载时也要能渲染下拉，给出「跟随服务端默认」占位。 */
export function wandModelOptions(
  catalog: WandModelCatalog | null,
  provider: ModelCatalogProvider,
): WandSelectOption[] {
  const options = catalog?.byProvider[provider];
  return options && options.length > 0
    ? options
    : [{ value: MODEL_CATALOG_DEFAULT_VALUE, label: "跟随服务端默认" }];
}

/** 目录已拉过多久还算新鲜；过期后下一次调用会重新请求（避免长期显示旧模型列表）。 */
const MODEL_CATALOG_TTL_MS = 60_000;

let cachedCatalog: WandModelCatalog | null = null;
let cachedAt = 0;

/**
 * 最近一次成功的目录快照，供 UI 拿同步初值直接渲染（不会先闪一下占位项）。
 * 失败不写缓存，所以登录前那次 401 不会让选择器永远停在「跟随服务端默认」。
 */
export function cachedWandModelCatalog(): WandModelCatalog | null {
  return cachedCatalog && Date.now() - cachedAt < MODEL_CATALOG_TTL_MS ? cachedCatalog : null;
}

/** 读取服务端模型目录；成功结果会缓存，失败 / 取消由调用方决定怎么兜底。 */
export async function loadWandModelCatalog(signal?: AbortSignal): Promise<WandModelCatalog> {
  const cached = cachedWandModelCatalog();
  if (cached) return cached;
  const catalog = normalizeWandModelCatalog(await requestJson<unknown>("/api/models", {
    signal,
    credentials: "same-origin",
  }));
  cachedCatalog = catalog;
  cachedAt = Date.now();
  return catalog;
}
