import crypto from "node:crypto";
import type { Express, RequestHandler } from "express";
import { principalHasScope, readSessionCookie } from "./auth.js";
import type { AuthPrincipal } from "./storage.js";

export const SETTINGS_WEB_COOKIE = "wand_settings_access";

/** A WebView-only proof bound to the existing, live client session, not a new administrator login. */
export class SettingsWebAccess {
  private readonly key = crypto.randomBytes(32);

  issue(sessionToken: string): string {
    return crypto.createHmac("sha256", this.key).update(sessionToken).digest("base64url");
  }

  accepts(sessionToken: string | undefined, cookieHeader: string | undefined): boolean {
    if (!sessionToken || !cookieHeader) return false;
    const prefix = `${SETTINGS_WEB_COOKIE}=`;
    const value = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
    return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(this.issue(sessionToken)));
  }
}

export function registerSettingsWebAccessRoute(app: Express, deps: {
  requireAuth: RequestHandler;
  useHttps: boolean;
  access: SettingsWebAccess;
  authenticateSession(token: string | undefined): AuthPrincipal | null;
}): void {
  app.post("/api/settings/webview-session", deps.requireAuth, (req, res) => {
    const token = readSessionCookie(req, deps.useHttps);
    const principal = deps.authenticateSession(token);
    if (!token || !principal) {
      res.status(401).json({ error: "客户端登录已失效，请重新连接客户端。" });
      return;
    }
    if (!principalHasScope(principal, "session-preferences")) {
      res.status(403).json({ error: "当前客户端连接不能访问完整设置。" });
      return;
    }
    // The parent session remains unchanged; revocation/expiry immediately invalidates this proof.
    res.set("Cache-Control", "no-store").cookie(SETTINGS_WEB_COOKIE, deps.access.issue(token), {
      httpOnly: true, sameSite: "strict", secure: deps.useHttps, path: "/", maxAge: 1000 * 60 * 60 * 12,
    }).json({ ok: true });
  });
}
