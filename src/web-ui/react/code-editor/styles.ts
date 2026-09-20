export const codeEditorStyles = String.raw`
.wand-code-editor-host {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary, #fff);
  /* Above the session composer (26), below drawers and their backdrop (44+). */
  z-index: 40;
}
.wand-code-editor-host[hidden] { display: none !important; }

.wand-code-editor-tabs {
  display: flex;
  align-items: stretch;
  gap: 0;
  flex: 0 0 auto;
  padding: 0 8px;
  background: var(--bg-secondary, #f7f7f8);
  border-bottom: 1px solid var(--border-subtle, #e5e7eb);
  min-height: 36px;
  overflow-x: auto;
  scrollbar-width: thin;
}
.wand-code-editor-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  margin: 4px 2px 0;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: var(--text-secondary, #555);
  font-size: 11.375px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}
.wand-code-editor-tab:hover { background: var(--bg-tertiary, #eee); color: var(--text-primary, #111); }
.wand-code-editor-tab.active {
  background: var(--bg-primary, #fff);
  border-color: var(--border-subtle, #e5e7eb);
  color: var(--text-primary, #111);
}
.wand-code-editor-tab-dirty {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent, #2563eb);
  display: inline-block;
  flex: 0 0 auto;
}
.wand-code-editor-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: var(--text-muted, #999);
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
}
.wand-code-editor-tab-close:hover { background: var(--bg-hover, #ddd); color: var(--text-primary, #111); }

.wand-code-editor-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 6px 12px;
  background: var(--bg-primary, #fff);
  border-bottom: 1px solid var(--border-subtle, #e5e7eb);
  font-size: 11.375px;
  color: var(--text-secondary, #555);
  min-height: 32px;
}
.wand-code-editor-toolbar-spacer { flex: 1 1 auto; }
.wand-code-editor-toolbar button.wand-code-editor-btn {
  border: 1px solid var(--border-subtle, #e5e7eb);
  background: var(--bg-secondary, #f7f7f8);
  color: var(--text-primary, #111);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 11.375px;
  cursor: pointer;
}
.wand-code-editor-toolbar button.wand-code-editor-btn:hover:not(:disabled) { background: var(--bg-tertiary, #eee); }
.wand-code-editor-toolbar button.wand-code-editor-btn:disabled { opacity: 0.5; cursor: default; }
.wand-code-editor-toolbar button.wand-code-editor-btn.primary {
  background: var(--accent-solid);
  border-color: var(--accent-solid);
  color: #fff;
}
.wand-code-editor-dirty-mark {
  color: var(--accent, #2563eb);
  font-size: 10.5px;
}

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

.wand-code-editor-state {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted, #999);
  font-size: 12.25px;
  padding: 24px;
  text-align: center;
}
.wand-code-editor-state.error { color: #c0392b; }
.wand-code-editor-inline-error {
  margin: 0;
  padding: 6px 12px;
  background: #fdecea;
  color: #c0392b;
  font-size: 11.375px;
}

/* find bar (⌘F) */
.wand-code-editor-find {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 4px 12px 4px 10px;
  background: var(--bg-secondary, #f7f7f8);
  border-bottom: 1px solid var(--border-subtle, #e5e7eb);
  color: var(--text-muted, #999);
  min-height: 32px;
}
.wand-code-editor-find-input {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 320px;
  border: 1px solid var(--border-subtle, #e5e7eb);
  border-radius: 6px;
  padding: 3px 8px;
  background: var(--bg-primary, #fff);
  color: var(--text-primary, #111);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11.375px;
}
.wand-code-editor-find-input:focus { outline: none; border-color: var(--accent, #2563eb); }
.wand-code-editor-find-count {
  flex: 0 0 auto;
  min-width: 52px;
  color: var(--text-secondary, #555);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  text-align: right;
}
.wand-code-editor-find-count.empty { color: var(--danger, #c0392b); }
.wand-code-editor-find-line {
  flex: 0 0 auto;
  color: var(--text-muted, #999);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
}
.wand-code-editor-find-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 4px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary, #555);
  font-size: 11.375px;
  line-height: 1;
  cursor: pointer;
}
.wand-code-editor-find-btn:hover:not(:disabled) { background: var(--bg-tertiary, #eee); color: var(--text-primary, #111); }
.wand-code-editor-find-btn:disabled { opacity: 0.4; cursor: default; }
.wand-code-editor-find-btn.active {
  background: var(--accent-muted, rgba(37,99,235,0.12));
  border-color: var(--accent, #2563eb);
  color: var(--text-primary, #111);
}

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
@media (prefers-reduced-motion: reduce) {
  .wand-code-editor-find-btn { transition: none; }
}
`;
