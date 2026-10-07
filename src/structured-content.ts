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

/**
 * 将工具执行产生的原始结果（无论是纯文本、JSON、还是带图片的多模态数组）统一归一化为 Wand 内容块格式。
 * - 纯文本结果（或仅包含 text part 的数组）：统一合并为格式规整的纯文本字符串，避免无谓的数组包装；
 * - 包含图片/富媒体的结果：归一化为 `StructuredContentPart[]`，并将图片收敛为规范的 image part；
 * - 针对 `{ content: [...] }` / `{ result: ... }` / `{ output: ... }` 等常见包装层自动解包。
 */
export function canonicalizeToolResultContent(
  value: unknown,
): string | StructuredContentPart[] {
  const record = asRecord(value);
  const raw = record && "content" in record
    ? record.content
    : record && "output" in record && typeof record.output === "string"
      ? record.output
      : value;

  const normalized = normalizeStructuredToolResultContent(raw);
  if (typeof normalized === "string") return normalized;
  if (normalized.length > 0 && normalized.every((part) => part.type === "text" && typeof part.text === "string")) {
    return normalized
      .map((part) => part.text as string)
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return normalized;
}

export type AgentContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * 将 Wand 历史存储或传输层中的 tool_result content 还原为 Agent/LLM SDK（如 @earendil-works/pi-ai）
 * 可识别的 content parts 数组。
 * - 文本转换为 `{ type: "text", text }`；
 * - 包含 Base64 的图片转换为 `{ type: "image", data, mimeType }`；
 * - 保证在多轮历史回放或断点恢复时，模型能够感知之前工具返回的多模态图片。
 */
export function toolResultContentToAgentParts(
  content: unknown,
): AgentContentPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    const text = typeof content === "undefined" || content === null ? "" : String(content);
    return [{ type: "text", text }];
  }

  const parts: AgentContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push({ type: "text", text: record.text });
      continue;
    }
    if (isStructuredImagePart(record)) {
      const canonical = canonicalizeStructuredImagePart(record);
      const source = asRecord(canonical?.source);
      if (source && source.type === "base64" && typeof source.data === "string" && source.data) {
        parts.push({
          type: "image",
          data: source.data,
          mimeType: typeof source.media_type === "string" && source.media_type ? source.media_type : "image/png",
        });
        continue;
      }
    }
    try {
      parts.push({ type: "text", text: JSON.stringify(record) });
    } catch {
      parts.push({ type: "text", text: String(record) });
    }
  }

  if (parts.length === 0) {
    return [{ type: "text", text: "" }];
  }
  return parts;
}

