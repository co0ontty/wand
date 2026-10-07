import { Alert, Button, Card, Descriptions, Empty, Flex, Image, Input, Spin, Typography } from "antd";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import * as React from "react";
import { WandBadge, WandButton, WandDialogSurface, WandIcon } from "../ui";
import { filePreviewController, filePreviewStore } from "./controller";
import { CodeTokens, MarkdownPreview } from "./markdown";
import { markdownPreviewStyles } from "./markdown-styles";
import {
  fileNameFromPath,
  filePreviewIconName,
  filePreviewKindLabel,
  formatFilePreviewSize,
  isMarkdownPreview,
  nextFilePreviewSibling,
  tokenizeFilePreviewCode,
} from "./model";
import { filePreviewStyles } from "./styles";
import type { FilePreviewFile, FilePreviewSnapshot } from "./types";

function run(command: Parameters<typeof filePreviewController.execute>[0]): void {
  void filePreviewController.execute(command);
}

/**
 * Real download link. Ant Button renders the anchor, and it is imported directly
 * instead of via WandButton because WandButton's props are native-button props,
 * which cannot carry the anchor-only `download` attribute. The class and href
 * stay exactly as the browser harness expects.
 */
function DownloadLink({ file, label = "下载" }: { file: Pick<FilePreviewFile, "url" | "name">; label?: string }) {
  return (
    <Button className="wand-file-preview-download" size="small" href={file.url} download={file.name}>
      {label}
    </Button>
  );
}

function TextPreview({ snapshot, file }: { snapshot: FilePreviewSnapshot; file: FilePreviewFile }) {
  const content = file.content ?? "";
  if (isMarkdownPreview(file)) {
    return <MarkdownPreview content={content} fontSize={snapshot.fontSize} wrap={snapshot.wrap} />;
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
    <Card className="wand-file-preview-binary" style={{ margin: "auto", width: "min(560px, 100%)" }} styles={{ body: { display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" } }}>
      <span className="wand-file-preview-binary-icon" aria-hidden="true"><WandIcon name="binary" size={44} strokeWidth={1.6}/></span>
      <Typography.Text strong>{file.name}</Typography.Text>
      <Flex gap="small" className="wand-file-preview-binary-meta">
        <span>{file.ext.replace(/^\./, "") || "未知格式"}</span>
        <span aria-hidden="true">·</span>
        <span>{formatFilePreviewSize(file.size)}</span>
      </Flex>
      <Typography.Text code style={{ maxWidth: "100%", overflowWrap: "anywhere" }}>{file.path}</Typography.Text>
      <Flex wrap gap="small" className="wand-file-preview-binary-actions">
        <DownloadLink file={file} label="下载文件" />
        <WandButton size="small" onClick={() => run({ type: "composer.cat" })}>
          在终端中查看
        </WandButton>
      </Flex>
    </Card>
  );
}

function PreviewBody({ snapshot, editorRef }: {
  snapshot: FilePreviewSnapshot;
  editorRef: RefObject<HTMLTextAreaElement | null>;
}) {
  if (snapshot.status === "loading") {
    return (
      <Flex vertical align="center" justify="center" gap="small" className="wand-file-preview-state" role="status" style={{ flex: 1, padding: 24 }}>
        <Spin size="small" aria-hidden="true"/>正在加载预览…
      </Flex>
    );
  }
  if (snapshot.status === "error") {
    return (
      <Flex vertical align="center" justify="center" gap="small" className="wand-file-preview-state wand-file-preview-error" role="alert" style={{ flex: 1, padding: 24 }}>
        <WandIcon name="warning" size={22}/>
        <strong>{snapshot.failure?.message || "加载预览失败"}</strong>
        {snapshot.failure?.size != null ? <small>文件大小：{formatFilePreviewSize(snapshot.failure.size)}</small> : null}
        {snapshot.failure?.download ? <DownloadLink file={snapshot.failure.download} label="仍然下载文件" /> : null}
        {snapshot.request ? <WandButton
          kind="ghost"
          size="small"
          // 预览没有 reload 命令，同路径 open() 会在「已打开且不脏」分支里直接返回而根本不读盘；
          // 先 close（错误态必不脏，close 是同步复位）再 open 同一个 request，才走得到 load()。
          onClick={() => {
            const request = snapshot.request;
            if (!request) return;
            void filePreviewController.execute({ type: "close" });
            void filePreviewController.open(request);
          }}
        >重新加载</WandButton> : null}
      </Flex>
    );
  }
  const file = snapshot.file;
  if (!file) return <Empty className="wand-file-preview-state" description="选择文件后将在这里显示预览。" />;
  if (snapshot.editing) {
    return (
      <Flex className="wand-file-preview-editor" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        <Input.TextArea className="resize-none"
          ref={node => { editorRef.current = node?.resizableTextArea?.textArea ?? null; }}
          style={{ flex: 1, width: "100%", height: "100%", resize: "none", fontFamily: "var(--font-mono)", fontSize: snapshot.fontSize, tabSize: 2 }}
          aria-label={`编辑 ${file.name}`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          wrap="off"
          value={snapshot.draft}
          onChange={(event) => run({ type: "edit.change", value: event.currentTarget.value })}
          onKeyDown={(event) => {
            if (event.key !== "Tab" || event.nativeEvent.isComposing) return;
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
      </Flex>
    );
  }
  switch (file.kind) {
    case "image":
      return (
        <Button
          type="text"
          className={`wand-media-stage${snapshot.imageZoomed ? " zoomed" : ""}`}
          aria-label={snapshot.imageZoomed ? "缩小图片" : "放大图片"}
          onClick={() => run({ type: "view.image.zoom.toggle" })}
        >
          <Image preview={false} src={file.rawUrl} alt={file.name} />
        </Button>
      );
    case "pdf":
      return <iframe className="wand-file-preview-pdf" style={{ width: "100%", height: "100%", border: 0 }} src={file.rawUrl} title={file.name} />;
    case "video":
      return (
        <Flex vertical align="center" justify="center" gap="middle" className="wand-file-preview-media" style={{ flex: 1, padding: 16 }}>
          <video style={{ maxWidth: "100%", maxHeight: "100%" }} controls preload="metadata" src={file.rawUrl}>您的浏览器不支持视频预览。</video>
          <span>{formatFilePreviewSize(file.size)}</span>
        </Flex>
      );
    case "audio":
      return (
        <Flex vertical align="center" justify="center" gap="middle" className="wand-file-preview-media wand-file-preview-audio" style={{ flex: 1, padding: 16 }}>
          <span className="wand-file-preview-media-icon" aria-hidden="true"><WandIcon name="audio" size={28} strokeWidth={1.6}/></span>
          <Typography.Text strong>{file.name}</Typography.Text>
          <audio style={{ width: "min(520px, 100%)" }} controls preload="metadata" src={file.rawUrl}>您的浏览器不支持音频预览。</audio>
          <span>{formatFilePreviewSize(file.size)}</span>
        </Flex>
      );
    case "binary":
      return <BinaryPreview file={file} />;
    default:
      return <TextPreview snapshot={snapshot} file={file} />;
  }
}

function PreviewToolbar({ snapshot, onExitEdit }: { snapshot: FilePreviewSnapshot; onExitEdit(): void }) {
  const previous = nextFilePreviewSibling(snapshot.request, -1);
  const next = nextFilePreviewSibling(snapshot.request, 1);
  const file = snapshot.file;
  return (
    <Flex wrap align="center" gap="small" style={{ flexShrink: 0 }} className={`wand-file-preview-toolbar${snapshot.editing ? " editing" : ""}`} aria-label="文件预览工具栏">
      <Flex wrap align="center" gap="small" className="wand-file-preview-toolbar-group">
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
      </Flex>

      {snapshot.editing ? (
        <Flex wrap align="center" gap="small" className="wand-file-preview-toolbar-group wand-file-preview-edit-actions">
          <WandButton kind="primary" size="small" loading={snapshot.saving} onClick={() => run({ type: "edit.save" })}>
            {snapshot.saving ? "保存中…" : "保存"}
          </WandButton>
          <WandButton size="small" disabled={snapshot.saving || !snapshot.dirty} onClick={() => run({ type: "edit.revert" })}>
            撤销改动
          </WandButton>
          <WandButton size="small" disabled={snapshot.saving} onClick={onExitEdit}>
            退出编辑
          </WandButton>
        </Flex>
      ) : file ? (
        <>
          <Flex wrap align="center" gap="small" className="wand-file-preview-toolbar-group">
            {file.kind === "text" ? (
              <WandButton kind="primary" size="small" onClick={() => run({ type: "edit.enter" })}>
                编辑
              </WandButton>
            ) : null}
            <WandButton size="small" onClick={() => run({ type: "copy.path" })}>复制路径</WandButton>
            <WandButton size="small" onClick={() => run({ type: "composer.path" })}>粘贴到输入框</WandButton>
            <DownloadLink file={file} />
          </Flex>
          {file.kind === "text" ? (
            <Flex wrap align="center" gap="small" className="wand-file-preview-toolbar-group">
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
              <span className="wand-file-preview-font-size" role="status" aria-label={`字号 ${snapshot.fontSize}`}>{snapshot.fontSize}</span>
              <WandButton size="small" aria-label="放大字号" onClick={() => run({ type: "view.font.adjust", delta: 1 })}>A+</WandButton>
            </Flex>
          ) : null}
        </>
      ) : snapshot.failure?.download ? (
        <DownloadLink file={snapshot.failure.download} />
      ) : null}
    </Flex>
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

  function exitEdit(): void {
    const path = snapshot.request?.path;
    void filePreviewController.execute({ type: "edit.exit" }).then(exited => {
      if (exited) return;
      // The generic confirmation is unmounted when it settles. Return its
      // cancelled lease after that commit, preserving the existing caret.
      requestAnimationFrame(() => {
        const latest = filePreviewStore.getSnapshot();
        const editor = editorRef.current;
        const owner = editor?.closest("[role=dialog]");
        const active = document.activeElement;
        if (latest.open && latest.editing && latest.request?.path === path && editor?.isConnected
          && (active === document.body || (active && owner?.contains(active)))) editor.focus({ preventScroll: true });
      });
    });
  }

  function handleKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && snapshot.editing) {
      event.preventDefault();
      event.stopPropagation();
      run({ type: "edit.save" });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (snapshot.editing) exitEdit();
      else run({ type: "close" });
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
      <style id="wand-file-preview-styles">{filePreviewStyles}{markdownPreviewStyles}</style>
      <WandDialogSurface
      open={snapshot.open}
      onOpenChange={(open) => { if (!open) run({ type: "close" }); }}
      title={title}
      description={path || "查看文件内容与元数据。"}
      className="wand-ui-dialog-content wand-file-preview-dialog"
      width={{ xs: "calc(100vw - 16px)", md: 960, xl: 1040 }}
      styles={{ body: { display: "flex", height: "min(72dvh, 680px)", minHeight: 0, overflow: "hidden" } }}
      closeLabel="关闭文件预览"
      testId="file-preview-dialog"
      dismissable={!snapshot.saving && !snapshot.editing}
    >
      <Flex vertical gap="small"
        style={{ flex: 1, minHeight: 0, minWidth: 0 }}
        className="wand-file-preview-shell"
        data-wand-autofocus
        tabIndex={-1}
        onKeyDownCapture={handleKeyboard}
      >
        <Flex align="center" gap="small" className="wand-file-preview-title-meta" aria-live="polite">
          <span className="wand-file-preview-kind-icon" aria-hidden="true">
            {file ? <WandIcon name={filePreviewIconName(file.kind)} size={14} strokeWidth={1.8}/> : "…"}
          </span>
          {file ? <WandBadge className="wand-file-preview-kind" size="sm">{filePreviewKindLabel(file)}</WandBadge> : null}
          {snapshot.dirty ? <WandBadge className="wand-file-preview-dirty" size="sm" tone="warning">● 未保存</WandBadge> : null}
        </Flex>
        <PreviewToolbar snapshot={snapshot} onExitEdit={exitEdit} />
        {snapshot.status === "ready" && snapshot.failure ? (
          <Alert className="wand-file-preview-inline-error" type="error" showIcon title={snapshot.failure.message} />
        ) : null}
        <Flex className={`wand-file-preview-body kind-${file?.kind ?? snapshot.status}`} style={{ position: "relative", flex: 1, minHeight: 0, minWidth: 0, overflow: "auto", overscrollBehavior: "contain" }}>
          <PreviewBody snapshot={snapshot} editorRef={editorRef} />
        </Flex>
        {file ? (
          <Descriptions className="wand-file-preview-metadata" aria-label="文件元数据" size="small" column={{ xs: 1, sm: 2, md: 3 }}
            items={[{ key: "size", label: "大小", children: formatFilePreviewSize(file.size) },
              { key: "type", label: "类型", children: file.mime || file.ext.replace(/^\./, "") || file.kind },
              { key: "path", label: "路径", children: <Typography.Text ellipsis={{ tooltip: file.path }} style={{ maxWidth: 260 }}>{file.path}</Typography.Text> }]} />
        ) : null}
      </Flex>
      </WandDialogSurface>
    </>
  );
}
