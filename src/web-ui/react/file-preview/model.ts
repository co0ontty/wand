import type {
  FilePreviewFile,
  FilePreviewKind,
  FilePreviewOpenRequest,
  FilePreviewSibling,
} from "./types";

const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 22;

export function fileNameFromPath(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized || "file";
}

export function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index).toLowerCase() : "";
}

export function normalizeFilePreviewRequest(
  input: FilePreviewOpenRequest | string,
): FilePreviewOpenRequest | null {
  const request = typeof input === "string" ? { path: input } : input;
  const path = request.path.trim();
  if (!path) return null;
  const seen = new Set<string>();
  const siblings: FilePreviewSibling[] = [];
  for (const item of request.siblings ?? []) {
    const siblingPath = item.path.trim();
    if (!siblingPath || item.type === "dir" || seen.has(siblingPath)) continue;
    seen.add(siblingPath);
    siblings.push({
      path: siblingPath,
      name: item.name?.trim() || fileNameFromPath(siblingPath),
      type: "file",
    });
  }
  return { path, siblings };
}

export function nextFilePreviewSibling(
  request: FilePreviewOpenRequest | null,
  direction: -1 | 1,
): FilePreviewSibling | null {
  const siblings = request?.siblings ?? [];
  if (siblings.length < 2 || !request) return null;
  const currentIndex = siblings.findIndex((item) => item.path === request.path);
  if (currentIndex < 0) return null;
  const nextIndex = (currentIndex + direction + siblings.length) % siblings.length;
  const next = siblings[nextIndex];
  return next && next.path !== request.path ? next : null;
}

export function clampFilePreviewFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FONT_SIZE;
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(value)));
}

export function defaultFilePreviewFontSize(): number {
  return DEFAULT_FONT_SIZE;
}

export function formatFilePreviewSize(value: number | undefined): string {
  const size = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  if (size < 1024) return `${Math.round(size)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = size / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

export function filePreviewKindLabel(file: Pick<FilePreviewFile, "kind" | "lang" | "ext">): string {
  if (file.kind === "text") return file.lang || file.ext.replace(/^\./, "") || "text";
  const labels: Record<Exclude<FilePreviewKind, "text">, string> = {
    image: "图片",
    pdf: "PDF",
    video: "视频",
    audio: "音频",
    binary: "二进制",
  };
  return labels[file.kind] || file.ext.replace(/^\./, "") || file.kind;
}

export function filePreviewIcon(kind: FilePreviewKind): string {
  switch (kind) {
    case "image": return "▧";
    case "pdf": return "PDF";
    case "video": return "▶";
    case "audio": return "♫";
    case "binary": return "◇";
    default: return "≡";
  }
}

export function isMarkdownPreview(file: Pick<FilePreviewFile, "lang" | "name">): boolean {
  return file.lang === "markdown" || /\.(md|markdown|mdx)$/i.test(file.name);
}

export function shellQuoteFilePath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

const KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "default", "def", "delete", "do", "else", "enum", "export", "extends",
  "false", "finally", "fn", "for", "from", "func", "function", "go", "if", "impl",
  "import", "in", "instanceof", "interface", "let", "match", "mod", "new", "nil", "null",
  "of", "package", "pass", "private", "protected", "pub", "public", "raise", "readonly",
  "return", "self", "static", "struct", "super", "switch", "throw", "trait", "true", "try",
  "type", "typeof", "undefined", "unsafe", "use", "var", "void", "while", "with", "yield",
]);

const CODE_TOKEN = /\/\/[^\n]*|#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:0x[\da-fA-F]+|0b[01]+|\d+(?:\.\d+)?)\b|\b[A-Za-z_$][\w$]*\b|[+\-*/%=<>!&|^~?:]+/g;

export type FilePreviewCodeTokenKind = "comment" | "string" | "number" | "keyword" | "operator";

export interface FilePreviewCodeToken {
  value: string;
  kind?: FilePreviewCodeTokenKind;
}

export function tokenizeFilePreviewCode(source: string): FilePreviewCodeToken[] {
  const tokens: FilePreviewCodeToken[] = [];
  let offset = 0;
  for (const match of source.matchAll(CODE_TOKEN)) {
    const index = match.index ?? 0;
    if (index > offset) tokens.push({ value: source.slice(offset, index) });
    const token = match[0];
    let kind: FilePreviewCodeTokenKind | undefined;
    if (token.startsWith("//") || token.startsWith("#")) kind = "comment";
    else if (/^["'`]/.test(token)) kind = "string";
    else if (/^(?:0x|0b|\d)/.test(token)) kind = "number";
    else if (KEYWORDS.has(token)) kind = "keyword";
    else if (/^[+\-*/%=<>!&|^~?:]+$/.test(token)) kind = "operator";
    tokens.push({ value: token, kind });
    offset = index + token.length;
  }
  if (offset < source.length) tokens.push({ value: source.slice(offset) });
  return tokens;
}

function safeMarkdownUrl(value: string, image = false): string | null {
  const trimmed = value.trim();
  if (/^(?:https?:|mailto:|#|\/)/i.test(trimmed)) return trimmed;
  if (image && /^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(trimmed)) return trimmed;
  return null;
}

function splitMarkdownRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split("|");
}

export type FilePreviewMarkdownInline =
  | { type: "text"; value: string }
  | { type: "code" | "strong" | "emphasis" | "delete"; value: string }
  | { type: "link" | "image"; value: string; url: string };

export type FilePreviewTableAlignment = "left" | "center" | "right" | undefined;

export type FilePreviewMarkdownBlock =
  | { type: "paragraph" | "blockquote"; content: FilePreviewMarkdownInline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; content: FilePreviewMarkdownInline[] }
  | { type: "list"; ordered: boolean; items: FilePreviewMarkdownInline[][] }
  | { type: "code"; lang: string; value: string }
  | { type: "table"; headers: FilePreviewMarkdownInline[][]; aligns: FilePreviewTableAlignment[]; rows: FilePreviewMarkdownInline[][][] }
  | { type: "rule" };

const INLINE_MARKDOWN = /(!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*)/g;

export function tokenizeFilePreviewMarkdownInline(source: string): FilePreviewMarkdownInline[] {
  const tokens: FilePreviewMarkdownInline[] = [];
  let offset = 0;
  for (const match of source.matchAll(INLINE_MARKDOWN)) {
    const index = match.index ?? 0;
    if (index > offset) tokens.push({ type: "text", value: source.slice(offset, index) });
    const value = match[0];
    const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(value);
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value);
    if (image) {
      const url = safeMarkdownUrl(image[2], true);
      tokens.push(url ? { type: "image", value: image[1], url } : { type: "text", value: image[1] });
    } else if (link) {
      const url = safeMarkdownUrl(link[2]);
      tokens.push(url ? { type: "link", value: link[1], url } : { type: "text", value: link[1] });
    } else if (value.startsWith("`")) {
      tokens.push({ type: "code", value: value.slice(1, -1) });
    } else if (value.startsWith("**")) {
      tokens.push({ type: "strong", value: value.slice(2, -2) });
    } else if (value.startsWith("~~")) {
      tokens.push({ type: "delete", value: value.slice(2, -2) });
    } else {
      tokens.push({ type: "emphasis", value: value.slice(1, -1) });
    }
    offset = index + value.length;
  }
  if (offset < source.length) tokens.push({ type: "text", value: source.slice(offset) });
  return tokens;
}

function startsMarkdownBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  const next = lines[index + 1]?.trim() ?? "";
  return /^```/.test(line)
    || /^#{1,6}\s+/.test(line)
    || /^>\s?/.test(line)
    || /^[-*]\s+/.test(line)
    || /^\d+\.\s+/.test(line)
    || /^(?:---+|\*\*\*+)$/.test(line.trim())
    || (line.includes("|") && /^\|?\s*:?-+:?(\s*\|\s*:?-+:?)+\s*\|?$/.test(next));
}

/** Parses a safe Markdown subset into data; React owns all resulting DOM. */
export function parseFilePreviewMarkdown(source: string): FilePreviewMarkdownBlock[] {
  const lines = source.split("\n");
  const blocks: FilePreviewMarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = /^```([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        content.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", lang: fence[1], value: content.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        content: tokenizeFilePreviewMarkdownInline(heading[2]),
      });
      index += 1;
      continue;
    }
    if (/^(?:---+|\*\*\*+)$/.test(line.trim())) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }
    const separator = lines[index + 1]?.trim() ?? "";
    if (line.includes("|") && /^\|?\s*:?-+:?(\s*\|\s*:?-+:?)+\s*\|?$/.test(separator)) {
      const headers = splitMarkdownRow(line).map((cell) => tokenizeFilePreviewMarkdownInline(cell.trim()));
      const aligns: FilePreviewTableAlignment[] = splitMarkdownRow(separator).map((cell) => {
        const value = cell.trim();
        if (value.startsWith(":") && value.endsWith(":")) return "center";
        if (value.endsWith(":")) return "right";
        if (value.startsWith(":")) return "left";
        return undefined;
      });
      const rows: FilePreviewMarkdownInline[][][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(splitMarkdownRow(lines[index]).map((cell) => tokenizeFilePreviewMarkdownInline(cell.trim())));
        index += 1;
      }
      blocks.push({ type: "table", headers, aligns, rows });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", content: tokenizeFilePreviewMarkdownInline(quote.join("\n")) });
      continue;
    }
    const unordered = /^[-*]\s+/.test(line);
    const ordered = /^\d+\.\s+/.test(line);
    if (unordered || ordered) {
      const items: FilePreviewMarkdownInline[][] = [];
      const itemPattern = ordered ? /^\d+\.\s+(.*)$/ : /^[-*]\s+(.*)$/;
      while (index < lines.length) {
        const item = itemPattern.exec(lines[index]);
        if (!item) break;
        items.push(tokenizeFilePreviewMarkdownInline(item[1]));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsMarkdownBlock(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", content: tokenizeFilePreviewMarkdownInline(paragraph.join("\n")) });
  }
  return blocks;
}
