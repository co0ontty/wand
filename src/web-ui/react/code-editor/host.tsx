import { Alert, Badge, Empty, Flex, Spin, Tabs, Typography } from "antd";
import * as React from "react";
import { Fragment, type KeyboardEvent, type RefObject, useEffect, useRef, useSyncExternalStore } from "react";
import { isMarkdownPreview, tokenizeFilePreviewCode, type FilePreviewCodeToken } from "../file-preview/model";
import { MarkdownPreview } from "../file-preview/markdown";
import { markdownPreviewStyles } from "../file-preview/markdown-styles";
import { WandBadge, WandButton, WandIcon, WandIconButton, WandInput } from "../ui";
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
    return (
      <Flex id={CODE_EDITOR_PANEL_ID} align="center" justify="center" gap="small" style={{ flex: 1 }} className="wand-code-editor-state" role="status">
        <Spin size="small" aria-hidden="true"/>正在打开文件…
      </Flex>
    );
  }
  if (snapshot.status === "error") {
    return (
      <Flex id={CODE_EDITOR_PANEL_ID} vertical align="center" justify="center" gap="small" style={{ flex: 1 }} className="wand-code-editor-state error" role="alert">
        <WandIcon name="warning" size={20}/>
        <strong>{snapshot.failure?.message || "打开文件失败"}</strong>
        {snapshot.activePath ? <WandButton
          kind="ghost"
          size="small"
          // 失败的文件没进 files 缓存，open(同一路径) 会真的重读磁盘（activate/open 的已开分支只会复用）。
          onClick={() => void codeEditorController.open(snapshot.activePath!)}
        >重新加载</WandButton> : null}
      </Flex>
    );
  }
  const file = snapshot.file;
  if (!file) return <Flex id={CODE_EDITOR_PANEL_ID} justify="center" align="center" style={{ flex: 1 }}><Empty className="wand-code-editor-state" description="选择文件后将在这里编辑。" /></Flex>;
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
    <Flex wrap align="center" gap="small" className="wand-code-editor-find" style={{ padding: "4px 12px", flexShrink: 0 }}>
      <WandIcon name="search" size={14}/>
      <WandInput
        ref={inputRef}
        className="wand-code-editor-find-input"
        style={{ flex: "1 1 180px", minWidth: 0, maxWidth: 320 }}
        inputSize="sm"
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
      <Typography.Text
        type={hasQuery && matchCount === 0 ? "danger" : "secondary"}
        className={`wand-code-editor-find-count${hasQuery && matchCount === 0 ? " empty" : ""}`}
        title={hidden ? "匹配过多，只高亮当前项" : undefined}
        aria-live="polite"
      >
        {!hasQuery ? "" : matchCount === 0 ? "无结果" : `${activeIndex + 1}/${matchCount}`}
      </Typography.Text>
      {hasQuery && activeLine !== null ? (
        <Typography.Text type="secondary" className="wand-code-editor-find-line">第 {activeLine} 行</Typography.Text>
      ) : null}
      <WandIconButton
        title="上一个匹配 (⇧↵)"
        aria-label="上一个匹配"
        disabled={matchCount === 0}
        onClick={() => run({ type: "find.step", delta: -1 })}
      >↑</WandIconButton>
      <WandIconButton
        title="下一个匹配 (↵)"
        aria-label="下一个匹配"
        disabled={matchCount === 0}
        onClick={() => run({ type: "find.step", delta: 1 })}
      >↓</WandIconButton>
      <WandIconButton
        kind={snapshot.findCaseSensitive ? "primary" : "ghost"}
        title="区分大小写"
        aria-label="区分大小写"
        aria-pressed={snapshot.findCaseSensitive}
        onClick={() => run({ type: "find.case.toggle" })}
      >Aa</WandIconButton>
      <WandIconButton
        title="关闭查找 (Esc)"
        aria-label="关闭查找"
        onClick={() => run({ type: "find.close" })}
      ><WandIcon name="close" size={12}/></WandIconButton>
    </Flex>
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
  const wasSaving = useRef(false);

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
    const finished = wasSaving.current && !snapshot.saving;
    wasSaving.current = snapshot.saving;
    // A successful save disables its button; keep subsequent typing/Escape in
    // the editor when the browser drops that focus, without stealing elsewhere.
    if (finished && snapshot.status === "ready" && document.activeElement === document.body) editorRef.current?.focus();
  }, [snapshot.saving, snapshot.status]);

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
    if (document.activeElement?.getAttribute("role") !== "tab") editorRef.current?.focus();
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

  function closeFile(path: string): void {
    const origin = document.activeElement;
    void codeEditorController.execute({ type: "close", path }).then(closed => {
      if (closed) return;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        const owner = editorRef.current?.closest(".wand-code-editor-host");
        if (origin instanceof HTMLElement && origin.isConnected
          && (active === document.body || (active && owner?.contains(active)))) origin.focus({ preventScroll: true });
      });
    });
  }

  function handleKeydown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.nativeEvent.isComposing) return;
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
      if (snapshot.activePath) closeFile(snapshot.activePath);
    }
  }

  const hidden = !snapshot.open || !snapshot.activePath;

  return (
    <>
      <style id="wand-code-editor-styles">{codeEditorStyles}{markdownPreviewStyles}</style>
      <Flex vertical
        className={`wand-code-editor-host${snapshot.wrap ? " wrap" : ""}`}
        hidden={hidden}
        onKeyDownCapture={handleKeydown}
        aria-hidden={hidden}
        style={{ position: "absolute", inset: 0, zIndex: 40, background: "var(--bg-primary)", minHeight: 0 }}
      >
        {snapshot.tabs.length > 0 && (
          <Tabs
            className="wand-code-editor-tabs"
            type="editable-card"
            hideAdd
            size="small"
            activeKey={snapshot.activePath ?? undefined}
            aria-label="打开的文件"
            onChange={path => run({ type: "activate", path })}
            onEdit={(path, action) => { if (action === "remove" && typeof path === "string") closeFile(path); }}
            items={snapshot.tabs.map(tab => ({
              key: tab.path,
              label: <span className={`wand-code-editor-tab${snapshot.activePath === tab.path ? " active" : ""}`} title={tab.path}>
                <Badge dot={tab.dirty} offset={[4, 0]}><span className="wand-code-editor-tab-name">{tab.name}</span></Badge>
              </span>,
              closeIcon: <WandIcon name="close" size={12}/>,
            }))}
            style={{ flexShrink: 0 }}
            styles={{ header: { margin: 0 }, body: { display: "none" } }}
            renderTabBar={(props, DefaultTabBar) => <DefaultTabBar {...props}>{node => {
              const tab = snapshot.tabs.find(item => item.path === node.key);
              const element = node as React.ReactElement<React.HTMLAttributes<HTMLElement>>;
              return React.cloneElement(element, {}, React.Children.map(element.props.children, child => {
                if (!React.isValidElement(child)) return child;
                const control = child as React.ReactElement<React.HTMLAttributes<HTMLElement>>;
                if (control.props.role === "tab") return React.cloneElement(control, {
                  "aria-controls": CODE_EDITOR_PANEL_ID,
                  "aria-label": tab?.dirty ? `${tab.name}，未保存` : tab?.name,
                  onFocus: event => {
                    control.props.onFocus?.(event);
                    if (tab) run({ type: "activate", path: tab.path });
                  },
                });
                if (control.type === "button") return React.cloneElement(control, {
                  className: `${control.props.className ?? ""} wand-code-editor-tab-close`,
                  "aria-label": `关闭 ${tab?.name ?? "文件"}`,
                });
                return child;
              }));
            }}</DefaultTabBar>}
          />
        )}
        {snapshot.file && (
          <Flex wrap align="center" gap="small" className="wand-code-editor-toolbar" aria-label="编辑器工具栏" style={{ padding: "8px 12px", flexShrink: 0 }}>
            <WandBadge className="wand-code-editor-dirty-mark" size="sm"
              tone={snapshot.file.dirty ? "warning" : "success"}>
              {snapshot.file.dirty ? "● 未保存" : "已保存"}
            </WandBadge>
            <span style={{ flex: 1 }}/>
            <WandButton
              size="small"
              kind="primary"
              loading={snapshot.saving}
              disabled={snapshot.saving || !snapshot.file.dirty}
              onClick={() => run({ type: "save" })}
            >
              {snapshot.saving ? "保存中…" : "保存 (⌘S)"}
            </WandButton>
            <WandButton
              size="small"
              disabled={snapshot.saving || !snapshot.file.dirty}
              onClick={() => run({ type: "revert" })}
            >
              撤销改动
            </WandButton>
            {markdown ? (
              <WandButton
                size="small"
                kind={rendered ? "primary" : "secondary"}
                aria-pressed={rendered}
                title={rendered ? "显示 Markdown 源码" : "渲染 Markdown 预览"}
                onClick={() => run({ type: "preview.toggle" })}
              >
                预览
              </WandButton>
            ) : null}
            <WandButton
              size="small"
              kind={snapshot.findOpen ? "primary" : "secondary"}
              onClick={openFind}
              aria-pressed={snapshot.findOpen}
              title="在文件中查找 (⌘F)"
            >
              查找 ⌘F
            </WandButton>
            <WandButton
              size="small"
              kind={snapshot.wrap ? "primary" : "secondary"}
              onClick={() => run({ type: "wrap.toggle" })}
              aria-pressed={snapshot.wrap}
            >
              自动换行
            </WandButton>
            <WandIconButton
              aria-label="缩小字号"
              onClick={() => run({ type: "font.adjust", delta: -1 })}
            >A−</WandIconButton>
            <span role="status" aria-label={`字号 ${snapshot.fontSize}`}>{snapshot.fontSize}</span>
            <WandIconButton
              aria-label="放大字号"
              onClick={() => run({ type: "font.adjust", delta: 1 })}
            >A+</WandIconButton>
          </Flex>
        )}
        {snapshot.status === "ready" && snapshot.failure ? (
          <Alert className="wand-code-editor-inline-error" type="error" showIcon title={snapshot.failure.message} />
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
      </Flex>
    </>
  );
}
