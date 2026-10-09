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
export const PREFERENCE_KEYS = [
  "defaultProvider",
  "defaultSessionKind",
  "defaultEngine",
  "defaultTaskWorktree",
  "defaultMode",
  "defaultCwd",
  "defaultModel",
  "defaultCodexModel",
  "defaultOpenCodeModel",
  "defaultGrokModel",
  "defaultQoderModel",
  "defaultPiModel",
  "defaultGeminiModel",
  "modelGroups",
  "commitCli",
  "commitModel",
  "systemAiCli",
  "systemAiModel",
  "defaultThinkingEffort",
  "language",
  "cardDefaults",
  "inheritEnv",
  "taskRetention",
  "userProfile",
  "localDecision",
] as const satisfies readonly (keyof WandConfig)[];

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

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
const PROVIDER_MODEL_FIELD_SET: ReadonlySet<string> = new Set(PROVIDER_MODEL_FIELDS);

function isProviderModelField(key: PreferenceKey): key is ProviderModelField {
  return PROVIDER_MODEL_FIELD_SET.has(key);
}

const PREFERENCE_KEY_SET = new Set<string>(PREFERENCE_KEYS);

function preferenceStorageKey(key: PreferenceKey): string {
  return `pref:${key}`;
}

export function isPreferenceKey(key: string): key is PreferenceKey {
  return PREFERENCE_KEY_SET.has(key);
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
  defaultProvider: "claude",
  defaultSessionKind: "structured",
  // 新建会话默认走 CLI；只有用户在新建面板显式选过 Wand Agent 才会改成 sdk。
  defaultEngine: "cli",
  defaultTaskWorktree: true,
  // 非 root 启动时才有资格用 Claude 的 permission-bypass（root 会被 Claude CLI 拒绝），
  // 所以这种环境下把默认执行模式抬到「托管」——开箱即得自动确认权限的全自主体验。
  // root 启动则保守回落到「default」（托管在 root 下也只能降级成 acceptEdits）。
  // 注意：defaultMode 是偏好字段，只存 SQLite、不写 config.json（见 stripPreferenceFields），
  // 这里仅作为「用户从未在设置里显式选过模式」时的回落值——显式选择始终优先。
  defaultMode: isRunningAsRoot() ? "default" : "managed",
  shell: resolveDefaultShell(),
  defaultCwd: process.cwd(),
  startupCommands: [],
  allowedCommandPrefixes: [],
  shortcutLogMaxBytes: 10 * 1024 * 1024,
  language: "",
  android: defaultAndroidApkConfig(),
  macos: defaultMacosDmgConfig(),
  ios: defaultIosIpaConfig(),
  render: defaultRenderConfig(),
  harness: defaultHarnessConfig(),
  structured: { processHost: "legacy" },
  localDecision: { enabled: false, pythonPath: "", modelPath: "" },
  cardDefaults: defaultCardExpandDefaults(),
  taskRetention: defaultTaskRetention(),
  defaultModel: "",
  defaultCodexModel: "",
  defaultOpenCodeModel: "",
  defaultGrokModel: "",
  defaultQoderModel: "",
  defaultPiModel: "",
  defaultGeminiModel: "",
  modelGroups: [],
  commitCli: "claude",
  commitModel: "",
  systemAiModel: "",
  defaultThinkingEffort: "off",
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

  // 内置「系统运维」员工：Wand 自有 AI 调用（commit message / 标题 / 提示词优化 /
  // 员工起草）都由它执行。这里只做幂等补齐——首次按用户已有的系统 AI 工具与默认
  // provider 建首条候选，之后候选由用户在员工设置里维护，不再回写 config。
  storage.ensureSystemSiliconEmployee({
    cli: config.systemAiCli,
    model: config.systemAiModel,
    provider: config.defaultProvider,
  });
  // 默认任务伙伴独立于系统运维；重启保留短期偏好与用户维护的候选。
  storage.ensureDefaultSiliconEmployee(config.defaultProvider);

  // 如果 JSON 里有偏好字段（说明是老版本配置或刚迁移），重写一次干净版本
  const hasLegacyPrefs = PREFERENCE_KEYS.some((key) => key in rawInput);
  const hasLegacySecrets = "password" in rawInput || "appSecret" in rawInput;
  if (!hadFile || hasLegacyPrefs || hasLegacySecrets) {
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
 * 用 DB 里的偏好覆盖 config 对象（in-place），返回同一个引用，
 * 方便各 manager 持有引用后继续工作。DB 里没有的字段不动，保留 JSON 默认值。
 */
export function applyStoragePreferences(config: WandConfig, storage: WandStorage): WandConfig {
  const defaults = defaultConfig();

  if (storage.hasPreference(preferenceStorageKey("defaultProvider"))) {
    const v = storage.getPreference<string>(preferenceStorageKey("defaultProvider"), defaults.defaultProvider ?? "claude");
    if (isSessionProvider(v)) config.defaultProvider = v;
  }
  if (storage.hasPreference(preferenceStorageKey("defaultSessionKind"))) {
    const v = storage.getPreference<string>(preferenceStorageKey("defaultSessionKind"), defaults.defaultSessionKind ?? "structured");
    if (v === "pty" || v === "structured") config.defaultSessionKind = v;
  }
  if (storage.hasPreference(preferenceStorageKey("defaultEngine"))) {
    const v = storage.getPreference<string>(preferenceStorageKey("defaultEngine"), defaults.defaultEngine ?? "cli");
    if (v === "cli" || v === "sdk") config.defaultEngine = v;
  }
  if (storage.hasPreference(preferenceStorageKey("defaultTaskWorktree"))) {
    const v = storage.getPreference<boolean>(preferenceStorageKey("defaultTaskWorktree"), defaults.defaultTaskWorktree ?? true);
    if (typeof v === "boolean") config.defaultTaskWorktree = v;
  }
  if (storage.hasPreference(preferenceStorageKey("defaultMode"))) {
    const v = storage.getPreference<string>(preferenceStorageKey("defaultMode"), defaults.defaultMode);
    if (isExecutionMode(v)) config.defaultMode = v;
  }
  if (storage.hasPreference(preferenceStorageKey("defaultCwd"))) {
    const v = storage.getPreference<string>(preferenceStorageKey("defaultCwd"), defaults.defaultCwd);
    if (typeof v === "string" && v.trim()) config.defaultCwd = v;
  }
  for (const field of PROVIDER_MODEL_FIELDS) {
    const dbKey = preferenceStorageKey(field);
    if (!storage.hasPreference(dbKey)) continue;
    const v = storage.getPreference<string>(dbKey, defaults[field] ?? "");
    if (typeof v === "string") config[field] = v.trim();
  }
  if (storage.hasPreference(preferenceStorageKey("modelGroups"))) {
    config.modelGroups = normalizeModelGroups(storage.getPreference<unknown>(preferenceStorageKey("modelGroups"), []));
  }
  if (storage.hasPreference(preferenceStorageKey("commitCli"))) {
    const v = storage.getPreference<string>(preferenceStorageKey("commitCli"), defaults.commitCli ?? "claude");
    if (v === "claude" || v === "codex" || v === "opencode") config.commitCli = v;
  }
  if (storage.hasPreference(preferenceStorageKey("commitModel"))) {
    const v = storage.getPreference<string>(preferenceStorageKey("commitModel"), defaults.commitModel ?? "");
    if (typeof v === "string") config.commitModel = v.trim();
  }
  if (storage.hasPreference(preferenceStorageKey("systemAiCli"))) {
    const v = storage.getPreference<unknown>(preferenceStorageKey("systemAiCli"), defaults.systemAiCli);
    if (isSessionProvider(v)) config.systemAiCli = v;
  }
  if (storage.hasPreference(preferenceStorageKey("systemAiModel"))) {
    const v = storage.getPreference<unknown>(preferenceStorageKey("systemAiModel"), defaults.systemAiModel);
    if (typeof v === "string") config.systemAiModel = v.trim();
  }
  if (storage.hasPreference(preferenceStorageKey("defaultThinkingEffort"))) {
    const v = storage.getPreference<string>(preferenceStorageKey("defaultThinkingEffort"), defaults.defaultThinkingEffort ?? "off");
    if (isThinkingEffort(v)) config.defaultThinkingEffort = v;
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
  if (storage.hasPreference(preferenceStorageKey("taskRetention"))) {
    config.taskRetention = normalizeTaskRetention(
      storage.getPreference<unknown>(preferenceStorageKey("taskRetention"), defaults.taskRetention),
    );
  }
  if (storage.hasPreference(preferenceStorageKey("userProfile"))) {
    config.userProfile = normalizeUserProfile(storage.getPreference<unknown>(preferenceStorageKey("userProfile"), null));
  }
  if (storage.hasPreference(preferenceStorageKey("localDecision"))) {
    try { config.localDecision = parseLocalDecisionConfig(storage.getPreference<unknown>(preferenceStorageKey("localDecision"), defaults.localDecision)); }
    catch { config.localDecision = { ...defaults.localDecision! }; }
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
  const dbKey = preferenceStorageKey(key);
  // Default model fields share one shape (trimmed string) across every provider;
  // handling them before the switch keeps the switch free of seven copies.
  if (isProviderModelField(key)) {
    const v = typeof value === "string" ? value.trim() : "";
    storage.setPreference(dbKey, v);
    config[key] = v;
    return;
  }
  switch (key) {
    case "localDecision": {
      const decision = parseLocalDecisionConfig(value);
      storage.setPreference(dbKey, decision);
      config.localDecision = decision;
      break;
    }
    case "modelGroups": {
      const groups = normalizeModelGroups(value);
      storage.setPreference(dbKey, groups);
      config.modelGroups = groups;
      break;
    }
    case "defaultProvider": {
      if (!isSessionProvider(value)) throw new Error(`无效 Provider: ${String(value)}`);
      storage.setPreference(dbKey, value);
      config.defaultProvider = value;
      break;
    }
    case "defaultSessionKind": {
      if (value !== "pty" && value !== "structured") throw new Error(`无效会话类型: ${value}`);
      storage.setPreference(dbKey, value);
      config.defaultSessionKind = value;
      break;
    }
    case "defaultEngine": {
      if (value !== "cli" && value !== "sdk") throw new Error(`无效执行引擎: ${String(value)}`);
      storage.setPreference(dbKey, value);
      config.defaultEngine = value;
      break;
    }
    case "defaultTaskWorktree": {
      if (typeof value !== "boolean") throw new Error("defaultTaskWorktree 必须是布尔值。");
      storage.setPreference(dbKey, value);
      config.defaultTaskWorktree = value;
      break;
    }
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
    case "commitCli": {
      if (value !== "claude" && value !== "codex" && value !== "opencode") throw new Error(`无效 commit CLI: ${value}`);
      storage.setPreference(dbKey, value);
      config.commitCli = value;
      break;
    }
    case "commitModel": {
      const v = typeof value === "string" ? value.trim() : "";
      storage.setPreference(dbKey, v);
      config.commitModel = v;
      break;
    }
    case "systemAiCli": {
      if (!isSessionProvider(value)) throw new Error(`无效系统 AI CLI: ${String(value)}`);
      storage.setPreference(dbKey, value);
      config.systemAiCli = value;
      break;
    }
    case "systemAiModel": {
      const v = typeof value === "string" ? value.trim() : "";
      storage.setPreference(dbKey, v);
      config.systemAiModel = v;
      break;
    }
    case "defaultThinkingEffort": {
      if (!isThinkingEffort(value)) throw new Error(`无效思考深度: ${String(value)}`);
      const v = value;
      storage.setPreference(dbKey, v);
      config.defaultThinkingEffort = v;
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
      if (typeof value !== "boolean") throw new Error(`inheritEnv 必须是布尔值: ${String(value)}`);
      const v = value;
      storage.setPreference(dbKey, v);
      config.inheritEnv = v;
      break;
    }
    case "taskRetention": {
      const retention = parseTaskRetention(value);
      storage.setPreference(dbKey, retention);
      config.taskRetention = retention;
      break;
    }
    case "userProfile": {
      const profile = parseUserProfile(value);
      storage.setPreference(dbKey, profile ?? null);
      config.userProfile = profile;
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
