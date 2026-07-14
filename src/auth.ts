import crypto from "node:crypto";
import { WandStorage, type AuthPrincipal, type AuthScope } from "./storage.js";

interface CachedAuthSession {
  expiresAt: number;
  principal: AuthPrincipal;
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

export const BROWSER_ADMIN_PRINCIPAL: AuthPrincipal = {
  kind: "browser-admin",
  scopes: ["admin"],
};

export const CONNECTED_APP_PRINCIPAL: AuthPrincipal = {
  kind: "connected-app",
  scopes: ["sessions", "files", "password-vault", "session-preferences"],
};

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

export class AuthService {
  private readonly sessions = new Map<string, CachedAuthSession>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private readonly storage: WandStorage,
    private readonly sessionTtlMs = SESSION_TTL_MS,
    cleanupIntervalMs = 1000 * 60 * 10,
  ) {
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  createSession(principal: AuthPrincipal = BROWSER_ADMIN_PRINCIPAL): string {
    if (this.disposed) throw new Error("AuthService has been disposed.");
    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = Date.now() + this.sessionTtlMs;
    const cached = { expiresAt, principal: clonePrincipal(principal) };
    this.sessions.set(token, cached);
    this.storage.saveAuthSession(token, expiresAt, cached.principal);
    return token;
  }

  authenticateSession(token: string | undefined): AuthPrincipal | null {
    if (!token || this.disposed) return null;
    let cached = this.sessions.get(token);
    if (!cached) {
      const persisted = this.storage.getAuthSession(token);
      if (persisted) {
        cached = { expiresAt: persisted.expiresAt, principal: clonePrincipal(persisted.principal) };
        this.sessions.set(token, cached);
      }
    }
    if (!cached || cached.expiresAt < Date.now()) {
      if (cached) {
        this.sessions.delete(token);
        this.storage.deleteAuthSession(token);
      }
      return null;
    }
    return clonePrincipal(cached.principal);
  }

  validateSession(token: string | undefined): boolean {
    return this.authenticateSession(token) !== null;
  }

  revokeSession(token: string | undefined): void {
    if (!token || this.disposed) return;
    this.sessions.delete(token);
    this.storage.deleteAuthSession(token);
  }

  revokeAllSessions(): void {
    if (this.disposed) return;
    this.sessions.clear();
    this.storage.deleteAllAuthSessions();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.cleanupTimer);
    this.sessions.clear();
  }

  private cleanupExpiredSessions(): void {
    if (this.disposed) return;
    const now = Date.now();
    for (const [token, cached] of this.sessions) {
      if (cached.expiresAt < now) this.sessions.delete(token);
    }
    this.storage.deleteExpiredAuthSessions(now);
  }
}

export function principalHasScope(principal: AuthPrincipal, scope: AuthScope): boolean {
  return principal.kind === "browser-admin"
    || principal.scopes.includes("admin")
    || principal.scopes.includes(scope);
}

function clonePrincipal(principal: AuthPrincipal): AuthPrincipal {
  return { kind: principal.kind, scopes: [...principal.scopes] };
}
