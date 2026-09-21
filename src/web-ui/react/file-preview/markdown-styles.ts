/**
 * Markdown rendering rules shared by the file preview dialog and the code
 * editor's rendered mode. They live in their own module (instead of either
 * component's stylesheet) so the two surfaces cannot drift apart.
 */
export const markdownPreviewStyles = String.raw`
.wand-markdown-preview {
  box-sizing: border-box;
  width: min(100%, 920px);
  min-height: 100%;
  margin: 0 auto;
  padding: 26px 32px 48px;
  color: var(--text-primary);
  background: var(--bg-primary);
  line-height: 1.72;
}

.wand-markdown-preview.wrap { overflow-wrap: anywhere; white-space: pre-wrap; }
.wand-markdown-preview p,
.wand-markdown-preview blockquote { white-space: pre-wrap; }
.wand-markdown-preview h1,
.wand-markdown-preview h2,
.wand-markdown-preview h3 { margin: 1.35em 0 0.55em; line-height: 1.25; }
.wand-markdown-preview h1:first-child,
.wand-markdown-preview h2:first-child,
.wand-markdown-preview h3:first-child { margin-top: 0; }
.wand-markdown-preview a { color: var(--accent-active); }
.wand-markdown-preview code {
  border-radius: var(--radius-xs);
  padding: 0.12em 0.34em;
  background: var(--bg-tertiary);
  font-family: var(--font-mono);
}
.wand-markdown-preview pre {
  overflow: auto;
  padding: 14px 16px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  white-space: pre;
}
.wand-markdown-preview pre code { padding: 0; background: transparent; }
.wand-markdown-preview blockquote { margin-left: 0; padding-left: 14px; border-left: 3px solid var(--accent); color: var(--text-secondary); }
.wand-markdown-preview img { max-width: 100%; height: auto; border-radius: var(--radius-md); }
.wand-markdown-table-wrap { max-width: 100%; overflow-x: auto; }
.wand-markdown-table-wrap table { width: 100%; border-collapse: collapse; }
.wand-markdown-table-wrap th,
.wand-markdown-table-wrap td { padding: 8px 10px; border: 1px solid var(--border-subtle); }
.wand-markdown-table-wrap th { background: var(--bg-secondary); }

@media (max-width: 768px) {
  .wand-markdown-preview { padding: 20px 18px 36px; }
}
`;
