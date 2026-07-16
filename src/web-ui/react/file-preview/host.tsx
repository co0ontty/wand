import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { WandButton, WandDialogSurface } from "../ui";
import { filePreviewController, filePreviewStore } from "./controller";
import {
  fileNameFromPath,
  filePreviewIcon,
  filePreviewKindLabel,
  formatFilePreviewSize,
  isMarkdownPreview,
  nextFilePreviewSibling,
  parseFilePreviewMarkdown,
  tokenizeFilePreviewCode,
} from "./model";
import { filePreviewStyles } from "./styles";
import type {
  FilePreviewCodeToken,
  FilePreviewMarkdownBlock,
  FilePreviewMarkdownInline,
} from "./model";
import type { FilePreviewFile, FilePreviewSnapshot } from "./types";

function run(command: Parameters<typeof filePreviewController.execute>[0]): void {
  void filePreviewController.execute(command);
}

function DownloadLink({ file, label = "下载" }: { file: Pick<FilePreviewFile, "url" | "name">; label?: string }) {
  return (
    <a className="wand-file-preview-download" href={file.url} download={file.name}>
      {label}
    </a>
  );
}

function CodeTokens({ tokens }: { tokens: ReadonlyArray<FilePreviewCodeToken> }) {
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
          case "link": return <a key={index} href={token.url} target="_blank" rel="noopener noreferrer">{token.value}</a>;
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
        <div className="wand-file-preview-table-wrap">
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

function TextPreview({ snapshot, file }: { snapshot: FilePreviewSnapshot; file: FilePreviewFile }) {
  const content = file.content ?? "";
  if (isMarkdownPreview(file)) {
    return (
      <div
        className={`wand-file-preview-markdown${snapshot.wrap ? " wrap" : ""}`}
        style={{ fontSize: `${snapshot.fontSize}px` }}
      >
        {parseFilePreviewMarkdown(content).map((block, index) => <MarkdownBlock block={block} key={index} />)}
      </div>
    );
  }
  const lineCount = Math.max(1, content.split("\n").length);
  return (
    <div className={`wand-file-preview-code${snapshot.wrap ? " wrap" : ""}`}>
      <pre
        aria-hidden="true"
        className="wand-file-preview-lines"
        style={{ fontSize: `${snapshot.fontSize}px` }}
      >
        {Array.from({ length: lineCount }, (_value, index) => index + 1).join("\n")}
      </pre>
      <pre
        className="wand-file-preview-code-content"
        style={{ fontSize: `${snapshot.fontSize}px` }}
      >
        <code><CodeTokens tokens={tokenizeFilePreviewCode(content)} /></code>
      </pre>
    </div>
  );
}

function BinaryPreview({ file }: { file: FilePreviewFile }) {
  return (
    <div className="wand-file-preview-binary">
      <span className="wand-file-preview-binary-icon" aria-hidden="true">◇</span>
      <strong>{file.name}</strong>
      <div className="wand-file-preview-binary-meta">
        <span>{file.ext.replace(/^\./, "") || "未知格式"}</span>
        <span aria-hidden="true">·</span>
        <span>{formatFilePreviewSize(file.size)}</span>
      </div>
      <code>{file.path}</code>
      <div className="wand-file-preview-binary-actions">
        <DownloadLink file={file} label="下载文件" />
        <WandButton size="small" onClick={() => run({ type: "composer.cat" })}>
          在终端中查看
        </WandButton>
      </div>
    </div>
  );
}

function PreviewBody({ snapshot, editorRef }: {
  snapshot: FilePreviewSnapshot;
  editorRef: RefObject<HTMLTextAreaElement | null>;
}) {
  if (snapshot.status === "loading") {
    return <div className="wand-file-preview-state" role="status">正在加载预览…</div>;
  }
  if (snapshot.status === "error") {
    return (
      <div className="wand-file-preview-state wand-file-preview-error" role="alert">
        <span aria-hidden="true">!</span>
        <strong>{snapshot.failure?.message || "加载预览失败"}</strong>
        {snapshot.failure?.size != null ? <small>文件大小：{formatFilePreviewSize(snapshot.failure.size)}</small> : null}
        {snapshot.failure?.download ? <DownloadLink file={snapshot.failure.download} label="仍然下载文件" /> : null}
      </div>
    );
  }
  const file = snapshot.file;
  if (!file) return <div className="wand-file-preview-state">选择文件后将在这里显示预览。</div>;
  if (snapshot.editing) {
    return (
      <div className="wand-file-preview-editor">
        <textarea
          ref={editorRef}
          aria-label={`编辑 ${file.name}`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          wrap="off"
          value={snapshot.draft}
          onChange={(event) => run({ type: "edit.change", value: event.currentTarget.value })}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            event.preventDefault();
            const input = event.currentTarget;
            const start = input.selectionStart;
            const end = input.selectionEnd;
            const value = `${snapshot.draft.slice(0, start)}  ${snapshot.draft.slice(end)}`;
            run({ type: "edit.change", value });
            requestAnimationFrame(() => {
              input.selectionStart = start + 2;
              input.selectionEnd = start + 2;
            });
          }}
        />
      </div>
    );
  }
  switch (file.kind) {
    case "image":
      return (
        <button
          type="button"
          className={`wand-file-preview-image${snapshot.imageZoomed ? " zoomed" : ""}`}
          aria-label={snapshot.imageZoomed ? "缩小图片" : "放大图片"}
          onClick={() => run({ type: "view.image.zoom.toggle" })}
        >
          <img src={file.rawUrl} alt={file.name} />
        </button>
      );
    case "pdf":
      return <iframe className="wand-file-preview-pdf" src={file.rawUrl} title={file.name} />;
    case "video":
      return (
        <div className="wand-file-preview-media">
          <video controls preload="metadata" src={file.rawUrl}>您的浏览器不支持视频预览。</video>
          <span>{formatFilePreviewSize(file.size)}</span>
        </div>
      );
    case "audio":
      return (
        <div className="wand-file-preview-media wand-file-preview-audio">
          <span className="wand-file-preview-media-icon" aria-hidden="true">♫</span>
          <strong>{file.name}</strong>
          <audio controls preload="metadata" src={file.rawUrl}>您的浏览器不支持音频预览。</audio>
          <span>{formatFilePreviewSize(file.size)}</span>
        </div>
      );
    case "binary":
      return <BinaryPreview file={file} />;
    default:
      return <TextPreview snapshot={snapshot} file={file} />;
  }
}

function PreviewToolbar({ snapshot }: { snapshot: FilePreviewSnapshot }) {
  const previous = nextFilePreviewSibling(snapshot.request, -1);
  const next = nextFilePreviewSibling(snapshot.request, 1);
  const file = snapshot.file;
  return (
    <div className={`wand-file-preview-toolbar${snapshot.editing ? " editing" : ""}`} aria-label="文件预览工具栏">
      <div className="wand-file-preview-toolbar-group">
        <WandButton
          size="small"
          kind="ghost"
          aria-label="上一个文件"
          title={previous ? `上一个文件：${previous.name}` : "没有上一个文件"}
          disabled={!previous || snapshot.editing || snapshot.saving}
          onClick={() => run({ type: "navigate", direction: -1 })}
        >
          ←
        </WandButton>
        <WandButton
          size="small"
          kind="ghost"
          aria-label="下一个文件"
          title={next ? `下一个文件：${next.name}` : "没有下一个文件"}
          disabled={!next || snapshot.editing || snapshot.saving}
          onClick={() => run({ type: "navigate", direction: 1 })}
        >
          →
        </WandButton>
      </div>

      {snapshot.editing ? (
        <div className="wand-file-preview-toolbar-group wand-file-preview-edit-actions">
          <WandButton kind="primary" size="small" disabled={snapshot.saving} onClick={() => run({ type: "edit.save" })}>
            {snapshot.saving ? "保存中…" : "保存"}
          </WandButton>
          <WandButton size="small" disabled={snapshot.saving || !snapshot.dirty} onClick={() => run({ type: "edit.revert" })}>
            撤销改动
          </WandButton>
          <WandButton size="small" disabled={snapshot.saving} onClick={() => run({ type: "edit.exit" })}>
            退出编辑
          </WandButton>
        </div>
      ) : file ? (
        <>
          <div className="wand-file-preview-toolbar-group">
            {file.kind === "text" ? (
              <WandButton kind="primary" size="small" onClick={() => run({ type: "edit.enter" })}>
                编辑
              </WandButton>
            ) : null}
            <WandButton size="small" onClick={() => run({ type: "copy.path" })}>复制路径</WandButton>
            <WandButton size="small" onClick={() => run({ type: "composer.path" })}>粘贴到输入框</WandButton>
            <DownloadLink file={file} />
          </div>
          {file.kind === "text" ? (
            <div className="wand-file-preview-toolbar-group">
              <WandButton size="small" onClick={() => run({ type: "copy.content" })}>复制内容</WandButton>
              <WandButton
                size="small"
                kind={snapshot.wrap ? "primary" : "secondary"}
                aria-pressed={snapshot.wrap}
                onClick={() => run({ type: "view.wrap.toggle" })}
              >
                自动换行
              </WandButton>
              <WandButton size="small" aria-label="缩小字号" onClick={() => run({ type: "view.font.adjust", delta: -1 })}>A−</WandButton>
              <span className="wand-file-preview-font-size" aria-label={`字号 ${snapshot.fontSize}`}>{snapshot.fontSize}</span>
              <WandButton size="small" aria-label="放大字号" onClick={() => run({ type: "view.font.adjust", delta: 1 })}>A+</WandButton>
            </div>
          ) : null}
        </>
      ) : snapshot.failure?.download ? (
        <DownloadLink file={snapshot.failure.download} />
      ) : null}
    </div>
  );
}

export function FilePreviewHost() {
  const snapshot = useSyncExternalStore(
    filePreviewStore.subscribe,
    filePreviewStore.getSnapshot,
    filePreviewStore.getSnapshot,
  );
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!snapshot.editing) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    editor.setSelectionRange(0, 0);
    editor.scrollTop = 0;
  }, [snapshot.editing]);

  const path = snapshot.request?.path ?? "";
  const title = snapshot.file?.name || (path ? fileNameFromPath(path) : "文件预览");
  const file = snapshot.file;

  function handleKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && snapshot.editing) {
      event.preventDefault();
      event.stopPropagation();
      run({ type: "edit.save" });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      run({ type: snapshot.editing ? "edit.exit" : "close" });
      return;
    }
    const target = event.target;
    if (target instanceof HTMLElement && (target.matches("input, textarea") || target.isContentEditable)) return;
    if (snapshot.editing) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      run({ type: "navigate", direction: -1 });
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      run({ type: "navigate", direction: 1 });
    } else if (event.key.toLowerCase() === "e" && file?.kind === "text") {
      event.preventDefault();
      run({ type: "edit.enter" });
    }
  }

  return (
    <>
      <style id="wand-file-preview-styles">{filePreviewStyles}</style>
      <WandDialogSurface
      open={snapshot.open}
      onOpenChange={(open) => { if (!open) run({ type: "close" }); }}
      title={title}
      description={path || "查看文件内容与元数据。"}
      className="wand-ui-dialog-content wand-file-preview-dialog"
      overlayClassName="wand-ui-dialog-overlay wand-file-preview-overlay"
      titleClassName="wand-ui-dialog-title wand-file-preview-title"
      descriptionClassName="wand-ui-dialog-description wand-file-preview-path"
      headerClassName="wand-ui-dialog-heading wand-file-preview-header"
      closeLabel="关闭文件预览"
      testId="file-preview-dialog"
      dismissable={!snapshot.saving && !snapshot.editing}
    >
      <div
        className="wand-file-preview-shell"
        data-wand-autofocus
        tabIndex={-1}
        onKeyDownCapture={handleKeyboard}
      >
        <div className="wand-file-preview-title-meta" aria-live="polite">
          <span className="wand-file-preview-kind-icon" aria-hidden="true">
            {file ? filePreviewIcon(file.kind) : "…"}
          </span>
          {file ? <span className="wand-file-preview-kind">{filePreviewKindLabel(file)}</span> : null}
          {snapshot.dirty ? <span className="wand-file-preview-dirty">● 未保存</span> : null}
        </div>
        <PreviewToolbar snapshot={snapshot} />
        {snapshot.status === "ready" && snapshot.failure ? (
          <p className="wand-file-preview-inline-error" role="alert">{snapshot.failure.message}</p>
        ) : null}
        <div className={`wand-file-preview-body kind-${file?.kind ?? snapshot.status}`}>
          <PreviewBody snapshot={snapshot} editorRef={editorRef} />
        </div>
        {file ? (
          <footer className="wand-file-preview-metadata" aria-label="文件元数据">
            <span>{formatFilePreviewSize(file.size)}</span>
            <span>{file.mime || file.ext.replace(/^\./, "") || file.kind}</span>
            <code title={file.path}>{file.path}</code>
          </footer>
        ) : null}
      </div>
      </WandDialogSurface>
    </>
  );
}
