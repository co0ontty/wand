import * as React from "react";
import type { ReactNode } from "react";
import { messageFileTarget, type MessageFileContext as FileContext } from "../../message-file-target.js";
import { InlineHtmlPreview } from "../local-preview/inline";

export const MessageFileContext = React.createContext<FileContext>({});
import { localFilePreviewHref, localHttpPreviewHref, localPreviewController } from "../local-preview/controller";
import { classNames } from "../ui/class-names";
import { openMessageImage } from "../image-viewer/gallery";
import { tokenizeFilePreviewCode, type FilePreviewCodeToken } from "./model";
import { parseFilePreviewMarkdown } from "./markdown-model";
import type {
  FilePreviewMarkdownBlock,
  FilePreviewMarkdownInline,
} from "./markdown-model";

/** Tokenized source, shared by the raw text preview and fenced Markdown blocks. */
export function CodeTokens({ tokens }: { tokens: ReadonlyArray<FilePreviewCodeToken> }) {
  return (
    <>
      {tokens.map((token, index) => token.kind ? (
        <span className={`wand-file-preview-syntax-${token.kind}`} key={index}>{token.value}</span>
      ) : <React.Fragment key={index}>{token.value}</React.Fragment>)}
    </>
  );
}

function MarkdownInline({ tokens, renderText }: {
  tokens: ReadonlyArray<FilePreviewMarkdownInline>;
  renderText?: (value: string) => ReactNode;
}) {
  // 纯文本片段的自定义渲染（群聊用它保留 @成员名 token）；不传就是原样文本。
  const text = (value: string): ReactNode => renderText ? renderText(value) : value;
  const fileContext = React.useContext(MessageFileContext);
  return (
    <>
      {tokens.map((token, index): ReactNode => {
        switch (token.type) {
          case "code": return <code key={index}>{token.value}</code>;
          case "strong": return <strong key={index}>{text(token.value)}</strong>;
          case "emphasis": return <em key={index}>{text(token.value)}</em>;
          case "delete": return <del key={index}>{text(token.value)}</del>;
          case "link": {
            const file = messageFileTarget(token.url, fileContext);
            if (file?.previewUrl) return <InlineHtmlPreview key={index} previewUrl={file.previewUrl} downloadUrl={file.downloadUrl} label={token.value}/>;
            if (file) return <a key={index} href={file.downloadUrl}>{text(token.value)}</a>;
            if (!/^(?:https?:|mailto:|#|\/)/i.test(token.url)) return <React.Fragment key={index}>{text(token.value)}</React.Fragment>;
            const isServerHtmlPath = token.url.startsWith("/") && /\.(?:html?|)$/i.test(token.url);
            const localHref = isServerHtmlPath
              ? localFilePreviewHref(token.url)
              : localHttpPreviewHref(token.url);
            return localHref ? (
              <a
                key={index}
                href={localHref}
                onClick={(event) => {
                  event.preventDefault();
                  if (isServerHtmlPath) localPreviewController.openFile(token.url);
                  else localPreviewController.openUrl(token.url);
                }}
              >
                {text(token.value)}
              </a>
            ) : (
              <a key={index} href={token.url} target="_blank" rel="noopener noreferrer">{text(token.value)}</a>
            );
          }
          case "image": {
            const file = messageFileTarget(token.url, fileContext);
            if (!file && !/^(?:https?:|data:image\/|\/)/i.test(token.url)) return <React.Fragment key={index}>{token.value}</React.Fragment>;
            return <img key={index} src={file?.rawUrl || token.url} alt={token.value} role="button" tabIndex={0}
            aria-label={`查看${token.value || "图片"}`} onClick={event => { event.stopPropagation(); openMessageImage(event.currentTarget); }}
            onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.click(); } }}/>;
          }
          default: return <React.Fragment key={index}>{text(token.value)}</React.Fragment>;
        }
      })}
    </>
  );
}

// 内容区标题整体下移一级：文件预览对话框的标题是 h2（Base UI Dialog.Title 默认渲染
// h2），正文再出 h1 就会盖过它；编辑器渲染模式没有标题元素，只有一个
// aria-label=`${file.name} 预览` 的容器，同样不该在内部冒出 h1。
// 元素最深只用到 h3：markdown-styles.ts 的标题间距规则只覆盖 h1..h3（而且它们共享
// 同一条规则），落到 h4 连这段间距都没有。所以第 4 级往下仍用 h3 拿样式，
// 真实层级交给 aria-level。
function MarkdownHeading({ block, renderText }: {
  block: Extract<FilePreviewMarkdownBlock, { type: "heading" }>;
  renderText?: (value: string) => ReactNode;
}) {
  const content = <MarkdownInline tokens={block.content} renderText={renderText}/>;
  const level = Math.min(block.level + 1, 6);
  const Tag: "h2" | "h3" = level === 2 ? "h2" : "h3";
  if (level <= 3) return <Tag>{content}</Tag>;
  return <Tag role="heading" aria-level={level}>{content}</Tag>;
}

function MarkdownBlock({ block, renderText }: {
  block: FilePreviewMarkdownBlock;
  renderText?: (value: string) => ReactNode;
}) {
  switch (block.type) {
    case "heading":
      return <MarkdownHeading block={block} renderText={renderText}/>;
    case "paragraph":
      return <p><MarkdownInline tokens={block.content} renderText={renderText}/></p>;
    case "blockquote":
      return <blockquote><MarkdownInline tokens={block.content} renderText={renderText}/></blockquote>;
    case "list": {
      const items = block.items.map((item, index) => <li key={index}><MarkdownInline tokens={item} renderText={renderText}/></li>);
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "code":
      return (
        <pre data-language={block.lang || undefined}>
          <code><CodeTokens tokens={tokenizeFilePreviewCode(block.value)} /></code>
        </pre>
      );
    case "table":
      return (
        <div className="wand-markdown-table-wrap">
          <table>
            <thead>
              <tr>{block.headers.map((cell, index) => (
                <th key={index} style={{ textAlign: block.aligns[index] }}><MarkdownInline tokens={cell} renderText={renderText}/></th>
              ))}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.map((cell, cellIndex) => (
                  <td key={cellIndex} style={{ textAlign: block.aligns[cellIndex] }}><MarkdownInline tokens={cell} renderText={renderText}/></td>
                ))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr />;
  }
}

export interface MarkdownPreviewProps {
  content: string;
  /** Trusted source session/directory, not a model-provided base URL. */
  fileContext?: FileContext;
  /** Font size in px; omitted keeps the surrounding stylesheet's size. */
  fontSize?: number;
  /** Soft-wrap long lines instead of forcing the container to scroll. */
  wrap?: boolean;
  /**
   * `page`（默认）是对话框/编辑器里的纸面排版；`inline` 去掉纸面（宽度、内边距、底色、
   * 行高）只留正文排版，供消息气泡复用同一份解析与转义。
   */
  variant?: "page" | "inline";
  /** 纯文本片段的自定义渲染（群聊用它把 @成员名 交回自己的 token）；不传就是原样文本。 */
  renderText?: (value: string) => ReactNode;
}

/**
 * Renders the supported Markdown subset as React elements. The file preview
 * dialog, the code editor's rendered mode and the chat message bodies use this
 * entry point, so parsing and sanitising stay in one place; React owns every DOM node.
 */
export function MarkdownPreview({ content, fontSize, wrap, variant = "page", renderText, fileContext }: MarkdownPreviewProps) {
  const inherited = React.useContext(MessageFileContext);
  const blocks = React.useMemo(() => parseFilePreviewMarkdown(content), [content]);
  return (
    <MessageFileContext.Provider value={fileContext || inherited}><div
      className={classNames("wand-markdown-preview", variant === "inline" && "wand-markdown-preview-inline", wrap && "wrap")}
      style={fontSize == null ? undefined : { fontSize: `${fontSize}px` }}
    >
      {blocks.map((block, index) => <MarkdownBlock block={block} renderText={renderText} key={index} />)}
    </div></MessageFileContext.Provider>
  );
}
