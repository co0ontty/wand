import http from "node:http";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";

import { getErrorMessage } from "./error-utils.js";
import { asyncRoute } from "./express-async.js";

const MAX_PORT = 65535;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** URL 里可能写 `localhost` / `[::1]`，建立连接前规范成裸主机名。 */
const NORMALIZED_LOOPBACK_HOSTNAMES: Record<string, string> = {
  localhost: "127.0.0.1",
  "[::1]": "::1",
};

/** Headers that identify the original Wand request and must not leak downstream. */
const FILTERED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "cookie",
  "expect",
  "host",
  "upgrade",
]);

/** Hop-by-hop and browser-security headers are owned by the proxy response. */
const FILTERED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "keep-alive",
  "permissions-policy",
  "set-cookie",
  "strict-transport-security",
  "transfer-encoding",
  "upgrade",
  "x-frame-options",
]);

export interface LocalPreviewTarget {
  hostname: string;
  port: number;
  path: string;
}

/** Parse and constrain a proxy target to a loopback HTTP service. */
export function parseLocalPreviewTarget(
  rawHost: string,
  rawPort: string,
  rawPath: string,
): LocalPreviewTarget | null {
  const hostname = rawHost.trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) return null;

  if (!/^\d{1,5}$/.test(rawPort)) return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) return null;

  const suffix = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  return {
    hostname: NORMALIZED_LOOPBACK_HOSTNAMES[hostname] ?? hostname,
    port,
    path: suffix,
  };
}

function proxyLocation(
  value: string,
  target: LocalPreviewTarget,
): string {
  if (value.startsWith("/")) {
    return `/api/local-preview/${target.hostname}/${target.port}${value}`;
  }
  try {
    const url = new URL(value);
    if (url.hostname === target.hostname && url.port === String(target.port)) {
      return `/api/local-preview/${target.hostname}/${target.port}${url.pathname}${url.search}`;
    }
  } catch {
    // Leave non-HTTP schemes and opaque values untouched.
  }
  return value;
}

/**
 * Reverse-proxy a user-selected loopback port. The route is mounted before the
 * JSON body parser so POST/PUT bodies remain byte streams, including multipart
 * uploads and other content types that Express does not need to inspect.
 */
export function registerLocalPreviewRoutes(
  app: Express,
  dependencies: { requireAuth: RequestHandler; requireFiles: RequestHandler },
): void {
  const handler = asyncRoute(async (req: Request, res: Response, next: NextFunction) => {
    const target = parseLocalPreviewTarget(
      String(req.params.host ?? ""),
      String(req.params.port ?? ""),
      req.url || "/",
    );
    if (!target) {
      res.status(400).json({ error: "只允许预览本机（localhost）HTTP 服务。" });
      return;
    }

    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (FILTERED_REQUEST_HEADERS.has(key) || value === undefined) continue;
      headers[key] = Array.isArray(value) ? [...value] : value;
    }
    headers["x-forwarded-for"] = req.ip || req.socket.remoteAddress || "";
    headers["x-forwarded-host"] = req.headers.host ?? "";
    headers["x-forwarded-proto"] = req.protocol;

    let upstream: http.IncomingMessage;
    try {
      upstream = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const proxyReq = http.request({
          hostname: target.hostname,
          port: target.port,
          path: target.path,
          method: req.method,
          headers,
        }, resolve);
        proxyReq.once("error", reject);
        req.once("error", reject);
        req.pipe(proxyReq);
      });
    } catch (error) {
      if (!res.headersSent) {
        const code = (error as NodeJS.ErrnoException).code;
        const message = code === "ECONNREFUSED"
          ? "本地服务未启动或端口不可用。"
          : `无法连接本地服务：${getErrorMessage(error)}`;
        res.status(502).json({ error: message });
      } else {
        res.destroy();
      }
      return;
    }

    res.status(upstream.statusCode ?? 502);
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (FILTERED_RESPONSE_HEADERS.has(key) || value === undefined) continue;
      if (key.toLowerCase() === "location" && typeof value === "string") {
        res.setHeader(key, proxyLocation(value, target));
        continue;
      }
      res.setHeader(key, value);
    }

    if (req.method === "HEAD" || !upstream.statusCode) {
      upstream.destroy();
      res.end();
      return;
    }

    upstream.once("error", () => {
      if (!res.writableEnded) res.destroy();
    });
    upstream.pipe(res);
  });

  // req.url is the suffix after the mounted host/port prefix, preserving query
  // strings and relative assets while keeping host and port as route params.
  app.use("/api/local-preview/:host/:port", dependencies.requireAuth, dependencies.requireFiles, handler);
}
