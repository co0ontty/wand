import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { resolveChildEnv } from "./env-utils.js";
import { discoverPiEndpointModels, type PiModelEndpointDiscoveryOptions } from "./pi-model-discovery.js";
import { ClaudeModelAvailability, ClaudeModelInfo, ClaudeModelSource } from "./types.js";
import { extractSemver } from "./version-utils.js";
import { AUTO_ASSIGN_LABEL, AUTO_ASSIGN_SELECTOR, FREE_MODEL_GROUP_ID, isAutoAssignSelector, isModelGroupSelector, modelGroupSelector, orderModelIds, type ModelGroup } from "./model-groups.js";
import { MODEL_ID_PATTERN, QODER_MODEL_ID_PATTERN, CLAUDE_BUILTIN_MODELS, CODEX_FALLBACK_MODELS, OPENCODE_FALLBACK_MODELS, GROK_FALLBACK_MODELS, QODER_FALLBACK_MODELS, PI_FALLBACK_MODELS, cloneModels, isRecord } from "./models/shared.js";
import { EFFORT_ID_PATTERN, ThinkingEffortLevel, ProviderThinkingEfforts, FALLBACK_PROVIDER_THINKING, cloneThinkingEfforts, effortLevelsFromIds, unionModelEfforts, parseCliEffortList } from "./models/thinking.js";
import { parseOpenCodeModelCatalog } from "./models/parsers/opencode.js";
import { parseGrokModels } from "./models/parsers/grok.js";
import { parseQoderModels } from "./models/parsers/qoder.js";
import { parsePiRpcModels, parsePiModels } from "./models/parsers/pi.js";
import { parseCodexModels } from "./models/parsers/codex.js";
export type { ThinkingEffortLevel, ProviderThinkingEfforts } from "./models/thinking.js";
export { FALLBACK_PROVIDER_THINKING, piThinkingLevelsForModel, parseCliEffortList } from "./models/thinking.js";
export { parseOpenCodeModelCatalog, parseOpenCodeModels } from "./models/parsers/opencode.js";
export { parseGrokModels } from "./models/parsers/grok.js";
export { parseQoderModels } from "./models/parsers/qoder.js";
export { parsePiRpcModels, parsePiModels } from "./models/parsers/pi.js";
export { parseCodexModels } from "./models/parsers/codex.js";
import { OPENROUTER_FREE_GROUP, OPENROUTER_FREE_SELECTOR } from "./openrouter-free-selection.js";

const execFileAsync = promisify(execFile);
const CLAUDE_VERIFICATION_CACHE_KEY = "claude-model-verifications-v1";
/**
 * The complete server-side model catalog. Keep this separate from the Claude
 * verification cache: the former is a client-facing snapshot for every
 * provider, whereas the latter records evidence from individual probes.
 */
export const MODEL_CATALOG_CACHE_KEY = "model-catalog-v1";
const MODEL_CATALOG_CACHE_VERSION = 1;
const CLAUDE_VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLAUDE_PROBE_TIMEOUT_MS = 15_000;
const MAX_CLAUDE_MODEL_PROBES = 12;
const CLAUDE_PROBE_CONCURRENCY = 3;

interface ModelCacheStorage {
  getConfigValue(key: string): string | null;
  setConfigValue(key: string, value: string): void;
}

interface ModelCommandOptions {
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
  timeout: number;
  /** Written to stdin, then closed. Pi RPC needs this. */
  input?: string;
}

interface ModelCommandResult {
  stdout: string;
  stderr: string;
}

export type ModelCommandRunner = (
  file: string,
  args: string[],
  options: ModelCommandOptions,
) => Promise<ModelCommandResult>;

interface ClaudeModelsApiEntry {
  id: string;
  display_name?: string;
}

interface ClaudeModelsApi {
  list(): AsyncIterable<ClaudeModelsApiEntry>;
}

export interface ModelRefreshOptions {
  signal?: AbortSignal;
  storage?: ModelCacheStorage;
  configuredClaudeModels?: readonly (string | null | undefined)[];
  inheritEnv?: boolean;
  env?: NodeJS.ProcessEnv;
  apiKey?: string;
  baseUrl?: string;
  commandRunner?: ModelCommandRunner;
  modelsApi?: ClaudeModelsApi;
  verifyClaudeCandidates?: boolean;
  piEndpointDiscovery?: PiModelEndpointDiscoveryOptions & { enabled: boolean };
  managedPiModels?: () => readonly ClaudeModelInfo[];
  managedPiModelMembers?: () => ClaudeModelInfo[];
  modelGroups?: () => readonly ModelGroup[];
  now?: () => Date;
}

export interface ModelCache {
  models: ClaudeModelInfo[];
  codexModels: ClaudeModelInfo[];
  opencodeModels: ClaudeModelInfo[];
  grokModels: ClaudeModelInfo[];
  qoderModels: ClaudeModelInfo[];
  piModels: ClaudeModelInfo[];
  thinkingEfforts: ProviderThinkingEfforts;
  claudeVersion: string | null;
  opencodeVersion: string | null;
  refreshedAt: string;
}

/** Immutable-looking snapshot returned to API clients. */
/** provider → 目录里的模型列表字段（与 `/api/models` 的 payload 同源）。 */
const PROVIDER_MODEL_LIST_FIELDS = {
  claude: "models",
  codex: "codexModels",
  opencode: "opencodeModels",
  grok: "grokModels",
  qoder: "qoderModels",
  pi: "piModels",
} as const;

/**
 * 目录里 `default` 项（「不传 --model」那一项）的标签补上服务端配置的默认模型名：
 * CLI 自己报的文案（「跟随 Claude Code 默认」）看不出真正会跑哪个模型，两端选择器只能显示占位。
 * 没配置、列表里没有这一项、或标签里已经写了这个 id 时原样返回（引用不变，便于上游比对缓存）。
 */
export function withConfiguredDefaultModelLabels<T extends object>(
  catalog: T,
  defaults: Readonly<Record<string, string>>,
): T {
  let next: Record<string, unknown> | null = null;
  for (const [provider, field] of Object.entries(PROVIDER_MODEL_LIST_FIELDS)) {
    const list = (catalog as Record<string, unknown>)[field];
    const configured = (defaults[provider] ?? "").trim();
    if (!configured || !Array.isArray(list)) continue;
    const at = list.findIndex((entry) => (
      !!entry && typeof entry === "object" && (entry as { id?: unknown }).id === "default"
    ));
    if (at < 0) continue;
    const entry = list[at] as { label?: unknown };
    const selected = list.find((item) => item?.id === configured);
    const name = isModelGroupSelector(configured) || configured === OPENROUTER_FREE_SELECTOR
      ? selected?.label || "模型分组"
      : isAutoAssignSelector(configured) ? selected?.label || AUTO_ASSIGN_LABEL : configured;
    if (String(entry.label ?? "").includes(name)) continue;
    const updated = [...list];
    updated[at] = { ...(entry as object), label: `跟随服务端默认（${name}）` };
    next ??= { ...(catalog as Record<string, unknown>) };
    next[field] = updated;
  }
  return (next ?? catalog) as T;
}

export interface ModelCatalogSnapshot extends ModelCache {
  modelGroups?: ModelGroup[];
  /** Verified concrete free members, used only when editing the pool order. */
  freeModels?: ClaudeModelInfo[];
  /** SHA-256 of the catalog excluding `refreshedAt`. Changes only with content. */
  revision: string;
}

export interface ModelCatalogRefreshResult extends ModelCatalogSnapshot {
  /** True only when the persisted catalog content changed (or was first saved). */
  changed: boolean;
  /** Time this server-side refresh check ran; it is deliberately not persisted. */
  checkedAt: string;
}

export interface ModelCatalogRefreshRequest {
  /** Administrator-triggered refreshes may also validate Claude candidates. */
  verifyClaudeCandidates?: boolean;
}

interface PersistedClaudeVerification {
  id: string;
  label?: string;
  verifiedAt: string;
  claudeVersion: string | null;
}

interface PersistedClaudeVerificationCache {
  version: 1;
  models: PersistedClaudeVerification[];
}

interface ClaudeCandidate {
  id: string;
  label: string;
  alias?: boolean;
  source: ClaudeModelSource;
}

interface PersistedModelCatalog {
  version: typeof MODEL_CATALOG_CACHE_VERSION;
  revision: string;
  catalog: ModelCache;
}

type ProbeResult<T> =
  | { ok: true; value: T }
  | { ok: false };

function cloneCache(cache: ModelCache): ModelCache {
  return {
    models: cloneModels(cache.models),
    codexModels: cloneModels(cache.codexModels),
    opencodeModels: cloneModels(cache.opencodeModels),
    grokModels: cloneModels(cache.grokModels),
    qoderModels: cloneModels(cache.qoderModels),
    piModels: cloneModels(cache.piModels),
    thinkingEfforts: cloneThinkingEfforts(cache.thinkingEfforts),
    claudeVersion: cache.claudeVersion,
    opencodeVersion: cache.opencodeVersion,
    refreshedAt: cache.refreshedAt,
  };
}

function defaultCommandRunner(
  file: string,
  args: string[],
  options: ModelCommandOptions,
): Promise<ModelCommandResult> {
  return execFileAsync(file, args, {
    env: options.env,
    timeout: options.timeout,
    signal: options.signal,
    maxBuffer: 4 * 1024 * 1024,
    ...(options.input !== undefined ? { input: options.input } : {}),
  }).then(({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr) }));
}

function normalizeClaudeModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return MODEL_ID_PATTERN.test(id) && !isModelGroupSelector(id) ? id : null;
}

function formatClaudeModelLabel(id: string, displayName?: string): string {
  const name = displayName?.trim();
  return name && name !== id ? `${name} · ${id}` : id;
}

function sourcePriority(source: ClaudeModelSource): number {
  switch (source) {
    case "configured": return 4;
    case "verified-cache": return 3;
    case "models-api": return 2;
    case "builtin": return 1;
  }
}

function loadClaudeVerifications(storage?: ModelCacheStorage): PersistedClaudeVerification[] {
  if (!storage) return [];
  const raw = storage.getConfigValue(CLAUDE_VERIFICATION_CACHE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedClaudeVerificationCache>;
    if (parsed.version !== 1 || !Array.isArray(parsed.models)) return [];
    const seen = new Set<string>();
    const models: PersistedClaudeVerification[] = [];
    for (const entry of parsed.models) {
      const id = normalizeClaudeModelId(entry?.id);
      if (!id || seen.has(id) || typeof entry?.verifiedAt !== "string" || Number.isNaN(Date.parse(entry.verifiedAt))) {
        continue;
      }
      seen.add(id);
      models.push({
        id,
        ...(typeof entry.label === "string" && entry.label.trim() ? { label: entry.label.trim() } : {}),
        verifiedAt: entry.verifiedAt,
        claudeVersion: typeof entry.claudeVersion === "string" && entry.claudeVersion.trim()
          ? entry.claudeVersion.trim()
          : null,
      });
    }
    return models;
  } catch {
    return [];
  }
}

function saveClaudeVerifications(storage: ModelCacheStorage | undefined, models: PersistedClaudeVerification[]): void {
  if (!storage) return;
  const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
  storage.setConfigValue(CLAUDE_VERIFICATION_CACHE_KEY, JSON.stringify({ version: 1, models: sorted }));
}

function verificationAvailability(
  verification: PersistedClaudeVerification | undefined,
  claudeVersion: string | null,
  now: Date,
): ClaudeModelAvailability {
  if (!verification) return "candidate";
  const isFresh = now.getTime() - Date.parse(verification.verifiedAt) <= CLAUDE_VERIFICATION_TTL_MS;
  const versionMatches = !claudeVersion || !verification.claudeVersion || claudeVersion === verification.claudeVersion;
  return isFresh && versionMatches ? "verified" : "stale";
}

function candidateNote(
  candidate: ClaudeCandidate,
  availability: ClaudeModelAvailability,
  verification: PersistedClaudeVerification | undefined,
): string | undefined {
  if (availability === "verified") return "已由 Claude Code 验证";
  if (availability === "stale" && verification) return `上次由 Claude Code 验证：${verification.verifiedAt}`;
  if (candidate.source === "models-api") return "API 目录候选，尚未验证 Claude Code 可用性";
  if (candidate.source === "configured") return "已配置，尚未验证 Claude Code 可用性";
  return "尚未验证 Claude Code 可用性";
}

function candidateFromModel(model: ClaudeModelInfo): ClaudeCandidate | null {
  const id = normalizeClaudeModelId(model.id);
  if (!id || id === "default") return null;
  const source = model.source === "configured" || model.source === "verified-cache" || model.source === "models-api"
    ? model.source
    : "builtin";
  return { id, label: model.label || id, alias: model.alias, source };
}

function buildClaudeModels(options: {
  configuredClaudeModels?: readonly (string | null | undefined)[];
  existingModels?: readonly ClaudeModelInfo[];
  apiModels?: readonly ClaudeModelsApiEntry[];
  verifications: readonly PersistedClaudeVerification[];
  claudeVersion: string | null;
  now: Date;
}): ClaudeModelInfo[] {
  const candidates = new Map<string, ClaudeCandidate>();
  const add = (candidate: ClaudeCandidate): void => {
    const id = normalizeClaudeModelId(candidate.id);
    if (!id || id === "default") return;
    const normalized = { ...candidate, id, label: candidate.label || id };
    const existing = candidates.get(id);
    if (!existing || sourcePriority(normalized.source) >= sourcePriority(existing.source)) {
      candidates.set(id, normalized);
    }
  };

  for (const model of CLAUDE_BUILTIN_MODELS) {
    const candidate = candidateFromModel(model);
    if (candidate) add(candidate);
  }
  for (const model of options.existingModels ?? []) {
    const candidate = candidateFromModel(model);
    if (candidate) add(candidate);
  }
  for (const model of options.apiModels ?? []) {
    const id = normalizeClaudeModelId(model.id);
    if (id) add({ id, label: formatClaudeModelLabel(id, model.display_name), source: "models-api" });
  }
  for (const verification of options.verifications) {
    add({ id: verification.id, label: verification.label || verification.id, source: "verified-cache" });
  }
  for (const value of options.configuredClaudeModels ?? []) {
    const id = normalizeClaudeModelId(value);
    if (id && id !== "default") add({ id, label: id, source: "configured" });
  }

  const verificationById = new Map(options.verifications.map((entry) => [entry.id, entry]));
  const models: ClaudeModelInfo[] = [cloneModels(CLAUDE_BUILTIN_MODELS)[0]!];
  for (const candidate of candidates.values()) {
    const verification = verificationById.get(candidate.id);
    const availability = verificationAvailability(verification, options.claudeVersion, options.now);
    models.push({
      id: candidate.id,
      label: candidate.label,
      ...(candidate.alias ? { alias: true } : {}),
      source: candidate.source,
      availability,
      ...(verification ? {
        lastVerifiedAt: verification.verifiedAt,
        ...(verification.claudeVersion ? { verifiedWithClaudeVersion: verification.claudeVersion } : {}),
      } : {}),
      ...(candidateNote(candidate, availability, verification) ? { note: candidateNote(candidate, availability, verification) } : {}),
    });
  }
  return models;
}

function createInitialCache(options: ModelRefreshOptions): ModelCache {
  const now = options.now?.() ?? new Date();
  return {
    models: buildClaudeModels({
      configuredClaudeModels: options.configuredClaudeModels,
      verifications: loadClaudeVerifications(options.storage),
      claudeVersion: null,
      now,
    }),
    codexModels: cloneModels(CODEX_FALLBACK_MODELS),
    opencodeModels: cloneModels(OPENCODE_FALLBACK_MODELS),
    grokModels: cloneModels(GROK_FALLBACK_MODELS),
    qoderModels: cloneModels(QODER_FALLBACK_MODELS),
    piModels: cloneModels(PI_FALLBACK_MODELS),
    thinkingEfforts: cloneThinkingEfforts(FALLBACK_PROVIDER_THINKING),
    claudeVersion: null,
    opencodeVersion: null,
    refreshedAt: now.toISOString(),
  };
}

async function probeClaudeVersion(runner: ModelCommandRunner, env: NodeJS.ProcessEnv): Promise<ProbeResult<string | null>> {
  try {
    const { stdout } = await runner("claude", ["--version"], { env, timeout: 5000 });
    return { ok: true, value: extractSemver(stdout) ?? (stdout.trim().slice(0, 64) || null) };
  } catch {
    return { ok: false };
  }
}

async function probeClaudeModel(
  id: string,
  runner: ModelCommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await runner("claude", ["--model", id, "-p", "Reply with exactly: ok"], {
      env,
      timeout: CLAUDE_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

async function probeCodexModels(
  runner: ModelCommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<ProbeResult<ClaudeModelInfo[]>> {
  try {
    const { stdout } = await runner("codex", ["debug", "models"], { env, timeout: 8000 });
    return { ok: true, value: parseCodexModels(stdout) };
  } catch {
    return { ok: false };
  }
}

async function probeOpenCode(
  runner: ModelCommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<{ models: ProbeResult<ClaudeModelInfo[]>; version: ProbeResult<string | null> }> {
  const [modelsResult, versionResult] = await Promise.allSettled([
    runner("opencode", ["models", "--verbose"], { env, timeout: 8000 }),
    runner("opencode", ["--version"], { env, timeout: 5000 }),
  ]);
  const models = modelsResult.status === "fulfilled"
    ? { ok: true as const, value: parseOpenCodeModelCatalog(modelsResult.value.stdout) }
    : { ok: false as const };
  const version = versionResult.status === "fulfilled"
    ? {
      ok: true as const,
      value: extractSemver(versionResult.value.stdout) ?? (versionResult.value.stdout.trim().slice(0, 64) || null),
    }
    : { ok: false as const };
  return { models, version };
}

async function probeGrokModels(
  runner: ModelCommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<ProbeResult<ClaudeModelInfo[]>> {
  try {
    const { stdout } = await runner("grok", ["models"], { env, timeout: 8000 });
    return { ok: true, value: parseGrokModels(stdout) };
  } catch {
    return { ok: false };
  }
}

async function probeQoderModels(
  runner: ModelCommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<ProbeResult<ClaudeModelInfo[]>> {
  try {
    const { stdout } = await runner("qodercli", ["--list-models"], { env, timeout: 8000 });
    return { ok: true, value: parseQoderModels(stdout) };
  } catch {
    return { ok: false };
  }
}

async function probePiModels(
  runner: ModelCommandRunner,
  env: NodeJS.ProcessEnv,
  options: ModelRefreshOptions,
): Promise<ProbeResult<ClaudeModelInfo[]>> {
  const agentDir = options.piEndpointDiscovery?.agentDir;
  if (agentDir) env = { ...env, PI_CODING_AGENT_DIR: agentDir };
  const rpcText = await commandText(
    runner,
    "pi",
    ["--mode", "rpc", "--no-session"],
    env,
    12_000,
    `${JSON.stringify({ id: "wand-models", type: "get_available_models" })}\n`,
  );
  const fromRpc = parsePiRpcModels(rpcText);
  let configuredModels = fromRpc.length > 1 || (fromRpc.length === 1 && fromRpc[0]?.id !== "default")
    ? fromRpc
    : [];
  if (!configuredModels.length) {
    try {
      const { stdout } = await runner("pi", ["--list-models"], { env, timeout: 8000 });
      const parsed = parsePiModels(stdout);
      if (parsed.some((model) => model.id !== "default")) configuredModels = parsed;
    } catch {
      // The remote endpoint catalog can still be useful when the Pi CLI is temporarily unavailable.
    }
  }
  const endpointModels = options.piEndpointDiscovery?.enabled
    ? await discoverPiEndpointModels({
      agentDir: options.piEndpointDiscovery.agentDir,
      env,
      fetchImpl: options.piEndpointDiscovery.fetchImpl,
    })
    : [];
  if (!configuredModels.length && !endpointModels.length) return { ok: false };
  return { ok: true, value: mergePiModelCatalog(configuredModels, endpointModels) };
}

function mergePiModelCatalog(
  configuredModels: readonly ClaudeModelInfo[],
  endpointModels: readonly ClaudeModelInfo[],
): ClaudeModelInfo[] {
  const defaultModel = configuredModels.find((model) => model.id === "default")
    ?? cloneModels(PI_FALLBACK_MODELS)[0]!;
  const models = new Map<string, ClaudeModelInfo>();
  for (const model of configuredModels) {
    if (model.id !== "default") models.set(model.id, model);
  }
  for (const model of endpointModels) {
    if (model.id !== "default" && !models.has(model.id)) models.set(model.id, model);
  }
  return [defaultModel, ...models.values()];
}

async function commandText(
  runner: ModelCommandRunner,
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
  input?: string,
): Promise<string> {
  try {
    const result = await runner(file, args, { env, timeout, ...(input !== undefined ? { input } : {}) });
    return `${result.stderr}\n${result.stdout}`;
  } catch (error) {
    const record = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return `${String(record.stderr ?? "")}\n${String(record.stdout ?? "")}\n${String(record.message ?? "")}`;
  }
}

async function probeEffortList(
  runner: ModelCommandRunner,
  env: NodeJS.ProcessEnv,
  file: string,
  args: string[],
): Promise<ProbeResult<ThinkingEffortLevel[]>> {
  const text = await commandText(runner, file, args, env, 8000);
  const ids = parseCliEffortList(text);
  return ids.length ? { ok: true, value: effortLevelsFromIds(ids) } : { ok: false };
}

function createOfficialModelsApi(apiKey: string, baseURL?: string): ClaudeModelsApi {
  const client = new Anthropic({ apiKey, baseURL: baseURL || undefined });
  return {
    list: () => client.models.list({ limit: 100 }) as AsyncIterable<ClaudeModelsApiEntry>,
  };
}

function resolveClaudeAuth(
  options: ModelRefreshOptions,
  env: NodeJS.ProcessEnv,
): { apiKey?: string; baseURL?: string } {
  let apiKey = options.apiKey?.trim() || env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim();
  let baseURL = options.baseUrl?.trim() || env.ANTHROPIC_BASE_URL?.trim();
  if (!apiKey) {
    try {
      const settingsPath = path.join(homedir(), ".claude", "settings.json");
      if (existsSync(settingsPath)) {
        const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
        const token = raw?.env?.ANTHROPIC_AUTH_TOKEN || raw?.env?.ANTHROPIC_API_KEY;
        if (typeof token === "string" && token.trim()) {
          apiKey = token.trim();
        }
        const base = raw?.env?.ANTHROPIC_BASE_URL;
        if (typeof base === "string" && base.trim() && !baseURL) {
          baseURL = base.trim();
        }
      }
    } catch {
      // ignore
    }
  }
  return { apiKey, baseURL };
}

async function listClaudeModelsFromApi(
  options: ModelRefreshOptions,
  env: NodeJS.ProcessEnv,
): Promise<ProbeResult<ClaudeModelsApiEntry[]>> {
  const { apiKey, baseURL } = resolveClaudeAuth(options, env);
  if (!apiKey) return { ok: false };
  try {
    const api = options.modelsApi ?? createOfficialModelsApi(apiKey, baseURL);
    const models: ClaudeModelsApiEntry[] = [];
    for await (const model of api.list()) {
      const id = normalizeClaudeModelId(model?.id);
      if (id) models.push({ id, ...(typeof model.display_name === "string" ? { display_name: model.display_name } : {}) });
    }
    return { ok: true, value: models };
  } catch {
    return { ok: false };
  }
}

function probePriority(model: ClaudeModelInfo): number {
  if (model.source === "configured") return 0;
  if (model.availability === "stale") return 1;
  if (model.source === "verified-cache") return 2;
  if (model.source === "builtin") return 3;
  return 4;
}

async function verifyClaudeCandidates(
  models: readonly ClaudeModelInfo[],
  runner: ModelCommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<Set<string>> {
  const candidates = models
    .filter((model) => model.id !== "default" && model.availability !== "verified")
    .sort((a, b) => probePriority(a) - probePriority(b) || a.id.localeCompare(b.id))
    .slice(0, MAX_CLAUDE_MODEL_PROBES);
  const verified = new Set<string>();
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < candidates.length) {
      const candidate = candidates[nextIndex++];
      if (candidate && await probeClaudeModel(candidate.id, runner, env)) {
        verified.add(candidate.id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CLAUDE_PROBE_CONCURRENCY, candidates.length) }, worker));
  return verified;
}

function mergeVerifications(
  previous: readonly PersistedClaudeVerification[],
  models: readonly ClaudeModelInfo[],
  verifiedIds: ReadonlySet<string>,
  claudeVersion: string | null,
  now: Date,
): PersistedClaudeVerification[] {
  const byId = new Map(previous.map((entry) => [entry.id, entry]));
  for (const id of verifiedIds) {
    const model = models.find((entry) => entry.id === id);
    byId.set(id, {
      id,
      ...(model?.label ? { label: model.label } : {}),
      verifiedAt: now.toISOString(),
      claudeVersion,
    });
  }
  return [...byId.values()];
}

function catalogRevision(cache: ModelCache): string {
  // `refreshedAt` answers "when did content last change", so it must not
  // create a false change by itself. JSON keeps the provider/model order that
  // the CLIs publish; that order is part of the client-facing catalog.
  const content = JSON.stringify({
    models: cache.models,
    codexModels: cache.codexModels,
    opencodeModels: cache.opencodeModels,
    grokModels: cache.grokModels,
    qoderModels: cache.qoderModels,
    piModels: cache.piModels,
    thinkingEfforts: cache.thinkingEfforts,
    claudeVersion: cache.claudeVersion,
    opencodeVersion: cache.opencodeVersion,
  });
  return createHash("sha256").update(content).digest("hex");
}

function safePersistedString(value: unknown, maxLength = 512): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function parsePersistedModelInfo(value: unknown): ClaudeModelInfo | null {
  if (!isRecord(value)) return null;
  const id = safePersistedString(value.id, 128);
  const label = safePersistedString(value.label);
  if (!id || !QODER_MODEL_ID_PATTERN.test(id) || !label) return null;
  const source = value.source === "builtin" || value.source === "configured"
    || value.source === "verified-cache" || value.source === "models-api"
    ? value.source
    : undefined;
  const availability = value.availability === "default" || value.availability === "candidate"
    || value.availability === "verified" || value.availability === "stale"
    ? value.availability
    : undefined;
  const reasoningEfforts = Array.isArray(value.reasoningEfforts)
    ? value.reasoningEfforts.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const effort = safePersistedString(entry.effort, 128);
      if (!effort) return [];
      const description = safePersistedString(entry.description);
      return [{ effort, ...(description ? { description } : {}) }];
    })
    : undefined;
  const note = safePersistedString(value.note);
  const lastVerifiedAt = safePersistedString(value.lastVerifiedAt, 64);
  const verifiedWithClaudeVersion = safePersistedString(value.verifiedWithClaudeVersion, 128);
  const defaultReasoningEffort = safePersistedString(value.defaultReasoningEffort, 128);
  return {
    id,
    label,
    ...(typeof value.alias === "boolean" ? { alias: value.alias } : {}),
    ...(typeof value.group === "string" ? { group: value.group.slice(0, 80) } : {}),
    ...(source ? { source } : {}),
    ...(availability ? { availability } : {}),
    ...(note ? { note } : {}),
    ...(lastVerifiedAt && !Number.isNaN(Date.parse(lastVerifiedAt)) ? { lastVerifiedAt } : {}),
    ...(verifiedWithClaudeVersion ? { verifiedWithClaudeVersion } : {}),
    ...(reasoningEfforts?.length ? { reasoningEfforts } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
  };
}

function parsePersistedModelList(value: unknown): ClaudeModelInfo[] | null {
  if (!Array.isArray(value)) return null;
  const result: ClaudeModelInfo[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const model = parsePersistedModelInfo(entry);
    if (!model || seen.has(model.id)) return null;
    seen.add(model.id);
    result.push(model);
  }
  return result;
}

function parsePersistedThinkingEfforts(value: unknown): ProviderThinkingEfforts {
  const fallback = cloneThinkingEfforts(FALLBACK_PROVIDER_THINKING);
  if (!isRecord(value)) return fallback;
  const providers = ["claude", "opencode", "grok", "qoder", "pi"] as const;
  for (const provider of providers) {
    const levels = parsePersistedEffortLevels(value[provider]);
    if (levels) fallback[provider] = levels;
  }
  return fallback;
}

function parsePersistedEffortLevels(value: unknown): ThinkingEffortLevel[] | null {
  if (!Array.isArray(value)) return null;
  const levels: ThinkingEffortLevel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const effort = safePersistedString(entry.effort, 32)?.toLowerCase() ?? "";
    if (!EFFORT_ID_PATTERN.test(effort) || seen.has(effort)) return null;
    seen.add(effort);
    const description = safePersistedString(entry.description);
    levels.push({ effort, ...(description ? { description } : {}) });
  }
  return levels.length ? levels : null;
}

function parsePersistedModelCatalog(value: unknown): PersistedModelCatalog | null {
  if (!isRecord(value) || value.version !== MODEL_CATALOG_CACHE_VERSION || !isRecord(value.catalog)) return null;
  const catalog = value.catalog;
  const models = parsePersistedModelList(catalog.models);
  const codexModels = parsePersistedModelList(catalog.codexModels);
  const opencodeModels = parsePersistedModelList(catalog.opencodeModels);
  const grokModels = parsePersistedModelList(catalog.grokModels);
  const qoderModels = parsePersistedModelList(catalog.qoderModels);
  const piModels = parsePersistedModelList(catalog.piModels);
  const refreshedAt = safePersistedString(catalog.refreshedAt, 64);
  if (
    !models || !codexModels || !opencodeModels || !grokModels || !qoderModels || !piModels
    || !refreshedAt || Number.isNaN(Date.parse(refreshedAt))
  ) {
    return null;
  }
  const nullableVersion = (field: unknown): string | null | undefined =>
    field === null ? null : safePersistedString(field, 128) ?? undefined;
  const claudeVersion = nullableVersion(catalog.claudeVersion);
  const opencodeVersion = nullableVersion(catalog.opencodeVersion);
  if (claudeVersion === undefined || opencodeVersion === undefined) return null;
  const parsedCatalog: ModelCache = {
    models,
    codexModels,
    opencodeModels,
    grokModels,
    qoderModels,
    piModels,
    thinkingEfforts: parsePersistedThinkingEfforts(catalog.thinkingEfforts),
    claudeVersion,
    opencodeVersion,
    refreshedAt,
  };
  // A stale/missing revision should not make a previously good snapshot
  // unreadable. It is recomputed instead of trusted.
  return {
    version: MODEL_CATALOG_CACHE_VERSION,
    revision: catalogRevision(parsedCatalog),
    catalog: parsedCatalog,
  };
}

function loadPersistedModelCatalog(storage: ModelCacheStorage | undefined): PersistedModelCatalog | null {
  if (!storage) return null;
  const raw = storage.getConfigValue(MODEL_CATALOG_CACHE_KEY);
  if (!raw) return null;
  try {
    return parsePersistedModelCatalog(JSON.parse(raw));
  } catch {
    return null;
  }
}

function savePersistedModelCatalog(
  storage: ModelCacheStorage | undefined,
  cache: ModelCache,
  revision: string,
): void {
  if (!storage) return;
  const persisted: PersistedModelCatalog = {
    version: MODEL_CATALOG_CACHE_VERSION,
    revision,
    catalog: cloneCache(cache),
  };
  storage.setConfigValue(MODEL_CATALOG_CACHE_KEY, JSON.stringify(persisted));
}

async function discoverModelCache(
  options: ModelRefreshOptions,
  previous: ModelCache,
): Promise<ModelCache> {
  const now = options.now?.() ?? new Date();
  const env = resolveChildEnv(options);
  const execute = options.commandRunner ?? defaultCommandRunner;
  const runner: ModelCommandRunner = (file, args, commandOptions) => {
    options.signal?.throwIfAborted();
    return execute(file, args, { ...commandOptions, signal: options.signal });
  };
  const [
    claudeVersionProbe,
    codexProbe,
    opencodeProbe,
    grokProbe,
    qoderProbe,
    piProbe,
    apiProbe,
    claudeEffortProbe,
    grokEffortProbe,
    qoderEffortProbe,
    piEffortProbe,
  ] = await Promise.all([
    probeClaudeVersion(runner, env),
    probeCodexModels(runner, env),
    probeOpenCode(runner, env),
    probeGrokModels(runner, env),
    probeQoderModels(runner, env),
    probePiModels(runner, env, options),
    listClaudeModelsFromApi(options, env),
    probeEffortList(runner, env, "claude", ["--effort", "__wand_probe__", "--help"]),
    probeEffortList(runner, env, "grok", ["--effort", "__wand_probe__", "-p", "x", "--output-format", "streaming-json", "--max-turns", "1"]),
    probeEffortList(runner, env, "qodercli", ["-p", "x", "--reasoning-effort", "__wand_probe__"]),
    probeEffortList(runner, env, "pi", ["--help"]),
  ]);
  options.signal?.throwIfAborted();
  const claudeVersion = claudeVersionProbe.ok ? claudeVersionProbe.value : previous.claudeVersion;
  const priorVerifications = loadClaudeVerifications(options.storage);
  // A failed Models API request is not evidence that its prior models vanished.
  // Keep the last good candidate set until a successful catalog request says
  // otherwise; configured and verification-backed candidates are merged below.
  const initialModels = buildClaudeModels({
    configuredClaudeModels: options.configuredClaudeModels,
    ...(apiProbe.ok ? { apiModels: apiProbe.value } : { existingModels: previous.models }),
    verifications: priorVerifications,
    claudeVersion,
    now,
  });
  const verifiedIds = options.verifyClaudeCandidates
    ? await verifyClaudeCandidates(initialModels, runner, env)
    : new Set<string>();
  options.signal?.throwIfAborted();
  const verifications = mergeVerifications(priorVerifications, initialModels, verifiedIds, claudeVersion, now);
  if (verifiedIds.size > 0) saveClaudeVerifications(options.storage, verifications);
  return {
    models: buildClaudeModels({
      configuredClaudeModels: options.configuredClaudeModels,
      ...(apiProbe.ok ? { apiModels: apiProbe.value } : { existingModels: previous.models }),
      verifications,
      claudeVersion,
      now,
    }),
    codexModels: codexProbe.ok ? codexProbe.value : cloneModels(previous.codexModels),
    opencodeModels: opencodeProbe.models.ok ? opencodeProbe.models.value : cloneModels(previous.opencodeModels),
    grokModels: grokProbe.ok ? grokProbe.value : cloneModels(previous.grokModels),
    qoderModels: qoderProbe.ok ? qoderProbe.value : cloneModels(previous.qoderModels),
    piModels: piProbe.ok ? piProbe.value : cloneModels(previous.piModels),
    thinkingEfforts: {
      claude: claudeEffortProbe.ok ? claudeEffortProbe.value : cloneThinkingEfforts(previous.thinkingEfforts).claude,
      opencode: opencodeProbe.models.ok && unionModelEfforts(opencodeProbe.models.value).length
        ? unionModelEfforts(opencodeProbe.models.value)
        : cloneThinkingEfforts(previous.thinkingEfforts).opencode,
      grok: grokEffortProbe.ok ? grokEffortProbe.value : cloneThinkingEfforts(previous.thinkingEfforts).grok,
      qoder: qoderEffortProbe.ok ? qoderEffortProbe.value : cloneThinkingEfforts(previous.thinkingEfforts).qoder,
      pi: piProbe.ok && unionModelEfforts(piProbe.value).length
        ? unionModelEfforts(piProbe.value)
        : piEffortProbe.ok
          ? piEffortProbe.value
          : cloneThinkingEfforts(previous.thinkingEfforts).pi,
    },
    claudeVersion,
    opencodeVersion: opencodeProbe.version.ok ? opencodeProbe.version.value : previous.opencodeVersion,
    refreshedAt: now.toISOString(),
  };
}

/**
 * Server-owned, persisted model directory.
 *
 * It deliberately has a tiny surface: clients read `snapshot`; only server
 * jobs and an administrator route may call `refresh`. Each service instance
 * owns its cache and single-flight lock, so test servers and multiple hosts in
 * the same Node process cannot leak a catalog into one another.
 */
export class ModelCatalogService {
  private readonly lifecycle = new AbortController();

  dispose(): void {
    this.lifecycle.abort(new Error("ModelCatalogService has been disposed."));
    this.changeListeners.clear();
  }

  private cache: ModelCache;
  private revision: string;
  private publishedRevision: string;
  private hasPersistedSnapshot: boolean;
  private refreshPromise: Promise<ModelCatalogRefreshResult> | null = null;
  private inFlightIncludesVerification = false;
  private readonly changeListeners = new Set<(result: ModelCatalogRefreshResult) => void>();

  constructor(private readonly getOptions: () => ModelRefreshOptions) {
    const initialOptions = getOptions();
    const persisted = loadPersistedModelCatalog(initialOptions.storage);
    this.cache = persisted ? cloneCache(persisted.catalog) : createInitialCache(initialOptions);
    this.cache.piModels = this.withManagedPiModels(this.cache.piModels);
    this.revision = catalogRevision(this.cache);
    this.hasPersistedSnapshot = persisted !== null;
    this.publishedRevision = this.snapshot().revision;
  }

  private withManagedPiModels(models: ClaudeModelInfo[]): ClaudeModelInfo[] {
    const managed = this.getOptions().managedPiModels;
    if (!managed) return models;
    const entries = managed();
    const ids = new Set(entries.map((model) => model.id));
    return [...models.filter((model) => !model.id.startsWith("wand-openrouter-free/") && !ids.has(model.id)), ...entries];
  }

  publishManagedPiModels(): void {
    if (this.lifecycle.signal.aborted) return;
    const next = { ...this.cache, piModels: this.withManagedPiModels(this.cache.piModels) };
    const revision = catalogRevision(next);
    const projectionChanged = this.snapshot().revision !== this.publishedRevision;
    if (revision === this.revision && !projectionChanged) return;
    next.refreshedAt = new Date().toISOString();
    this.cache = next;
    this.revision = revision;
    savePersistedModelCatalog(this.getOptions().storage, this.cache, revision);
    const result = { ...this.snapshot(), changed: true, checkedAt: next.refreshedAt };
    this.publishedRevision = result.revision;
    for (const listener of this.changeListeners) {
      try { listener(result); } catch { /* notification must not prevent publication */ }
    }
  }

  snapshot(): ModelCatalogSnapshot {
    const options = this.getOptions();
    const configured = options.modelGroups?.() ?? [];
    const catalog = cloneCache(this.cache);
    // Virtual group identities are never concrete models or CLI verification targets.
    for (const field of Object.values(PROVIDER_MODEL_LIST_FIELDS)) {
      catalog[field] = catalog[field].filter((model) => !isModelGroupSelector(model.id));
    }
    const freeModels = options.managedPiModelMembers?.() ?? [];
    const groups = structuredClone(configured.filter((group) => group.id !== FREE_MODEL_GROUP_ID));
    if (options.managedPiModelMembers) {
      const saved = configured.find((group) => group.id === FREE_MODEL_GROUP_ID && group.provider === "pi");
      groups.push({ id: FREE_MODEL_GROUP_ID, provider: "pi", name: OPENROUTER_FREE_GROUP,
        models: orderModelIds(freeModels.map((model) => model.id), saved?.models ?? []) });
    }
    for (const group of groups) {
      if (group.id === FREE_MODEL_GROUP_ID) continue; // Already published by OpenRouter as a single pool option.
      const list = catalog[PROVIDER_MODEL_LIST_FIELDS[group.provider]];
      const members = group.provider === "pi" ? [...list, ...freeModels] : list;
      const memberInfo = group.models.map((id) => members.find((model) => model.id === id));
      const efforts = memberInfo.every((model) => model?.reasoningEfforts?.length)
        ? memberInfo[0]!.reasoningEfforts!.filter((level) => memberInfo.every((model) =>
          model!.reasoningEfforts!.some((item) => item.effort === level.effort))) : [];
      list.push({ id: modelGroupSelector(group), label: group.name, group: "模型分组",
        ...(efforts.length ? { reasoningEfforts: structuredClone(efforts) } : {}) });
    }
    const projection = { ...catalog, ...(groups.length ? { modelGroups: groups } : {}),
      ...(options.managedPiModelMembers ? { freeModels } : {}) };
    for (const field of Object.values(PROVIDER_MODEL_LIST_FIELDS)) {
      const list = projection[field];
      if (!list.some((model) => model.id === AUTO_ASSIGN_SELECTOR)) {
        const entry = { id: AUTO_ASSIGN_SELECTOR, label: AUTO_ASSIGN_LABEL, alias: false,
          source: "builtin" as ClaudeModelSource, availability: "default" as ClaudeModelAvailability,
          note: "按第一条提示词在本工具的模型分组里自动选一个" };
        // 默认项排在最前；智能分配紧跟其后，其余具体模型与分组保持原顺序。
        if (list[0]?.id === "default") list.splice(1, 0, entry); else list.unshift(entry);
      }
    }
    return { ...projection, revision: groups.length
      ? createHash("sha256").update(`${this.revision}:${JSON.stringify(groups)}:${JSON.stringify(freeModels)}`).digest("hex") : this.revision };
  }

  /** Preference changes publish immediately without re-running CLI discovery or altering stored history. */
  publishModelGroups(): void {
    if (this.lifecycle.signal.aborted) return;
    const result = { ...this.snapshot(), changed: true, checkedAt: new Date().toISOString() };
    this.publishedRevision = result.revision;
    for (const listener of this.changeListeners) {
      try { listener(result); } catch { /* notification must not prevent saving */ }
    }
  }

  /** 目录内容真正变化时通知。客户端靠它刷新下拉，不用自己再跑一遍 CLI。 */
  onChanged(listener: (result: ModelCatalogRefreshResult) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  refresh(request: ModelCatalogRefreshRequest = {}): Promise<ModelCatalogRefreshResult> {
    if (this.lifecycle.signal.aborted) return Promise.reject(this.lifecycle.signal.reason);
    const verifyClaudeCandidates = request.verifyClaudeCandidates === true;
    if (this.refreshPromise) {
      const sharedRefresh = this.refreshPromise;
      const sharedIncludesVerification = this.inFlightIncludesVerification;
      return sharedRefresh.then((result) =>
        verifyClaudeCandidates && !sharedIncludesVerification
          ? this.refresh({ verifyClaudeCandidates: true })
          : result,
      );
    }

    this.inFlightIncludesVerification = verifyClaudeCandidates;
    const refresh = this.performRefresh({ verifyClaudeCandidates });
    this.refreshPromise = refresh;
    return refresh.finally(() => {
      if (this.refreshPromise === refresh) {
        this.refreshPromise = null;
        this.inFlightIncludesVerification = false;
      }
    });
  }

  private async performRefresh(request: ModelCatalogRefreshRequest): Promise<ModelCatalogRefreshResult> {
    const baseOptions = this.getOptions();
    const options: ModelRefreshOptions = {
      ...baseOptions,
      signal: baseOptions.signal ? AbortSignal.any([baseOptions.signal, this.lifecycle.signal]) : this.lifecycle.signal,
      verifyClaudeCandidates: request.verifyClaudeCandidates === true,
    };
    const checkedAt = (options.now?.() ?? new Date()).toISOString();
    const discovered = await discoverModelCache(options, this.cache);
    options.signal?.throwIfAborted();
    discovered.piModels = this.withManagedPiModels(discovered.piModels);
    const discoveredRevision = catalogRevision(discovered);
    const changed = !this.hasPersistedSnapshot || discoveredRevision !== this.revision;
    if (changed) {
      // The timestamp is only advanced with a meaningful catalog revision.
      discovered.refreshedAt = checkedAt;
      this.cache = cloneCache(discovered);
      this.revision = catalogRevision(this.cache);
      savePersistedModelCatalog(options.storage, this.cache, this.revision);
      this.hasPersistedSnapshot = Boolean(options.storage);
    }
    const result = { ...this.snapshot(), changed, checkedAt };
    this.publishedRevision = result.revision;
    if (changed) {
      for (const listener of this.changeListeners) {
        try { listener(result); } catch { /* 通知失败不影响目录本身 */ }
      }
    }
    return result;
  }
}

/**
 * Compatibility helper for direct callers and unit tests. Server code should
 * use `ModelCatalogService` so the result is persisted and diffed.
 */
export async function refreshModels(options: ModelRefreshOptions = {}): Promise<ModelCache> {
  return discoverModelCache(options, createInitialCache(options));
}
