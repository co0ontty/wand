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
import type { SessionSnapshot, WandConfig } from "./types.js";
import { resolveClientIp } from "./server-request.js";
import { WebLoginTickets, webLoginOrigin } from "./web-login-tickets.js";
import { HttpError } from "./http-error.js";
import { AttemptLimiter } from "./middleware/rate-limit.js";

export interface AuthRouteDependencies {
  storage: WandStorage;
  config: WandConfig;
  authService: AuthService;
  useHttps: boolean;
  requireAuth: RequestHandler;
  tickets?: WebLoginTickets;
  /** Production uses the live runtime owner; storage fallback is for route harnesses. */
  getSession?(id: string): SessionSnapshot | null;
  /** 改密后断开已认证的 WebSocket。 */
  disconnectAuthenticatedSockets(): void;
}

export function registerAuthRoutes(app: Express, deps: AuthRouteDependencies): void {
  const { storage, config, authService, useHttps } = deps;
  const tickets = deps.tickets ?? new WebLoginTickets();
  const ticketAttempts = new AttemptLimiter({ windowMs: 60_000, maxAttempts: 20, lockoutMs: 60_000, maxKeys: 4096 });
  authService.onRevokeAll(() => tickets.clear());
  storage.onClose(() => tickets.clear());
  const ticketFailure = (res: import("express").Response, error: unknown): void => {
    const known = error instanceof HttpError;
    res.status(known ? error.status : 503).json({ code: known ? error.code : "ticket_delivery_unknown",
      error: known ? error.message : "票据操作结果未知；请核对登录状态，不要重复提交。" });
  };
  // Only the trusted local owner CLI may mint/cancel. Browsers, connected-app tokens and
  // reverse-proxy traffic cannot use this route, even with an admin cookie.
  const localOwner: RequestHandler = (req, res, next) => {
    const ip = req.socket.remoteAddress;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip ?? "")
      || req.headers.origin || req.headers["sec-fetch-site"] || Object.keys(req.headers).some(key => key === "forwarded" || key.startsWith("x-forwarded-"))) {
      res.status(403).json({ code: "local_cli_required", error: "仅允许本机可信所有者 CLI 签发或取消票据。" }); return;
    }
    next();
  };
  app.post("/api/login/ticket/issue", localOwner, deps.requireAuth, requireAdmin, (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some(key => !["requestId", "origin"].includes(key))
        || typeof body.requestId !== "string") {
        throw new HttpError(400, "invalid_request", "无效票据请求；不能选择员工、权限或有效期。");
      }
      const subject = tickets.resolveGrant(req.headers["x-wand-web-login-proof"]);
      const session = subject?.sessionId ? (deps.getSession ? deps.getSession(subject.sessionId) : storage.getSessionSlim(subject.sessionId)) : null;
      if (!subject || !session || session.archived || session.status !== "running" || !session.employeeId || session.employeeId !== subject.employeeId) {
        throw new HttpError(403, "invalid_subject", "当前执行主体已结束或不可用，不能改用其他员工。");
      }
      const origin = webLoginOrigin(body.origin);
      if (config.publicOrigin && origin !== webLoginOrigin(config.publicOrigin)) throw new HttpError(400, "origin_mismatch", "目标不属于当前服务的公开 origin。");
      res.status(201).json(tickets.issue(body.requestId, origin, { sessionId: session?.id ?? null, employeeId: session?.employeeId ?? null }));
    } catch (error) { ticketFailure(res, error); }
  });
  app.post("/api/login/ticket/cancel", localOwner, deps.requireAuth, requireAdmin, (req, res) => {
    res.set("Cache-Control", "no-store");
    if (typeof req.body?.requestId !== "string") { res.status(400).json({ code: "invalid_request", error: "缺少 requestId。" }); return; }
    try { tickets.cancel(req.body.requestId); res.json({ ok: true }); }
    catch (error) { ticketFailure(res, error); }
  });
  app.post("/api/login/ticket", (req, res) => {
    res.set("Cache-Control", "no-store");
    const ip = resolveClientIp(req);
    if (ticketAttempts.check(ip)) { res.status(429).json({ code: "rate_limited", error: "票据尝试过多，请稍后再试。" }); return; }
    ticketAttempts.record(ip);
    try {
      // Configured reverse-proxy origin wins. Otherwise use Express's bounded proxy
      // protocol handling and the actual Host, never an arbitrary Origin as authority.
      const actual = webLoginOrigin(config.publicOrigin || `${req.protocol}://${req.get("host")}`);
      if (req.headers.origin !== actual || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) {
        throw new HttpError(403, "origin_mismatch", "请在票据绑定服务的真实登录页面提交。");
      }
      const { principal, subject } = tickets.consume(req.body?.ticket, actual);
      if (subject.sessionId) {
        const session = deps.getSession ? deps.getSession(subject.sessionId) : storage.getSessionSlim(subject.sessionId);
        if (!session || session.archived || session.status !== "running" || session.employeeId !== subject.employeeId) {
          throw new HttpError(401, "invalid_subject", "签发时的执行主体已结束或改变，请重新确认授权。");
        }
      }
      const token = authService.createSession(principal);
      issueSessionCookies(res, token, useHttps);
      res.json({ ok: true, principal, subject });
    } catch (error) { ticketFailure(res, error); }
  });

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

