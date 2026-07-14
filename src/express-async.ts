import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";

import { getErrorMessage } from "./error-utils.js";

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

/** Keep API failures JSON-shaped, including body-parser and async route errors. */
export const jsonErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const status = typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : 500;
  if (status === 413 || (error as { type?: unknown })?.type === "entity.too.large") {
    res.status(413).json({ error: "请求内容过大。" });
    return;
  }

  console.error("[wand] Unhandled request error:", getErrorMessage(error));
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: "请求处理失败。" });
};
