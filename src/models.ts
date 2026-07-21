import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { buildChildEnv } from "./env-utils.js";
import { ClaudeModelAvailability, ClaudeModelInfo, ClaudeModelSource } from "./types.js";
import { extractSemver } from "./version-utils.js";

const execFileAsync = promisify(execFile);
const CLAUDE_VERIFICATION_CACHE_KEY = "claude-model-verifications-v1";
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

let cache: ModelCache | null = null;

function cloneModels(models: readonly ClaudeModelInfo[]): ClaudeModelInfo[] {
  return models.map((model) => ({ ...model }));
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

function refreshCachedClaudeModels(options: ModelRefreshOptions): void {
  if (!cache) return;
  const now = options.now?.() ?? new Date();
  cache.models = buildClaudeModels({
    configuredClaudeModels: options.configuredClaudeModels,
    existingModels: cache.models,
    verifications: loadClaudeVerifications(options.storage),
    claudeVersion: cache.claudeVersion,
    now,
  });
}

async function probeClaudeVersion(runner: ModelCommandRunner, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await runner("claude", ["--version"], { env, timeout: 5000 });
    return extractSemver(stdout) ?? (stdout.trim().slice(0, 64) || null);
  } catch {
    return null;
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

async function probeCodexModels(runner: ModelCommandRunner, env: NodeJS.ProcessEnv): Promise<ClaudeModelInfo[]> {
  try {
    const { stdout } = await runner("codex", ["debug", "models"], { env, timeout: 8000 });
    return parseCodexModels(stdout);
  } catch {
    return cloneModels(CODEX_FALLBACK_MODELS);
  }
}

async function probeOpenCode(
  runner: ModelCommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<{ models: ClaudeModelInfo[]; version: string | null }> {
  const [modelsResult, versionResult] = await Promise.allSettled([
    runner("opencode", ["models"], { env, timeout: 8000 }),
    runner("opencode", ["--version"], { env, timeout: 5000 }),
  ]);
  const models = modelsResult.status === "fulfilled"
    ? parseOpenCodeModels(modelsResult.value.stdout)
    : cloneModels(OPENCODE_FALLBACK_MODELS);
  const version = versionResult.status === "fulfilled"
    ? extractSemver(versionResult.value.stdout) ?? (versionResult.value.stdout.trim().slice(0, 64) || null)
    : null;
  return { models, version };
}

async function probeGrokModels(runner: ModelCommandRunner, env: NodeJS.ProcessEnv): Promise<ClaudeModelInfo[]> {
  try {
    const { stdout } = await runner("grok", ["models"], { env, timeout: 8000 });
    return parseGrokModels(stdout);
  } catch {
    return cloneModels(GROK_FALLBACK_MODELS);
  }
}

async function probeQoderModels(runner: ModelCommandRunner, env: NodeJS.ProcessEnv): Promise<ClaudeModelInfo[]> {
  try {
    const { stdout } = await runner("qodercli", ["--list-models"], { env, timeout: 8000 });
    return parseQoderModels(stdout);
  } catch {
    return cloneModels(QODER_FALLBACK_MODELS);
  }
}

function createOfficialModelsApi(apiKey: string): ClaudeModelsApi {
  const client = new Anthropic({ apiKey });
  return {
    list: () => client.models.list({ limit: 100 }) as AsyncIterable<ClaudeModelsApiEntry>,
  };
}

async function listClaudeModelsFromApi(options: ModelRefreshOptions, env: NodeJS.ProcessEnv): Promise<ClaudeModelsApiEntry[]> {
  const apiKey = options.apiKey?.trim() || env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return [];
  try {
    const api = options.modelsApi ?? createOfficialModelsApi(apiKey);
    const models: ClaudeModelsApiEntry[] = [];
    for await (const model of api.list()) {
      const id = normalizeClaudeModelId(model?.id);
      if (id) models.push({ id, ...(typeof model.display_name === "string" ? { display_name: model.display_name } : {}) });
    }
    return models;
  } catch {
    return [];
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

export function getCachedModels(options: ModelRefreshOptions = {}): ModelCache {
  if (!cache) {
    cache = createInitialCache(options);
  } else if (options.storage || options.configuredClaudeModels) {
    refreshCachedClaudeModels(options);
  }
  return cache;
}

export async function refreshModels(options: ModelRefreshOptions = {}): Promise<ModelCache> {
  const now = options.now?.() ?? new Date();
  const env = resolveProbeEnv(options);
  const runner = options.commandRunner ?? defaultCommandRunner;
  const [claudeVersion, codexModels, opencode, grokModels, qoderModels, apiModels] = await Promise.all([
    probeClaudeVersion(runner, env),
    probeCodexModels(runner, env),
    probeOpenCode(runner, env),
    probeGrokModels(runner, env),
    probeQoderModels(runner, env),
    listClaudeModelsFromApi(options, env),
  ]);
  const priorVerifications = loadClaudeVerifications(options.storage);
  const initialModels = buildClaudeModels({
    configuredClaudeModels: options.configuredClaudeModels,
    apiModels,
    verifications: priorVerifications,
    claudeVersion,
    now,
  });
  const verifiedIds = options.verifyClaudeCandidates
    ? await verifyClaudeCandidates(initialModels, runner, env)
    : new Set<string>();
  const verifications = mergeVerifications(priorVerifications, initialModels, verifiedIds, claudeVersion, now);
  if (verifiedIds.size > 0) saveClaudeVerifications(options.storage, verifications);
  cache = {
    models: buildClaudeModels({
      configuredClaudeModels: options.configuredClaudeModels,
      apiModels,
      verifications,
      claudeVersion,
      now,
    }),
    codexModels,
    opencodeModels: opencode.models,
    grokModels,
    qoderModels,
    claudeVersion,
    opencodeVersion: opencode.version,
    refreshedAt: now.toISOString(),
  };
  return cache;
}
