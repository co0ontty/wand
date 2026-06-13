import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { AndroidApkConfig, CardExpandDefaults, ExecutionMode, MacosDmgConfig, StructuredChatPersonaConfig, WandConfig } from "./types.js";
import type { WandStorage } from "./storage.js";
type StructuredRunnerOption = WandConfig["structuredRunner"];

const DEFAULT_CONFIG_DIR = ".wand";
const DEFAULT_CONFIG_FILE = "config.json";

/**
 * 通过 UI 设置面板可改的"用户偏好"字段。这些字段从 SQLite app_config 表读取，
 * 不再写入 ~/.wand/config.json。JSON 只保留服务部署/启动期参数（host/port/shell 等）。
 *
 * 升级路径：老 JSON 里仍存有这些字段时，首次启动会被搬到 DB（见 migrateLegacyPreferencesToDb），
 * 然后下一次 saveConfig 写回 JSON 时它们会被剥离（见 stripPreferenceFields）。
 */
export const PREFERENCE_KEYS = [
  "defaultMode",
  "defaultCwd",
  "defaultModel",
  "defaultThinkingEffort",
  "structuredRunner",
  "language",
  "cardDefaults",
  "inheritEnv",
] as const satisfies readonly (keyof WandConfig)[];

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

const PREFERENCE_KEY_SET = new Set<string>(PREFERENCE_KEYS);

function preferenceStorageKey(key: PreferenceKey): string {
  return `pref:${key}`;
}

export function isPreferenceKey(key: string): key is PreferenceKey {
  return PREFERENCE_KEY_SET.has(key);
}

export const defaultConfig = (): WandConfig => ({
  host: "127.0.0.1",
  port: 8443,
  https: false,
  password: "change-me",
  defaultMode: "default",
  shell: process.env.SHELL || "/bin/bash",
  defaultCwd: process.cwd(),
  startupCommands: [],
  allowedCommandPrefixes: [],
  shortcutLogMaxBytes: 10 * 1024 * 1024,
  language: "",
  android: defaultAndroidApkConfig(),
  macos: defaultMacosDmgConfig(),
  cardDefaults: defaultCardExpandDefaults(),
  defaultModel: "",
  defaultThinkingEffort: "off",
  structuredRunner: "cli" as StructuredRunnerOption,
  inheritEnv: true,
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
  await writeFile(tmpPath, content, "utf8");
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* noop */ }
    throw err;
  }
}

/** saveConfig 写出时去掉偏好字段——这些已经移到 SQLite。 */
export async function saveConfig(configPath: string, config: WandConfig): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
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
  await mkdir(dir, { recursive: true });

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

  // 如果 JSON 里有偏好字段（说明是老版本配置或刚迁移），重写一次干净版本
  const hasLegacyPrefs = PREFERENCE_KEYS.some((key) => key in rawInput);
  if (!hadFile || hasLegacyPrefs) {
    await saveConfig(configPath, config);
  }
  return config;
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
  return out;
}

/**
 * 老版本 JSON 里如果还存有偏好字段，且 DB 里对应 key 没有写过，
 * 把 JSON 的值搬到 DB。注意：必须在 mergeWithDefaults 之前操作 raw input，
 * 这样能区分"用户显式写过 X" 和 "X 是 mergeWithDefaults 注入的默认值"。
 */
export function migrateLegacyPreferencesToDb(rawJsonInput: Partial<WandConfig> | null | undefined, storage: WandStorage): void {
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
 * 用 DB 里的偏好覆盖 config 对象（in-place），返回同一个引用，
 * 方便各 manager 持有引用后继续工作。DB 里没有的字段不动，保留 JSON 默认值。
 */
export function applyStoragePreferences(config: WandConfig, storage: WandStorage): WandConfig {
  const defaults = defaultConfig();

  if (storage.hasPreference(preferenceStorageKey("defaultMode"))) {
    const v = storage.getPreference<string>(preferenceStorageKey("defaultMode"), defaults.defaultMode);
    if (isExecutionMode(v)) config.defaultMode = v;
  }
  if (storage.hasPreference(preferenceStorageKey("defaultCwd"))) {
    const v = storage.getPreference<string>(preferenceStorageKey("defaultCwd"), defaults.defaultCwd);
    if (typeof v === "string" && v.trim()) config.defaultCwd = v;
  }
  if (storage.hasPreference(preferenceStorageKey("defaultModel"))) {
    const v = storage.getPreference<string>(preferenceStorageKey("defaultModel"), defaults.defaultModel ?? "");
    if (typeof v === "string") config.defaultModel = v.trim();
  }
  if (storage.hasPreference(preferenceStorageKey("defaultThinkingEffort"))) {
    const v = storage.getPreference<string>(preferenceStorageKey("defaultThinkingEffort"), defaults.defaultThinkingEffort ?? "off");
    if (v === "off" || v === "standard" || v === "deep" || v === "max") config.defaultThinkingEffort = v;
  }
  if (storage.hasPreference(preferenceStorageKey("structuredRunner"))) {
    const v = storage.getPreference<string>(preferenceStorageKey("structuredRunner"), defaults.structuredRunner ?? "cli");
    if (v === "cli" || v === "sdk") config.structuredRunner = v;
  }
  if (storage.hasPreference(preferenceStorageKey("language"))) {
    const v = storage.getPreference<string>(preferenceStorageKey("language"), defaults.language ?? "");
    if (typeof v === "string") config.language = v.trim();
  }
  if (storage.hasPreference(preferenceStorageKey("cardDefaults"))) {
    const v = storage.getPreference<unknown>(preferenceStorageKey("cardDefaults"), defaults.cardDefaults);
    config.cardDefaults = normalizeCardDefaults(v);
  }
  if (storage.hasPreference(preferenceStorageKey("inheritEnv"))) {
    const v = storage.getPreference<unknown>(preferenceStorageKey("inheritEnv"), defaults.inheritEnv ?? true);
    config.inheritEnv = v === false ? false : true;
  }
  return config;
}

/** Write a single preference value to DB and (in-place) update the live config object. */
export function writePreferenceToStorage(
  config: WandConfig,
  storage: WandStorage,
  key: PreferenceKey,
  value: unknown
): void {
  const dbKey = preferenceStorageKey(key);
  switch (key) {
    case "defaultMode": {
      if (!isExecutionMode(value)) throw new Error(`无效执行模式: ${value}`);
      storage.setPreference(dbKey, value);
      config.defaultMode = value;
      break;
    }
    case "defaultCwd": {
      const v = typeof value === "string" ? value : "";
      storage.setPreference(dbKey, v);
      config.defaultCwd = v || defaultConfig().defaultCwd;
      break;
    }
    case "defaultModel": {
      const v = typeof value === "string" ? value.trim() : "";
      storage.setPreference(dbKey, v);
      config.defaultModel = v;
      break;
    }
    case "defaultThinkingEffort": {
      const v = value === "standard" || value === "deep" || value === "max" ? value : "off";
      storage.setPreference(dbKey, v);
      config.defaultThinkingEffort = v;
      break;
    }
    case "structuredRunner": {
      const v: StructuredRunnerOption = value === "cli" ? "cli" : "sdk";
      storage.setPreference(dbKey, v);
      config.structuredRunner = v;
      break;
    }
    case "language": {
      const v = typeof value === "string" ? value.trim() : "";
      storage.setPreference(dbKey, v);
      config.language = v;
      break;
    }
    case "cardDefaults": {
      const normalized = normalizeCardDefaults(value);
      storage.setPreference(dbKey, normalized);
      config.cardDefaults = normalized;
      break;
    }
    case "inheritEnv": {
      const v = value === false ? false : true;
      storage.setPreference(dbKey, v);
      config.inheritEnv = v;
      break;
    }
  }
}

function defaultCardExpandDefaults(): CardExpandDefaults {
  return {
    editCards: false,
    inlineTools: false,
    terminal: false,
    thinking: false,
    toolGroup: false,
  };
}

export function normalizeCardDefaults(input: unknown): CardExpandDefaults {
  if (!input || typeof input !== "object") return defaultCardExpandDefaults();
  const raw = input as Record<string, unknown>;
  return {
    editCards: typeof raw.editCards === "boolean" ? raw.editCards : false,
    inlineTools: typeof raw.inlineTools === "boolean" ? raw.inlineTools : false,
    terminal: typeof raw.terminal === "boolean" ? raw.terminal : false,
    thinking: typeof raw.thinking === "boolean" ? raw.thinking : false,
    toolGroup: typeof raw.toolGroup === "boolean" ? raw.toolGroup : false,
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
    language: typeof input.language === "string" ? input.language.trim() : defaults.language,
    appSecret: typeof input.appSecret === "string" && input.appSecret.length >= 32
      ? input.appSecret
      : crypto.randomBytes(32).toString("hex"),
    android: normalizeAndroidApkConfig(input.android) ?? defaults.android,
    macos: normalizeMacosDmgConfig(input.macos) ?? defaults.macos,
    cardDefaults: normalizeCardDefaults(input.cardDefaults),
    defaultModel: typeof input.defaultModel === "string" ? input.defaultModel.trim() : defaults.defaultModel,
    defaultThinkingEffort: input.defaultThinkingEffort === "standard"
      || input.defaultThinkingEffort === "deep"
      || input.defaultThinkingEffort === "max"
      ? input.defaultThinkingEffort
      : "off",
    structuredRunner: (input.structuredRunner === "sdk" || input.structuredRunner === "cli") ? input.structuredRunner : defaults.structuredRunner,
    inheritEnv: typeof input.inheritEnv === "boolean" ? input.inheritEnv : (defaults.inheritEnv ?? true),
  };
}

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === "assist" || value === "agent" || value === "agent-max" || value === "auto-edit" || value === "default" || value === "full-access" || value === "native" || value === "managed";
}

export function normalizeMode(input: string | undefined, fallback: ExecutionMode): ExecutionMode {
  return isExecutionMode(input) ? input : fallback;
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
