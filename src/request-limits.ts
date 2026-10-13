/**
 * 查询参数 / 请求字段的整数解析：唯一入口。
 *
 * - 只接受十进制整数字符串（允许首尾空白与负号），其他一律回落到 fallback；
 * - 超出范围时：`clamp` 夹到边界（分页大小、预算等可安全截断的值），
 *   `fallback` 回落到缺省值（页码等不能静默改写的值）。
 */
export type IntegerRangeMode = "clamp" | "fallback";

export function parseBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  outOfRange: IntegerRangeMode = "clamp",
): number {
  if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) return fallback;
  if (parsed >= minimum && parsed <= maximum) return parsed;
  if (outOfRange === "fallback") return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}
