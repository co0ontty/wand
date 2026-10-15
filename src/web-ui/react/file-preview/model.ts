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

export function filePreviewIconName(kind: FilePreviewKind): "image" | "pdf" | "video" | "audio" | "binary" | "file" {
  switch (kind) {
    case "image":
    case "pdf":
    case "video":
    case "audio":
    case "binary":
      return kind;
    default:
      return "file";
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

type FilePreviewCodeTokenKind = "comment" | "string" | "number" | "keyword" | "operator";

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
