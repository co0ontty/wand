import { Marked, type MarkedToken, type Token } from "marked";
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

/**
 * Markdown parsing is Marked's job. This module only maps Marked's token stream
 * onto the flat shapes the React renderer consumes, so the viewer keeps one
 * parser and one spelling for every construct. Raw HTML is never interpreted —
 * it stays literal text — and links/images pass an explicit protocol allowlist.
 */
const markdown = new Marked({ gfm: true, breaks: true, async: false });

function safeMarkdownUrl(value: string, image = false): string | null {
  const trimmed = value.trim();
  if (/^(?:https?:|mailto:|#|\/)/i.test(trimmed)) return trimmed;
  if (image && /^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(trimmed)) return trimmed;
  return null;
}

export type FilePreviewMarkdownInline =
  | { type: "text"; value: string }
  | { type: "code" | "strong" | "emphasis" | "delete"; value: string }
  | { type: "link" | "image"; value: string; url: string };

type FilePreviewTableAlignment = "left" | "center" | "right" | undefined;

export type FilePreviewMarkdownBlock =
  | { type: "paragraph" | "blockquote"; content: FilePreviewMarkdownInline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; content: FilePreviewMarkdownInline[] }
  | { type: "list"; ordered: boolean; items: FilePreviewMarkdownInline[][] }
  | { type: "code"; lang: string; value: string }
  | { type: "table"; headers: FilePreviewMarkdownInline[][]; aligns: FilePreviewTableAlignment[]; rows: FilePreviewMarkdownInline[][][] }
  | { type: "rule" };

/** Flattens nested inline tokens to their readable text (used inside emphasis/link). */
function inlineText(tokens: readonly Token[]): string {
  let text = "";
  for (const raw of tokens) {
    const token = raw as MarkedToken;
    if (token.type === "br") { text += "\n"; continue; }
    if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0) {
      text += inlineText(token.tokens);
      continue;
    }
    if ("text" in token && typeof token.text === "string") text += token.text;
  }
  return text;
}

function inlineTokens(tokens: readonly Token[]): FilePreviewMarkdownInline[] {
  const result: FilePreviewMarkdownInline[] = [];
  for (const raw of tokens) {
    const token = raw as MarkedToken;
    switch (token.type) {
      case "text":
        if (token.tokens && token.tokens.length > 0) result.push(...inlineTokens(token.tokens));
        else result.push({ type: "text", value: token.text });
        break;
      case "escape":
      case "html":
        // Raw HTML reaches the DOM as text; React never parses it.
        result.push({ type: "text", value: token.text });
        break;
      case "checkbox":
        result.push({ type: "text", value: token.raw });
        break;
      case "br":
        result.push({ type: "text", value: "\n" });
        break;
      case "codespan":
        result.push({ type: "code", value: token.text });
        break;
      case "strong":
        result.push({ type: "strong", value: inlineText(token.tokens) });
        break;
      case "em":
        result.push({ type: "emphasis", value: inlineText(token.tokens) });
        break;
      case "del":
        result.push({ type: "delete", value: inlineText(token.tokens) });
        break;
      case "link": {
        const url = safeMarkdownUrl(token.href);
        const label = inlineText(token.tokens);
        result.push(url ? { type: "link", value: label, url } : { type: "text", value: label });
        break;
      }
      case "image": {
        const url = safeMarkdownUrl(token.href, true);
        result.push(url ? { type: "image", value: token.text, url } : { type: "text", value: token.text });
        break;
      }
      default:
        if ("tokens" in token && token.tokens && token.tokens.length > 0) result.push(...inlineTokens(token.tokens));
        else if ("text" in token && typeof token.text === "string") result.push({ type: "text", value: token.text });
    }
  }
  return result;
}

function codeText(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

/** Flattens the block tokens of one quote / list item into one inline run. */
type MarkdownListItem = Extract<MarkedToken, { type: "list" }>["items"][number];

/** One list item as one inline run; GFM task markers are part of the label text. */
function listItemInline(item: MarkdownListItem): FilePreviewMarkdownInline[] {
  const content = blockInlineTokens(item.tokens);
  return item.task
    ? [{ type: "text", value: item.checked ? "[x] " : "[ ] " }, ...content]
    : content;
}

function blockInlineTokens(tokens: readonly Token[]): FilePreviewMarkdownInline[] {
  const parts: FilePreviewMarkdownInline[][] = [];
  for (const raw of tokens) {
    const token = raw as MarkedToken;
    switch (token.type) {
      case "paragraph":
      case "text":
        parts.push(inlineTokens(token.tokens ?? []));
        break;
      case "blockquote":
        parts.push(blockInlineTokens(token.tokens));
        break;
      case "list":
        // The flat model has no nested list level: child items join the parent
        // item's text instead of disappearing.
        parts.push(token.items.map(listItemInline)
          .flatMap((item, index) => index === 0 ? item : [{ type: "text" as const, value: "\n" }, ...item]));
        break;
      case "code":
        parts.push([{ type: "text", value: codeText(token.text) }]);
        break;
      case "table":
        parts.push([...token.header, ...token.rows.flat()].map((cell) => inlineTokens(cell.tokens))
          .flatMap((cell, index) => index === 0 ? cell : [{ type: "text" as const, value: " " }, ...cell]));
        break;
      case "space":
      case "def":
      case "hr":
        break;
      default:
        if ("tokens" in token && token.tokens && token.tokens.length > 0) parts.push(inlineTokens(token.tokens));
        else if ("text" in token && typeof token.text === "string") parts.push([{ type: "text", value: token.text }]);
    }
  }
  return parts.flatMap((part, index) => index === 0 ? part : [{ type: "text" as const, value: "\n" }, ...part]);
}

/** Parses Markdown with Marked into data; React owns all resulting DOM. */
export function parseFilePreviewMarkdown(source: string): FilePreviewMarkdownBlock[] {
  const blocks: FilePreviewMarkdownBlock[] = [];
  for (const raw of markdown.lexer(source)) {
    const token = raw as MarkedToken;
    switch (token.type) {
      case "heading":
        blocks.push({
          type: "heading",
          level: Math.min(6, Math.max(1, token.depth)) as 1 | 2 | 3 | 4 | 5 | 6,
          content: inlineTokens(token.tokens),
        });
        break;
      case "paragraph":
        blocks.push({ type: "paragraph", content: inlineTokens(token.tokens) });
        break;
      case "text":
        blocks.push({ type: "paragraph", content: inlineTokens(token.tokens ?? []) });
        break;
      case "html":
        blocks.push({ type: "paragraph", content: [{ type: "text", value: token.text }] });
        break;
      case "blockquote":
        blocks.push({ type: "blockquote", content: blockInlineTokens(token.tokens) });
        break;
      case "list":
        blocks.push({ type: "list", ordered: token.ordered, items: token.items.map(listItemInline) });
        break;
      case "code":
        blocks.push({
          type: "code",
          lang: (token.lang || "").trim().split(/\s+/)[0] || "",
          value: codeText(token.text),
        });
        break;
      case "table":
        blocks.push({
          type: "table",
          headers: token.header.map((cell) => inlineTokens(cell.tokens)),
          aligns: token.align.map((align) => align ?? undefined),
          rows: token.rows.map((row) => row.map((cell) => inlineTokens(cell.tokens))),
        });
        break;
      case "hr":
        blocks.push({ type: "rule" });
        break;
      default:
        break;
    }
  }
  return blocks;
}

export function tokenizeFilePreviewMarkdownInline(source: string): FilePreviewMarkdownInline[] {
  return inlineTokens(markdown.Lexer.lexInline(source, markdown.defaults));
}
