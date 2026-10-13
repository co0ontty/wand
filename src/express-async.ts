import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";

import { getErrorMessage } from "./error-utils.js";
import { isHttpError } from "./http-error.js";

export type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown | Promise<unknown>;

/** Forward both synchronous throws and rejected route promises to Express. */
export function asyncRoute(handler: AsyncRouteHandler): RequestHandler {
  return (req, res, next) => {
    try {
      void Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      next(error);
    }
  };
}

/** 状态码到稳定错误码；未知 4xx/5xx 归到通用码。 */
export function errorCodeForStatus(status: number): string {
  switch (status) {
    case 400: return "bad_request";
    case 401: return "unauthorized";
    case 403: return "forbidden";
    case 404: return "not_found";
    case 409: return "conflict";
    case 413: return "payload_too_large";
    case 415: return "unsupported_media_type";
    case 429: return "rate_limited";
    case 503: return "service_unavailable";
    default: return status >= 500 ? "internal_error" : "request_failed";
  }
}

/**
 * Keep API failures JSON-shaped, including body-parser and async route errors.
 * HttpError messages are user-facing and returned verbatim; everything else is logged
 * and answered with a generic message so internal error text never reaches the client.
 */
export const jsonErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (isHttpError(error)) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }

  const status = typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : 500;
  if (status === 413 || (error as { type?: unknown })?.type === "entity.too.large") {
    res.status(413).json({ error: "请求内容过大。", code: "payload_too_large" });
    return;
  }

  const finalStatus = status >= 400 && status < 600 ? status : 500;
  console.error("[wand] Unhandled request error:", getErrorMessage(error));
  res.status(finalStatus).json({
    error: "请求处理失败。",
    code: errorCodeForStatus(finalStatus),
  });
};
