import { DatabaseSync } from "node:sqlite";
import { nowIso } from "../password-manager.js";
import { defaultPiCliSessionSettings, patchPiSessionSettings, type PiSessionSettings } from "../pi-session-settings.js";
import { normalizeSessionDirectory } from "../session-directory-tree.js";
import type { WandStorage } from "../storage.js";
import { WORKSPACE_GROUP_ORDER_KEY, PI_SESSION_DEFAULTS_KEY } from "./internal.js";

/** Preferences storage: one domain of the WandStorage facade. Shares the connection and the facade's transaction. */
export class PreferencesRepository {
  constructor(private readonly db: DatabaseSync, _s: WandStorage) {}

  /** Get a config value from database */
  getConfigValue(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM app_config WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Set a config value in database */
  setConfigValue(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  /** Delete a config value */
  deleteConfigValue(key: string): void {
    this.db.prepare("DELETE FROM app_config WHERE key = ?").run(key);
  }

  /** 读取偏好。未设置或 JSON 解析失败时返回 fallback。 */
  getPreference<T>(key: string, fallback: T): T {
    const raw = this.getConfigValue(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  /** 写入偏好。undefined / null 视为删除。 */
  setPreference<T>(key: string, value: T | null | undefined): void {
    if (value === undefined || value === null) {
      this.deleteConfigValue(key);
      return;
    }
    this.setConfigValue(key, JSON.stringify(value));
  }

  /** 判断偏好是否在 DB 中存在（区别于值为 null/false/""）。 */
  hasPreference(key: string): boolean {
    return this.getConfigValue(key) !== null;
  }

  /**
   * Pi CLI 会话的「上次设置」：用户在任意 Pi 会话里改过设置后，新建会话以它起步，
   * 不必每开一个会话都重配自动选择 / CodeMode。返回 null 表示沿用出厂默认
   * （跟随 Pi 自身配置），不是「设置全关」。只存设置字段本身，不含路径、命令或凭据。
   */
  getPiSessionDefaults(): PiSessionSettings | null {
    const raw = this.getPreference<unknown>(PI_SESSION_DEFAULTS_KEY, null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    try { return patchPiSessionSettings(defaultPiCliSessionSettings(), raw); } catch {
      // 非法/过期的默认设置不能静默开启任何能力，退回出厂默认。
      return null;
    }
  }

  /** 写入 Pi 会话默认设置；null / undefined 清除，回到出厂默认。 */
  setPiSessionDefaults(settings: PiSessionSettings | null | undefined): void {
    this.setPreference(PI_SESSION_DEFAULTS_KEY, settings ?? null);
  }

  /**
   * 用户在首页拖动排序后的目录组顺序（服务端偏好，所有客户端共用）。
   * 存的是客户端看到的组 id：真实工作区用 workspace id，合成目录用 `cwd:<规范化路径>`。
   * 不存在的 id 只是被忽略，不影响渲染。
   */
  getWorkspaceGroupOrder(): string[] {
    const stored = this.getPreference<unknown>(WORKSPACE_GROUP_ORDER_KEY, []);
    if (!Array.isArray(stored)) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const value of stored) {
      if (typeof value !== "string") continue;
      const id = value.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  setWorkspaceGroupOrder(ids: string[]): void {
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const value of ids) {
      const id = typeof value === "string" ? value.trim() : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      cleaned.push(id);
    }
    // 空顺序等于「没设置过」，回到默认排序，而不是存一个空数组。
    this.setPreference(WORKSPACE_GROUP_ORDER_KEY, cleaned.length > 0 ? cleaned : null);
  }

  /** 工作区被删除后，把它的排序位也清掉，避免 id 被复用后继承旧位置。 */
  forgetWorkspaceGroupOrder(id: string): void {
    const current = this.getWorkspaceGroupOrder();
    if (!current.includes(id)) return;
    this.setWorkspaceGroupOrder(current.filter((item) => item !== id));
  }

  /** Return user-defined workspace labels keyed by normalized session cwd. */
  listSessionDirectoryNames(): Map<string, string> {
    const rows = this.db
      .prepare("SELECT path, name FROM session_directory_names ORDER BY path ASC")
      .all() as unknown as Array<{ path: string; name: string }>;
    return new Map(rows.map((row) => [row.path, row.name]));
  }

  /** Set a workspace label, or remove it when name is null/blank. */
  setSessionDirectoryName(directoryPath: string, name: string | null): void {
    const normalizedPath = normalizeSessionDirectory(directoryPath);
    if (!normalizedPath) throw new Error("会话目录路径不能为空。");
    const normalizedName = name?.trim() ?? "";
    if (!normalizedName) {
      this.db.prepare("DELETE FROM session_directory_names WHERE path = ?").run(normalizedPath);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO session_directory_names (path, name, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           name = excluded.name,
           updated_at = excluded.updated_at`
      )
      .run(normalizedPath, normalizedName, nowIso());
  }
}
