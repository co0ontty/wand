export const filePreviewStyles = String.raw`
.wand-file-preview-overlay { z-index: 54; }

/* Generic confirmation dialogs render after File Preview in the shared portal. */
.wand-file-preview-overlay ~ .wand-ui-dialog-overlay:not(.wand-file-preview-overlay) { z-index: 56; }
.wand-file-preview-overlay ~ .wand-ui-dialog-content:not(.wand-file-preview-dialog) { z-index: 57; }

.wand-file-preview-dialog {
  z-index: 55;
  width: min(1040px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 40px));
  height: min(760px, calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 40px));
  max-width: none;
  max-height: none;
  padding: 0;
  overflow: hidden;
}

.wand-file-preview-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex: 0 0 auto;
  padding: 17px 20px 13px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-primary);
}

.wand-file-preview-header > div:first-child { min-width: 0; }
.wand-file-preview-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wand-file-preview-path {
  max-width: min(76vw, 820px);
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wand-file-preview-shell {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  outline: none;
}

.wand-file-preview-title-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  background: var(--bg-secondary);
  font-size: var(--font-size-xs);
}

.wand-file-preview-kind-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 20px;
  color: var(--accent-active);
  font-family: var(--font-mono);
  font-weight: var(--font-weight-bold);
}

.wand-file-preview-kind {
  padding: 2px 7px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  background: var(--bg-primary);
  font-family: var(--font-mono);
}

.wand-file-preview-dirty { margin-left: auto; color: var(--warning); font-weight: var(--font-weight-semibold); }

.wand-file-preview-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  min-height: 48px;
  padding: 7px 12px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-primary);
  scrollbar-width: thin;
}

.wand-file-preview-toolbar.editing { background: var(--bg-secondary); }
.wand-file-preview-toolbar-group { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; }
.wand-file-preview-toolbar-group + .wand-file-preview-toolbar-group {
  padding-left: 8px;
  border-left: 1px solid var(--border-subtle);
}

.wand-file-preview-download {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 30px;
  padding: 5px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  background: var(--bg-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  line-height: 1.2;
  text-decoration: none;
}

.wand-file-preview-download:hover { border-color: var(--accent); color: var(--accent-active); background: var(--bg-elevated); }
.wand-file-preview-download:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--bg-primary), 0 0 0 4px var(--accent); }
.wand-file-preview-font-size { min-width: 24px; color: var(--text-muted); font-family: var(--font-mono); text-align: center; }

.wand-file-preview-inline-error {
  flex: 0 0 auto;
  margin: 0;
  padding: 8px 14px;
  border-bottom: 1px solid var(--danger);
  color: var(--danger);
  background: var(--danger-muted);
  font-size: var(--font-size-sm);
}

.wand-file-preview-body {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: var(--bg-secondary);
  overscroll-behavior: contain;
}

.wand-file-preview-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  min-height: 220px;
  padding: 28px;
  color: var(--text-muted);
  text-align: center;
}

.wand-file-preview-error > span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-full);
  color: var(--danger);
  background: var(--danger-muted);
  font-weight: var(--font-weight-bold);
}
.wand-file-preview-error strong { color: var(--danger); }

.wand-file-preview-code {
  display: grid;
  grid-template-columns: auto minmax(max-content, 1fr);
  min-width: 100%;
  min-height: 100%;
  background: var(--bg-primary);
}

.wand-file-preview-lines,
.wand-file-preview-code-content {
  box-sizing: border-box;
  min-height: 100%;
  margin: 0;
  padding: 16px 14px;
  font-family: var(--font-mono);
  line-height: 1.62;
  tab-size: 2;
  white-space: pre;
}

.wand-file-preview-lines {
  position: sticky;
  left: 0;
  z-index: 1;
  min-width: 52px;
  border-right: 1px solid var(--border-subtle);
  color: var(--text-muted);
  background: var(--bg-secondary);
  text-align: right;
  user-select: none;
}

.wand-file-preview-code-content { color: var(--text-primary); }
.wand-file-preview-code.wrap { grid-template-columns: auto minmax(0, 1fr); width: 100%; }
.wand-file-preview-code.wrap .wand-file-preview-code-content,
.wand-file-preview-markdown.wrap { overflow-wrap: anywhere; white-space: pre-wrap; }

.wand-file-preview-syntax-comment { color: var(--text-muted); font-style: italic; }
.wand-file-preview-syntax-string { color: var(--success); }
.wand-file-preview-syntax-number { color: var(--warning); }
.wand-file-preview-syntax-keyword { color: var(--accent-active); font-weight: var(--font-weight-semibold); }
.wand-file-preview-syntax-operator { color: var(--danger); }

.wand-file-preview-markdown {
  box-sizing: border-box;
  width: min(100%, 920px);
  min-height: 100%;
  margin: 0 auto;
  padding: 26px 32px 48px;
  color: var(--text-primary);
  background: var(--bg-primary);
  line-height: 1.72;
}

.wand-file-preview-markdown p,
.wand-file-preview-markdown blockquote { white-space: pre-wrap; }
.wand-file-preview-markdown h1,
.wand-file-preview-markdown h2,
.wand-file-preview-markdown h3 { margin: 1.35em 0 0.55em; line-height: 1.25; }
.wand-file-preview-markdown h1:first-child,
.wand-file-preview-markdown h2:first-child,
.wand-file-preview-markdown h3:first-child { margin-top: 0; }
.wand-file-preview-markdown a { color: var(--accent-active); }
.wand-file-preview-markdown code {
  border-radius: var(--radius-xs);
  padding: 0.12em 0.34em;
  background: var(--bg-tertiary);
  font-family: var(--font-mono);
}
.wand-file-preview-markdown pre {
  overflow: auto;
  padding: 14px 16px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  white-space: pre;
}
.wand-file-preview-markdown pre code { padding: 0; background: transparent; }
.wand-file-preview-markdown blockquote { margin-left: 0; padding-left: 14px; border-left: 3px solid var(--accent); color: var(--text-secondary); }
.wand-file-preview-markdown img { max-width: 100%; height: auto; border-radius: var(--radius-md); }
.wand-file-preview-table-wrap { max-width: 100%; overflow-x: auto; }
.wand-file-preview-table-wrap table { width: 100%; border-collapse: collapse; }
.wand-file-preview-table-wrap th,
.wand-file-preview-table-wrap td { padding: 8px 10px; border: 1px solid var(--border-subtle); }
.wand-file-preview-table-wrap th { background: var(--bg-secondary); }

.wand-file-preview-editor { display: flex; flex: 1 1 auto; min-width: 0; min-height: 0; }
.wand-file-preview-editor textarea {
  box-sizing: border-box;
  flex: 1 1 auto;
  width: 100%;
  min-height: 100%;
  resize: none;
  border: 0;
  outline: none;
  padding: 18px 20px 44px;
  color: var(--text-primary);
  background: var(--bg-primary);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.62;
  tab-size: 2;
  caret-color: var(--accent-active);
}
.wand-file-preview-editor textarea:focus { box-shadow: inset 0 0 0 2px var(--accent-muted); }

.wand-file-preview-image {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 100%;
  padding: 24px;
  overflow: auto;
  border: 0;
  color: inherit;
  background-image: linear-gradient(45deg, var(--bg-tertiary) 25%, transparent 25%), linear-gradient(-45deg, var(--bg-tertiary) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg-tertiary) 75%), linear-gradient(-45deg, transparent 75%, var(--bg-tertiary) 75%);
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-size: 16px 16px;
  cursor: zoom-in;
}
.wand-file-preview-image img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; box-shadow: var(--shadow-md); }
.wand-file-preview-image.zoomed { align-items: flex-start; justify-content: flex-start; cursor: zoom-out; }
.wand-file-preview-image.zoomed img { max-width: none; max-height: none; }

.wand-file-preview-pdf { width: 100%; min-height: 100%; border: 0; background: var(--bg-primary); }
.wand-file-preview-media {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  min-height: 100%;
  padding: 26px;
  color: var(--text-secondary);
}
.wand-file-preview-media video { max-width: 100%; max-height: calc(100% - 40px); border-radius: var(--radius-md); background: #000; }
.wand-file-preview-audio audio { width: min(520px, 100%); }
.wand-file-preview-media-icon { font-size: 48px; color: var(--accent-active); }

.wand-file-preview-binary {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 12px;
  width: min(560px, calc(100% - 32px));
  margin: auto;
  padding: 30px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  color: var(--text-primary);
  background: var(--bg-primary);
  box-shadow: var(--shadow-sm);
  text-align: center;
}
.wand-file-preview-binary-icon { font-size: 44px; color: var(--accent-active); }
.wand-file-preview-binary-meta { display: flex; gap: 7px; color: var(--text-muted); }
.wand-file-preview-binary > code { max-width: 100%; overflow-wrap: anywhere; color: var(--text-secondary); font-family: var(--font-mono); }
.wand-file-preview-binary-actions { display: flex; gap: 8px; margin-top: 6px; }

.wand-file-preview-metadata {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 0 0 auto;
  min-height: 32px;
  padding: 6px 14px calc(6px + var(--wand-safe-bottom));
  border-top: 1px solid var(--border-subtle);
  color: var(--text-muted);
  background: var(--bg-primary);
  font-size: var(--font-size-xs);
}
.wand-file-preview-metadata code { min-width: 0; margin-left: auto; overflow: hidden; font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 768px) {
  .wand-file-preview-dialog {
    width: calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 12px);
    height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 12px);
    border-radius: var(--radius-md);
  }
  .wand-file-preview-header { padding: 13px 14px 10px; }
  .wand-file-preview-path { max-width: calc(100vw - 88px); }
  .wand-file-preview-title-meta { padding-inline: 10px; }
  .wand-file-preview-toolbar { padding: 6px 8px; }
  .wand-file-preview-markdown { padding: 20px 18px 36px; }
  .wand-file-preview-lines,
  .wand-file-preview-code-content { padding: 12px 10px; }
  .wand-file-preview-lines { min-width: 42px; }
  .wand-file-preview-metadata { gap: 8px; padding-inline: 10px; }
  .wand-file-preview-metadata code { display: none; }
  .wand-file-preview-binary { padding: 22px 16px; }
  .wand-file-preview-binary-actions { width: 100%; flex-direction: column; }
  .wand-file-preview-binary-actions > * { width: 100%; }
}

@media (max-width: 420px) {
  .wand-file-preview-dialog {
    width: calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 8px);
    height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 8px);
  }
  .wand-file-preview-header { padding-inline: 12px; }
  .wand-file-preview-toolbar-group + .wand-file-preview-toolbar-group { padding-left: 6px; }
  .wand-file-preview-download { white-space: nowrap; }
  .wand-file-preview-image { padding: 10px; }
  .wand-file-preview-media { padding: 16px 10px; }
}
`;
