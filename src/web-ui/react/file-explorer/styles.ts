export const fileExplorerStyles = String.raw`
.wand-file-explorer {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  font-size: 0.8125rem;
}
.wand-file-explorer-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-subtle, #e5e7eb);
}
.wand-file-explorer-title {
  flex: 1 1 auto;
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted, #999);
  padding: 0 4px;
}
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

.wand-file-explorer-search {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-subtle, #e5e7eb);
}
.wand-file-explorer-search input {
  flex: 1 1 auto;
  min-width: 0;
  border: 1px solid var(--border-subtle, #e5e7eb);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 0.8125rem;
  background: var(--bg-primary, #fff);
  color: var(--text-primary, #111);
}
.wand-file-explorer-search input:focus { outline: none; border-color: var(--accent, #2563eb); }

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
  border-radius: 4px;
  color: var(--text-primary, #111);
  white-space: nowrap;
  line-height: 1.45;
}
.wand-explorer-row:hover { background: var(--bg-hover, rgba(0,0,0,0.04)); }
.wand-explorer-row.active { background: var(--bg-active, rgba(37,99,235,0.12)); }
.wand-explorer-row.editing { background: transparent; cursor: default; }
.wand-explorer-row.editing:hover { background: transparent; }
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
.wand-explorer-git {
  flex: 0 0 auto;
  font-size: 0.6875rem;
  font-weight: 600;
  width: 14px;
  text-align: center;
}
.wand-explorer-git.git-modified { color: #e76f51; }
.wand-explorer-git.git-added { color: #2a9d8f; }
.wand-explorer-git.git-deleted { color: #c0392b; }
.wand-explorer-git.git-renamed { color: #6f42c1; }
.wand-explorer-git.git-untracked { color: #8a8a8a; }

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
  font-size: 0.8125rem;
  background: var(--bg-primary, #fff);
  color: var(--text-primary, #111);
}
.wand-explorer-rename input:focus { outline: none; }

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
  font-size: 0.8125rem;
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

.wand-file-explorer-empty {
  padding: 24px 16px;
  color: var(--text-muted, #999);
  text-align: center;
  font-size: 0.8125rem;
}
`;
