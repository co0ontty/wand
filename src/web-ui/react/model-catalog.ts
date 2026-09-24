/**
 * `/api/models` 的浏览器侧视图。
 *
 * 三处入口共用这一份清单：任务看板的「创建并指派」、新建任务 / 新建工作窗口 / 任务欢迎页的
 * 模型选择。归一化只做一次，避免同一个 payload 在两处解析出不同的下拉项。
 */
import { type ProviderId } from "../provider-identity";
import { requestJson } from "./http-adapter";
import type { CliThinkingEffort } from "../thinking-efforts";
import type { WandSelectOption } from "./ui";

export type ModelCatalogProvider = ProviderId;

/** 未加载 / 拉取失败时给空目录，调用方仍要能渲染下拉。 */
export interface WandModelEffortInfo {
  efforts: CliThinkingEffort[];
  defaultEffort?: string;
}

export interface WandModelCatalog {
  byProvider: Record<ModelCatalogProvider, WandSelectOption[]>;
  /** CLI 级思考档位。Codex 和带 variants 的 OpenCode 模型优先看 modelEfforts。 */
  effortsByProvider: Partial<Record<ModelCatalogProvider, CliThinkingEffort[]>>;
  modelEfforts: Partial<Record<ModelCatalogProvider, Record<string, WandModelEffortInfo>>>;
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
  reasoningEfforts?: unknown;
  defaultReasoningEffort?: unknown;
}

function effortList(value: unknown): CliThinkingEffort[] {
  if (!Array.isArray(value)) return [];
  const efforts: CliThinkingEffort[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { effort?: unknown; description?: unknown };
    const effort = typeof record.effort === "string" ? record.effort.trim().toLowerCase() : "";
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(effort)) continue;
    const description = typeof record.description === "string" ? record.description.trim() : "";
    efforts.push(description ? { effort, description } : { effort });
  }
  return efforts;
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
  const modelEfforts = {} as WandModelCatalog["modelEfforts"];
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
    const perModel: Record<string, WandModelEffortInfo> = {};
    for (const entry of raw) {
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      const efforts = effortList(entry.reasoningEfforts);
      if (!id || !efforts.length) continue;
      const defaultEffort = typeof entry.defaultReasoningEffort === "string"
        ? entry.defaultReasoningEffort.trim()
        : "";
      perModel[id] = defaultEffort ? { efforts, defaultEffort } : { efforts };
    }
    if (Object.keys(perModel).length) modelEfforts[provider] = perModel;
  }
  const thinking = root.thinkingEfforts && typeof root.thinkingEfforts === "object"
    ? root.thinkingEfforts as Record<string, unknown>
    : {};
  const effortsByProvider: WandModelCatalog["effortsByProvider"] = {};
  for (const [provider] of MODEL_KEYS) {
    const efforts = effortList(thinking[provider]);
    if (efforts.length) effortsByProvider[provider] = efforts;
  }
  return {
    byProvider,
    effortsByProvider,
    modelEfforts,
    refreshedAt: typeof root.refreshedAt === "string" ? root.refreshedAt : "",
  };
}

/** 目录尚未加载时也要能渲染下拉，给出「跟随服务端默认」占位。 */
export function catalogThinkingEfforts(
  catalog: WandModelCatalog | null,
  provider: ModelCatalogProvider,
  modelId?: string,
): { efforts: CliThinkingEffort[]; defaultEffort?: string } {
  if (!catalog) return { efforts: [] };
  const perModel = catalog.modelEfforts[provider];
  const selected = modelId ? perModel?.[modelId] : undefined;
  const fallbackModel = perModel?.[MODEL_CATALOG_DEFAULT_VALUE];
  const match = selected?.efforts.length ? selected : fallbackModel;
  if (match?.efforts.length) return match;
  return { efforts: catalog.effortsByProvider[provider] ?? [] };
}

export function wandModelOptions(
  catalog: WandModelCatalog | null,
  provider: ModelCatalogProvider,
): WandSelectOption[] {
  const options = catalog?.byProvider[provider];
  return options && options.length > 0
    ? options
    : [{ value: MODEL_CATALOG_DEFAULT_VALUE, label: "跟随服务端默认" }];
}

/** 页面定时拉服务端快照的间隔。CLI 探测在服务端更疏，这里只读已缓存的目录。 */
export const MODEL_CATALOG_POLL_MS = 60_000;

/** 目录已拉过多久还算新鲜；过期后下一次调用会重新请求（避免长期显示旧模型列表）。 */
const MODEL_CATALOG_TTL_MS = 60_000;

let cachedCatalog: WandModelCatalog | null = null;
let cachedAt = 0;
let pollTimer = 0;
const catalogListeners = new Set<(catalog: WandModelCatalog) => void>();

export function subscribeWandModelCatalog(listener: (catalog: WandModelCatalog) => void): () => void {
  catalogListeners.add(listener);
  return () => { catalogListeners.delete(listener); };
}

/** 把一次 `/api/models` 应答写进缓存并通知打开着的选择器。 */
function catalogSignature(catalog: WandModelCatalog): string {
  return JSON.stringify({
    refreshedAt: catalog.refreshedAt,
    byProvider: catalog.byProvider,
    effortsByProvider: catalog.effortsByProvider,
    modelEfforts: catalog.modelEfforts,
  });
}

export function publishWandModelCatalog(payload: unknown): WandModelCatalog {
  const catalog = normalizeWandModelCatalog(payload);
  const unchanged = cachedCatalog !== null && catalogSignature(cachedCatalog) === catalogSignature(catalog);
  cachedCatalog = catalog;
  cachedAt = Date.now();
  if (unchanged) return catalog;
  for (const listener of catalogListeners) listener(catalog);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("wand-model-catalog", { detail: payload }));
  }
  return catalog;
}

/** 登录后定时拉目录快照。服务端探测到新模型或新思考档位时，页面不用再手点刷新。 */
export function startWandModelCatalogPolling(): void {
  if (typeof window === "undefined" || pollTimer) return;
  pollTimer = window.setInterval(() => {
    void requestJson<unknown>("/api/models", { credentials: "same-origin" })
      .then((payload) => { publishWandModelCatalog(payload); })
      .catch(() => undefined);
  }, MODEL_CATALOG_POLL_MS);
}

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
  return publishWandModelCatalog(await requestJson<unknown>("/api/models", {
    signal,
    credentials: "same-origin",
  }));
}
