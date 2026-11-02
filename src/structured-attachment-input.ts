import { statSync } from "node:fs";
import path from "node:path";

/**
 * Wand 四端上传附件后统一在 prompt 前注入一段路径前缀（Web `buildAttachmentPrefix`、
 * macOS `ChatView`、Android `ChatComposer`、iOS 同款）：
 *
 *   [附件已上传，请查看以下文件:\n<path1>\n<path2>\n]\n\n<正文>
 *
 * 这段前缀既是聊天里的附件展示依据，也是服务端唯一可用的附件清单。结构化 provider 若支持
 * 原生多模态输入（Codex app-server 的 `localImage`），必须把其中的图片路径映射成原生输入，
 * 否则模型只能看到一行路径文本，等于没有看图能力。
 *
 * 只认这条 Wand 自有协议，不从自由文本里猜路径：用户正文里出现的图片路径仍按普通文本处理。
 */
const ATTACHMENT_PREFIX_RE = /^\s*\[附件已上传，请查看以下文件:\r?\n([\s\S]*?)\]\r?\n+/;

/** Codex `localImage` 支持的位图格式；heic/svg 等交给模型按路径读取，不冒充原生图片。 */
const NATIVE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

/** 单轮原生图片输入上限：Codex 侧同样有数量预算，过多图片只会挤占上下文。 */
const MAX_NATIVE_IMAGES = 10;
const MAX_NATIVE_IMAGE_BYTES = 20 * 1024 * 1024;

export interface ParsedAttachmentPrompt {
  /** 去掉附件前缀后的正文；没有前缀时原样返回。 */
  text: string;
  /** 前缀里列出的全部绝对路径（未做存在性/类型过滤）。 */
  paths: string[];
}

export function parseAttachmentPrompt(prompt: string): ParsedAttachmentPrompt {
  const match = ATTACHMENT_PREFIX_RE.exec(prompt);
  if (!match) return { text: prompt, paths: [] };
  const paths = match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { text: prompt.slice(match[0].length), paths };
}

/**
 * 从附件前缀里挑出可以走 Codex 原生图片输入的文件。
 *
 * 只返回「绝对路径 + 真实存在的普通文件 + 受支持的位图后缀 + 有界大小」的条目；
 * 其余附件（PDF、代码、目录、丢失文件）保持原样留在文本前缀里，由模型按路径读取。
 */
export function nativeImagePaths(prompt: string): string[] {
  const { paths } = parseAttachmentPrompt(prompt);
  const images: string[] = [];
  for (const candidate of paths) {
    if (images.length >= MAX_NATIVE_IMAGES) break;
    if (!path.isAbsolute(candidate)) continue;
    if (!NATIVE_IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) continue;
    try {
      const stat = statSync(candidate);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_NATIVE_IMAGE_BYTES) continue;
    } catch {
      continue;
    }
    images.push(candidate);
  }
  return images;
}

/** Codex `UserInput` 里的原生图片 part（app-server `localImage`）。 */
export function codexLocalImageInputs(paths: readonly string[] | undefined): Array<{ type: "localImage"; path: string }> {
  if (!paths?.length) return [];
  return paths.slice(0, MAX_NATIVE_IMAGES)
    // 绝对路径 + 位图后缀：即便上游传错，也不能把文本文件当图片发给模型。
    .filter((value) => typeof value === "string" && path.isAbsolute(value)
      && NATIVE_IMAGE_EXTENSIONS.has(path.extname(value).toLowerCase()))
    .map((value) => ({ type: "localImage" as const, path: value }));
}
