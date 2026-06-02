import { SessionSnapshot } from "./types.js";
export declare const DEFAULT_DB_FILE = "wand.db";
export interface PersistedAuthSession {
    token: string;
    expiresAt: number;
}
export declare function resolveDatabasePath(configPath: string): string;
export declare function ensureDatabaseFile(dbPath: string): boolean;
export declare class WandStorage {
    private readonly db;
    constructor(dbPath: string);
    close(): void;
    /** Get a config value from database */
    getConfigValue(key: string): string | null;
    /** Set a config value in database */
    setConfigValue(key: string, value: string): void;
    /** Delete a config value */
    deleteConfigValue(key: string): void;
    /** 读取偏好。未设置或 JSON 解析失败时返回 fallback。 */
    getPreference<T>(key: string, fallback: T): T;
    /** 写入偏好。undefined / null 视为删除。 */
    setPreference<T>(key: string, value: T | null | undefined): void;
    /** 判断偏好是否在 DB 中存在（区别于值为 null/false/""）。 */
    hasPreference(key: string): boolean;
    /** Get password from database */
    getPassword(): string | null;
    /** Set password in database */
    setPassword(password: string): void;
    /** Check if password has been set (not default) */
    hasCustomPassword(): boolean;
    /** Get appSecret from database (used to mint Android appTokens) */
    getAppSecret(): string | null;
    /** Persist appSecret in database (DB is the authoritative source after first migration) */
    setAppSecret(value: string): void;
    saveAuthSession(token: string, expiresAt: number): void;
    getAuthSession(token: string): PersistedAuthSession | null;
    deleteAuthSession(token: string): void;
    deleteExpiredAuthSessions(now: number): void;
    saveSession(snapshot: SessionSnapshot): void;
    /**
     * Lightweight update — only touches scalar session fields, skips messages.
     * Use this in the hot persist path to avoid serializing large message arrays.
     * Full messages are written by saveSession() at state transitions (exit/stop).
     */
    saveSessionMetadata(snapshot: SessionSnapshot): void;
    getSession(id: string): SessionSnapshot | null;
    getLatestSessionByClaudeSessionId(claudeSessionId: string): SessionSnapshot | null;
    loadSessions(): SessionSnapshot[];
    private mapSessionRow;
    updateSessionWorktreeMergeState(id: string, status: SessionSnapshot["worktreeMergeStatus"], info: SessionSnapshot["worktreeMergeInfo"]): SessionSnapshot | null;
    deleteSession(id: string): void;
}
