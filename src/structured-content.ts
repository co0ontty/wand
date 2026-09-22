/** 把 unknown 收敛成普通对象；数组 / null / 原始值都返回 null。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export type StructuredContentPart = { type: string; [key: string]: unknown };

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 各家 provider 的图片 part 形态不同：
 *   · Anthropic：`{ type:"image", source:{ type:"base64", media_type, data } }` / `source:{ type:"url", url }`
 *   · OpenAI Responses：`{ type:"image_url", image_url:{ url } }` / `image_url:"…"`
 *   · Pi：`{ type:"image", data, mimeType }`
 * 只要带图片语义就算，具体归一化交给 canonicalizeStructuredImagePart。
 */
export function isStructuredImagePart(value: unknown): boolean {
  const part = asRecord(value);
  if (!part) return false;
  if (part.type === "image_url") return !!imageUrlOf(part);
  if (part.type !== "image") return false;
  const source = asRecord(part.source);
  if (source && (stringValue(source.data) || stringValue(source.url))) return true;
  return !!(stringValue(part.data) || stringValue(part.url));
}

function imageUrlOf(part: Record<string, unknown>): string | undefined {
  const raw = part.image_url;
  if (typeof raw === "string") return stringValue(raw);
  return stringValue(asRecord(raw)?.url);
}

/**
 * 统一成客户端认识的规范形态（Web / Android / iOS / macOS 都按
 * `{ type:"image", source:{ type:"base64"|"url", … } }` 解析）。识别不了返回 null，
 * 由调用方原样保留，避免丢信息。
 */
export function canonicalizeStructuredImagePart(value: unknown): StructuredContentPart | null {
  const part = asRecord(value);
  if (!part) return null;

  if (part.type === "image_url") {
    const url = imageUrlOf(part);
    return url ? { type: "image", source: { type: "url", url } } : null;
  }
  if (part.type !== "image") return null;

  const source = asRecord(part.source);
  if (source) {
    const data = stringValue(source.data);
    if (source.type === "base64" && data) {
      return {
        type: "image",
        source: { type: "base64", media_type: stringValue(source.media_type) ?? "image/png", data },
      };
    }
    const url = stringValue(source.url);
    if (url) return { type: "image", source: { type: "url", url } };
  }

  const data = stringValue(part.data);
  if (data) {
    const mediaType = stringValue(part.mimeType)
      ?? stringValue(part.mime_type)
      ?? stringValue(source?.media_type)
      ?? "image/png";
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  }
  const url = stringValue(part.url);
  if (url) return { type: "image", source: { type: "url", url } };
  return null;
}

/** content（字符串 / part 数组）里是否含图片 part。 */
export function contentHasStructuredImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => isStructuredImagePart(part));
}

/** Preserve both Responses content parts and arbitrary structured tool output. */
export function normalizeStructuredToolResultContent(
  content: unknown,
): string | StructuredContentPart[] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((item): item is StructuredContentPart =>
        !!item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string",
      )
      // 图片 part 归一化后客户端才能跨端渲染；非图片 part 原样保留。
      .map((part) => canonicalizeStructuredImagePart(part) ?? part);
    if (parts.length === content.length) return parts;
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return typeof content === "undefined" || content === null ? "" : String(content);
}
