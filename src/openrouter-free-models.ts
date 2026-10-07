import type { Model, Api } from "@earendil-works/pi-ai";
import type { WandStorage } from "./storage.js";
import type { ClaudeModelInfo } from "./types.js";
import { freeModelOrder, normalizeModelGroups, orderModelIds } from "./model-groups.js";
import { OPENROUTER_FREE_PROVIDER, OPENROUTER_FREE_GROUP, OPENROUTER_FREE_SELECTOR,
  isOpenRouterFreeSelector } from "./openrouter-free-selection.js";

export { OPENROUTER_FREE_PROVIDER, OPENROUTER_FREE_GROUP, OPENROUTER_FREE_SELECTOR,
  isOpenRouterFreeSelector } from "./openrouter-free-selection.js";
export const OPENROUTER_REFRESH_MS = 6 * 60 * 60 * 1000;
const CACHE_KEY = "openrouter-free-models-v1";
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,100}$/;
const MAX_BYTES = 4 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 20000;
const PROBE_CONCURRENCY = 2;
const PROBE_VERSION = 2;

/** Same zero-price routing constraint for validation and actual core calls. */
export const OPENROUTER_FREE_ROUTING = {
  require_parameters: true,
  max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
};

async function readJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    throw new OpenRouterSyncError("OpenRouter 返回内容过大。");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new OpenRouterSyncError("OpenRouter 返回了空内容。");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new OpenRouterSyncError("OpenRouter 返回内容过大。");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

class OpenRouterSyncError extends Error {}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

export interface OpenRouterStatus {
  configured: boolean;
  group: string;
  modelCount: number;
  lastCheckedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  refreshIntervalHours: number;
  candidateCount: number;
  rejectedCount: number;
}

/** Only zero-priced language models with text input/output and tool support can serve the agent. */
export function parseOpenRouterFreeModels(body: unknown): Model<Api>[] {
  const rows = record(body).data;
  if (!Array.isArray(rows)) throw new OpenRouterSyncError("OpenRouter 返回的模型目录格式无效。");
  const models = new Map<string, Model<Api>>();
  for (const entry of rows.slice(0, 4000)) {
    const row = record(entry);
    const pricing = record(row.pricing);
    const zero = (value: unknown): boolean =>
      (typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
      && Number.isFinite(Number(value)) && Number(value) === 0;
    if (!zero(pricing.prompt) || !zero(pricing.completion)
      || !Object.values(pricing).every(zero)) continue;
    const architecture = record(row.architecture);
    const inputs = architecture.input_modalities;
    const outputs = architecture.output_modalities;
    // Understanding images is allowed; generating images, video, audio, or unknown outputs is not.
    if (!Array.isArray(inputs) || !inputs.includes("text")
      || !Array.isArray(outputs) || outputs.length === 0
      || !outputs.every((modality) => modality === "text")) continue;
    if (!Array.isArray(row.supported_parameters) || !row.supported_parameters.includes("tools")) continue;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!MODEL_PATTERN.test(id)) continue;
    const contextWindow = Number(row.context_length);
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024) continue;
    const reportedMax = Number(record(row.top_provider).max_completion_tokens);
    const maxTokens = Number.isSafeInteger(reportedMax) && reportedMax > 0
      ? Math.min(reportedMax, contextWindow) : Math.min(8192, contextWindow);
    models.set(id, {
      id,
      name: typeof row.name === "string" ? row.name.slice(0, 160) : id,
      provider: OPENROUTER_FREE_PROVIDER,
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: row.supported_parameters.includes("reasoning"),
      compat: { thinkingFormat: "openrouter" },
      input: Array.isArray(architecture.input_modalities) && architecture.input_modalities.includes("image")
        ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface FreeModelRequirements {
  preferReasoning?: boolean;
  /** A custom group must never substitute a free model from outside its membership. */
  allowedSelectors?: readonly string[];
}

/** Prefer requested reasoning support, then a larger context/output budget for coding tasks. */
function automaticModelOrder(models: Model<Api>[], requirements: FreeModelRequirements): Model<Api>[] {
  return [...models].sort((a, b) =>
    (requirements.preferReasoning ? Number(b.reasoning) - Number(a.reasoning) : 0)
    || b.contextWindow - a.contextWindow
    || b.maxTokens - a.maxTokens
    || a.id.localeCompare(b.id));
}

export type OpenRouterFreeStorage = Pick<WandStorage,
  "getConnectorToken" | "getConfigValue" | "setConfigValue" | "getPreference" | "saveConnector" | "deleteConnector">;

/** Server-owned credentials and last successful catalog; never writes Pi's auth/models files. */
export class OpenRouterFreeModelsService {
  private models: Model<Api>[] = [];
  private lastCheckedAt: string | null = null;
  private lastSyncedAt: string | null = null;
  private error: string | null = null;
  private candidateCount = 0;
  private rejectedCount = 0;
  private revision = 0;
  private catalogSequence = 0;
  private committedSequence = 0;
  private credentialController = new AbortController();
  private pending: { revision: number; promise: Promise<OpenRouterStatus> } | null = null;
  private controller: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  private listeners = new Set<() => void>();

  constructor(
    private readonly storage: OpenRouterFreeStorage,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    try {
      const cached = record(JSON.parse(storage.getConfigValue(CACHE_KEY) ?? "{}"));
      // Restore through the same validator rather than trusting stored runtime model fields.
      if (this.key() && cached.body && cached.probeVersion === PROBE_VERSION) {
        this.models = parseOpenRouterFreeModels(cached.body);
        this.candidateCount = Math.max(this.models.length, Number(cached.candidateCount) || 0);
        this.rejectedCount = this.candidateCount - this.models.length;
      }
      if (cached.probeVersion === PROBE_VERSION && typeof cached.lastSyncedAt === "string" && Number.isFinite(Date.parse(cached.lastSyncedAt))) {
        this.lastSyncedAt = cached.lastSyncedAt;
      }
    } catch { /* A malformed cache can be rediscovered. */ }
  }

  private key(): string { return this.storage.getConnectorToken("openrouter") ?? ""; }

  status(): OpenRouterStatus {
    return {
      configured: !!this.key(), group: OPENROUTER_FREE_GROUP, modelCount: this.models.length,
      lastCheckedAt: this.lastCheckedAt, lastSyncedAt: this.lastSyncedAt, lastError: this.error,
      refreshIntervalHours: OPENROUTER_REFRESH_MS / 3600000,
      candidateCount: this.candidateCount, rejectedCount: this.rejectedCount,
    };
  }

  catalog(): ClaudeModelInfo[] {
    if (this.disposed || !this.models.length || !this.key()) return [];
    // One selectable pool, not a category that still requires choosing a concrete model.
    const efforts = this.models.some((model) => model.reasoning)
      ? ["off", "minimal", "low", "medium", "high"] : ["off"];
    return [{
      id: OPENROUTER_FREE_SELECTOR,
      label: OPENROUTER_FREE_GROUP,
      reasoningEfforts: efforts.map((effort) => ({ effort })),
    }];
  }

  /** Concrete verified members for the group editor; no key or provider payload is exposed. */
  members(): ClaudeModelInfo[] {
    if (this.disposed || !this.key()) return [];
    return this.orderedModels(this.models, {}).map((model) => ({
      id: `${OPENROUTER_FREE_PROVIDER}/${model.id}`, label: `${model.name} · ${model.id}`,
      reasoningEfforts: (model.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"])
        .map((effort) => ({ effort })),
    }));
  }

  private orderedModels(models: Model<Api>[], requirements: FreeModelRequirements): Model<Api>[] {
    const groups = normalizeModelGroups(this.storage.getPreference<unknown>("pref:modelGroups", []));
    const automatic = automaticModelOrder(models, requirements).filter((model) => !requirements.allowedSelectors
      || requirements.allowedSelectors.includes(`${OPENROUTER_FREE_PROVIDER}/${model.id}`));
    const order = orderModelIds(automatic.map((model) => `${OPENROUTER_FREE_PROVIDER}/${model.id}`),
      requirements.allowedSelectors ?? freeModelOrder(groups));
    const byId = new Map(automatic.map((model) => [`${OPENROUTER_FREE_PROVIDER}/${model.id}`, model]));
    return order.map((id) => byId.get(id)!);
  }

  resolve(selector: string | null | undefined, requirements: FreeModelRequirements = {}): {
    model: Model<Api>; apiKey: string;
  } | null {
    if (this.disposed || !isOpenRouterFreeSelector(selector)) return null;
    const id = selector!.slice(OPENROUTER_FREE_PROVIDER.length + 1);
    const model = selector === OPENROUTER_FREE_SELECTOR
      ? this.orderedModels(this.models, requirements)[0] : this.models.find((entry) => entry.id === id);
    const apiKey = this.key();
    return model && apiKey ? { model: structuredClone(model), apiKey } : null;
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* An observer must not invalidate a successful sync. */ }
    }
  }

  async saveKey(value: unknown): Promise<OpenRouterStatus> {
    if (typeof value !== "string" || !value.trim() || value.length > 512 || /\s/.test(value.trim())) {
      throw new TypeError("请填写有效的 OpenRouter Key。");
    }
    const key = value.trim();
    this.revision++;
    this.credentialController.abort();
    this.credentialController = new AbortController();
    this.controller?.abort();
    const changedKey = key !== this.key();
    this.storage.saveConnector("openrouter", { token: key, apiUrl: "https://openrouter.ai/api/v1" });
    if (changedKey) {
      // Validation belongs to the credential used for the probe.
      this.models = [];
      this.candidateCount = 0;
      this.rejectedCount = 0;
      this.lastSyncedAt = null;
      this.storage.setConfigValue(CACHE_KEY, "{}");
      this.notify();
    }
    this.error = null;
    return this.refresh();
  }

  clearKey(): OpenRouterStatus {
    this.revision++;
    this.credentialController.abort();
    this.credentialController = new AbortController();
    this.controller?.abort();
    this.storage.deleteConnector("openrouter");
    this.storage.setConfigValue(CACHE_KEY, "{}");
    this.models = [];
    this.candidateCount = 0;
    this.rejectedCount = 0;
    this.lastCheckedAt = null;
    this.lastSyncedAt = null;
    this.error = null;
    this.notify();
    return this.status();
  }

  refresh(): Promise<OpenRouterStatus> {
    if (this.disposed) return Promise.resolve(this.closedStatus());
    if (!this.key()) return Promise.resolve(this.status());
    if (this.pending?.revision === this.revision) return this.pending.promise;
    const revision = this.revision;
    const promise = this.performRefresh(revision);
    this.pending = { revision, promise };
    return promise.finally(() => { if (this.pending?.promise === promise) this.pending = null; });
  }

  private async performRefresh(revision: number): Promise<OpenRouterStatus> {
    const controller = new AbortController();
    this.controller = controller;
    const sequence = ++this.catalogSequence;
    const current = (): boolean => !this.disposed && this.revision === revision && sequence >= this.committedSequence;
    try {
      const candidates = await this.fetchCandidates(this.key(), controller.signal);
      if (!current()) return this.disposed ? this.closedStatus() : this.status();
      // A continuous free price and an earlier successful probe allow reuse.
      const verified = new Set(this.models.map((model) => model.id));
      const newModels = await this.validateModels(candidates.filter((model) => !verified.has(model.id)), this.key(), controller.signal);
      if (!current()) return this.disposed ? this.closedStatus() : this.status();
      const passed = new Set([...verified, ...newModels.map((model) => model.id)]);
      this.publish(candidates, candidates.filter((model) => passed.has(model.id)), sequence);
    } catch (cause) {
      if (current()) {
        this.lastCheckedAt = this.now().toISOString();
        // Network/provider errors may echo credentials: only emit our own bounded messages.
        this.error = cause instanceof OpenRouterSyncError
          ? cause.message : "OpenRouter 同步失败，请检查网络后重试。";
      }
    } finally { if (this.controller === controller) this.controller = null; }
    return this.disposed ? this.closedStatus() : this.status();
  }

  private async fetchCandidates(apiKey: string, signal: AbortSignal): Promise<Model<Api>[]> {
    const response = await this.fetchImpl("https://openrouter.ai/api/v1/models/user", {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new OpenRouterSyncError(response.status === 401 || response.status === 403
        ? "OpenRouter Key 无效或没有访问权限。"
        : `OpenRouter 价格检查失败（HTTP ${response.status}）。`);
    }
    return parseOpenRouterFreeModels(await readJsonResponse(response, MAX_BYTES));
  }

  private publish(candidates: Model<Api>[], models: Model<Api>[], sequence: number): void {
    const checkedAt = this.now().toISOString();
    const body = { data: models.map((model) => ({
      id: model.id, name: model.name, context_length: model.contextWindow,
      top_provider: { max_completion_tokens: model.maxTokens },
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: model.reasoning ? ["tools", "reasoning"] : ["tools"],
      architecture: { input_modalities: model.input, output_modalities: ["text"] },
    })) };
    this.storage.setConfigValue(CACHE_KEY, JSON.stringify({ body, lastSyncedAt: checkedAt,
      probeVersion: PROBE_VERSION, candidateCount: candidates.length }));
    this.models = models;
    this.candidateCount = candidates.length;
    this.rejectedCount = candidates.length - models.length;
    this.lastCheckedAt = checkedAt;
    this.lastSyncedAt = checkedAt;
    this.error = null;
    this.committedSequence = sequence;
    this.notify();
  }

  /** Fresh pricing is mandatory for each inference, including tool-loop continuations. */
  async resolveForCall(selector: string, signal?: AbortSignal, requirements: FreeModelRequirements = {}): Promise<{
    model: Model<Api>; apiKey: string;
  }> {
    if (this.disposed || !isOpenRouterFreeSelector(selector)) throw new Error("免费模型服务不可用。");
    const apiKey = this.key();
    if (!apiKey) throw new Error("OpenRouter Key 未配置，请先保存 Key。");
    const revision = this.revision;
    const sequence = ++this.catalogSequence;
    const callSignal = signal
      ? AbortSignal.any([signal, this.credentialController.signal]) : this.credentialController.signal;
    const assertCurrent = (): void => {
      if (this.disposed || this.revision !== revision || apiKey !== this.key()
        || callSignal.aborted || sequence < this.committedSequence) {
        throw new Error("免费模型配置或目录已变化，本次调用已停止，请重试。");
      }
    };
    let candidates: Model<Api>[];
    try { candidates = await this.fetchCandidates(apiKey, callSignal); }
    catch (cause) {
      // Never proceed with stale prices when a fresh lookup fails.
      const message = cause instanceof OpenRouterSyncError
        ? cause.message : "OpenRouter 价格检查失败，本次调用已停止，请重试。";
      if (!this.disposed && this.revision === revision && sequence >= this.committedSequence) {
        this.lastCheckedAt = this.now().toISOString();
        this.error = message;
      }
      throw new Error(message);
    }
    assertCurrent();
    const verifiedIds = new Set(this.models.map((model) => model.id));
    const verified = candidates.filter((model) => verifiedIds.has(model.id));
    // Removing a paid/missing entry also invalidates its earlier usability proof.
    this.publish(candidates, verified, sequence);
    const id = selector.slice(OPENROUTER_FREE_PROVIDER.length + 1);
    const automatic = selector === OPENROUTER_FREE_SELECTOR;
    const permitted = (model: Model<Api>): boolean => !requirements.allowedSelectors
      || requirements.allowedSelectors.includes(`${OPENROUTER_FREE_PROVIDER}/${model.id}`);
    let chosen = (automatic ? undefined : verified.find((model) => model.id === id && permitted(model)))
      ?? this.orderedModels(verified, requirements)[0];
    if (!chosen) {
      const preferred = automatic ? undefined : candidates.find((model) => model.id === id && permitted(model));
      const alternatives = this.orderedModels(candidates, requirements);
      const ordered = preferred ? [preferred, ...alternatives.filter((model) => model.id !== id)] : alternatives;
      for (const candidate of ordered) {
        const usable = await this.probeModel(candidate, apiKey, callSignal);
        assertCurrent();
        if (usable) { chosen = candidate; break; }
      }
      if (chosen) this.publish(candidates, [chosen], sequence);
    }
    if (!chosen) throw new Error("当前没有已验证且免费的模型，本次调用已停止，请稍后同步免费分组。");
    assertCurrent();
    return { model: structuredClone(chosen), apiKey };
  }

  /** Every discovered model must answer a real message before it becomes selectable. */
  private async validateModels(candidates: Model<Api>[], apiKey: string, signal: AbortSignal): Promise<Model<Api>[]> {
    const passed = new Set<string>();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, candidates.length) }, async () => {
      while (!signal.aborted) {
        const model = candidates[next++];
        if (!model) break;
        if (await this.probeModel(model, apiKey, signal)) passed.add(model.id);
      }
    }));
    return candidates.filter((model) => passed.has(model.id));
  }

  private async probeModel(model: Model<Api>, apiKey: string, signal: AbortSignal): Promise<boolean> {
    try {
      const response = await this.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
        body: JSON.stringify({
          model: model.id,
          stream: false,
          max_tokens: Math.min(512, model.maxTokens),
          messages: [
            { role: "system", content: "你是标题助手。只返回简短标题，不要解释，不要使用工具。" },
            { role: "user", content: "请为这段对话拟一个简短标题：用户正在设置免费AI模型，并验证模型是否可以正常回复。" },
          ],
          // Exercise a tool-capable request without granting executable tools.
          tools: [{ type: "function", function: {
            name: "connectivity_check", description: "连接测试占位工具，请勿调用。",
            parameters: { type: "object", properties: {} },
          } }],
          provider: OPENROUTER_FREE_ROUTING,
          ...(model.reasoning ? { reasoning: { effort: "none" } } : {}),
        }),
      });
      if (!response.ok) { await response.body?.cancel(); return false; }
      const body = record(await readJsonResponse(response, 64 * 1024));
      if (body.error || !Array.isArray(body.choices) || body.choices.length === 0) return false;
      const choice = record(body.choices[0]);
      const message = record(choice.message);
      return choice.finish_reason === "stop" && typeof message.content === "string"
        && message.content.trim().length > 0 && !message.refusal
        && (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0);
    } catch {
      // Provider/network failures can echo secrets. Retain only the pass/fail result.
      return false;
    }
  }

  private closedStatus(): OpenRouterStatus {
    return { configured: false, group: OPENROUTER_FREE_GROUP, modelCount: 0, lastCheckedAt: null,
      lastSyncedAt: null, lastError: null, refreshIntervalHours: 6, candidateCount: 0, rejectedCount: 0 };
  }

  start(): void {
    if (this.timer || this.disposed) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, OPENROUTER_REFRESH_MS);
    this.timer.unref();
  }

  dispose(): void {
    this.disposed = true;
    this.revision++;
    this.credentialController.abort();
    this.controller?.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}
