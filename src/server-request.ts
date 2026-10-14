/**
 * 路由层共享的请求解析小工具。
 *
 * 这些函数原来在 `server-task-routes.ts`、`server-github-routes.ts`、
 * `server.ts` 里各写了一份；集中到一处后，行为（尤其是“空字符串视为缺省”）
 * 只有一个定义，路由文件只保留业务语义。
 */

import { getErrorMessage } from "./error-utils.js";
import { badRequest, isHttpError } from "./http-error.js";

/** 客户端 IP：经 trust proxy 解析后的 req.ip，缺省回落到 socket 地址。 */
export function resolveClientIp(req: { ip?: string; socket: { remoteAddress?: string } }): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

/** 取字符串并 trim；非字符串一律当缺省处理。 */
export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/** Shared length check for employee and team name fields. */
export function boundedText(value: unknown, label: string, min: number, max: number): string {
  const result = text(value);
  if (result.length < min) throw badRequest(`${label}不能为空。`);
  if (result.length > max) throw badRequest(`${label}不能超过 ${max} 个字符。`);
  return result;
}

/** Express query 值可能是数组，取第一个字符串。 */
export function firstQueryStringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstQueryStringValue(value[0]);
  return undefined;
}

/** 请求头可能是数组（重复头），取第一个值。 */
export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** 逗号分隔的请求头（如 Forwarded / X-Forwarded-*）取第一段。 */
export function firstHeaderListValue(value: string | string[] | undefined): string | undefined {
  return firstHeaderValue(value)?.split(",")[0]?.trim();
}

/** 从 Forwarded 头（`proto=https;host=example.com`）里取指定参数；缺失返回 undefined。 */
export function forwardedParam(header: string | undefined, key: string): string | undefined {
  if (!header) return undefined;
  const targetKey = key.toLowerCase();
  for (const part of header.split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex < 1) continue;
    if (part.slice(0, eqIndex).trim().toLowerCase() !== targetKey) continue;
    const value = part.slice(eqIndex + 1).trim();
    return value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")
      ? value.slice(1, -1)
      : value;
  }
  return undefined;
}

/** 把 header / URL 里的协议名收敛成 http | https；其余情况返回 undefined。 */
export function normalizeProtocol(value: string | undefined): "http" | "https" | undefined {
  const proto = value?.trim().toLowerCase();
  if (proto === "http" || proto === "https") return proto;
  return undefined;
}


/** 要求请求体是普通对象；数组和 null 都拒绝。 */
export function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("请求体必须是对象。");
  return value as Record<string, unknown>;
}

/** 从对象里取必填的非空字符串字段。 */
export function requiredString(body: Record<string, unknown>, key: string): string {
  const value = text(body[key]);
  if (!value) throw badRequest(`${key} 不能为空。`);
  return value;
}

/**
 * 路由 catch 块的标准回包。
 *
 * - HttpError：使用它自己的状态码、code 与面向用户的 message；
 * - 其他异常：记日志，响应 fallback 文案（不透出 Error.message，避免内部细节泄露），
 *   状态码取调用方给定的 status（默认 400，内部故障请显式传 500）。
 */
export function sendRouteError(
  res: { status(code: number): { json(body: unknown): unknown } },
  error: unknown,
  fallback: string,
  status = 400,
): void {
  if (isHttpError(error)) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  console.error(`[wand] route error (${status}): ${getErrorMessage(error, fallback)}`);
  res.status(status).json({ error: fallback, code: status >= 500 ? "internal_error" : "bad_request" });
}

/** 缺省只信任本机与 Docker 桥接网段的反向代理，避免任意来源伪造 X-Forwarded-For 绕过登录限流。 */
export const DEFAULT_TRUST_PROXY = "loopback, 172.16.0.0/12";

/**
 * 解析 `trustProxy` 配置。拒绝 "true"/"*"（信任任意跳，等于允许伪造客户端 IP）并回落到缺省值。
 */
export function resolveTrustProxy(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return DEFAULT_TRUST_PROXY;
  if (trimmed === "true" || trimmed === "*") return DEFAULT_TRUST_PROXY;
  return trimmed;
}
