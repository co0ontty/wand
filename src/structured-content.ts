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
