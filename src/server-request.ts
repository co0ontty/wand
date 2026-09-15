/**
 * 路由层共享的请求解析小工具。
 *
 * 这些函数原来在 `server-task-routes.ts`、`server-github-routes.ts`、
 * `server.ts` 里各写了一份；集中到一处后，行为（尤其是“空字符串视为缺省”）
 * 只有一个定义，路由文件只保留业务语义。
 */

import { getErrorMessage } from "./error-utils.js";

/** 取字符串并 trim；非字符串一律当缺省处理。 */
export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
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

/** 解析范围内整数，越界或非整数回落到 fallback。 */
export function integerQuery(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(text(value));
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** 要求请求体是普通对象；数组和 null 都拒绝。 */
export function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是对象。");
  return value as Record<string, unknown>;
}

/** 从对象里取必填的非空字符串字段。 */
export function requiredString(body: Record<string, unknown>, key: string): string {
  const value = text(body[key]);
  if (!value) throw new Error(`${key} 不能为空。`);
  return value;
}

/**
 * 路由 catch 块的标准回包：业务异常用 fallback 文案，默认 400。
 *
 * `getErrorMessage` 会把 Error.message 原样透出，因此抛出的错误必须是面向用户的；
 * 内部错误请用 getErrorMessage(error, fallback) 已包好的 fallback。
 */
export function sendRouteError(
  res: { status(code: number): { json(body: unknown): unknown } },
  error: unknown,
  fallback: string,
  status = 400,
): void {
  res.status(status).json({ error: getErrorMessage(error, fallback) });
}
