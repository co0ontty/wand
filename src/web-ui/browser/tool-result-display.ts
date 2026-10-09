interface ResultImage { src: string; }

/** MCP/Anthropic image payloads can arrive directly or as a serialized tool result.
 * Only recognize image envelopes; ordinary JSON/text remains readable diagnostic output. */
function imageEnvelope(value: unknown, depth = 0): unknown[] | null {
  if (depth > 4 || !value) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[\[{]/.test(text) || !/"type"\s*:\s*"image(?:_url)?"/.test(text)) return null;
    try { return imageEnvelope(JSON.parse(text), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) return value.some(item => imageSource(item) || imageEnvelope(item?.text, depth + 1)) ? value : null;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (imageSource(object)) return [object];
    return imageEnvelope(object.content, depth + 1);
  }
  return null;
}

function imageSource(item: any): string {
  if (!item || typeof item !== "object") return "";
  if (item.type === "image") {
    const source = item.source || {};
    const data = source.type === "base64" ? source.data : item.data;
    const mime = source.media_type || item.mimeType || item.mime_type || "image/png";
    if (typeof data === "string" && /^image\/[a-z0-9.+-]+$/i.test(mime)) return `data:${mime};base64,${data}`;
    return typeof source.url === "string" ? source.url : typeof item.url === "string" ? item.url : "";
  }
  if (item.type === "image_url") return typeof item.image_url === "string" ? item.image_url : item.image_url?.url || "";
  return "";
}

export function extractToolResultImages(content: unknown): ResultImage[] {
  const blocks = imageEnvelope(content);
  if (!blocks) return [];
  return blocks.flatMap((item: any) => {
    const src = imageSource(item);
    return src ? [{ src }] : item?.type === "text" ? extractToolResultImages(item.text) : [];
  });
}

export function extractToolResultText(content: unknown): string {
  if (!content) return "";
  const envelope = imageEnvelope(content);
  if (envelope) return envelope.map((item: any) => item?.type === "text" ? extractToolResultText(item.text) : imageSource(item) ? "" : JSON.stringify(item)).filter(Boolean).join("\n");
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(item => {
    if (!item || typeof item !== "object") return "";
    if (item.type === "text" && typeof item.text === "string") return extractToolResultText(item.text);
    if (item.type === "image" || item.type === "image_url") return "";
    try { return JSON.stringify(item); } catch { return ""; }
  }).filter(Boolean).join("\n");
  return "";
}

/** Compact snapshots may retain only the beginning of a serialized image payload. */
export function toolResultPreview(result: { preview?: string; content?: unknown } | null | undefined): string {
  if (!result) return "";
  const preview = result.preview || "";
  if (extractToolResultImages(result.content).length || /"type"\s*:\s*"image(?:_url)?"/.test(preview)
    || /(?:data:image\/[\w.+-]+;base64,|\/(?:9j|wAB)|iVBORw0KGgo)[A-Za-z0-9+/=]{16,}/.test(preview)) {
    return "图片结果 · 展开查看";
  }
  return preview;
}
