import { CardExpandDefaults, ExecutionMode, WandConfig } from "./types.js";
import type { WandStorage } from "./storage.js";
/**
 * 通过 UI 设置面板可改的"用户偏好"字段。这些字段从 SQLite app_config 表读取，
 * 不再写入 ~/.wand/config.json。JSON 只保留服务部署/启动期参数（host/port/shell 等）。
 *
 * 升级路径：老 JSON 里仍存有这些字段时，首次启动会被搬到 DB（见 migrateLegacyPreferencesToDb），
 * 然后下一次 saveConfig 写回 JSON 时它们会被剥离（见 stripPreferenceFields）。
 */
export declare const PREFERENCE_KEYS: readonly ["defaultMode", "defaultCwd", "defaultModel", "structuredRunner", "language", "cardDefaults", "inheritEnv"];
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];
export declare function isPreferenceKey(key: string): key is PreferenceKey;
export declare const defaultConfig: () => WandConfig;
export declare function resolveConfigPath(inputPath?: string): string;
export declare function resolveConfigDir(configPath: string): string;
export declare function hasConfigFile(configPath: string): boolean;
export declare function ensureConfig(configPath: string): Promise<WandConfig>;
/** saveConfig 写出时去掉偏好字段——这些已经移到 SQLite。 */
export declare function saveConfig(configPath: string, config: WandConfig): Promise<void>;
/**
 * 启动期合并 JSON + DB 偏好。语义：
 *   1. 读 raw JSON
 *   2. 把 JSON 中残留的偏好字段搬到 DB（只在 DB 没值时迁移）
 *   3. mergeWithDefaults(raw) 得到 baseline
 *   4. applyStoragePreferences 用 DB 覆盖 baseline 的偏好字段
 *   5. 如果 JSON 里仍含偏好字段（来自 1），用 saveConfig 重写一次 JSON（剥离后）
 */
export declare function loadConfigWithStorage(configPath: string, storage: WandStorage): Promise<WandConfig>;
/**
 * 老版本 JSON 里如果还存有偏好字段，且 DB 里对应 key 没有写过，
 * 把 JSON 的值搬到 DB。注意：必须在 mergeWithDefaults 之前操作 raw input，
 * 这样能区分"用户显式写过 X" 和 "X 是 mergeWithDefaults 注入的默认值"。
 */
export declare function migrateLegacyPreferencesToDb(rawJsonInput: Partial<WandConfig> | null | undefined, storage: WandStorage): void;
/**
 * 用 DB 里的偏好覆盖 config 对象（in-place），返回同一个引用，
 * 方便各 manager 持有引用后继续工作。DB 里没有的字段不动，保留 JSON 默认值。
 */
export declare function applyStoragePreferences(config: WandConfig, storage: WandStorage): WandConfig;
/** Write a single preference value to DB and (in-place) update the live config object. */
export declare function writePreferenceToStorage(config: WandConfig, storage: WandStorage, key: PreferenceKey, value: unknown): void;
export declare function normalizeCardDefaults(input: unknown): CardExpandDefaults;
export declare function isExecutionMode(value: unknown): value is ExecutionMode;
