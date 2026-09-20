export const fileExplorerStyles = String.raw`
.wand-file-explorer {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  font-size: var(--font-size-sm);
}

/* One toolbar row: search plus the create actions. The panel header above
   already owns the title and refresh, so the tree keeps its vertical budget. */
.wand-file-explorer-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-subtle, #e5e7eb);
}
.wand-file-explorer-search {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
}
.wand-file-explorer-search > .wand-ui-search { flex: 1 1 auto; min-width: 0; }
.wand-file-explorer-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-secondary, #555);
  border-radius: 5px;
  cursor: pointer;
  padding: 0;
}
.wand-file-explorer-btn:hover { background: var(--bg-tertiary, #eee); color: var(--text-primary, #111); }
.wand-file-explorer-btn:disabled { opacity: 0.4; cursor: default; }

.wand-file-explorer-tree {
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0;
  min-height: 0;
}

.wand-explorer-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  cursor: pointer;
  user-select: none;
  border-left: 2px solid transparent;
  border-radius: 0 4px 4px 0;
  color: var(--text-primary, #111);
  white-space: nowrap;
  line-height: 1.45;
}
.wand-explorer-row:hover { background: var(--bg-hover, rgba(0,0,0,0.04)); }
.wand-explorer-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.wand-explorer-row.active {
  background: var(--accent-muted, rgba(37,99,235,0.12));
  border-left-color: var(--accent);
}
.wand-explorer-row.editing { background: transparent; cursor: default; }
.wand-explorer-row.editing:hover { background: transparent; }
.wand-explorer-row.pending { color: var(--text-muted); cursor: default; }
.wand-explorer-row.pending:hover { background: transparent; }
.wand-explorer-row.error { color: var(--danger, #b24f45); cursor: default; }
.wand-explorer-row.error:hover { background: transparent; }
.wand-explorer-chevron {
  width: 12px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted, #999);
  transition: transform 0.12s;
}
.wand-explorer-chevron.open { transform: rotate(90deg); }
.wand-explorer-chevron.empty { visibility: hidden; }
.wand-explorer-icon {
  flex: 0 0 auto;
  width: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.wand-explorer-icon svg,
.wand-file-explorer-btn svg {
  width: 15px;
  height: 15px;
  display: block;
}
.wand-explorer-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Size is a hover detail: the tree keeps one quiet reading column. */
.wand-explorer-size {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  opacity: 0;
  transition: opacity 0.12s;
}
.wand-explorer-row:hover .wand-explorer-size,
.wand-explorer-row.active .wand-explorer-size { opacity: 1; }
.wand-explorer-git {
  flex: 0 0 auto;
  font-size: var(--font-size-xs);
  font-weight: 600;
  width: 14px;
  text-align: center;
}
.wand-explorer-git.git-modified { color: #e76f51; }
.wand-explorer-git.git-added { color: #2a9d8f; }
.wand-explorer-git.git-deleted { color: #c0392b; }
.wand-explorer-git.git-renamed { color: #6f42c1; }
.wand-explorer-git.git-untracked { color: #8a8a8a; }

.wand-explorer-dots { display: inline-flex; gap: 2px; margin-left: 2px; color: var(--text-muted); }
.wand-explorer-dots i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  animation: wand-explorer-dot 1.1s ease-in-out infinite;
}
.wand-explorer-dots i:nth-child(2) { animation-delay: 0.16s; }
.wand-explorer-dots i:nth-child(3) { animation-delay: 0.32s; }
@keyframes wand-explorer-dot {
  0%, 80%, 100% { opacity: 0.25; }
  40% { opacity: 1; }
}

.wand-explorer-rename {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  flex: 1 1 auto;
}
.wand-explorer-rename input {
  flex: 1 1 auto;
  min-width: 0;
  border: 1px solid var(--accent, #2563eb);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: var(--font-size-sm);
  background: var(--bg-primary, #fff);
  color: var(--text-primary, #111);
}
.wand-explorer-rename input:focus { outline: none; }

/* ---------- search results ---------- */

.wand-explorer-search-panel {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.wand-explorer-search-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 7px 8px 6px;
  border-bottom: 1px solid var(--border-subtle);
}
.wand-explorer-search-count {
  flex: 0 0 auto;
  color: var(--text-primary);
  font-size: var(--font-size-xs);
  font-weight: 600;
}
.wand-explorer-search-duration {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
}
.wand-explorer-search-filters {
  display: inline-flex;
  gap: 1px;
  margin-left: auto;
  padding: 2px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full, 999px);
  background: var(--bg-secondary);
}
.wand-explorer-filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 0;
  padding: 2px 8px;
  border-radius: var(--radius-full, 999px);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
  line-height: 1.6;
  cursor: pointer;
}
.wand-explorer-filter:hover:not(:disabled) { background: var(--bg-tertiary); color: var(--text-primary); }
.wand-explorer-filter:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
.wand-explorer-filter.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm);
  font-weight: 600;
}
.wand-explorer-filter:disabled { opacity: 0.5; cursor: default; }
.wand-explorer-filter-count { color: var(--text-muted); font-family: var(--font-mono); font-size: 10px; }

.wand-explorer-search-progress {
  position: relative;
  flex: 0 0 auto;
  height: 2px;
  overflow: hidden;
  background: var(--border-subtle);
}
.wand-explorer-search-progress > span {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -38%;
  width: 38%;
  background: var(--accent);
  animation: wand-explorer-progress 1.15s ease-in-out infinite;
}
@keyframes wand-explorer-progress {
  0% { left: -38%; }
  100% { left: 100%; }
}

.wand-explorer-results {
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  padding-bottom: 6px;
}
.wand-explorer-search-group-label {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
}
.wand-explorer-search-group:first-child .wand-explorer-search-group-label { border-top: 0; }
.wand-explorer-search-group-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wand-explorer-search-group-count { margin-left: auto; }

.wand-explorer-result {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 12px;
  border-left: 2px solid transparent;
  border-radius: 0 4px 4px 0;
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
  line-height: 1.55;
}
.wand-explorer-result:hover { background: var(--bg-hover, rgba(0,0,0,0.04)); }
.wand-explorer-result.active {
  background: var(--accent-muted, rgba(37,99,235,0.12));
  border-left-color: var(--accent);
}
.wand-explorer-result-icon {
  flex: 0 0 auto;
  width: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}
.wand-explorer-result-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wand-explorer-hit {
  border-radius: 2px;
  padding: 0 1px;
  background: var(--accent-muted);
  color: var(--accent-active);
  font-weight: 600;
}
.wand-explorer-result.active .wand-explorer-hit { background: var(--bg-primary); }

.wand-explorer-keyhints {
  display: flex;
  gap: 10px;
  flex: 0 0 auto;
  padding: 5px 8px calc(5px + var(--wand-safe-bottom));
  border-top: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: 10px;
}
.wand-explorer-keyhints > span { display: inline-flex; align-items: center; gap: 3px; }
.wand-explorer-keyhints kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  height: 15px;
  padding: 0 3px;
  border: 1px solid var(--border-subtle);
  border-bottom-width: 2px;
  border-radius: 3px;
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 1;
}

.wand-file-explorer-empty {
  padding: 20px 16px;
  color: var(--text-muted, #999);
  text-align: center;
  font-size: var(--font-size-sm);
}
.wand-file-explorer-empty-title {
  margin: 0 0 6px;
  color: var(--text-secondary);
  font-weight: 600;
}
.wand-file-explorer-empty-hint {
  margin: 0 0 10px;
  font-size: var(--font-size-xs);
  line-height: 1.6;
}
.wand-file-explorer-empty .wand-ui-button { margin-top: 2px; }

.wand-explorer-context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 168px;
  background: var(--bg-primary, #fff);
  border: 1px solid var(--border-subtle, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.16);
  padding: 4px 0;
}
.wand-explorer-context-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border: none;
  background: transparent;
  color: var(--text-primary, #111);
  font-size: var(--font-size-sm);
  cursor: pointer;
  text-align: left;
}
.wand-explorer-context-item:hover { background: var(--bg-hover, rgba(0,0,0,0.04)); }
.wand-explorer-context-item.danger { color: #c0392b; }
.wand-explorer-context-item:disabled { opacity: 0.4; cursor: default; }
.wand-explorer-context-divider {
  height: 1px;
  background: var(--border-subtle, #e5e7eb);
  margin: 4px 0;
}

/* Touch devices have no arrow keys and no hover, so the hover-only size and the
   keyboard legend would be dead weight. */
@media (hover: none), (pointer: coarse) {
  .wand-explorer-keyhints { display: none; }
  .wand-explorer-size { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .wand-explorer-search-progress > span { animation: none; left: 0; width: 100%; opacity: 0.5; }
  .wand-explorer-dots i { animation: none; }
  .wand-explorer-chevron { transition: none; }
  .wand-explorer-size { transition: none; }
}
`;
