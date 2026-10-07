export const filePreviewStyles = String.raw`
/* Code document grid, sticky gutter, wrapping and syntax are content rendering. */
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
.wand-file-preview-code.wrap .wand-file-preview-code-content { overflow-wrap: anywhere; white-space: pre-wrap; }

.wand-file-preview-syntax-comment { color: var(--text-muted); font-style: italic; }
.wand-file-preview-syntax-string { color: var(--success); }
.wand-file-preview-syntax-number { color: var(--warning); }
.wand-file-preview-syntax-keyword { color: var(--accent-active); font-weight: var(--font-weight-semibold); }
.wand-file-preview-syntax-operator { color: var(--danger); }

`;
