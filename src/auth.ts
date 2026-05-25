import crypto from "node:crypto";
import { WandStorage } from "./storage.js";

const sessions = new Map<string, number>();
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
let storage: WandStorage | null = null;

/**
 * Cookie 名按 scheme 隔离 —— 解决浏览器 Strict Secure Cookies 在 HTTPS↔HTTP 切换时
 * "新 Set-Cookie 被同名 Secure 旧 cookie 静默丢弃"导致登录后立刻 401 的问题。
 *
 *   - HTTPS 模式：`__Host-wand_session`（强制 Secure + Path=/，安全性更高）
 *   - HTTP 模式：`wand_session_local`（独立名字，不会被 HTTPS 留下的 Secure cookie 拦截）
 *   - `wand_session`：legacy 名字。HTTPS 模式下仍写一份用于兼容老 macOS APP（写死了找
 *     `wand_session`），同时让升级前的老登录态在过渡期不被踢。
 *
 * 读取顺序按"当前 scheme 主名字 → legacy"逐项 fallback。
 */
export const SESSION_COOKIE_HTTPS = "__Host-wand_session";
export const SESSION_COOKIE_HTTP = "wand_session_local";
export const SESSION_COOKIE_LEGACY = "wand_session";

/** 解析 Cookie 头，按候选名字顺序返回第一个匹配到的 token 值。 */
export function readSessionCookie(
  req: { headers: { cookie?: string } },
  useHttps: boolean,
): string | undefined {
  const cookie = req.headers.cookie;
  if (!cookie) return undefined;
  const parts = cookie.split(";").map((part) => part.trim());
  const order = useHttps
    ? [SESSION_COOKIE_HTTPS, SESSION_COOKIE_LEGACY, SESSION_COOKIE_HTTP]
    : [SESSION_COOKIE_HTTP, SESSION_COOKIE_LEGACY, SESSION_COOKIE_HTTPS];
  for (const name of order) {
    const prefix = `${name}=`;
    const hit = parts.find((part) => part.startsWith(prefix));
    if (hit) return hit.slice(prefix.length);
  }
  return undefined;
}

// Periodic cleanup every 10 minutes
const sessionCleanupTimer = setInterval(() => {
  cleanupExpiredSessions();
}, 1000 * 60 * 10);
sessionCleanupTimer.unref();

export function createSession(): string {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, expiresAt);
  storage?.saveAuthSession(token, expiresAt);
  return token;
}

export function validateSession(token: string | undefined): boolean {
  if (!token) {
    return false;
  }

  let expiresAt = sessions.get(token);
  if (typeof expiresAt === "undefined") {
    const persisted = storage?.getAuthSession(token);
    if (persisted) {
      sessions.set(token, persisted.expiresAt);
      expiresAt = persisted.expiresAt;
    }
  }

  if (!expiresAt || expiresAt < Date.now()) {
    if (expiresAt) {
      sessions.delete(token);
      storage?.deleteAuthSession(token);
    }
    return false;
  }

  return true;
}

export function revokeSession(token: string | undefined): void {
  if (token) {
    sessions.delete(token);
    storage?.deleteAuthSession(token);
  }
}

export function setAuthStorage(nextStorage: WandStorage): void {
  storage = nextStorage;
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt < now) {
      sessions.delete(token);
    }
  }
  storage?.deleteExpiredAuthSessions(now);
}
