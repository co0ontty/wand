/**
 * 浏览器扩展的跨域策略。
 *
 * 扩展用 `Authorization: Bearer` 调用 API，不依赖 Cookie，因此：
 *   - 配置了 `browserExtensionIds` 时，只有列表内的扩展 origin 会拿到 CORS 回包，
 *     且只有它们获得 `Access-Control-Allow-Credentials`；其余扩展直接没有 CORS 头，浏览器拦截；
 *   - 未配置时保持原有可用性（任何扩展 origin 都能用 Bearer 调用），但一律不下发
 *     `Allow-Credentials`，所以陌生扩展无法借用浏览器里的会话 Cookie 读取响应。
 */
import type { RequestHandler } from "express";

import { isBrowserExtensionOrigin } from "../server-app-connect.js";
import { firstHeaderValue } from "../server-request.js";

const ALLOWED_HEADERS = "Authorization, Content-Type";
const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

/** `chrome-extension://abc…` → `abc…`；其余 scheme 同理取 `://` 之后的部分。 */
export function extensionIdOf(origin: string): string {
  const index = origin.indexOf("://");
  return (index >= 0 ? origin.slice(index + 3) : origin).toLowerCase();
}

export function createExtensionCors(allowedIds: readonly string[] | undefined): RequestHandler {
  const allowList = allowedIds && allowedIds.length > 0
    ? new Set(allowedIds.map((id) => id.trim().toLowerCase()).filter(Boolean))
    : null;

  return function extensionCors(req, res, next) {
    const origin = firstHeaderValue(req.headers.origin);
    if (!origin || !isBrowserExtensionOrigin(origin)) {
      next();
      return;
    }
    const listed = allowList?.has(extensionIdOf(origin)) ?? true;
    if (!listed) {
      // Not on the configured list: no CORS grant at all, so the browser refuses the response.
      next();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    if (allowList) res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
