import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { AndroidApkConfig, CardExpandDefaults, ExecutionMode, StructuredChatPersonaConfig, WandConfig } from "./types.js";
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
  "structuredRunner",
  "language",
  "cardDefaults",
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
  cardDefaults: defaultCardExpandDefaults(),
  defaultModel: "",
  structuredRunner: "cli" as StructuredRunnerOption,
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

export async function ensureConfig(configPath: string): Promise<WandConfig> {
  const dir = path.dirname(configPath);
  await mkdir(dir, { recursive: true });

  try {
    const raw = await readFile(configPath, "utf8");
    const merged = mergeWithDefaults(JSON.parse(raw) as Partial<WandConfig>);
    const normalized = `${JSON.stringify(merged, null, 2)}\n`;
    // Only write if the file content actually changed
    if (raw.trimEnd() !== normalized.trimEnd()) {
      await writeFile(configPath, normalized, "utf8");
    }
    return merged;
  } catch {
    const config = defaultConfig();
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return config;
  }
}

/** saveConfig 写出时去掉偏好字段——这些已经移到 SQLite。 */
export async function saveConfig(configPath: string, config: WandConfig): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(stripPreferenceFields(config), null, 2)}\n`, "utf8");
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
    rawInput = {};
  }

  migrateLegacyPreferencesToDb(rawInput, storage);

  const config = mergeWithDefaults(rawInput);
  applyStoragePreferences(config, storage);

  // 如果 JSON 里有偏好字段（说明是老版本配置或刚迁移），重写一次干净版本
  const hasLegacyPrefs = PREFERENCE_KEYS.some((key) => key in rawInput);
  if (!hadFile || hasLegacyPrefs) {
    await saveConfig(configPath, config);
  }
  return config;
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
    cardDefaults: normalizeCardDefaults(input.cardDefaults),
    defaultModel: typeof input.defaultModel === "string" ? input.defaultModel.trim() : defaults.defaultModel,
    structuredRunner: (input.structuredRunner === "sdk" || input.structuredRunner === "cli") ? input.structuredRunner : defaults.structuredRunner,
  };
}

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === "assist" || value === "agent" || value === "agent-max" || value === "auto-edit" || value === "default" || value === "full-access" || value === "native" || value === "managed";
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
