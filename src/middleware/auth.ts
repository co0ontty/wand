/**
 * HTTP 鉴权中间件：会话 Cookie、Bearer 应用令牌、scope 检查与 Cookie 签发。
 *
 * 认证结果写入 `req.principal`（类型化），后续路由只读它；不再用 WeakMap 旁路保存。
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  AuthService,
  BROWSER_ADMIN_PRINCIPAL,
  CONNECTED_APP_PRINCIPAL,
  principalHasScope,
  readSessionCookie,
  SESSION_COOKIE_HTTP,
  SESSION_COOKIE_HTTPS,
  SESSION_COOKIE_LEGACY,
} from "../auth.js";
import { firstHeaderValue } from "../server-request.js";
import { verifyAppToken } from "../server-app-connect.js";
import type { SettingsWebAccess } from "../settings-web-access.js";
import type { AuthPrincipal, AuthScope, WandStorage } from "../storage.js";
import type { WandConfig } from "../types.js";
import { checkBearerRateLimit, recordFailedBearer } from "./rate-limit.js";
import { webSessionRequestAllowed } from "../web-session-access.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** 通过 requireAuth 后由服务端写入；未认证请求上不存在。 */
      principal?: AuthPrincipal;
    }
  }
}

export const UNAUTHORIZED_ERROR = { error: "未授权，请先登录。", code: "unauthorized" } as const;
export const FORBIDDEN_SCOPE_ERROR = { error: "当前连接没有执行此操作的权限。", code: "forbidden" } as const;
export const PREFERENCE_ONLY_ERROR = { error: "当前连接只能修改新会话默认偏好。", code: "forbidden" } as const;

/** 连接应用（原生客户端、浏览器扩展）可修改的新会话默认偏好字段白名单。 */
export const CONNECTED_APP_PREFERENCE_KEYS = new Set([
  "defaultMode",
  "defaultModel",
  "defaultCodexModel",
  "defaultOpenCodeModel",
  "defaultGrokModel",
  "defaultQoderModel",
  "defaultModels",
  "defaultThinkingEffort",
  "defaultProvider",
  "defaultSessionKind",
  "defaultEngine",
  "defaultTaskWorktree",
]);

export function getEffectivePassword(storage: WandStorage, config: WandConfig): string {
  return storage.getPassword() ?? config.password;
}

/** 解析 `Authorization: Bearer <app token>`；无效返回 null。 */
export function authenticateBearerAppToken(
  req: { headers: { authorization?: string | string[] } },
  storage: WandStorage,
  config: WandConfig,
): AuthPrincipal | null {
  const header = firstHeaderValue(req.headers.authorization);
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  try {
    return verifyAppToken(token, getEffectivePassword(storage, config), config.appSecret ?? "")
      ? connectedAppPrincipal()
      : null;
  } catch {
    return null;
  }
}

export function connectedAppPrincipal(): AuthPrincipal {
  return { ...CONNECTED_APP_PRINCIPAL, scopes: [...CONNECTED_APP_PRINCIPAL.scopes] };
}

export function browserAdminPrincipal(): AuthPrincipal {
  return { ...BROWSER_ADMIN_PRINCIPAL, scopes: [...BROWSER_ADMIN_PRINCIPAL.scopes] };
}

export interface AuthMiddlewareDeps {
  useHttps: boolean;
  storage: WandStorage;
  config: WandConfig;
  authService: AuthService;
  settingsAccess: SettingsWebAccess;
}

/**
 * 解析请求的主体：会话 Cookie（若已授予 WebView 设置访问则提升为 browser-admin），
 * 否则回落到 Bearer 应用令牌。Bearer 失败次数按 IP 限流。
 */
export function resolvePrincipal(req: Request, deps: AuthMiddlewareDeps): AuthPrincipal | null {
  const sessionToken = readSessionCookie(req, deps.useHttps);
  const sessionPrincipal = deps.authService.authenticateSession(sessionToken);
  if (sessionPrincipal) {
    return principalHasScope(sessionPrincipal, "session-preferences")
      && deps.settingsAccess.accepts(sessionToken, req.headers.cookie)
      ? browserAdminPrincipal()
      : sessionPrincipal;
  }
  if (!firstHeaderValue(req.headers.authorization)?.startsWith("Bearer ")) return null;
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (checkBearerRateLimit(ip)) return null;
  const bearer = authenticateBearerAppToken(req, deps.storage, deps.config);
  if (!bearer) recordFailedBearer(ip);
  return bearer;
}

export function createRequireAuth(deps: AuthMiddlewareDeps): RequestHandler {
  return function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const principal = resolvePrincipal(req, deps);
    if (!principal) {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      if (checkBearerRateLimit(ip)) {
        res.status(429).json({ error: "认证失败次数过多，请稍后再试。", code: "rate_limited" });
        return;
      }
      res.status(401).json(UNAUTHORIZED_ERROR);
      return;
    }
    if (principal.webSession) {
      const session = deps.storage.getSessionSlim(principal.webSession.sessionId);
      if (!session || session.employeeId !== principal.webSession.employeeId) {
        deps.authService.revokeSession(readSessionCookie(req, deps.useHttps));
        res.status(401).json(UNAUTHORIZED_ERROR); return;
      }
      if (!webSessionRequestAllowed(principal, req.method, `${req.baseUrl}${req.path}`)) {
        res.status(403).json({ error: "此票据登录仅可查看签发时的当前员工会话。", code: "web_session_read_only" }); return;
      }
    }
    req.principal = principal;
    next();
  };
}

/** 要求已认证且持有 scope（browser-admin 与 admin scope 隐式满足所有 scope）。 */
export function requireScope(scope: AuthScope): RequestHandler {
  return function requireScopeHandler(req: Request, res: Response, next: NextFunction): void {
    const principal = req.principal;
    if (!principal) {
      res.status(401).json(UNAUTHORIZED_ERROR);
      return;
    }
    if (!principalHasScope(principal, scope)) {
      res.status(403).json(FORBIDDEN_SCOPE_ERROR);
      return;
    }
    next();
  };
}

export const requireAdmin = requireScope("admin");

/**
 * 管理员可改任意设置；连接应用只能改 CONNECTED_APP_PREFERENCE_KEYS 内的新会话默认偏好。
 */
export const requireAdminOrSessionPreferences: RequestHandler = function requireAdminOrSessionPreferences(req, res, next) {
  const principal = req.principal;
  if (!principal) {
    res.status(401).json(UNAUTHORIZED_ERROR);
    return;
  }
  if (principalHasScope(principal, "admin")) {
    next();
    return;
  }
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const keys = Object.keys(body);
  if (!principalHasScope(principal, "session-preferences")
    || keys.length === 0
    || keys.some((key) => !CONNECTED_APP_PREFERENCE_KEYS.has(key))) {
    res.status(403).json(PREFERENCE_ONLY_ERROR);
    return;
  }
  next();
};

const SESSION_COOKIE_NAMES = [SESSION_COOKIE_HTTPS, SESSION_COOKIE_HTTP, SESSION_COOKIE_LEGACY] as const;

const SESSION_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 12;

/**
 * 签发会话 Cookie。HTTPS 下写 `__Host-` 名字与 legacy 名字（老 macOS APP 依赖），
 * HTTP 下写本地名字与 legacy 名字；见 src/auth.ts 中的命名说明。
 */
export function issueSessionCookies(res: Response, token: string, useHttps: boolean): void {
  const base = { httpOnly: true, sameSite: "strict" as const, path: "/", maxAge: SESSION_COOKIE_MAX_AGE_MS };
  if (useHttps) {
    res.cookie(SESSION_COOKIE_HTTPS, token, { ...base, secure: true });
    res.cookie(SESSION_COOKIE_LEGACY, token, { ...base, secure: true });
  } else {
    res.cookie(SESSION_COOKIE_HTTP, token, { ...base, secure: false });
    res.cookie(SESSION_COOKIE_LEGACY, token, { ...base, secure: false });
  }
}

export function clearSessionCookies(res: Response): void {
  for (const name of SESSION_COOKIE_NAMES) {
    res.clearCookie(name, { path: "/" });
  }
}
