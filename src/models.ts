import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { resolveChildEnv } from "./env-utils.js";
import { ClaudeModelAvailability, ClaudeModelInfo, ClaudeModelSource } from "./types.js";
import { extractSemver } from "./version-utils.js";

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
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Shared catalog IDs are later forwarded to `--model`. Qoder and Pi both use
// provider-qualified values (`zhipu/glm5.2-cp`, `xai/grok-4.6`); Pi also emits
// `@` in some Cloudflare-style ids.
const QODER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const PI_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}\/[A-Za-z0-9@][A-Za-z0-9._:@/-]{0,127}$/;

const CLAUDE_BUILTIN_MODELS: ClaudeModelInfo[] = [
  {
    id: "default",
    label: "跟随 Claude Code 默认",
    alias: true,
    source: "builtin",
    availability: "default",
    note: "不传 --model 参数",
  },
  { id: "opus", label: "opus（最新 Opus）", alias: true, source: "builtin", availability: "candidate" },
  { id: "sonnet", label: "sonnet（最新 Sonnet）", alias: true, source: "builtin", availability: "candidate" },
  { id: "haiku", label: "haiku（最新 Haiku）", alias: true, source: "builtin", availability: "candidate" },
];

const CODEX_FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "GPT-5.5 · gpt-5.5（Codex 默认）", alias: true },
];

const OPENCODE_FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "跟随 OpenCode 默认", alias: true },
];

const GROK_FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "跟随 Grok 默认", alias: true },
  { id: "grok-4.5", label: "grok-4.5" },
];

const QODER_FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "跟随 Qoder 默认", alias: true },
  { id: "lite", label: "Lite" },
  { id: "efficient", label: "Efficient" },
  { id: "auto", label: "Auto" },
  { id: "performance", label: "Performance" },
  { id: "ultimate", label: "Ultimate" },
];
const PI_FALLBACK_MODELS: ClaudeModelInfo[] = [
  { id: "default", label: "跟随 Pi 默认", alias: true },
];

interface ModelCacheStorage {
  getConfigValue(key: string): string | null;
  setConfigValue(key: string, value: string): void;
}

interface ModelCommandOptions {
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
  storage?: ModelCacheStorage;
  configuredClaudeModels?: readonly (string | null | undefined)[];
  inheritEnv?: boolean;
  env?: NodeJS.ProcessEnv;
  apiKey?: string;
  commandRunner?: ModelCommandRunner;
  modelsApi?: ClaudeModelsApi;
  verifyClaudeCandidates?: boolean;
  now?: () => Date;
}

export interface ThinkingEffortLevel {
  effort: string;
  description?: string;
}

/** 各 CLI 自己报出来的思考档位。Codex / 部分 OpenCode 模型另有 per-model 列表。 */
export interface ProviderThinkingEfforts {
  claude: ThinkingEffortLevel[];
  opencode: ThinkingEffortLevel[];
  grok: ThinkingEffortLevel[];
  qoder: ThinkingEffortLevel[];
  pi: ThinkingEffortLevel[];
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

const EFFORT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

function effortLevels(ids: readonly string[]): ThinkingEffortLevel[] {
  return ids.map((effort) => ({ effort }));
}

/** 探针失败时的已知档位。下一次 CLI 成功应答会把它换掉。 */
export const FALLBACK_PROVIDER_THINKING: ProviderThinkingEfforts = {
  claude: effortLevels(["low", "medium", "high", "xhigh", "max"]),
  opencode: effortLevels(["low", "medium", "high", "max"]),
  grok: effortLevels(["low", "medium", "high", "xhigh"]),
  qoder: effortLevels(["auto", "none", "low", "medium", "high", "xhigh", "max", "ultracode"]),
  pi: effortLevels(["minimal", "low", "medium", "high", "xhigh", "max"]),
};

function cloneThinkingEfforts(efforts: ProviderThinkingEfforts): ProviderThinkingEfforts {
  const copy = (levels: readonly ThinkingEffortLevel[]) => levels.map((level) => ({ ...level }));
  return {
    claude: copy(efforts.claude),
    opencode: copy(efforts.opencode),
    grok: copy(efforts.grok),
    qoder: copy(efforts.qoder),
    pi: copy(efforts.pi),
  };
}

/** Immutable-looking snapshot returned to API clients. */
export interface ModelCatalogSnapshot extends ModelCache {
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

interface CodexModelEntry {
  slug: string;
  display_name?: string;
  visibility?: string;
  priority?: number;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{
    effort?: string;
    description?: string;
  }>;
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

function cloneModels(models: readonly ClaudeModelInfo[]): ClaudeModelInfo[] {
  return models.map((model) => ({
    ...model,
    ...(model.reasoningEfforts
      ? { reasoningEfforts: model.reasoningEfforts.map((level) => ({ ...level })) }
      : {}),
  }));
}

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
    maxBuffer: 4 * 1024 * 1024,
    ...(options.input !== undefined ? { input: options.input } : {}),
  }).then(({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr) }));
}

function normalizeClaudeModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return MODEL_ID_PATTERN.test(id) ? id : null;
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
): Promise<ProbeResult<ClaudeModelInfo[]>> {
  const rpcText = await commandText(
    runner,
    "pi",
    ["--mode", "rpc", "--no-session"],
    env,
    12_000,
    `${JSON.stringify({ id: "wand-models", type: "get_available_models" })}\n`,
  );
  const fromRpc = parsePiRpcModels(rpcText);
  if (fromRpc.length > 1 || (fromRpc.length === 1 && fromRpc[0]?.id !== "default")) {
    return { ok: true, value: fromRpc };
  }
  try {
    const { stdout } = await runner("pi", ["--list-models"], { env, timeout: 8000 });
    const parsed = parsePiModels(stdout);
    return parsed.some((model) => model.id !== "default") ? { ok: true, value: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** 从 CLI 的 help / 非法档位报错里抽出 `low, medium, high` 这种列表。 */
export function parseCliEffortList(text: string): string[] {
  const patterns = [
    /valid values(?:\s+are)?\s*:\s*([^.`\n]+)/i,
    /use one of:\s*([^.`\n]+)/i,
    /set thinking level:\s*([^.`\n]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const ids = match[1]
      .split(/[,/]/)
      .map((part) => part.trim().toLowerCase())
      .filter((part) => EFFORT_ID_PATTERN.test(part));
    if (ids.length) return Array.from(new Set(ids));
  }
  return [];
}

function effortLevelsFromIds(ids: readonly string[]): ThinkingEffortLevel[] {
  return ids.map((effort) => ({ effort }));
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

function variantsToEfforts(value: unknown): ThinkingEffortLevel[] {
  const ids: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") ids.push(item);
      else if (isRecord(item) && typeof item.effort === "string") ids.push(item.effort);
    }
  } else if (isRecord(value)) {
    ids.push(...Object.keys(value));
  }
  const unique = Array.from(new Set(
    ids.map((id) => id.trim().toLowerCase()).filter((id) => EFFORT_ID_PATTERN.test(id)),
  ));
  return effortLevelsFromIds(unique);
}

/**
 * `opencode models --verbose` 是「一行 id + 一段 JSON」。
 * variants 是这个模型自己的推理档位；没有 JSON 时退回一行一个 id。
 */
export function parseOpenCodeModelCatalog(stdout: string): ClaudeModelInfo[] {
  const verbose = parseOpenCodeVerboseModels(stdout);
  if (verbose.length) return verbose;
  return parseOpenCodeModels(stdout);
}

function parseOpenCodeVerboseModels(stdout: string): ClaudeModelInfo[] {
  const lines = stdout.split(/\r?\n/);
  const found: ClaudeModelInfo[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]?.trim() ?? "";
    if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i.test(header)) continue;
    if ((lines[index + 1] ?? "").trim() !== "{") continue;
    let depth = 0;
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      for (const character of lines[end] ?? "") {
        if (character === "{") depth += 1;
        else if (character === "}") depth -= 1;
      }
      if (depth === 0) break;
    }
    if (depth !== 0) continue;
    let record: Record<string, unknown> | null = null;
    try {
      record = JSON.parse(lines.slice(index + 1, end + 1).join("\n")) as Record<string, unknown>;
    } catch {
      record = null;
    }
    const reasoningEfforts = record ? variantsToEfforts(record.variants) : [];
    found.push({
      id: header,
      label: header,
      ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
    });
    index = end;
  }
  if (!found.length) return [];
  return [
    { id: "default", label: "跟随 OpenCode 默认", alias: true },
    ...found,
  ];
}

function unionModelEfforts(models: readonly ClaudeModelInfo[]): ThinkingEffortLevel[] {
  const seen = new Set<string>();
  const levels: ThinkingEffortLevel[] = [];
  for (const model of models) {
    for (const level of model.reasoningEfforts ?? []) {
      const effort = level.effort.trim().toLowerCase();
      if (!EFFORT_ID_PATTERN.test(effort) || seen.has(effort)) continue;
      seen.add(effort);
      levels.push({ effort, ...(level.description ? { description: level.description } : {}) });
    }
  }
  return levels;
}

function createOfficialModelsApi(apiKey: string): ClaudeModelsApi {
  const client = new Anthropic({ apiKey });
  return {
    list: () => client.models.list({ limit: 100 }) as AsyncIterable<ClaudeModelsApiEntry>,
  };
}

async function listClaudeModelsFromApi(
  options: ModelRefreshOptions,
  env: NodeJS.ProcessEnv,
): Promise<ProbeResult<ClaudeModelsApiEntry[]>> {
  const apiKey = options.apiKey?.trim() || env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { ok: false };
  try {
    const api = options.modelsApi ?? createOfficialModelsApi(apiKey);
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

/**
 * Parse `grok models` human-readable output:
 *
 *   Default model: grok-4.5
 *   Available models:
 *     * grok-4.5 (default)
 */
export function parseGrokModels(stdout: string): ClaudeModelInfo[] {
  const stripAnsi = (line: string) => line.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
  const lines = stdout.split(/\r?\n/).map((line) => stripAnsi(line).trim()).filter(Boolean);
  let defaultModel = "";
  const ids: string[] = [];
  for (const line of lines) {
    const defaultMatch = line.match(/^Default model:\s*([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\s*$/i);
    if (defaultMatch) {
      defaultModel = defaultMatch[1];
      continue;
    }
    const bulletMatch = line.match(/^[-*•]+\s+([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\s*\(.*\))?\s*$/);
    if (bulletMatch) {
      ids.push(bulletMatch[1]);
      continue;
    }
    // Some builds may print plain model ids after the "Available models" header.
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(line) && !/^(available|default)\b/i.test(line)) {
      ids.push(line);
    }
  }
  const unique = Array.from(new Set(ids.filter((id) => id && id !== "default")));
  if (defaultModel && !unique.includes(defaultModel)) unique.unshift(defaultModel);
  if (!unique.length && !defaultModel) return cloneModels(GROK_FALLBACK_MODELS);
  const defaultLabel = defaultModel
    ? `${defaultModel}（Grok 默认）`
    : "跟随 Grok 默认";
  return [
    { id: "default", label: defaultLabel, alias: true },
    ...unique.map((id) => ({ id, label: id })),
  ];
}

/**
 * Parse `qodercli --list-models`.
 *
 * Qoder has used both provider-qualified custom IDs (`zhipu/glm5.2-cp`) and
 * plain tier/frontier IDs (`glm51`). The CLI's human-readable rows put the
 * selectable value in the final parentheses; some versions also emit a bare
 * safe ID below the `MODEL` header.
 */
export function parseQoderModels(stdout: string): ClaudeModelInfo[] {
  const discovered: ClaudeModelInfo[] = [];
  const seen = new Set(QODER_FALLBACK_MODELS.map((model) => model.id));
  let inModelList = false;
  const add = (id: string, label: string): void => {
    if (!QODER_MODEL_ID_PATTERN.test(id) || seen.has(id)) return;
    seen.add(id);
    discovered.push({ id, label: label || id });
  };
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").trim();
    if (/^models?\s*:?$/i.test(line)) {
      inModelList = true;
      continue;
    }
    const match = line.match(/^(.+?)\s+\(([^()]+)\)\s*$/);
    if (match) {
      const displayName = match[1].trim();
      const id = match[2].trim();
      if (displayName) add(id, displayName);
      continue;
    }
    if (inModelList && QODER_MODEL_ID_PATTERN.test(line)) add(line, line);
  }
  return [...cloneModels(QODER_FALLBACK_MODELS), ...discovered];
}

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Same rule as Pi's `getSupportedThinkingLevels`: no reasoning means only off;
 * `xhigh` / `max` exist only when `thinkingLevelMap` defines them; `null` drops a level.
 */
export function piThinkingLevelsForModel(model: {
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, unknown> | null;
}): string[] {
  if (!model.reasoning) return ["off"];
  const map = model.thinkingLevelMap ?? {};
  return PI_THINKING_LEVELS.filter((level) => {
    if (!Object.prototype.hasOwnProperty.call(map, level)) {
      return level !== "xhigh" && level !== "max";
    }
    return map[level] !== null;
  });
}

/** `pi --mode rpc` + `get_available_models`. One JSON response holds every model's thinking map. */
export function parsePiRpcModels(stdout: string): ClaudeModelInfo[] {
  let models: unknown[] | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let record: Record<string, unknown> | null = null;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      record = null;
    }
    if (!record || record.type !== "response" || record.command !== "get_available_models" || record.success !== true) {
      continue;
    }
    const data = isRecord(record.data) ? record.data : null;
    if (data && Array.isArray(data.models)) models = data.models;
  }
  if (!models) return [];
  const discovered: ClaudeModelInfo[] = [];
  const seen = new Set<string>();
  for (const entry of models) {
    if (!isRecord(entry)) continue;
    const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
    const modelId = typeof entry.id === "string" ? entry.id.trim() : "";
    const id = provider && modelId ? `${provider}/${modelId}` : "";
    if (!id || !PI_MODEL_ID_PATTERN.test(id) || id.length > 128 || seen.has(id)) continue;
    seen.add(id);
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id;
    const reasoningEfforts = effortLevelsFromIds(piThinkingLevelsForModel({
      reasoning: entry.reasoning === true,
      thinkingLevelMap: isRecord(entry.thinkingLevelMap) || entry.thinkingLevelMap === null
        ? entry.thinkingLevelMap as Record<string, unknown> | null
        : undefined,
    }));
    discovered.push({
      id,
      label: name === id ? id : `${name} · ${id}`,
      ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
    });
  }
  if (!discovered.length) return [];
  const union = unionModelEfforts(discovered);
  return [
    {
      id: "default",
      label: "跟随 Pi 默认",
      alias: true,
      ...(union.length ? { reasoningEfforts: union } : {}),
    },
    ...discovered,
  ];
}

/**
 * Parse `pi --list-models`.
 *
 * Pi prints a padEnd-aligned table whose selectable `--model` value is
 * `provider/id` (for example `xai/grok-4.6`). The table only says thinking
 * yes/no, so per-model levels come from `parsePiRpcModels` instead.
 */
export function parsePiModels(stdout: string): ClaudeModelInfo[] {
  const discovered: ClaudeModelInfo[] = [];
  const seen = new Set(["default"]);
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").trim();
    if (!line || /^provider\s+model\b/i.test(line)) continue;
    const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)/);
    if (!match || !/^\d/.test(match[3])) continue;
    const id = `${match[1]}/${match[2]}`;
    if (!PI_MODEL_ID_PATTERN.test(id) || id.length > 128 || seen.has(id)) continue;
    seen.add(id);
    discovered.push({ id, label: id });
  }
  if (!discovered.length) return cloneModels(PI_FALLBACK_MODELS);
  return [
    { id: "default", label: "跟随 Pi 默认", alias: true },
    ...discovered,
  ];
}

/** Parse `opencode models`, whose stable machine-friendly output is one provider/model id per line. */
export function parseOpenCodeModels(stdout: string): ClaudeModelInfo[] {
  const ids = Array.from(new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").trim())
      .filter((line) => /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i.test(line)),
  ));
  if (!ids.length) return cloneModels(OPENCODE_FALLBACK_MODELS);
  return [
    { id: "default", label: "跟随 OpenCode 默认", alias: true },
    ...ids.map((id) => ({ id, label: id })),
  ];
}

/** Parse the machine-readable model registry emitted by the installed Codex CLI. */
export function parseCodexModels(stdout: string): ClaudeModelInfo[] {
  try {
    const data = JSON.parse(stdout) as { models?: CodexModelEntry[] };
    const visible = (Array.isArray(data.models) ? data.models : [])
      .filter((model) => typeof model.slug === "string" && model.slug.length > 0)
      .filter((model) => model.visibility === "list")
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    if (!visible.length) return cloneModels(CODEX_FALLBACK_MODELS);
    const defaultModel = visible[0];
    const defaultLabel = formatCodexModelLabel(defaultModel);
    const result: ClaudeModelInfo[] = [
      {
        id: "default",
        label: `${defaultLabel}（Codex 默认）`,
        alias: true,
        ...codexReasoningMetadata(defaultModel),
      },
    ];
    for (const model of visible) {
      result.push({
        id: model.slug,
        label: formatCodexModelLabel(model),
        ...codexReasoningMetadata(model),
      });
    }
    return result;
  } catch {
    return cloneModels(CODEX_FALLBACK_MODELS);
  }
}

function codexReasoningMetadata(model: CodexModelEntry): Pick<ClaudeModelInfo, "reasoningEfforts" | "defaultReasoningEffort"> {
  const reasoningEfforts = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
    .filter((level) => typeof level?.effort === "string" && level.effort.length > 0)
    .map((level) => ({
      effort: level.effort as string,
      ...(typeof level.description === "string" && level.description ? { description: level.description } : {}),
    }));
  return {
    ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
    ...(typeof model.default_reasoning_level === "string" && model.default_reasoning_level
      ? { defaultReasoningEffort: model.default_reasoning_level }
      : {}),
  };
}

function formatCodexModelLabel(model: CodexModelEntry): string {
  return model.display_name && model.display_name !== model.slug
    ? `${model.display_name} · ${model.slug}`
    : model.slug;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
  const runner = options.commandRunner ?? defaultCommandRunner;
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
    probePiModels(runner, env),
    listClaudeModelsFromApi(options, env),
    probeEffortList(runner, env, "claude", ["--effort", "__wand_probe__", "--help"]),
    probeEffortList(runner, env, "grok", ["--effort", "__wand_probe__", "-p", "x", "--output-format", "streaming-json", "--max-turns", "1"]),
    probeEffortList(runner, env, "qodercli", ["-p", "x", "--reasoning-effort", "__wand_probe__"]),
    probeEffortList(runner, env, "pi", ["--help"]),
  ]);
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
  private cache: ModelCache;
  private revision: string;
  private hasPersistedSnapshot: boolean;
  private refreshPromise: Promise<ModelCatalogRefreshResult> | null = null;
  private inFlightIncludesVerification = false;
  private readonly changeListeners = new Set<(result: ModelCatalogRefreshResult) => void>();

  constructor(private readonly getOptions: () => ModelRefreshOptions) {
    const initialOptions = getOptions();
    const persisted = loadPersistedModelCatalog(initialOptions.storage);
    this.cache = persisted ? cloneCache(persisted.catalog) : createInitialCache(initialOptions);
    this.revision = persisted?.revision ?? catalogRevision(this.cache);
    this.hasPersistedSnapshot = persisted !== null;
  }

  snapshot(): ModelCatalogSnapshot {
    return { ...cloneCache(this.cache), revision: this.revision };
  }

  /** 目录内容真正变化时通知。客户端靠它刷新下拉，不用自己再跑一遍 CLI。 */
  onChanged(listener: (result: ModelCatalogRefreshResult) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  refresh(request: ModelCatalogRefreshRequest = {}): Promise<ModelCatalogRefreshResult> {
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
      verifyClaudeCandidates: request.verifyClaudeCandidates === true,
    };
    const checkedAt = (options.now?.() ?? new Date()).toISOString();
    const discovered = await discoverModelCache(options, this.cache);
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
