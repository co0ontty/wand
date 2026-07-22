import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { buildChildEnv } from "./env-utils.js";
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
// Qoder returns both tier/frontier IDs (for example `glm51`) and custom
// provider IDs (for example `zhipu/glm5.2-cp`). Keep this intentionally
// conservative because these values are later forwarded to `--model`.
const QODER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

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

export interface ModelCacheStorage {
  getConfigValue(key: string): string | null;
  setConfigValue(key: string, value: string): void;
}

export interface ModelCommandOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
}

export interface ModelCommandResult {
  stdout: string;
  stderr: string;
}

export type ModelCommandRunner = (
  file: string,
  args: string[],
  options: ModelCommandOptions,
) => Promise<ModelCommandResult>;

export interface ClaudeModelsApiEntry {
  id: string;
  display_name?: string;
}

export interface ClaudeModelsApi {
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

export interface ModelCache {
  models: ClaudeModelInfo[];
  codexModels: ClaudeModelInfo[];
  opencodeModels: ClaudeModelInfo[];
  grokModels: ClaudeModelInfo[];
  qoderModels: ClaudeModelInfo[];
  claudeVersion: string | null;
  opencodeVersion: string | null;
  refreshedAt: string;
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
    maxBuffer: 1024 * 1024,
  }).then(({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr) }));
}

function resolveProbeEnv(options: ModelRefreshOptions): NodeJS.ProcessEnv {
  return options.env ?? buildChildEnv(options.inheritEnv !== false);
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
    runner("opencode", ["models"], { env, timeout: 8000 }),
    runner("opencode", ["--version"], { env, timeout: 5000 }),
  ]);
  const models = modelsResult.status === "fulfilled"
    ? { ok: true as const, value: parseOpenCodeModels(modelsResult.value.stdout) }
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
    const bulletMatch = line.match(/^\*+\s*([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\s*\(.*\))?\s*$/);
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

function parsePersistedModelCatalog(value: unknown): PersistedModelCatalog | null {
  if (!isRecord(value) || value.version !== MODEL_CATALOG_CACHE_VERSION || !isRecord(value.catalog)) return null;
  const catalog = value.catalog;
  const models = parsePersistedModelList(catalog.models);
  const codexModels = parsePersistedModelList(catalog.codexModels);
  const opencodeModels = parsePersistedModelList(catalog.opencodeModels);
  const grokModels = parsePersistedModelList(catalog.grokModels);
  const qoderModels = parsePersistedModelList(catalog.qoderModels);
  const refreshedAt = safePersistedString(catalog.refreshedAt, 64);
  if (
    !models || !codexModels || !opencodeModels || !grokModels || !qoderModels
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
  const env = resolveProbeEnv(options);
  const runner = options.commandRunner ?? defaultCommandRunner;
  const [claudeVersionProbe, codexProbe, opencodeProbe, grokProbe, qoderProbe, apiProbe] = await Promise.all([
    probeClaudeVersion(runner, env),
    probeCodexModels(runner, env),
    probeOpenCode(runner, env),
    probeGrokModels(runner, env),
    probeQoderModels(runner, env),
    listClaudeModelsFromApi(options, env),
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
    return { ...this.snapshot(), changed, checkedAt };
  }
}

/**
 * Compatibility helper for callers that only need a synchronous fallback
 * catalog. It intentionally does not own or mutate process-global state.
 */
export function getCachedModels(options: ModelRefreshOptions = {}): ModelCache {
  const persisted = loadPersistedModelCatalog(options.storage);
  return cloneCache(persisted?.catalog ?? createInitialCache(options));
}

/**
 * Compatibility helper for direct callers and unit tests. Server code should
 * use `ModelCatalogService` so the result is persisted and diffed.
 */
export async function refreshModels(options: ModelRefreshOptions = {}): Promise<ModelCache> {
  return discoverModelCache(options, createInitialCache(options));
}
