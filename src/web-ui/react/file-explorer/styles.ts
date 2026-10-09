export const fileExplorerStyles = String.raw`
.wand-file-explorer-btn, .file-side-panel-header-actions .ant-btn, .file-explorer-up { width: 32px; height: 32px; flex-shrink: 0; }
.wand-explorer-search-scope { justify-content: space-between; gap: 8px; padding: 0 0 8px; }
.wand-explorer-search-scope .ant-checkbox-wrapper { font-size: 12px; }
.wand-explorer-search-scope > .ant-typography { font-size: 11px; flex-shrink: 0; }
.wand-explorer-search-count, .wand-explorer-search-duration { font-size: 12px; }
.wand-explorer-search-limit { font-size: 12px; line-height: 1.5; padding-bottom: 8px; }
.wand-explorer-results { overflow-x: hidden; }
@media (pointer: coarse) {
  .wand-file-explorer-btn, .file-side-panel-header-actions .ant-btn, .file-explorer-up { width: 44px; height: 44px; }
  .wand-file-explorer :is([role="treeitem"], [role="option"]) { min-height: 44px; }
}
/* Native touch has no arrow keys; the keyboard legend is conditional content. */
@media (hover: none), (pointer: coarse) { .wand-explorer-keyhints { display: none; } }
`;
