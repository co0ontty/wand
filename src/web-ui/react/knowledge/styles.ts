export const knowledgeStyles = `
.wand-knowledge-page{position:absolute;inset:0;z-index:8;display:flex;min-height:0;min-width:0;background:var(--bg-primary);color:var(--text-primary)}
.wand-knowledge-page .knowledge-directory{width:264px;flex-shrink:0;display:flex;flex-direction:column;min-height:0;background:var(--bg-secondary);border-right:1px solid var(--border-subtle)}
.wand-knowledge-page .directory-title{display:flex;align-items:center;justify-content:space-between;padding:18px 16px 8px;gap:12px}
.wand-knowledge-page .directory-title h1{font-size:18px;font-weight:600;line-height:26px;margin:0}
.wand-knowledge-page .knowledge-tabs{padding-inline:16px}
.wand-knowledge-page .knowledge-tabs .ant-tabs-nav{margin:0!important}
.wand-knowledge-page .knowledge-tabs .ant-tabs-content-holder{display:none}
.wand-knowledge-page .directory-tools{display:flex;flex-direction:column;gap:12px;padding:18px 16px}
.wand-knowledge-page .directory-tools>.wand-ui-select{width:100%}
.wand-knowledge-page .directory-caption{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 20px 10px;font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums}
.wand-knowledge-page .document-tree{overflow:auto;flex:1;min-height:0;padding:0 10px 20px;scrollbar-gutter:stable}
.wand-knowledge-page .document-tree .ant-tree{background:transparent;font-size:13px}
.wand-knowledge-page .document-tree .ant-tree-treenode{min-height:36px;align-items:center;padding-block:2px}
.wand-knowledge-page .document-tree .ant-tree-node-content-wrapper{min-width:0;display:flex;align-items:center;line-height:30px}
.wand-knowledge-page .document-tree .ant-tree-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wand-knowledge-page .document-tree .ant-tree-iconEle{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--text-secondary)}
.wand-knowledge-page .document-tree .ant-tree-indent-unit{width:12px}
.wand-knowledge-page .document-tree .ant-tree-switcher{align-self:center}
.wand-knowledge-page .directory-empty{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:22px 10px;color:var(--text-secondary);font-size:13px}
.wand-knowledge-page .library-note{display:flex;align-items:flex-start;gap:8px;padding:16px 18px;color:var(--text-secondary);font-size:11px;line-height:1.8;flex-shrink:0}
.wand-knowledge-page .library-note svg{margin-top:3px;flex-shrink:0}
.wand-knowledge-page .library-note p{margin:0}
.wand-knowledge-page .knowledge-document{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;background:var(--bg-primary)}
.wand-knowledge-page .document-bar{min-height:62px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 28px;flex-shrink:0}
.wand-knowledge-page .document-location{display:flex;align-items:center;gap:10px;min-width:0;font-size:12px;color:var(--text-secondary)}
.wand-knowledge-page .document-location>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wand-knowledge-page .breadcrumb-divider{opacity:.6;flex-shrink:0}
.wand-knowledge-page .document-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.wand-knowledge-page .knowledge-save-button{min-width:88px}
.wand-knowledge-page .directory-back{display:none!important}
.wand-knowledge-page .document-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
.wand-knowledge-page .document-paper{max-width:780px;margin:0 auto;padding:34px 48px 80px;overflow-wrap:anywhere}
.wand-knowledge-page .document-state{font-size:12px;line-height:22px;color:var(--text-secondary);min-height:22px;margin-bottom:12px}
.wand-knowledge-page .document-paper>h1{font-size:30px;line-height:1.5;font-weight:600;letter-spacing:-.02em;margin:0 0 30px;text-wrap:balance}
.wand-knowledge-page .document-paper .wand-markdown-preview{font-size:15px;line-height:1.95;color:var(--text-primary)}
.wand-knowledge-page .document-paper .wand-markdown-preview p{margin:0 0 18px}
.wand-knowledge-page .document-paper .wand-markdown-preview :is(h2,h3){font-size:19px;font-weight:600;line-height:1.5;margin:32px 0 12px}
.wand-knowledge-page .document-paper .wand-markdown-preview li{margin-block:6px}
.wand-knowledge-page .document-paper .wand-markdown-preview ul{padding-inline-start:22px;margin-block:0 18px}
.wand-knowledge-page .document-paper .document-title-input{font-size:30px;font-weight:600;line-height:1.5;padding:0;margin:0 0 24px;resize:none;letter-spacing:-.02em}
.wand-knowledge-page #knowledge-document-body{font-size:15px;line-height:1.95;padding:8px 0;resize:none}
.wand-knowledge-page .knowledge-editor-tools{margin-bottom:18px}
.wand-knowledge-page .knowledge-editor-tools label{display:flex;align-items:center;gap:10px;color:var(--text-secondary);font-size:12px;max-width:260px}
.wand-knowledge-page .editor-hint{display:block;font-size:12px;color:var(--text-secondary);line-height:1.7;margin-bottom:10px}
.wand-knowledge-page .document-count{font-size:11px;line-height:20px;color:var(--text-secondary);text-align:right;font-variant-numeric:tabular-nums}
.wand-knowledge-page .document-error{margin-bottom:20px}
.wand-knowledge-page .knowledge-conflict{padding:16px;margin-bottom:24px;border:1px solid var(--border-subtle);border-radius:8px}
.wand-knowledge-page .knowledge-conflict summary{cursor:pointer}
.wand-knowledge-page .document-footer{display:flex;align-items:center;gap:7px;border-top:1px solid var(--border-subtle);padding-top:18px;margin-top:44px;font-size:12px;color:var(--text-secondary)}
.wand-knowledge-page .document-empty{min-height:360px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:16px;padding:40px 24px;color:var(--text-secondary)}
.wand-knowledge-page .document-empty p{margin:0;font-size:13px;line-height:1.8;max-width:320px}
.wand-knowledge-page .document-empty .ant-empty{margin:0}
@media(max-width:1000px){.wand-knowledge-page .knowledge-directory{width:244px}.wand-knowledge-page .document-paper{padding:28px 32px 64px}.wand-knowledge-page .document-bar{padding-inline:20px}}
@media(max-width:700px){.wand-knowledge-page .knowledge-directory{width:auto;flex:1;border:0}.wand-knowledge-page.show-document .knowledge-directory,.wand-knowledge-page.show-directory .knowledge-document{display:none}.wand-knowledge-page .directory-back{display:inline-flex!important}.wand-knowledge-page .document-bar{padding:10px 12px;gap:8px;min-height:60px;border-bottom:1px solid var(--border-subtle)}.wand-knowledge-page .document-location{gap:6px}.wand-knowledge-page .document-location>span:last-child,.wand-knowledge-page .breadcrumb-divider{display:none}.wand-knowledge-page .document-actions{gap:4px}.wand-knowledge-page .document-paper{padding:26px 22px 48px}.wand-knowledge-page .document-paper>h1,.wand-knowledge-page .document-title-input{font-size:26px;margin-bottom:24px}.wand-knowledge-page .document-tree .ant-tree-treenode{min-height:44px}.wand-knowledge-page .library-note{font-size:12px}.wand-knowledge-page .document-footer{margin-top:32px;line-height:1.7}}
@media(max-width:360px){.wand-knowledge-page .document-location>span{max-width:70px}.wand-knowledge-page .document-paper{padding-inline:18px}}
@media(pointer:coarse){.wand-knowledge-page :is(.wand-ui-button,.wand-ui-icon-button,.wand-ui-input){min-height:44px}.wand-knowledge-page .knowledge-tabs .ant-tabs-tab{min-height:44px}}
@media(prefers-reduced-motion:reduce){.wand-knowledge-page *{scroll-behavior:auto!important}}
`;
