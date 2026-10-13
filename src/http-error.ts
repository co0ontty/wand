/**
 * 路由层的可预期 HTTP 错误。
 *
 * 只有 HttpError 的 message 会原样返回给客户端（它是为用户写的文案）；其他异常一律
 * 记日志并回落到调用方给的 fallback，避免内部错误文本（路径、SQL、栈信息片段）泄露到响应里。
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

/** 400：请求参数或请求体不合法；message 必须是面向用户的文案。 */
export function badRequest(message: string, code = "invalid_request"): HttpError {
  return new HttpError(400, code, message);
}

export function notFound(message: string, code = "not_found"): HttpError {
  return new HttpError(404, code, message);
}

export function conflict(message: string, code = "conflict"): HttpError {
  return new HttpError(409, code, message);
}

/**
 * 放行服务层已确认面向用户的业务错误文案（如引擎选择冲突、Git 仓库前置条件）。
 * 服务模块尚未改为抛 HttpError 时，路由用它显式列出允许透出的模式；不匹配则返回 undefined，
 * 调用方继续走通用回包。
 */
export function surfaceDomainError(error: unknown, allowed: RegExp): HttpError | undefined {
  if (isHttpError(error)) return error;
  const message = error instanceof Error ? error.message : "";
  return message && allowed.test(message) ? badRequest(message) : undefined;
}
