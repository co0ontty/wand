import { Fragment, useMemo, type ReactNode } from "react";
import { localFilePreviewHref, localHttpPreviewHref, localPreviewController } from "../local-preview/controller";
import { classNames } from "../ui/class-names";
import { parseFilePreviewMarkdown, tokenizeFilePreviewCode } from "./model";
import type {
  FilePreviewCodeToken,
  FilePreviewMarkdownBlock,
  FilePreviewMarkdownInline,
} from "./model";

/** Tokenized source, shared by the raw text preview and fenced Markdown blocks. */
export function CodeTokens({ tokens }: { tokens: ReadonlyArray<FilePreviewCodeToken> }) {
  return (
    <>
      {tokens.map((token, index) => token.kind ? (
        <span className={`wand-file-preview-syntax-${token.kind}`} key={index}>{token.value}</span>
      ) : <Fragment key={index}>{token.value}</Fragment>)}
    </>
  );
}

function MarkdownInline({ tokens }: { tokens: ReadonlyArray<FilePreviewMarkdownInline> }) {
  return (
    <>
      {tokens.map((token, index): ReactNode => {
        switch (token.type) {
          case "code": return <code key={index}>{token.value}</code>;
          case "strong": return <strong key={index}>{token.value}</strong>;
          case "emphasis": return <em key={index}>{token.value}</em>;
          case "delete": return <del key={index}>{token.value}</del>;
          case "link": {
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
                {token.value}
              </a>
            ) : (
              <a key={index} href={token.url} target="_blank" rel="noopener noreferrer">{token.value}</a>
            );
          }
          case "image": return <img key={index} src={token.url} alt={token.value} />;
          default: return <Fragment key={index}>{token.value}</Fragment>;
        }
      })}
    </>
  );
}

function MarkdownHeading({ block }: { block: Extract<FilePreviewMarkdownBlock, { type: "heading" }> }) {
  const content = <MarkdownInline tokens={block.content} />;
  switch (block.level) {
    case 1: return <h1>{content}</h1>;
    case 2: return <h2>{content}</h2>;
    case 3: return <h3>{content}</h3>;
    case 4: return <h4>{content}</h4>;
    case 5: return <h5>{content}</h5>;
    default: return <h6>{content}</h6>;
  }
}

function MarkdownBlock({ block }: { block: FilePreviewMarkdownBlock }) {
  switch (block.type) {
    case "heading":
      return <MarkdownHeading block={block} />;
    case "paragraph":
      return <p><MarkdownInline tokens={block.content} /></p>;
    case "blockquote":
      return <blockquote><MarkdownInline tokens={block.content} /></blockquote>;
    case "list": {
      const items = block.items.map((item, index) => <li key={index}><MarkdownInline tokens={item} /></li>);
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
                <th key={index} style={{ textAlign: block.aligns[index] }}><MarkdownInline tokens={cell} /></th>
              ))}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.map((cell, cellIndex) => (
                  <td key={cellIndex} style={{ textAlign: block.aligns[cellIndex] }}><MarkdownInline tokens={cell} /></td>
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
  /** Font size in px; omitted keeps the surrounding stylesheet's size. */
  fontSize?: number;
  /** Soft-wrap long lines instead of forcing the container to scroll. */
  wrap?: boolean;
}

/**
 * Renders the supported Markdown subset as React elements. Both the file
 * preview dialog and the code editor's rendered mode use this entry point, so
 * parsing and sanitising stay in one place; React owns every DOM node.
 */
export function MarkdownPreview({ content, fontSize, wrap }: MarkdownPreviewProps) {
  const blocks = useMemo(() => parseFilePreviewMarkdown(content), [content]);
  return (
    <div
      className={classNames("wand-markdown-preview", wrap && "wrap")}
      style={fontSize == null ? undefined : { fontSize: `${fontSize}px` }}
    >
      {blocks.map((block, index) => <MarkdownBlock block={block} key={index} />)}
    </div>
  );
}
