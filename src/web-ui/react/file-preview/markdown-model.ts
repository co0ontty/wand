import { Marked, type MarkedToken, type Token } from "marked";
/**
 * Markdown parsing is Marked's job. This module only maps Marked's token stream
 * onto the flat shapes the React renderer consumes, so the viewer keeps one
 * parser and one spelling for every construct. Raw HTML is never interpreted —
 * it stays literal text — and links/images pass an explicit protocol allowlist.
 */
const markdown = new Marked({ gfm: true, breaks: true, async: false });

function safeMarkdownUrl(value: string, image = false): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f]/.test(trimmed) || trimmed.startsWith("//")) return null;
  if (/^(?:https?:|mailto:|#|\/)/i.test(trimmed)) return trimmed;
  if (/^file:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return !url.hostname || url.hostname === "localhost" ? trimmed : null;
    } catch { return null; }
  }
  // Keep relative references as tokens. Only a trusted rendering context may
  // turn them into file URLs; without it the component keeps a plain label.
  if (!/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
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
