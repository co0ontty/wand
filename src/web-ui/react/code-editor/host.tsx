import * as React from "react";
import { Fragment, type KeyboardEvent, type RefObject, useEffect, useRef, useSyncExternalStore } from "react";
import { tokenizeFilePreviewCode, type FilePreviewCodeToken } from "../file-preview/model";
import { WandIcon } from "../ui";
import { codeEditorController, codeEditorStore } from "./controller";
import { codeEditorStyles } from "./styles";
import type { CodeEditorSnapshot } from "./types";

void React;

function run(command: Parameters<typeof codeEditorController.execute>[0]): void {
  void codeEditorController.execute(command);
}

function SyntaxLayer({ content }: { content: string }) {
  const tokens = tokenizeFilePreviewCode(content);
  return (
    <code>
      {tokens.map((token: FilePreviewCodeToken, index: number) => token.kind ? (
        <span className={`wand-file-preview-syntax-${token.kind}`} key={index}>{token.value}</span>
      ) : <Fragment key={index}>{token.value}</Fragment>)}
    </code>
  );
}

function EditorBody({ snapshot, editorRef }: {
  snapshot: CodeEditorSnapshot;
  editorRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const contentRef = useRef<HTMLPreElement>(null);
  const linesRef = useRef<HTMLPreElement>(null);
  if (snapshot.status === "loading") {
    return <div className="wand-code-editor-state" role="status">正在打开文件…</div>;
  }
  if (snapshot.status === "error") {
    return (
      <div className="wand-code-editor-state error" role="alert">
        <span aria-hidden="true">!</span>
        <strong>{snapshot.failure?.message || "打开文件失败"}</strong>
      </div>
    );
  }
  const file = snapshot.file;
  if (!file) return <div className="wand-code-editor-state">选择文件后将在这里编辑。</div>;
  const content = file.draft;
  const lineCount = Math.max(1, content.split("\n").length);
  return (
    <div className="wand-code-editor-body" style={{ fontSize: `${snapshot.fontSize}px` }}>
      <pre
        ref={linesRef}
        className="wand-code-editor-lines"
        aria-hidden="true"
        style={{ fontSize: `${snapshot.fontSize}px` }}
      >
        {Array.from({ length: lineCount }, (_value, index) => index + 1).join("\n")}
      </pre>
      <div className="wand-code-editor-area">
        <pre ref={contentRef} className="wand-code-editor-content" aria-hidden="true">
          <SyntaxLayer content={content} />
        </pre>
        <textarea
          ref={editorRef}
          className="wand-code-editor-textarea"
          aria-label={`编辑 ${file.name}`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          wrap="off"
          value={content}
          onChange={(event) => run({ type: "change", value: event.currentTarget.value })}
          onKeyDown={(event) => handleEditorKeydown(event, content)}
          onScroll={(event) => {
            const target = event.currentTarget;
            const layer = contentRef.current;
            if (layer) {
              layer.scrollTop = target.scrollTop;
              layer.scrollLeft = target.scrollLeft;
            }
            const lines = linesRef.current;
            if (lines) lines.scrollTop = target.scrollTop;
          }}
        />
      </div>
    </div>
  );
}

function handleEditorKeydown(event: KeyboardEvent<HTMLTextAreaElement>, content: string): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    event.stopPropagation();
    run({ type: "save" });
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const value = `${content.slice(0, start)}  ${content.slice(end)}`;
    run({ type: "change", value });
    requestAnimationFrame(() => {
      input.selectionStart = start + 2;
      input.selectionEnd = start + 2;
    });
    return;
  }
}

export function CodeEditorHost() {
  const snapshot = useSyncExternalStore(
    codeEditorStore.subscribe,
    codeEditorStore.getSnapshot,
    codeEditorStore.getSnapshot,
  );
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (snapshot.status !== "ready" || !snapshot.file) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
  }, [snapshot.activePath, snapshot.status]);

  useEffect(() => {
    if (snapshot.status !== "ready") return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.scrollTop = 0;
  }, [snapshot.activePath]);

  function handleKeydown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (snapshot.activePath) run({ type: "close", path: snapshot.activePath });
    }
  }

  const hidden = !snapshot.open || !snapshot.activePath;

  return (
    <>
      <style id="wand-code-editor-styles">{codeEditorStyles}</style>
      <div
        className={`wand-code-editor-host${snapshot.wrap ? " wrap" : ""}`}
        hidden={hidden}
        onKeyDownCapture={handleKeydown}
        aria-hidden={hidden}
      >
        {snapshot.tabs.length > 0 && (
          <div className="wand-code-editor-tabs" role="tablist" aria-label="打开的文件">
            {snapshot.tabs.map((tab) => (
              <button
                key={tab.path}
                type="button"
                role="tab"
                aria-selected={snapshot.activePath === tab.path}
                className={`wand-code-editor-tab${snapshot.activePath === tab.path ? " active" : ""}`}
                title={tab.path}
                onClick={() => run({ type: "activate", path: tab.path })}
              >
                {tab.dirty && <span className="wand-code-editor-tab-dirty" aria-label="未保存"/>}
                <span className="wand-code-editor-tab-name">{tab.name}</span>
                <span
                  className="wand-code-editor-tab-close"
                  role="button"
                  aria-label={`关闭 ${tab.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    run({ type: "close", path: tab.path });
                  }}
                >
                  <WandIcon name="close" size={11}/>
                </span>
              </button>
            ))}
          </div>
        )}
        {snapshot.file && (
          <div className="wand-code-editor-toolbar" aria-label="编辑器工具栏">
            <span className="wand-code-editor-dirty-mark">
              {snapshot.file.dirty ? "● 未保存" : "已保存"}
            </span>
            <span className="wand-code-editor-toolbar-spacer"/>
            <button
              type="button"
              className="wand-code-editor-btn primary"
              disabled={snapshot.saving || !snapshot.file.dirty}
              onClick={() => run({ type: "save" })}
            >
              {snapshot.saving ? "保存中…" : "保存 (⌘S)"}
            </button>
            <button
              type="button"
              className="wand-code-editor-btn"
              disabled={snapshot.saving || !snapshot.file.dirty}
              onClick={() => run({ type: "revert" })}
            >
              撤销改动
            </button>
            <button
              type="button"
              className="wand-code-editor-btn"
              onClick={() => run({ type: "wrap.toggle" })}
              aria-pressed={snapshot.wrap}
            >
              自动换行
            </button>
            <button
              type="button"
              className="wand-code-editor-btn"
              aria-label="缩小字号"
              onClick={() => run({ type: "font.adjust", delta: -1 })}
            >A−</button>
            <span aria-label={`字号 ${snapshot.fontSize}`}>{snapshot.fontSize}</span>
            <button
              type="button"
              className="wand-code-editor-btn"
              aria-label="放大字号"
              onClick={() => run({ type: "font.adjust", delta: 1 })}
            >A+</button>
          </div>
        )}
        {snapshot.status === "ready" && snapshot.failure ? (
          <p className="wand-code-editor-inline-error" role="alert">{snapshot.failure.message}</p>
        ) : null}
        <EditorBody snapshot={snapshot} editorRef={editorRef}/>
      </div>
    </>
  );
}
