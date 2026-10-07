import { Marked, Renderer } from "marked";
import { localFilePreviewHref, localHttpPreviewHref } from "./react/local-preview/controller.js";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function serverFilePath(target: string): string | null {
  let value = target.trim();
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return null;
      value = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  } else {
    if (!value.startsWith("/") || value.startsWith("//")) return null;
    try { value = decodeURIComponent(value); } catch { /* Keep literal percent signs. */ }
  }
  if (/^\/(?:api|android|macos)(?:\/|$)/.test(value)) return null;
  return value.replace(/#L\d+(?:C\d+)?$/i, "").replace(/:\d+(?::\d+)?$/, "");
}

function previewAttributes(value: string, href: string): Array<[string, string]> {
  return [
    ["href", href],
    ["class", "local-preview-link"],
    ["data-local-preview-url", value],
    ["onclick", "if(window.__openLocalPreview){event.preventDefault();window.__openLocalPreview(this.getAttribute('data-local-preview-url'));}"],
  ];
}

function linkAttributes(target: string): Array<[string, string]> | null {
  const path = serverFilePath(target);
  if (path) {
    const preview = /(?:\/$|\.(?:html?|)$)/i.test(path) ? localFilePreviewHref(path) : null;
    if (preview) return previewAttributes(path, preview);
    return [
      ["href", "/api/file-raw?download=1&path=" + encodeURIComponent(path)],
      ["class", "server-file-link"],
      ["data-server-file-path", path],
      ["title", "打开或下载服务端文件"],
      ["onclick", "if(window.__openFilePreview){event.preventDefault();window.__openFilePreview(this.getAttribute('data-server-file-path'));}"],
    ];
  }
  const preview = localHttpPreviewHref(target);
  if (preview) return previewAttributes(target, preview);
  if (/^https?:\/\//i.test(target)) {
    return [["href", target], ["target", "_blank"], ["rel", "noopener noreferrer"]];
  }
  if (/^(?:mailto:|#)/i.test(target)) return [["href", target]];
  return null;
}

// Marked parses Markdown; this renderer owns only Wand's output contracts.
// Raw HTML is text, and links/images use explicit protocol allowlists. Never
// enable raw HTML or accept renderer extensions from message content.
const renderer = new Renderer();
renderer.html = ({ text }) => escapeHtml(text);
renderer.link = function({ href, tokens }) {
  const label = this.parser.parseInline(tokens);
  const attributes = linkAttributes(href);
  if (!attributes) return "<span>" + label + "</span>";
  return "<a" + attributes.map(([name, value]) => " " + name + '="' + escapeHtml(value) + '"').join("") + ">" + label + "</a>";
};
renderer.image = ({ href, text, title }) => {
  if (!/^https?:\/\//i.test(href) && (!href.startsWith("/") || href.startsWith("//"))) return escapeHtml(text);
  return '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(text) + '"' +
    (title ? ' title="' + escapeHtml(title) + '"' : "") + ' loading="lazy" decoding="async">';
};
renderer.heading = function({ depth, tokens }) {
  const tag = "h" + Math.min(depth + 1, 6);
  return "<" + tag + ">" + this.parser.parseInline(tokens) + "</" + tag + ">\n";
};
renderer.codespan = ({ text }) => '<code class="code-inline">' + escapeHtml(text) + "</code>";
renderer.code = ({ text, lang }) => {
  const language = (lang || "").trim().split(/\s+/)[0];
  const content = text.endsWith("\n") ? text : text + "\n";
  return '<div class="code-block"><div class="code-block-header">' +
    '<span class="code-lang">' + escapeHtml(language) + "</span>" +
    '<button type="button" data-antd-control class="code-copy">复制</button></div>' +
    "<pre><code>" + escapeHtml(content) + "</code></pre></div>\n";
};
renderer.tablecell = function({ header, align, tokens }) {
  const tag = header ? "th" : "td";
  const alignment = align ? ' style="text-align:' + align + '"' : "";
  return "<" + tag + alignment + ">" + this.parser.parseInline(tokens) + "</" + tag + ">\n";
};
const renderTable = renderer.table;
renderer.table = function(token) {
  return '<div class="md-table-wrap">' + renderTable.call(this, token)
    .replace("<table>", '<table class="md-table">') + "</div>\n";
};
const markdown = new Marked({ renderer, breaks: true, gfm: true, async: false });

/** Shared parser with only Wand's presentation and local-link adaptations. */
export function renderChatMarkdown(text: string): string {
  if (!text) return "";
  return '<div class="markdown-content">' + markdown.parse(text, { async: false }) + "</div>";
}
