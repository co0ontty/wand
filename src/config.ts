import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { AndroidApkConfig, CardExpandDefaults, ExecutionMode, HarnessConfig, HarnessEngine, IosIpaConfig, MacosDmgConfig, RenderConfig, RenderEngine, SessionProvider, StructuredChatPersonaConfig, WandConfig } from "./types.js";
import type { WandStorage } from "./storage.js";
import { isRunningAsRoot } from "./env-utils.js";
import { isSessionProvider, SESSION_PROVIDERS } from "./session-provider.js";
import { isThinkingEffort } from "./structured-provider-common.js";
import { normalizeModelGroups } from "./model-groups.js";
import { normalizeUserProfile, parseUserProfile } from "./user-profile.js";
import { defaultTaskRetention, normalizeTaskRetention, parseTaskRetention } from "./task-retention.js";
import { parseLocalDecisionConfig } from "./decision-types.js";

const DEFAULT_CONFIG_DIR = ".wand";
const DEFAULT_CONFIG_FILE = "config.json";

/**
 * 通过 UI 设置面板可改的"用户偏好"字段。这些字段从 SQLite app_config 表读取，
 * 不再写入 ~/.wand/config.json。JSON 只保留服务部署/启动期参数（host/port/shell 等）。
 *
 * 升级路径：老 JSON 里仍存有这些字段时，首次启动会被搬到 DB（见 migrateLegacyPreferencesToDb），
 * 然后下一次 saveConfig 写回 JSON 时它们会被剥离（见 stripPreferenceFields）。
 */
export type PreferenceKey =
  | "defaultProvider"
  | "defaultSessionKind"
  | "defaultEngine"
  | "defaultTaskWorktree"
  | "defaultMode"
  | "defaultCwd"
  | "defaultModel"
  | "defaultCodexModel"
  | "defaultOpenCodeModel"
  | "defaultGrokModel"
  | "defaultQoderModel"
  | "defaultPiModel"
  | "defaultGeminiModel"
  | "modelGroups"
  | "commitCli"
  | "commitModel"
  | "systemAiCli"
  | "systemAiModel"
  | "defaultThinkingEffort"
  | "language"
  | "cardDefaults"
  | "inheritEnv"
  | "taskRetention"
  | "userProfile"
  | "localDecision";


/**
 * 每个 provider 的默认模型偏好字段。新增 provider 时只改这一处：
 * 偏好读写、环境归一、默认模型投影都从这张表派生。
 */
export const PROVIDER_MODEL_PREFERENCE_FIELDS = {
  claude: "defaultModel",
  codex: "defaultCodexModel",
  opencode: "defaultOpenCodeModel",
  grok: "defaultGrokModel",
  qoder: "defaultQoderModel",
  pi: "defaultPiModel",
  gemini: "defaultGeminiModel",
} as const satisfies Record<SessionProvider, keyof WandConfig>;

export type ProviderModelField = (typeof PROVIDER_MODEL_PREFERENCE_FIELDS)[SessionProvider];

const PROVIDER_MODEL_FIELDS: readonly ProviderModelField[] = Object.values(PROVIDER_MODEL_PREFERENCE_FIELDS);


function preferenceStorageKey(key: PreferenceKey): string {
  return `pref:${key}`;
}

export function isPreferenceKey(key: string): key is PreferenceKey {
  return (PREFERENCE_KEYS as readonly string[]).includes(key);
}

/**
 * The user's login shell from passwd, then $SHELL, then a platform default.
 * Launchd / systemd usually omit $SHELL, so falling back to /bin/bash made PTY
 * sessions look like a generic sh even when the account default is zsh.
 */
export function resolveDefaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "cmd.exe";
  }
  try {
    const loginShell = os.userInfo().shell?.trim();
    if (loginShell) return loginShell;
  } catch {
    // userInfo() throws when the process has no passwd entry.
  }
  const envShell = process.env.SHELL?.trim();
  if (envShell) return envShell;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

export const defaultConfig = (): WandConfig => ({
  host: "127.0.0.1",
  port: 8443,
  https: false,
  password: "change-me",
  shell: resolveDefaultShell(),
  startupCommands: [],
  allowedCommandPrefixes: [],
  shortcutLogMaxBytes: 10 * 1024 * 1024,
  android: defaultAndroidApkConfig(),
  macos: defaultMacosDmgConfig(),
  ios: defaultIosIpaConfig(),
  render: defaultRenderConfig(),
  harness: defaultHarnessConfig(),
  structured: { processHost: "legacy" },
  // User preferences (SQLite-owned): defaults come from PREFERENCE_SPECS.
  ...preferenceDefaults(),
  commandPresets: [
    {
      label: "Claude",
      command: "claude",
      mode: "default"
    },
    {
      label: "Claude Full Access",
      command: "claude",
      mode: "full-access"
    },
    {
      label: "Cursor Agent",
      command: "cursor-agent",
      mode: "default"
    },
    {
      label: "Claude Native",
      command: "claude",
      mode: "native"
    },
    {
      label: "Claude Managed",
      command: "claude",
      mode: "managed"
    }
  ]
});

export function resolveConfigPath(inputPath?: string): string {
  if (inputPath) {
    return path.resolve(process.cwd(), inputPath);
  }

  return path.resolve(process.env.HOME || process.cwd(), DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILE);
}

export function resolveConfigDir(configPath: string): string {
  return path.dirname(configPath);
}

export function hasConfigFile(configPath: string): boolean {
  return existsSync(configPath);
}

/**
 * 原子写入：先写 `<dir>/.<file>.tmp-<rand>`，再 rename 覆盖目标。
 * 防止 kill -9 / 断电 / 磁盘满导致 config.json 半截损坏 → 下次启动 catch 路径
 * 把 defaults 写回去 → appSecret 重生成 → 已分发的 APK appToken 全部作废。
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.tmp-${crypto.randomBytes(6).toString("hex")}`);
  await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(tmpPath, filePath);
    // rename preserves the temporary file mode, but chmod also repairs an
    // existing config created by older versions or a permissive umask.
    await chmod(filePath, 0o600);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* noop */ }
    throw err;
  }
}

/** saveConfig 写出时去掉偏好字段——这些已经移到 SQLite。 */
export async function saveConfig(configPath: string, config: WandConfig): Promise<void> {
  const dir = path.dirname(configPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await atomicWriteFile(configPath, `${JSON.stringify(stripPreferenceFields(config), null, 2)}\n`);
}

/**
 * 启动期合并 JSON + DB 偏好。语义：
 *   1. 读 raw JSON
 *   2. 把 JSON 中残留的偏好字段搬到 DB（只在 DB 没值时迁移）
 *   3. mergeWithDefaults(raw) 得到 baseline
 *   4. applyStoragePreferences 用 DB 覆盖 baseline 的偏好字段
 *   5. 如果 JSON 里仍含偏好字段（来自 1），用 saveConfig 重写一次 JSON（剥离后）
 */
export async function loadConfigWithStorage(configPath: string, storage: WandStorage): Promise<WandConfig> {
  const dir = path.dirname(configPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  let rawInput: Partial<WandConfig> = {};
  let hadFile = false;
  try {
    const raw = await readFile(configPath, "utf8");
    rawInput = JSON.parse(raw) as Partial<WandConfig>;
    hadFile = true;
  } catch {
    // 文件缺失 或 JSON 损坏：保留空 rawInput；reconcileAppSecret 会优先用 DB 里那份，
    // 避免已分发 APK 被踢下线。
    rawInput = {};
  }

  migrateLegacyPreferencesToDb(rawInput, storage);
  migrateLegacyPasswordToDb(rawInput, storage);

  const config = mergeWithDefaults(rawInput);
  applyStoragePreferences(config, storage);

  // appSecret: DB 是权威源。
  // - DB 有 → 直接覆盖 runtime config（即使 mergeWithDefaults 临时生成了新的，也以 DB 为准）
  // - DB 无、config 有 → 老用户首次升级，把 config.json 里的 appSecret 落到 DB
  // - 都没 → 用 config 当前那个（mergeWithDefaults 已经生成），落到 DB
  reconcileAppSecret(config, storage);

  // password: DB 优先映射到 runtime config，让 config:show 与 server.ts 都看到真值
  applyStoragePassword(config, storage);

  bootstrapBuiltinEmployees(config, storage);

  // 如果 JSON 里有偏好字段（说明是老版本配置或刚迁移），重写一次干净版本
  const hasLegacyPrefs = PREFERENCE_KEYS.some((key) => key in rawInput);
  const hasLegacySecrets = "password" in rawInput || "appSecret" in rawInput;
  if (!hadFile || hasLegacyPrefs || hasLegacySecrets) {
    await saveConfig(configPath, config);
  }
  return config;
}

/**
 * Idempotent seeding of built-in employees (system ops, default partner, decision
 * expert, speech polisher, HR). Runs once per process start from loadConfigWithStorage;
 * never rewrites user-maintained candidates.
 */
export function bootstrapBuiltinEmployees(config: WandConfig, storage: WandStorage): void {
  // 内置「系统运维」员工负责 commit message / 标题 / 提示词优化；招聘由 HR 负责。
  // 这里只做幂等补齐——首次按用户已有的系统 AI 工具与默认
  // provider 建首条候选，之后候选由用户在员工设置里维护，不再回写 config。
  storage.ensureSystemSiliconEmployee({
    cli: config.systemAiCli,
    model: config.systemAiModel,
    provider: config.defaultProvider,
  });
  // 默认任务伙伴独立于系统运维；重启保留短期偏好与用户维护的候选。
  storage.ensureDefaultSiliconEmployee(config.defaultProvider);
  storage.ensureDecisionExpertEmployee();
  storage.ensureSpeechPolisherEmployee();
  storage.ensureHrEmployee(storage.getSystemSiliconEmployee()?.agents);
}

/**
 * 把 DB 里的 appSecret 同步到 runtime config，缺失时反向回填，保证 DB 永远有备份。
 * 这条路径修掉了之前的 bug：mergeWithDefaults 在缺失 appSecret 时会随机生成一个新的，
 * 一旦 config.json 因为任何原因丢字段（损坏/手动编辑/catch fallback），所有 APK appToken 立刻作废。
 */
function reconcileAppSecret(config: WandConfig, storage: WandStorage): void {
  const dbSecret = storage.getAppSecret();
  if (dbSecret && dbSecret.length >= 32) {
    config.appSecret = dbSecret;
    return;
  }
  if (config.appSecret && config.appSecret.length >= 32) {
    storage.setAppSecret(config.appSecret);
    return;
  }
  const fresh = crypto.randomBytes(32).toString("hex");
  config.appSecret = fresh;
  storage.setAppSecret(fresh);
}

/** 把 DB 里设置过的 password 映射到 runtime config 字段，让 config:show 不再展示 "change-me" 假象。 */
function applyStoragePassword(config: WandConfig, storage: WandStorage): void {
  const dbPassword = storage.getPassword();
  if (dbPassword !== null) {
    config.password = dbPassword;
  }
}

/**
 * 老用户如果曾经手动编辑 config.json 设过非默认密码，但从没用 Web UI 改过密码
 * （DB 里没有 password 行），那个 JSON 字段就是当前生效密码。升级到 DB 权威源之前
 * 必须把它搬到 DB，否则后续如果 saveConfig 路径剥离 password 字段或 JSON 被截断，
 * 用户会被锁在门外。DB 已经有 password 行的情况下不覆盖。
 */
function migrateLegacyPasswordToDb(rawInput: Partial<WandConfig>, storage: WandStorage): void {
  if (storage.hasCustomPassword()) return;
  const legacy = rawInput.password;
  if (typeof legacy === "string" && legacy.length >= 6 && legacy !== "change-me") {
    storage.setPassword(legacy);
  }
}

/** Build a JSON-safe view of WandConfig that excludes preference fields (which live in DB). */
function stripPreferenceFields(config: WandConfig): Partial<WandConfig> {
  const out: Partial<WandConfig> = { ...config };
  for (const key of PREFERENCE_KEYS) {
    delete (out as Record<string, unknown>)[key];
  }
  // These values are DB-owned runtime secrets. They must never be copied back
  // into config.json when a deployment setting is updated.
  delete out.password;
  delete out.appSecret;
  return out;
}

/**
 * 老版本 JSON 里如果还存有偏好字段，且 DB 里对应 key 没有写过，
 * 把 JSON 的值搬到 DB。注意：必须在 mergeWithDefaults 之前操作 raw input，
 * 这样能区分"用户显式写过 X" 和 "X 是 mergeWithDefaults 注入的默认值"。
 */
function migrateLegacyPreferencesToDb(rawJsonInput: Partial<WandConfig> | null | undefined, storage: WandStorage): void {
  if (!rawJsonInput || typeof rawJsonInput !== "object") return;
  for (const key of PREFERENCE_KEYS) {
    if (!(key in rawJsonInput)) continue;
    const value = (rawJsonInput as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const dbKey = preferenceStorageKey(key);
    if (storage.hasPreference(dbKey)) continue;
    storage.setPreference(dbKey, value);
  }
}

/**
 * Declarative user-preference table. One record drives: the key list, the
 * defaults in defaultConfig(), the tolerant read on load (applyStoragePreferences),
 * the strict write from the CLI/UI (writePreferenceToStorage) and the runtime value.
 * The record is typed over PreferenceKey, so adding a key without a spec fails to compile.
 *
 * - read: tolerant. Returns null to keep the current value (legacy/invalid rows are ignored).
 * - write: strict. Throws on invalid input; returns what to persist (`stored`, null deletes)
 *   and what the live config should hold (`runtime`).
 * - hot: applied to the live config without restart (every preference today).
 */
export interface PreferenceSpec<T> {
  readonly storageKey: string;
  /** Value when unset or unreadable; undefined means "no value" and is not written into defaultConfig. */
  readonly default: () => T | undefined;
  readonly read: (raw: unknown) => { value: T } | null;
  readonly write: (value: unknown) => { stored: unknown; runtime: T | undefined };
  readonly hot: true;
}

type PreferenceSpecMap = { readonly [K in PreferenceKey]: PreferenceSpec<WandConfig[K]> };

function trimmedStringSpec(key: TrimmedStringPreferenceKey, fallback: () => string): PreferenceSpec<string> {
  return {
    storageKey: preferenceStorageKey(key),
    default: fallback,
    read: (raw) => (typeof raw === "string" ? { value: raw.trim() } : null),
    write: (value) => {
      const trimmed = typeof value === "string" ? value.trim() : "";
      return { stored: trimmed, runtime: trimmed };
    },
    hot: true,
  };
}

function enumSpec<T extends string | boolean>(
  key: PreferenceKey,
  options: {
    fallback: () => NoInfer<T> | undefined;
    accepts: (value: unknown) => value is T;
    rejectMessage: (value: unknown) => string;
  },
): PreferenceSpec<T> {
  return {
    storageKey: preferenceStorageKey(key),
    default: options.fallback,
    read: (raw) => (options.accepts(raw) ? { value: raw } : null),
    write: (value) => {
      if (!options.accepts(value)) throw new Error(options.rejectMessage(value));
      return { stored: value, runtime: value };
    },
    hot: true,
  };
}

const TRIMMED_STRING_PREFERENCE_KEYS = [
  "defaultModel", "defaultCodexModel", "defaultOpenCodeModel", "defaultGrokModel", "defaultQoderModel",
  "defaultPiModel", "defaultGeminiModel", "commitModel", "systemAiModel", "language",
] as const;
export type TrimmedStringPreferenceKey = (typeof TRIMMED_STRING_PREFERENCE_KEYS)[number];

function isOneOf<T extends string>(options: readonly T[]): (value: unknown) => value is T {
  return (value: unknown): value is T => typeof value === "string" && (options as readonly string[]).includes(value);
}
const isSessionKind = isOneOf(["pty", "structured"] as const);
const isEngine = isOneOf(["cli", "sdk"] as const);
const isCommitCli = isOneOf(["claude", "codex", "opencode"] as const);

const PREFERENCE_SPECS: PreferenceSpecMap = {
  defaultProvider: enumSpec<NonNullable<WandConfig["defaultProvider"]>>("defaultProvider", {
    fallback: () => "claude",
    accepts: isSessionProvider,
    rejectMessage: (value) => `无效 Provider: ${String(value)}`,
  }),
  defaultSessionKind: enumSpec<NonNullable<WandConfig["defaultSessionKind"]>>("defaultSessionKind", {
    fallback: () => "structured",
    accepts: isSessionKind,
    rejectMessage: (value) => `无效会话类型: ${String(value)}`,
  }),
  // 新建会话默认走 CLI；只有用户在新建面板显式选过 Wand Agent 才会改成 sdk。
  defaultEngine: enumSpec<NonNullable<WandConfig["defaultEngine"]>>("defaultEngine", {
    fallback: () => "cli",
    accepts: isEngine,
    rejectMessage: (value) => `无效执行引擎: ${String(value)}`,
  }),
  defaultTaskWorktree: enumSpec<NonNullable<WandConfig["defaultTaskWorktree"]>>("defaultTaskWorktree", {
    fallback: () => true,
    accepts: (value): value is boolean => typeof value === "boolean",
    rejectMessage: () => "defaultTaskWorktree 必须是布尔值。",
  }),
  // 非 root 启动时抬到「托管」，root 回落到「default」（见 defaultMode 注释，显式选择始终优先）。
  defaultMode: {
    storageKey: preferenceStorageKey("defaultMode"),
    default: () => (isRunningAsRoot() ? "default" : "managed"),
    read: (raw) => (isExecutionMode(raw) ? { value: raw } : null),
    write: (value) => {
      if (!isExecutionMode(value)) throw new Error(`无效执行模式: ${String(value)}`);
      return { stored: value, runtime: value };
    },
    hot: true,
  },
  defaultCwd: {
    storageKey: preferenceStorageKey("defaultCwd"),
    default: () => process.cwd(),
    read: (raw) => (typeof raw === "string" && raw.trim() ? { value: raw } : null),
    write: (value) => {
      const v = typeof value === "string" ? value : "";
      return { stored: v, runtime: v || defaultConfig().defaultCwd };
    },
    hot: true,
  },
  defaultModel: trimmedStringSpec("defaultModel", () => ""),
  defaultCodexModel: trimmedStringSpec("defaultCodexModel", () => ""),
  defaultOpenCodeModel: trimmedStringSpec("defaultOpenCodeModel", () => ""),
  defaultGrokModel: trimmedStringSpec("defaultGrokModel", () => ""),
  defaultQoderModel: trimmedStringSpec("defaultQoderModel", () => ""),
  defaultPiModel: trimmedStringSpec("defaultPiModel", () => ""),
  defaultGeminiModel: trimmedStringSpec("defaultGeminiModel", () => ""),
  modelGroups: {
    storageKey: preferenceStorageKey("modelGroups"),
    default: () => [],
    read: (raw) => ({ value: normalizeModelGroups(raw) }),
    write: (value) => {
      const groups = normalizeModelGroups(value);
      return { stored: groups, runtime: groups };
    },
    hot: true,
  },
  commitCli: enumSpec<NonNullable<WandConfig["commitCli"]>>("commitCli", {
    fallback: () => "claude",
    accepts: isCommitCli,
    rejectMessage: (value) => `无效 commit CLI: ${String(value)}`,
  }),
  commitModel: trimmedStringSpec("commitModel", () => ""),
  systemAiCli: enumSpec<NonNullable<WandConfig["systemAiCli"]>>("systemAiCli", {
    // No default in defaultConfig: the system employee seeds it on first run.
    fallback: () => undefined,
    accepts: isSessionProvider,
    rejectMessage: (value) => `无效系统 AI CLI: ${String(value)}`,
  }),
  systemAiModel: trimmedStringSpec("systemAiModel", () => ""),
  defaultThinkingEffort: enumSpec<NonNullable<WandConfig["defaultThinkingEffort"]>>("defaultThinkingEffort", {
    fallback: () => "off",
    accepts: isThinkingEffort,
    rejectMessage: (value) => `无效思考深度: ${String(value)}`,
  }),
  language: trimmedStringSpec("language", () => ""),
  cardDefaults: {
    storageKey: preferenceStorageKey("cardDefaults"),
    default: () => defaultCardExpandDefaults(),
    read: (raw) => ({ value: normalizeCardDefaults(raw) }),
    write: (value) => {
      const normalized = normalizeCardDefaults(value);
      return { stored: normalized, runtime: normalized };
    },
    hot: true,
  },
  inheritEnv: {
    storageKey: preferenceStorageKey("inheritEnv"),
    default: () => true,
    // Legacy read tolerance: anything other than an explicit false means inherit.
    read: (raw) => ({ value: raw !== false }),
    write: (value) => {
      if (typeof value !== "boolean") throw new Error(`inheritEnv 必须是布尔值: ${String(value)}`);
      return { stored: value, runtime: value };
    },
    hot: true,
  },
  taskRetention: {
    storageKey: preferenceStorageKey("taskRetention"),
    default: () => defaultTaskRetention(),
    read: (raw) => ({ value: normalizeTaskRetention(raw) }),
    write: (value) => {
      const retention = parseTaskRetention(value);
      return { stored: retention, runtime: retention };
    },
    hot: true,
  },
  userProfile: {
    storageKey: preferenceStorageKey("userProfile"),
    default: () => undefined,
    read: (raw) => ({ value: normalizeUserProfile(raw) }),
    write: (value) => {
      const profile = parseUserProfile(value);
      // null deletes the stored row, so clearing the profile leaves no value behind.
      return { stored: profile ?? null, runtime: profile };
    },
    hot: true,
  },
  localDecision: {
    storageKey: preferenceStorageKey("localDecision"),
    default: () => ({ enabled: false, pythonPath: "", modelPath: "" }),
    read: (raw) => {
      try {
        return { value: parseLocalDecisionConfig(raw) };
      } catch {
        return { value: { ...defaultConfig().localDecision! } };
      }
    },
    write: (value) => {
      const decision = parseLocalDecisionConfig(value);
      return { stored: decision, runtime: decision };
    },
    hot: true,
  },
};

/** Every preference key, in schema order. */
export const PREFERENCE_KEYS = Object.keys(PREFERENCE_SPECS) as PreferenceKey[];

/** Defaults for the preference fields, derived from the schema (used by defaultConfig). */
export function preferenceDefaults(): Pick<WandConfig, PreferenceKey> {
  const out: Record<string, unknown> = {};
  for (const key of PREFERENCE_KEYS) {
    const value = PREFERENCE_SPECS[key].default();
    if (value !== undefined) out[key] = value;
  }
  return out as Pick<WandConfig, PreferenceKey>;
}

export function preferenceSpec<K extends PreferenceKey>(key: K): PreferenceSpec<WandConfig[K]> {
  return PREFERENCE_SPECS[key];
}

/** Keys applied to the live process config without restart (all of them today). */
export const HOT_PREFERENCE_KEYS: readonly PreferenceKey[] = PREFERENCE_KEYS.filter((key) => PREFERENCE_SPECS[key].hot);

/** 用 DB 里的偏好覆盖 config 对象（in-place），返回同一个引用。DB 里没有的字段不动，保留默认值。 */
export function applyStoragePreferences(config: WandConfig, storage: WandStorage): WandConfig {
  const target = config as unknown as Record<string, unknown>;
  for (const key of PREFERENCE_KEYS) {
    const spec = PREFERENCE_SPECS[key];
    if (!storage.hasPreference(spec.storageKey)) continue;
    const result = spec.read(storage.getPreference<unknown>(spec.storageKey, spec.default()));
    if (result) target[key] = result.value;
  }
  return config;
}

/** Write a single preference value to DB and (in-place) update the live config object. */
export function writePreferenceToStorage(
  config: WandConfig,
  storage: WandStorage,
  key: PreferenceKey,
  value: unknown,
): void {
  const spec = PREFERENCE_SPECS[key];
  const { stored, runtime } = spec.write(value);
  storage.setPreference(spec.storageKey, stored);
  (config as unknown as Record<string, unknown>)[key] = runtime;
}

function defaultCardExpandDefaults(): CardExpandDefaults {
  return {
    editCards: false,
    inlineTools: false,
    terminal: false,
    thinking: false,
  };
}

function normalizeCardDefaults(input: unknown): CardExpandDefaults {
  if (!input || typeof input !== "object") return defaultCardExpandDefaults();
  const raw = input as Record<string, unknown>;
  return {
    editCards: typeof raw.editCards === "boolean" ? raw.editCards : false,
    inlineTools: typeof raw.inlineTools === "boolean" ? raw.inlineTools : false,
    terminal: typeof raw.terminal === "boolean" ? raw.terminal : false,
    thinking: typeof raw.thinking === "boolean" ? raw.thinking : false,
  };
}

function defaultAndroidApkConfig(): AndroidApkConfig {
  return {
    enabled: false,
    apkDir: "android",
    currentApkFile: "",
  };
}

function normalizeAndroidApkConfig(input: unknown): AndroidApkConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const defaults = defaultAndroidApkConfig();
  const androidInput = input as Record<string, unknown>;
  return {
    enabled: typeof androidInput.enabled === "boolean" ? androidInput.enabled : defaults.enabled,
    apkDir: typeof androidInput.apkDir === "string" && androidInput.apkDir.trim()
      ? androidInput.apkDir.trim()
      : defaults.apkDir,
    currentApkFile: typeof androidInput.currentApkFile === "string"
      ? androidInput.currentApkFile.trim()
      : defaults.currentApkFile,
  };
}

function defaultMacosDmgConfig(): MacosDmgConfig {
  return {
    enabled: false,
    dmgDir: "macos",
    currentDmgFile: "",
  };
}

function normalizeMacosDmgConfig(input: unknown): MacosDmgConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const defaults = defaultMacosDmgConfig();
  const macosInput = input as Record<string, unknown>;
  return {
    enabled: typeof macosInput.enabled === "boolean" ? macosInput.enabled : defaults.enabled,
    dmgDir: typeof macosInput.dmgDir === "string" && macosInput.dmgDir.trim()
      ? macosInput.dmgDir.trim()
      : defaults.dmgDir,
    currentDmgFile: typeof macosInput.currentDmgFile === "string"
      ? macosInput.currentDmgFile.trim()
      : defaults.currentDmgFile,
  };
}

function defaultIosIpaConfig(): IosIpaConfig {
  return {
    enabled: false,
    ipaDir: "ios",
    currentIpaFile: "",
  };
}

/**
 * 默认 auto：存在 wand-render 就用它，否则保持 legacy terminald。
 * 放在 config.json（部署项）而非 SQLite 偏好里——它决定进程所有权，属于部署决策。
 */
function defaultRenderConfig(): RenderConfig {
  return { engine: "auto" };
}

/** 旧 config.json 没有 render 字段时回落到默认值，不能因为新字段让启动失败。 */
function normalizeRenderConfig(input: unknown): RenderConfig | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const engine: RenderEngine = raw.engine === "rust" || raw.engine === "legacy" ? raw.engine : "auto";
  const binaryPath = typeof raw.binaryPath === "string" ? raw.binaryPath.trim() : "";
  return { engine, ...(binaryPath ? { binaryPath } : {}) };
}

/**
 * 默认 auto：Pi 侧有可用认证时，结构化 pi 会话走进程内 core，否则保持 CLI。
 * 放在 config.json（部署项）而非 SQLite 偏好里：它决定「谁持有 agent loop」，属于部署决策。
 */
function defaultHarnessConfig(): HarnessConfig {
  return { engine: "auto" };
}

function normalizeHarnessTokenLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** 旧 config.json 没有 harness 字段时回落到默认值，不能因为新字段让启动失败。 */
function normalizeHarnessConfig(input: unknown): HarnessConfig | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const engine: HarnessEngine = raw.engine === "core" || raw.engine === "cli" ? raw.engine : "auto";
  const compactionRaw = raw.compaction && typeof raw.compaction === "object" && !Array.isArray(raw.compaction)
    ? raw.compaction as Record<string, unknown>
    : null;
  const reserveTokens = normalizeHarnessTokenLimit(compactionRaw?.reserveTokens);
  const keepRecentTokens = normalizeHarnessTokenLimit(compactionRaw?.keepRecentTokens);
  const compaction = {
    ...(typeof compactionRaw?.enabled === "boolean" ? { enabled: compactionRaw.enabled } : {}),
    ...(reserveTokens !== undefined ? { reserveTokens } : {}),
    ...(keepRecentTokens !== undefined ? { keepRecentTokens } : {}),
  };
  const agentDir = typeof raw.agentDir === "string" ? raw.agentDir.trim() : "";
  return {
    engine,
    ...(agentDir ? { agentDir } : {}),
    ...(Object.keys(compaction).length > 0 ? { compaction } : {}),
  };
}

function normalizeIosIpaConfig(input: unknown): IosIpaConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const defaults = defaultIosIpaConfig();
  const iosInput = input as Record<string, unknown>;
  return {
    enabled: typeof iosInput.enabled === "boolean" ? iosInput.enabled : defaults.enabled,
    ipaDir: typeof iosInput.ipaDir === "string" && iosInput.ipaDir.trim()
      ? iosInput.ipaDir.trim()
      : defaults.ipaDir,
    currentIpaFile: typeof iosInput.currentIpaFile === "string"
      ? iosInput.currentIpaFile.trim()
      : defaults.currentIpaFile,
  };
}

function normalizeStructuredChatPersona(input: unknown): StructuredChatPersonaConfig | undefined {
  if (!input || typeof input !== "object") return undefined;

  const normalizeRole = (roleInput: unknown): StructuredChatPersonaConfig["user"] | undefined => {
    if (!roleInput || typeof roleInput !== "object") return undefined;
    const role = roleInput as Record<string, unknown>;
    const normalized = {
      name: typeof role.name === "string" ? role.name.trim() : undefined,
      avatar: typeof role.avatar === "string" ? role.avatar.trim() : undefined,
    };
    if (!normalized.name && !normalized.avatar) return undefined;
    return normalized;
  };

  const personaInput = input as Record<string, unknown>;
  const user = normalizeRole(personaInput.user);
  const assistant = normalizeRole(personaInput.assistant);

  if (!user && !assistant) return undefined;
  return { user, assistant };
}

function mergeWithDefaults(input: Partial<WandConfig>): WandConfig {
  const defaults = defaultConfig();
  return {
    ...defaults,
    ...input,
    // Ensure https is boolean
    https: typeof input.https === "boolean" ? input.https : defaults.https,
    browserExtensionIds: Array.isArray(input.browserExtensionIds)
      ? input.browserExtensionIds.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean)
      : undefined,
    trustProxy: typeof input.trustProxy === "string" ? input.trustProxy.trim() || undefined : undefined,
    // 只接受不带路径/查询/凭据的 http(s) origin；写了非法值就当作没配。
    publicOrigin: (() => {
      const raw = typeof input.publicOrigin === "string" ? input.publicOrigin.trim() : "";
      if (!raw) return undefined;
      try {
        const parsed = new URL(raw);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
        if (!parsed.hostname || parsed.username || parsed.password) return undefined;
        return parsed.origin;
      } catch {
        return undefined;
      }
    })(),
    tls: (() => {
      if (!input.tls || typeof input.tls !== "object") return undefined;
      const certPath = typeof input.tls.certPath === "string" ? input.tls.certPath.trim() : "";
      const keyPath = typeof input.tls.keyPath === "string" ? input.tls.keyPath.trim() : "";
      if (!certPath && !keyPath) return undefined;
      return {
        ...(certPath ? { certPath } : {}),
        ...(keyPath ? { keyPath } : {}),
      };
    })(),
    defaultCwd:
      typeof input.defaultCwd === "string" && input.defaultCwd.trim()
        ? input.defaultCwd
        : defaults.defaultCwd,
    shortcutLogMaxBytes:
      typeof input.shortcutLogMaxBytes === "number" && input.shortcutLogMaxBytes >= 0
        ? input.shortcutLogMaxBytes
        : defaults.shortcutLogMaxBytes,
    startupCommands: Array.isArray(input.startupCommands) ? input.startupCommands : defaults.startupCommands,
    allowedCommandPrefixes: Array.isArray(input.allowedCommandPrefixes)
      ? input.allowedCommandPrefixes
      : defaults.allowedCommandPrefixes,
    commandPresets: Array.isArray(input.commandPresets)
      ? input.commandPresets
          .filter(
            (preset): preset is { label: string; command: string; mode?: WandConfig["defaultMode"] } =>
              typeof preset === "object" &&
              preset !== null &&
              typeof preset.label === "string" &&
              typeof preset.command === "string"
          )
          .map((preset) => ({
            label: normalizePresetLabel(preset.label, preset.command),
            command: normalizePresetCommand(preset.command),
            mode: isExecutionMode(preset.mode) ? preset.mode : undefined
          }))
      : defaults.commandPresets,
    structuredChatPersona: normalizeStructuredChatPersona(input.structuredChatPersona),
    userProfile: normalizeUserProfile(input.userProfile),
    language: typeof input.language === "string" ? input.language.trim() : defaults.language,
    appSecret: typeof input.appSecret === "string" && input.appSecret.length >= 32
      ? input.appSecret
      : crypto.randomBytes(32).toString("hex"),
    android: normalizeAndroidApkConfig(input.android) ?? defaults.android,
    macos: normalizeMacosDmgConfig(input.macos) ?? defaults.macos,
    ios: normalizeIosIpaConfig(input.ios) ?? defaults.ios,
    render: normalizeRenderConfig(input.render) ?? defaults.render,
    harness: normalizeHarnessConfig(input.harness) ?? defaults.harness,
    structured: { processHost: input.structured?.processHost === "rust" ? "rust" : "legacy" },
    localDecision: {
      enabled: input.localDecision?.enabled === true,
      pythonPath: typeof input.localDecision?.pythonPath === "string" ? input.localDecision.pythonPath.trim() : "",
      modelPath: typeof input.localDecision?.modelPath === "string" ? input.localDecision.modelPath.trim() : "",
    },
    cardDefaults: normalizeCardDefaults(input.cardDefaults),
    taskRetention: normalizeTaskRetention(input.taskRetention),
    defaultProvider: isSessionProvider(input.defaultProvider) ? input.defaultProvider : "claude",
    defaultSessionKind: input.defaultSessionKind === "pty" ? "pty" : "structured",
    defaultEngine: input.defaultEngine === "sdk" ? "sdk" : "cli",
    defaultTaskWorktree: typeof input.defaultTaskWorktree === "boolean" ? input.defaultTaskWorktree : defaults.defaultTaskWorktree,
    ...providerModelOverrides(input, defaults),
    modelGroups: normalizeModelGroups(input.modelGroups ?? []),
    commitCli: input.commitCli === "codex" || input.commitCli === "opencode" ? input.commitCli : "claude",
    commitModel: typeof input.commitModel === "string" ? input.commitModel.trim() : defaults.commitModel,
    systemAiCli: isSessionProvider(input.systemAiCli) ? input.systemAiCli : undefined,
    systemAiModel: typeof input.systemAiModel === "string" ? input.systemAiModel.trim() : defaults.systemAiModel,
    defaultThinkingEffort: isThinkingEffort(input.defaultThinkingEffort) ? input.defaultThinkingEffort : "off",
    inheritEnv: typeof input.inheritEnv === "boolean" ? input.inheritEnv : (defaults.inheritEnv ?? true),
  };
}

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === "assist" || value === "agent" || value === "agent-max" || value === "auto-edit" || value === "default" || value === "full-access" || value === "native" || value === "managed";
}

/**
 * 配置里的默认模型 id：`default` 是「跟随 CLI 默认」的哨兵值、不是模型 id，
 * 历史设置里可能存过它（会一路传成 `--model default`），读到就当没配。
 */
function configuredModelId(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "default" ? "" : trimmed;
}

/** 归一每个 provider 的默认模型：字符串则 trim，否则回落到默认值。 */
function providerModelOverrides(
  input: Partial<WandConfig>,
  defaults: WandConfig,
): Pick<WandConfig, ProviderModelField> {
  const result = {} as Record<ProviderModelField, string | undefined>;
  for (const field of PROVIDER_MODEL_FIELDS) {
    const value = input[field];
    result[field] = typeof value === "string" ? value.trim() : defaults[field];
  }
  return result;
}

export function getProviderDefaultModels(config: Pick<WandConfig, ProviderModelField>): Record<SessionProvider, string> {
  const models = {} as Record<SessionProvider, string>;
  for (const provider of SESSION_PROVIDERS) {
    models[provider] = configuredModelId(config[PROVIDER_MODEL_PREFERENCE_FIELDS[provider]]);
  }
  return models;
}

export function getDefaultModelForProvider(
  config: Pick<WandConfig, ProviderModelField>,
  provider: SessionProvider | undefined,
): string {
  const defaults = getProviderDefaultModels(config);
  return provider ? defaults[provider] : defaults.claude;
}

/** 把按 provider 归档的默认模型投影回各自的 `default*Model` 字段（客户端兼容字段）。 */
export function providerModelFields(
  models: Record<SessionProvider, string>,
): Pick<WandConfig, ProviderModelField> {
  const result = {} as Record<ProviderModelField, string>;
  for (const provider of SESSION_PROVIDERS) {
    result[PROVIDER_MODEL_PREFERENCE_FIELDS[provider]] = models[provider];
  }
  return result;
}

function normalizePresetCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed === "cloud-code" || trimmed === "cloudcode" || trimmed === "claude code") {
    return "claude";
  }
  return trimmed;
}

function normalizePresetLabel(label: string, command: string): string {
  const normalizedCommand = normalizePresetCommand(command);
  if (normalizedCommand === "claude" && (label === "CloudCode" || label === "Claude Code")) {
    return "Claude";
  }
  return label;
}
