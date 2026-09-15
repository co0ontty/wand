/** 把 unknown 收敛成普通对象；数组 / null / 原始值都返回 null。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Preserve both Responses content parts and arbitrary structured tool output. */
export function normalizeStructuredToolResultContent(
  content: unknown,
): string | Array<{ type: string; [key: string]: unknown }> {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.filter((item): item is { type: string; [key: string]: unknown } =>
      !!item && typeof item === "object" && typeof (item as any).type === "string",
    );
    if (parts.length === content.length) return parts;
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return typeof content === "undefined" || content === null ? "" : String(content);
}
