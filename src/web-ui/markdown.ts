import { Marked, Renderer } from "marked";
import { localHttpPreviewHref } from "./react/local-preview/controller.js";
import { messageFileTarget, type MessageFileContext } from "./message-file-target.js";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function previewAttributes(value: string, href: string): Array<[string, string]> {
  return [
    ["href", href],
    ["class", "local-preview-link"],
    ["data-local-preview-url", value],
    ["onclick", "if(window.__openLocalPreview){event.preventDefault();window.__openLocalPreview(this.getAttribute('data-local-preview-url'));}"],
  ];
}

function linkAttributes(target: string, context: MessageFileContext): Array<[string, string]> | null {
  const file = messageFileTarget(target, context);
  if (file) {
    if (file.previewUrl) return previewAttributes(file.previewUrl, file.previewUrl);
    return [
      ["href", file.downloadUrl],
      ["class", "server-file-link"],
      ["data-server-file-path", file.path],
      ["data-server-file-url", file.rawUrl],
      ["title", "打开或下载服务端文件"],
      ["onclick", "if(window.__openFilePreview){event.preventDefault();window.__openFilePreview(this.getAttribute('data-server-file-url'));}"],
    ];
  }
  const preview = localHttpPreviewHref(target, context.serverOrigin);
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
function createMarkdown(context: MessageFileContext): Marked {
  const renderer = new Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.link = function({ href, tokens }) {
    const label = this.parser.parseInline(tokens);
    const file = messageFileTarget(href, context);
    const attributes = linkAttributes(href, context);
    if (file?.previewUrl) return '<span class="chat-html-preview" data-html-preview-url="' + escapeHtml(file.previewUrl) +
      '" data-html-download-url="' + escapeHtml(file.downloadUrl) + '" data-html-label="' + escapeHtml(tokens.map(token => "text" in token ? String(token.text) : "").join("")) + '">' +
      '<a href="' + escapeHtml(file.previewUrl) + '" class="local-preview-link" data-local-preview-url="' + escapeHtml(file.path) +
      '" onclick="if(window.__openLocalPreview){event.preventDefault();window.__openLocalPreview(this.getAttribute(\'href\'));}">' + label + '</a></span>';
    if (!attributes) return "<span>" + label + "</span>";
    return "<a" + attributes.map(([name, value]) => " " + name + '="' + escapeHtml(value) + '"').join("") + ">" + label + "</a>";
  };
  renderer.image = ({ href, text, title }) => {
    const file = messageFileTarget(href, context);
    const src = file?.rawUrl || href;
    if (!file && !/^https?:\/\//i.test(href) && (!href.startsWith("/") || href.startsWith("//"))) return escapeHtml(text);
    return '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(text) + '"' +
      (title ? ' title="' + escapeHtml(title) + '"' : "") + ' loading="lazy" decoding="async" role="button" tabindex="0"' +
      ' aria-label="查看' + escapeHtml(text || "图片") + '" onclick="event.stopPropagation();window.__openImageViewer?.(this);"' +
      ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}">';
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
  return new Marked({ renderer, breaks: true, gfm: true, async: false });
}
const markdown = createMarkdown({});

/** Shared parser with source-session-bound local-file adaptations. */
export function renderChatMarkdown(text: string, context: MessageFileContext = {}): string {
  if (!text) return "";
  return '<div class="markdown-content">' + (context.cwd || context.sessionId || context.serverOrigin ? createMarkdown(context) : markdown).parse(text, { async: false }) + "</div>";
}
