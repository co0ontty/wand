/**
 * 静态前端资源、嵌入式 vendor 资产、Web UI 入口页与结构化聊天头像。
 *
 * 缓存策略见 setAssetCache：URL 带的 hash 与当前字节一致才允许 immutable 缓存，
 * 否则 no-store，避免自更新后旧 URL 缓存到新字节。
 */
import path from "node:path";
import { stat } from "node:fs/promises";
import type { Express, Request, Response, RequestHandler } from "express";

import { resolveStructuredChatAvatarPath } from "./server-app-connect.js";
import { asyncRoute } from "./express-async.js";
import { EMBEDDED_WEB_ASSETS, type EmbeddedVendorAssetPath } from "./web-ui/embedded-assets.js";
import { renderApp } from "./web-ui/index.js";
import { getAiTeamsChunk, getBrowserModule, getPlushAvatarChunk, getScriptAsset, getThemePreloadAsset } from "./web-ui/scripts.js";
import { getStylesAsset } from "./web-ui/styles.js";
import type { WandConfig } from "./types.js";
import { getErrorMessage } from "./error-utils.js";

/** 结构化聊天头像允许的图片类型；未知扩展名回 415。 */
const AVATAR_CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
};

export interface AssetRouteDependencies {
  configPath: string;
  config: WandConfig;
  requireAuth: RequestHandler;
  requireSessions: RequestHandler;
}

export function registerAssetRoutes(app: Express, deps: AssetRouteDependencies): void {
  const { configPath, config, requireAuth, requireSessions } = deps;
  const requestedHash = (req: Request): string | undefined =>
    typeof req.query.v === "string" ? req.query.v : undefined;
  const setAssetCache = (req: Request, res: Response, hash: string, visibility: "public" | "private"): void => {
    // Never cache new bytes under an old URL after a package replacement. An old
    // process can still serve its embedded version; a new process serves current
    // bytes without caching the mismatch so an in-flight page remains usable.
    res.setHeader("Cache-Control", requestedHash(req) === hash
      ? `${visibility}, max-age=31536000, immutable`
      : "no-store");
  };
  const sendEmbeddedVendorAsset = (assetPath: EmbeddedVendorAssetPath, req: Request, res: Response): void => {
    const asset = EMBEDDED_WEB_ASSETS.vendor[assetPath];
    setAssetCache(req, res, asset.hash, "public");
    res.type(asset.contentType).send(asset.content);
  };
  app.get("/vendor/xterm/xterm.bundle.js", (req, res) => sendEmbeddedVendorAsset("/vendor/xterm/xterm.bundle.js", req, res));
  app.get("/vendor/xterm/xterm.css", (req, res) => sendEmbeddedVendorAsset("/vendor/xterm/xterm.css", req, res));
  app.get("/vendor/qrcode/qrcode.bundle.js", (req, res) => sendEmbeddedVendorAsset("/vendor/qrcode/qrcode.bundle.js", req, res));
  app.get("/assets/app.css", (req, res) => {
    const asset = getStylesAsset(requestedHash(req));
    setAssetCache(req, res, asset.hash, "public");
    res.type("text/css").send(asset.content);
  });
  app.get("/assets/theme.js", (req, res) => {
    const asset = getThemePreloadAsset();
    setAssetCache(req, res, asset.hash, "public");
    res.type("application/javascript").send(asset.content);
  });
  app.get("/assets/app.js", (req, res) => {
    const asset = getScriptAsset(configPath, requestedHash(req));
    setAssetCache(req, res, asset.hash, "private");
    res.type("application/javascript").send(asset.content);
  });
  app.get("/assets/modules/:build/:file", (req, res) => {
    const content = getBrowserModule(`modules/${req.params.build}/${req.params.file}`);
    if (content === undefined) {
      res.setHeader("Cache-Control", "no-store");
      res.status(404).type("text/plain").send("Browser module not found; reload the page after updating.");
      return;
    }
    // The directory fingerprints the entire immutable module graph. Never
    // substitute current bytes for a missing older module under its cached URL.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.type("application/javascript").send(content);
  });
  app.get("/assets/ai-teams.js", (req, res) => {
    const chunk = getAiTeamsChunk(requestedHash(req));
    setAssetCache(req, res, chunk.hash, "public");
    res.type("application/javascript").send(chunk.content);
  });
  app.get("/assets/plush-avatar.js", (req, res) => {
    const chunk = getPlushAvatarChunk(requestedHash(req));
    setAssetCache(req, res, chunk.hash, "public");
    res.type("application/javascript").send(chunk.content);
  });

  // ── Web UI endpoints ──

  app.get(["/", "/settings"], (req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.type("html").send(renderApp(configPath, /^\/settings\/?$/.test(req.path) ? "settings" : "console",
      req.query.client === "app" ? "client" : "browser"));
  });


  app.get("/api/structured-chat-avatar/:role", requireAuth, requireSessions, asyncRoute(async (req, res) => {
    const role = req.params.role === "user" || req.params.role === "assistant"
      ? req.params.role
      : null;
    if (!role) {
      res.status(404).end();
      return;
    }

    const resolvedPath = resolveStructuredChatAvatarPath(configPath, config, role);
    if (!resolvedPath) {
      res.status(404).end();
      return;
    }

    try {
      const fileStat = await stat(resolvedPath);
      if (!fileStat.isFile()) {
        res.status(404).end();
        return;
      }

      const contentType = AVATAR_CONTENT_TYPES[path.extname(resolvedPath).toLowerCase()];
      if (!contentType) {
        res.status(415).json({ error: "不支持的头像格式。" });
        return;
      }

      res.setHeader("X-Content-Type-Options", "nosniff");
      res.type(contentType).sendFile(resolvedPath);
    } catch {
      res.status(404).end();
    }
  }));
}
