import * as React from "react";
import { Fragment, type KeyboardEvent, type RefObject, useEffect, useRef, useSyncExternalStore } from "react";
import { isMarkdownPreview, tokenizeFilePreviewCode, type FilePreviewCodeToken } from "../file-preview/model";
import { MarkdownPreview } from "../file-preview/markdown";
import { markdownPreviewStyles } from "../file-preview/markdown-styles";
import { WandButton, WandIcon } from "../ui";
import { codeEditorController, codeEditorStore } from "./controller";
import { codeEditorFindMatches, maxCodeEditorFindHighlights, type CodeEditorFindMatch } from "./model";
import { codeEditorStyles } from "./styles";
import type { CodeEditorSnapshot } from "./types";

void React;

function run(command: Parameters<typeof codeEditorController.execute>[0]): void {
  void codeEditorController.execute(command);
}

/**
 * Viewport rect of the single character at `offset` inside a rendered layer.
 * Walks the text nodes so the offset survives the syntax/highlight spans.
 */
function measureCharacter(layer: HTMLElement, offset: number): DOMRect | null {
  const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    // `>=` matters: an offset that lands exactly on a node boundary belongs to
    // the start of the *next* node, not to a collapsed range at the end of this
    // one (which would measure as empty and scroll nowhere).
    if (remaining >= length) {
      remaining -= length;
      continue;
    }
    const range = layer.ownerDocument.createRange();
    range.setStart(node, Math.min(remaining, length));
    range.setEnd(node, Math.min(remaining + 1, length));
    const rect = range.getBoundingClientRect();
    return rect.height > 0 || rect.width > 0 ? rect : null;
  }
  return null;
}

/**
 * Syntax layer with find hits punched through it. Without a query this renders
 * exactly one span per token (unchanged shape); with one, only the tokens that
 * actually contain a hit are split, so the DOM stays proportional to the number
 * of visible matches rather than to the file size.
 */
function SyntaxLayer({ content, ranges, activeRange }: {
  content: string;
  ranges: readonly CodeEditorFindMatch[];
  activeRange: number;
}) {
  const tokens = tokenizeFilePreviewCode(content);
  if (ranges.length === 0) {
    return (
      <code>
        {tokens.map((token: FilePreviewCodeToken, index: number) => token.kind ? (
          <span className={`wand-file-preview-syntax-${token.kind}`} key={index}>{token.value}</span>
        ) : <Fragment key={index}>{token.value}</Fragment>)}
      </code>
    );
  }
  const nodes: React.ReactNode[] = [];
  let offset = 0;
  // Ranges are sorted and non-overlapping, so a single cursor suffices.
  let cursor = 0;
  tokens.forEach((token: FilePreviewCodeToken, tokenIndex: number) => {
    const tokenStart = offset;
    const tokenEnd = offset + token.value.length;
    offset = tokenEnd;
    while (cursor < ranges.length && ranges[cursor].end <= tokenStart) cursor += 1;
    const parts: Array<{ value: string; hit: number }> = [];
    let partStart = tokenStart;
    for (let scan = cursor; scan < ranges.length && ranges[scan].start < tokenEnd; scan += 1) {
      const hit = ranges[scan];
      const from = Math.max(hit.start, tokenStart);
      const to = Math.min(hit.end, tokenEnd);
      if (from > partStart) parts.push({ value: content.slice(partStart, from), hit: -1 });
      if (to > from) parts.push({ value: content.slice(from, to), hit: scan });
      partStart = Math.max(partStart, to);
    }
    if (partStart < tokenEnd) parts.push({ value: content.slice(partStart, tokenEnd), hit: -1 });
    parts.forEach((part, partIndex) => {
      const body = part.hit >= 0
        ? <mark className={`wand-code-editor-hit${part.hit === activeRange ? " active" : ""}`}>{part.value}</mark>
        : part.value;
      const key = `${tokenIndex}-${partIndex}`;
      nodes.push(token.kind
        ? <span className={`wand-file-preview-syntax-${token.kind}`} key={key}>{body}</span>
        : <Fragment key={key}>{body}</Fragment>);
    });
  });
  return <code>{nodes}</code>;
}

/** 标签页 aria-controls 指向的面板 id：EditorBody 的每种状态都挂同一个 id，面板换内容不换身份。 */
const CODE_EDITOR_PANEL_ID = "wand-code-editor-panel";

function EditorBody({ snapshot, editorRef, ranges, activeRange }: {
  snapshot: CodeEditorSnapshot;
  editorRef: RefObject<HTMLTextAreaElement | null>;
  ranges: readonly CodeEditorFindMatch[];
  activeRange: number;
}) {
  const contentRef = useRef<HTMLPreElement>(null);
  const linesRef = useRef<HTMLPreElement>(null);

  // The textarea owns the scroll position; the gutter and the syntax layer
  // mirror it from `onScroll`. Jumping to a match therefore means moving the
  // textarea, and the target's pixel position comes from measuring the very
  // same character in the rendered layer — no line-height arithmetic, so it
  // stays correct in wrap mode and at any font size.
  useEffect(() => {
    const textarea = editorRef.current;
    const layer = contentRef.current;
    const match = ranges[activeRange];
    if (!textarea || !layer || !match) return;
    const rect = measureCharacter(layer, match.start);
    if (!rect) return;
    // Offsets are expressed inside the layer's own content, so a stale scroll
    // position on either element cannot accumulate drift across rapid steps.
    const box = layer.getBoundingClientRect();
    const contentTop = rect.top - box.top + layer.scrollTop;
    const contentLeft = rect.left - box.left + layer.scrollLeft;
    textarea.scrollTop = Math.max(0, contentTop - textarea.clientHeight / 2 + rect.height / 2);
    textarea.scrollLeft = Math.max(0, contentLeft - textarea.clientWidth / 2 + rect.width / 2);
  }, [editorRef, ranges, activeRange]);

  if (snapshot.status === "loading") {
    return <div id={CODE_EDITOR_PANEL_ID} className="wand-code-editor-state" role="status">正在打开文件…</div>;
  }
  if (snapshot.status === "error") {
    return (
      <div id={CODE_EDITOR_PANEL_ID} className="wand-code-editor-state error" role="alert">
        <span aria-hidden="true">!</span>
        <strong>{snapshot.failure?.message || "打开文件失败"}</strong>
        {snapshot.activePath ? <WandButton
          kind="ghost"
          size="small"
          // 失败的文件没进 files 缓存，open(同一路径) 会真的重读磁盘（activate/open 的已开分支只会复用）。
          onClick={() => void codeEditorController.open(snapshot.activePath!)}
        >重新加载</WandButton> : null}
      </div>
    );
  }
  const file = snapshot.file;
  if (!file) return <div id={CODE_EDITOR_PANEL_ID} className="wand-code-editor-state">选择文件后将在这里编辑。</div>;
  if (snapshot.preview && isMarkdownPreview(file)) {
    return (
      <div id={CODE_EDITOR_PANEL_ID} className="wand-code-editor-markdown" tabIndex={0} aria-label={`${file.name} 预览`}>
        <MarkdownPreview content={file.draft} fontSize={snapshot.fontSize} wrap={snapshot.wrap}/>
      </div>
    );
  }
  const content = file.draft;
  const lineCount = Math.max(1, content.split("\n").length);
  return (
    <div id={CODE_EDITOR_PANEL_ID} className="wand-code-editor-body" style={{ fontSize: `${snapshot.fontSize}px` }}>
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
          <SyntaxLayer content={content} ranges={ranges} activeRange={activeRange} />
        </pre>
        <textarea
          ref={editorRef}
          className="resize-none wand-code-editor-textarea"
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

function FindBar({ snapshot, matchCount, activeIndex, activeLine, inputRef }: {
  snapshot: CodeEditorSnapshot;
  matchCount: number;
  activeIndex: number;
  activeLine: number | null;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const hasQuery = snapshot.findQuery.length > 0;
  const hidden = matchCount > maxCodeEditorFindHighlights;
  return (
    <div className="wand-code-editor-find">
      <WandIcon name="search" size={14}/>
      <input
        ref={inputRef}
        className="wand-code-editor-find-input"
        type="text"
        value={snapshot.findQuery}
        aria-label="在文件中查找"
        placeholder="在文件中查找"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => run({ type: "find.set", query: event.currentTarget.value })}
        onKeyDown={(event) => {
          // 中文输入法选词的回车只结束组字，不能当成「跳到下一个匹配」。
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            run({ type: "find.step", delta: event.shiftKey ? -1 : 1 });
          }
        }}
      />
      <span
        className={`wand-code-editor-find-count${hasQuery && matchCount === 0 ? " empty" : ""}`}
        title={hidden ? "匹配过多，只高亮当前项" : undefined}
        aria-live="polite"
      >
        {!hasQuery ? "" : matchCount === 0 ? "无结果" : `${activeIndex + 1}/${matchCount}`}
      </span>
      {hasQuery && activeLine !== null ? (
        <span className="wand-code-editor-find-line">第 {activeLine} 行</span>
      ) : null}
      <button
        type="button"
        className="wand-code-editor-find-btn"
        title="上一个匹配 (⇧↵)"
        aria-label="上一个匹配"
        disabled={matchCount === 0}
        onClick={() => run({ type: "find.step", delta: -1 })}
      >↑</button>
      <button
        type="button"
        className="wand-code-editor-find-btn"
        title="下一个匹配 (↵)"
        aria-label="下一个匹配"
        disabled={matchCount === 0}
        onClick={() => run({ type: "find.step", delta: 1 })}
      >↓</button>
      <button
        type="button"
        className={`wand-code-editor-find-btn${snapshot.findCaseSensitive ? " active" : ""}`}
        title="区分大小写"
        aria-label="区分大小写"
        aria-pressed={snapshot.findCaseSensitive}
        onClick={() => run({ type: "find.case.toggle" })}
      >Aa</button>
      <button
        type="button"
        className="wand-code-editor-find-btn"
        title="关闭查找 (Esc)"
        aria-label="关闭查找"
        onClick={() => run({ type: "find.close" })}
      ><WandIcon name="close" size={12}/></button>
    </div>
  );
}

function handleEditorKeydown(event: KeyboardEvent<HTMLTextAreaElement>, content: string): void {if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    event.stopPropagation();
    run({ type: "save" });
    return;
  }
  if (event.key === "Tab") {
    // 组字期的 Tab 属于输入法（确认/翻页候选），不能当成插入两空格写进正文。
    if (event.nativeEvent.isComposing) return;
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
  const findInputRef = useRef<HTMLInputElement>(null);
  // 方向键走位要焦点，但 React 侧不许摸 DOM 查询（见 web-ui-architecture 的边界）：按路径记标签节点。
  const tabRefs = useRef(new Map<string, HTMLDivElement>());

  const file = snapshot.file;
  const markdown = file ? isMarkdownPreview(file) : false;
  const rendered = markdown && snapshot.preview;
  const content = file?.draft ?? "";
  // Matches are derived from the live draft instead of stored, so they can never
  // drift from what is on screen after an edit or a tab switch.
  const find = React.useMemo(() => {
    if (!snapshot.findOpen || !snapshot.findQuery) {
      return { count: 0, ranges: [] as readonly CodeEditorFindMatch[], activeRange: -1, activeIndex: -1 };
    }
    const matches = codeEditorFindMatches(content, snapshot.findQuery, {
      caseSensitive: snapshot.findCaseSensitive,
    });
    if (matches.length === 0) {
      return { count: 0, ranges: [] as readonly CodeEditorFindMatch[], activeRange: -1, activeIndex: -1 };
    }
    const active = Math.min(Math.max(snapshot.findIndex, 0), matches.length - 1);
    // Past the highlight budget only the active hit is painted: file-wide marks
    // would mean splitting the syntax layer thousands of times.
    if (matches.length > maxCodeEditorFindHighlights) {
      return { count: matches.length, ranges: [matches[active]] as readonly CodeEditorFindMatch[], activeRange: 0, activeIndex: active };
    }
    return { count: matches.length, ranges: matches as readonly CodeEditorFindMatch[], activeRange: active, activeIndex: active };
  }, [snapshot.findOpen, snapshot.findQuery, snapshot.findCaseSensitive, snapshot.findIndex, content]);

  useEffect(() => {
    if (snapshot.findOpen) {
      const input = findInputRef.current;
      input?.focus();
      input?.select();
      return;
    }
    if (snapshot.status !== "ready" || !snapshot.file) return;
    // Leaving the rendered Markdown view returns the caret to the source, so
    // typing continues where the user left off.
    editorRef.current?.focus();
  }, [snapshot.findOpen, snapshot.activePath, snapshot.status, snapshot.preview]);

  useEffect(() => {
    if (snapshot.status !== "ready") return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.scrollTop = 0;
  }, [snapshot.activePath, snapshot.status]);

  function openFind(): void {
    // Search walks the source text, so a rendered Markdown file switches back
    // to source first instead of silently finding nothing.
    if (rendered) run({ type: "preview.toggle" });
    run({ type: "find.open" });
  }

  function handleKeydown(event: KeyboardEvent<HTMLDivElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      const editor = editorRef.current;
      const selected = editor && editor.selectionEnd > editor.selectionStart
        ? editor.value.slice(editor.selectionStart, editor.selectionEnd)
        : "";
      openFind();
      if (selected && !selected.includes("\n")) run({ type: "find.set", query: selected });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      // Esc closes the find bar first; only a second Esc closes the file.
      if (snapshot.findOpen) {
        run({ type: "find.close" });
        return;
      }
      if (snapshot.activePath) run({ type: "close", path: snapshot.activePath });
    }
  }

  const hidden = !snapshot.open || !snapshot.activePath;

  return (
    <>
      <style id="wand-code-editor-styles">{codeEditorStyles}{markdownPreviewStyles}</style>
      <div
        className={`wand-code-editor-host${snapshot.wrap ? " wrap" : ""}`}
        hidden={hidden}
        onKeyDownCapture={handleKeydown}
        aria-hidden={hidden}
      >
        {snapshot.tabs.length > 0 && (
          <div className="wand-code-editor-tabs" role="tablist" aria-label="打开的文件">
            {snapshot.tabs.map((tab) => (
              <div
                key={tab.path}
                ref={(element) => {
                  if (element) tabRefs.current.set(tab.path, element);
                  else tabRefs.current.delete(tab.path);
                }}
                role="tab"
                tabIndex={snapshot.activePath === tab.path ? 0 : -1}
                aria-selected={snapshot.activePath === tab.path}
                aria-controls={CODE_EDITOR_PANEL_ID}
                aria-label={tab.dirty ? `${tab.name}，未保存` : tab.name}
                className={`wand-code-editor-tab${snapshot.activePath === tab.path ? " active" : ""}`}
                title={tab.path}
                onClick={() => run({ type: "activate", path: tab.path })}
                onKeyDown={(event) => {
                  // 外层从 button 换成 div（button 里不能再套 button），
                  // Enter / Space 激活要自己补；子节点上的按键不归标签页处理。
                  if (event.target !== event.currentTarget) return;
                  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                  if (step !== 0 || event.key === "Home" || event.key === "End") {
                    event.preventDefault();
                    // roving tabindex：一组只有一个停靠点，方向键在标签之间走并跟着激活。
                    const order = snapshot.tabs.map((item) => item.path);
                    const at = order.indexOf(tab.path);
                    const next = event.key === "Home" ? 0
                      : event.key === "End" ? order.length - 1
                        : (at + step + order.length) % order.length;
                    const target = order[next];
                    if (!target || target === tab.path) return;
                    run({ type: "activate", path: target });
                    // 标签节点原地不动，焦点直接跟上；关闭按钮是独立停靠点，不参与走位。
                    tabRefs.current.get(target)?.focus();
                    return;
                  }
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    run({ type: "activate", path: tab.path });
                  }
                }}
              >
                {tab.dirty && <span className="wand-code-editor-tab-dirty" aria-hidden="true" title="未保存"/>}
                <span className="wand-code-editor-tab-name">{tab.name}</span>
                <button
                  type="button"
                  className="wand-code-editor-tab-close"
                  aria-label={`关闭 ${tab.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    run({ type: "close", path: tab.path });
                  }}
                >
                  <WandIcon name="close" size={11}/>
                </button>
              </div>
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
            {markdown ? (
              <button
                type="button"
                className={`wand-code-editor-btn${rendered ? " active" : ""}`}
                aria-pressed={rendered}
                title={rendered ? "显示 Markdown 源码" : "渲染 Markdown 预览"}
                onClick={() => run({ type: "preview.toggle" })}
              >
                预览
              </button>
            ) : null}
            <button
              type="button"
              className="wand-code-editor-btn"
              onClick={openFind}
              aria-pressed={snapshot.findOpen}
              title="在文件中查找 (⌘F)"
            >
              查找 ⌘F
            </button>
            <button
              type="button"
              className={`wand-code-editor-btn${snapshot.wrap ? " active" : ""}`}
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
            <span role="status" aria-label={`字号 ${snapshot.fontSize}`}>{snapshot.fontSize}</span>
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
        {snapshot.findOpen && snapshot.file ? (
          <FindBar
            snapshot={snapshot}
            matchCount={find.count}
            activeIndex={find.activeIndex < 0 ? 0 : find.activeIndex}
            activeLine={find.count > 0 && find.activeRange >= 0 ? find.ranges[find.activeRange]?.line ?? null : null}
            inputRef={findInputRef}
          />
        ) : null}
        <EditorBody
          snapshot={snapshot}
          editorRef={editorRef}
          ranges={find.ranges}
          activeRange={find.activeRange}
        />
      </div>
    </>
  );
}
