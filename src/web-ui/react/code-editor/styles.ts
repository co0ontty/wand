export const codeEditorStyles = String.raw`
.wand-code-editor-host[hidden] { display: none !important; }

/* The syntax layer, gutter and textarea share exact font metrics and scroll. */
.wand-code-editor-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  display: flex;
  background: var(--bg-primary, #fff);
}
.wand-code-editor-lines {
  flex: 0 0 auto;
  margin: 0;
  padding: 12px 8px 12px 12px;
  text-align: right;
  color: var(--text-muted, #999);
  font-family: var(--font-mono, ui-monospace, monospace);
  line-height: 1.55;
  white-space: pre;
  user-select: none;
  overflow: hidden;
  tab-size: 2;
}
.wand-code-editor-area {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  overflow: auto;
}
/* Rendered Markdown: the wrapper owns scrolling, the document keeps its
   readable measure (.wand-markdown-preview). */
.wand-code-editor-markdown {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: var(--bg-primary, #fff);
  overscroll-behavior: contain;
}
.wand-code-editor-markdown:focus-visible {
  outline: 2px solid var(--accent, #2563eb);
  outline-offset: -2px;
}
.wand-code-editor-content,
.wand-code-editor-textarea {
  margin: 0;
  padding: 12px 14px;
  border: 0;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: inherit;
  line-height: 1.55;
  white-space: pre;
  tab-size: 2;
  word-break: normal;
  overflow-wrap: normal;
}
.wand-code-editor-content {
  position: absolute;
  inset: 0;
  pointer-events: none;
  color: var(--text-primary, #111);
  /* The textarea is the only scroller. Without this the syntax layer keeps its
     own overflow, which makes the surrounding area scroll away from the caret
     and breaks every programmatic jump (find, restore). scrollbar-gutter keeps
     the same content width as the textarea so wrapped lines break at the same
     characters in both layers. */
  overflow: hidden;
  scrollbar-gutter: stable;
}
.wand-code-editor-content code { font-family: inherit; }
.wand-code-editor-textarea {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background: transparent;
  color: transparent;
  caret-color: var(--text-primary, #111);
  resize: none;
  outline: none;
  /* Transparent text over the syntax layer: the browser scrolls this box and
     onScroll mirrors it onto the gutter and the layer. */
  overflow: auto;
  scrollbar-gutter: stable;
}
.wand-code-editor-textarea::selection { background: rgba(37, 99, 235, 0.22); }
.wand-code-editor-host.wrap .wand-code-editor-content,
.wand-code-editor-host.wrap .wand-code-editor-textarea { white-space: pre-wrap; overflow-wrap: break-word; }

/* syntax highlight (reuses file-preview palette) */
.wand-code-editor-content .wand-file-preview-syntax-keyword { color: #8250df; }
.wand-code-editor-content .wand-file-preview-syntax-string { color: #0a7d37; }
.wand-code-editor-content .wand-file-preview-syntax-number { color: #b35900; }
.wand-code-editor-content .wand-file-preview-syntax-comment { color: #6a737d; font-style: italic; }
.wand-code-editor-content .wand-file-preview-syntax-operator { color: #b2085f; }

/* find hits inside the syntax layer */
.wand-code-editor-content mark.wand-code-editor-hit {
  background: rgba(250, 204, 21, 0.42);
  color: inherit;
  border-radius: 2px;
}
.wand-code-editor-content mark.wand-code-editor-hit.active {
  background: rgba(249, 115, 22, 0.55);
  box-shadow: 0 0 0 1px rgba(194, 65, 12, 0.55);
}
`;
