/**
 * 登录、登出、改密与会话探测路由。
 *
 * 这些路由在 `requireAuth` 之前注册（登录本身不需要认证），因此单独成模块，
 * 集中管理 Cookie 签发、登录限流与应用令牌登录策略。
 */
import type { Express, RequestHandler } from "express";

import { AuthService, readSessionCookie } from "./auth.js";
import {
  checkPasswordRateLimit,
  checkSetPasswordRateLimit,
  recordFailedPassword,
  recordSetPasswordAttempt,
  resetPasswordRateLimit,
} from "./middleware/rate-limit.js";
import {
  browserAdminPrincipal,
  clearSessionCookies,
  connectedAppPrincipal,
  getEffectivePassword,
  issueSessionCookies,
  requireAdmin,
} from "./middleware/auth.js";
import { appTokenLoginPayload, verifyAppToken } from "./server-app-connect.js";
import type { AuthPrincipal, WandStorage } from "./storage.js";
import type { WandConfig } from "./types.js";
import { resolveClientIp } from "./server-request.js";

export interface AuthRouteDependencies {
  storage: WandStorage;
  config: WandConfig;
  authService: AuthService;
  useHttps: boolean;
  requireAuth: RequestHandler;
  /** 改密后断开已认证的 WebSocket。 */
  disconnectAuthenticatedSockets(): void;
}

export function registerAuthRoutes(app: Express, deps: AuthRouteDependencies): void {
  const { storage, config, authService, useHttps } = deps;

  app.post("/api/login", (req, res) => {
    const clientIp = resolveClientIp(req);
    const { password, appToken, client } = req.body as { password?: string; appToken?: string; client?: string };
    const effectivePassword = getEffectivePassword(storage, config);

    // App token login is intentionally restricted even though the token remains
    // password-derived for compatibility with existing connect codes.
    // A stale token gets 401 without feeding the counter: the client cannot fix it by
    // retrying, and one device holding one used to lock out every user behind the same
    // reverse proxy IP. An active lock still gates unverified attempts.
    let principal: AuthPrincipal | null = null;
    if (appToken) {
      try {
        if (verifyAppToken(appToken, effectivePassword, config.appSecret ?? "")) {
          principal = connectedAppPrincipal();
        }
      } catch {
        principal = null;
      }
    }

    if (!principal) {
      const lock = checkPasswordRateLimit(clientIp);
      if (lock) {
        const minutes = Math.max(1, Math.ceil(lock.retryAfter / 60));
        res.setHeader("Retry-After", String(lock.retryAfter));
        res
          .status(429)
          .json({ error: `登录尝试次数过多，请在约 ${minutes} 分钟后再试。`, code: "rate_limited", retryAfter: lock.retryAfter });
        return;
      }
      if (password !== effectivePassword) {
        if (!appToken) recordFailedPassword(clientIp);
        res.status(401).json({ error: "密码错误，请重试。", code: "invalid_credentials" });
        return;
      }
      principal = browserAdminPrincipal();
    }

    resetPasswordRateLimit(clientIp);
    const token = authService.createSession(principal);
    issueSessionCookies(res, token, useHttps);
    res.json({
      ok: true,
      principal,
      ...(client === "browser-extension"
        ? appTokenLoginPayload(req, config, useHttps, getEffectivePassword(storage, config))
        : {}),
    });
  });

  app.post("/api/logout", (req, res) => {
    authService.revokeSession(readSessionCookie(req, useHttps));
    clearSessionCookies(res);
    res.json({ ok: true });
  });

  app.post("/api/set-password", deps.requireAuth, requireAdmin, (req, res) => {
    const clientIp = resolveClientIp(req);
    const lock = checkSetPasswordRateLimit(clientIp);
    if (lock) {
      res.setHeader("Retry-After", String(lock.retryAfter));
      res.status(429).json({ error: "修改密码尝试次数过多，请稍后再试。", code: "rate_limited", retryAfter: lock.retryAfter });
      return;
    }
    recordSetPasswordAttempt(clientIp);
    const { password } = req.body as { password?: string };
    if (!password || password.length < 6) {
      res.status(400).json({ error: "密码长度至少为 6 个字符。", code: "invalid_request" });
      return;
    }
    storage.setPassword(password);
    authService.revokeAllSessions();
    deps.disconnectAuthenticatedSockets();
    clearSessionCookies(res);
    res.json({ ok: true, reauthenticationRequired: true });
  });

  // Public probe so the unauthenticated browser does not log a 401 on /api/config
  app.get("/api/session-check", (req, res) => {
    res.json({ authed: authService.validateSession(readSessionCookie(req, useHttps)) });
  });
}

