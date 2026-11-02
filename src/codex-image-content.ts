import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { getErrorMessage } from "./error-utils.js";
import type { StructuredContentPart } from "./structured-content.js";

/**
 * Codex 的 `imageGeneration` item 只给出生成图的落盘路径（`savedPath`）或内联数据，
 * 而 Wand 四端渲染图片的唯一通道是 tool_result 里的规范 image part
 * （`{ type:"image", source:{ type:"base64", media_type, data } }`，传输层再改写成
 * 带鉴权的取图 URL）。这里把落盘文件读成有界的内联 part，四端无需各自实现取图协议。
 *
 * 上限按「一张 4K PNG 约 3–8MB」取值：超过就不再内联，交给客户端按路径处理，
 * 避免把会话快照和 WebSocket 帧撑爆。
 */
const MAX_INLINE_IMAGE_BYTES = 12 * 1024 * 1024;

/** Codex 图片后端产出的格式；其他后缀不当作图片，避免把任意文件塞进 image part。 */
const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

export interface CodexImageRead {
  part?: StructuredContentPart;
  /** 读不到图片时的可展示原因（不当作错误，图片只是没内联）。 */
  note?: string;
}

export function isCodexImagePath(filePath: string): boolean {
  return !!IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()];
}

/** 把 Codex 落盘图片读成规范 image part；任何失败都退化成 note，不抛出。 */
export function readCodexImagePart(filePath: string): CodexImageRead {
  if (!filePath) return { note: "缺少图片路径" };
  if (!isCodexImagePath(filePath)) return { note: `不支持的图片格式：${path.basename(filePath)}` };
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return { note: "图片路径不是普通文件" };
    if (stat.size === 0) return { note: "图片文件为空" };
    if (stat.size > MAX_INLINE_IMAGE_BYTES) {
      return { note: `图片过大（${Math.round(stat.size / 1024 / 1024)}MB），未内联` };
    }
    const data = readFileSync(filePath).toString("base64");
    return {
      part: {
        type: "image",
        source: {
          type: "base64",
          media_type: IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()],
          data,
        },
      },
    };
  } catch (error) {
    return { note: `读取图片失败：${getErrorMessage(error)}` };
  }
}

/**
 * `imageGeneration.result` 在部分版本里是内联图片本体：data URL 或裸 base64。
 * 只在能确认是 PNG/JPEG/WebP/GIF 魔数时才认，避免把普通字符串误当图片。
 */
export function codexInlineImagePart(value: unknown): StructuredContentPart | null {
  if (typeof value !== "string" || !value) return null;
  const trimmed = value.trim();
  const dataUrl = /^data:(image\/(?:png|jpeg|jpg|webp|gif|bmp));base64,([A-Za-z0-9+/=\s]+)$/.exec(trimmed);
  if (dataUrl) {
    const data = dataUrl[2].replace(/\s+/g, "");
    if (data.length > 0 && data.length <= MAX_INLINE_IMAGE_BYTES * 2) {
      return { type: "image", source: { type: "base64", media_type: dataUrl[1] === "image/jpg" ? "image/jpeg" : dataUrl[1], data } };
    }
    return null;
  }
  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length < 32 || compact.length > MAX_INLINE_IMAGE_BYTES * 2) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(compact)) return null;
  const head = compact.slice(0, 24);
  const mediaType = head.startsWith("iVBORw0KGgo")
    ? "image/png"
    : head.startsWith("/9j/")
      ? "image/jpeg"
      : head.startsWith("R0lGOD")
        ? "image/gif"
        : head.startsWith("UklGR")
          ? "image/webp"
          : "";
  return mediaType ? { type: "image", source: { type: "base64", media_type: mediaType, data: compact } } : null;
}
