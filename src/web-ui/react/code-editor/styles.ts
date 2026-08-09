export const codeEditorStyles = String.raw`
.wand-code-editor-host {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary, #fff);
  z-index: 12;
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
  font-size: 0.8125rem;
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
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 6px 12px;
  background: var(--bg-primary, #fff);
  border-bottom: 1px solid var(--border-subtle, #e5e7eb);
  font-size: 0.8125rem;
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
  font-size: 0.8125rem;
  cursor: pointer;
}
.wand-code-editor-toolbar button.wand-code-editor-btn:hover:not(:disabled) { background: var(--bg-tertiary, #eee); }
.wand-code-editor-toolbar button.wand-code-editor-btn:disabled { opacity: 0.5; cursor: default; }
.wand-code-editor-toolbar button.wand-code-editor-btn.primary {
  background: var(--accent, #2563eb);
  border-color: var(--accent, #2563eb);
  color: #fff;
}
.wand-code-editor-dirty-mark {
  color: var(--accent, #2563eb);
  font-size: 0.75rem;
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
  overflow: hidden;
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
  font-size: 0.875rem;
  padding: 24px;
  text-align: center;
}
.wand-code-editor-state.error { color: #c0392b; }
.wand-code-editor-inline-error {
  margin: 0;
  padding: 6px 12px;
  background: #fdecea;
  color: #c0392b;
  font-size: 0.8125rem;
}
`;
