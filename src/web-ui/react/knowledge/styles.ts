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
/* Execution history: compact record navigation and a full-width reading surface. */
.wand-knowledge-page .knowledge-executions-link{margin:0 12px 20px;width:calc(100% - 24px);min-height:36px;justify-content:flex-start;gap:8px;border-radius:6px;color:var(--text-secondary)}
.wand-knowledge-page .knowledge-executions-link>svg:last-child{margin-left:auto}
.wand-knowledge-page .knowledge-executions-link[aria-pressed=true]{background:var(--bg-hover);color:var(--text-primary);font-weight:500}
.wand-knowledge-page .directory-title{padding:16px 16px 12px}
.wand-knowledge-page .directory-tools{padding:16px;gap:8px}
.wand-knowledge-page .document-bar{min-height:48px;padding-block:8px;border-bottom:1px solid var(--border-subtle)}
.wand-knowledge-page.show-executions .document-paper{max-width:none;padding:0;margin:0;min-height:100%;display:flex}
.execution-library{display:flex;flex-direction:column;width:100%;min-width:0;font-size:14px;line-height:1.5}
.execution-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:28px 32px 24px}
.execution-eyebrow{font-size:12px;color:var(--text-secondary);margin-bottom:4px}
.execution-heading h1{margin:0;font-size:24px;font-weight:600;line-height:32px;letter-spacing:0}
.execution-heading p{margin:8px 0 0;color:var(--text-secondary);font-size:13px}
.execution-toolbar{display:flex;align-items:center;gap:8px;min-height:52px;padding:8px 24px;border-block:1px solid var(--border-subtle)}
.execution-toolbar .wand-ui-button{height:32px;font-size:13px;gap:8px;border-radius:6px;color:var(--text-secondary)}
.execution-toolbar .wand-ui-button[aria-pressed=true]{background:var(--bg-hover);color:var(--text-primary);font-weight:500}
.execution-count{font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums;margin-left:4px}
.execution-readonly{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);white-space:nowrap}
.execution-error{margin:16px 24px}
.execution-workspace{display:grid;grid-template-columns:260px minmax(0,1fr);flex:1;min-height:400px}
.execution-records{background:var(--bg-secondary);border-right:1px solid var(--border-subtle);padding:16px 8px;min-width:0}
.execution-list-caption{padding:0 12px 12px;font-size:12px;color:var(--text-secondary)}
.execution-record{display:flex;flex-direction:column;gap:4px;width:100%;padding:12px;border:1px solid transparent;border-radius:6px;text-align:left;background:transparent;color:var(--text-primary);font:inherit;cursor:pointer;margin-bottom:4px;transition:background 120ms ease,border-color 120ms ease}
.execution-record:hover{background:var(--bg-hover)}
.execution-record[aria-pressed=true]{background:var(--bg-primary);border-color:var(--border-subtle)}
.execution-record:focus-visible,.execution-scope summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.execution-record-time{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;font-variant-numeric:tabular-nums}
.execution-record-time svg{color:var(--text-secondary);flex-shrink:0}
.execution-record-time svg:last-child{margin-left:auto}
.execution-record-tool{padding-left:24px;font-size:12px;color:var(--text-secondary)}
.execution-record-model{padding-left:24px;font-size:12px;color:var(--text-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.execution-more{margin:12px;width:calc(100% - 24px)}
.execution-detail{padding:24px 32px 40px;min-width:0}
.execution-detail-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.execution-detail-heading h2,.execution-section-heading h2{font-size:18px;font-weight:600;line-height:24px;margin:0}
.execution-detail-heading time{font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums}
.execution-metadata{display:grid;gap:12px;margin:0 0 28px;font-size:13px}
.execution-metadata>div{display:grid;grid-template-columns:88px minmax(0,1fr);gap:12px}
.execution-metadata dt{color:var(--text-secondary)}
.execution-metadata dd{margin:0;overflow-wrap:anywhere}
.execution-session{font-family:var(--font-mono,monospace);font-size:12px}
.execution-parts-heading{display:flex;align-items:center;gap:12px;font-weight:500;font-size:13px;margin-bottom:12px}
.execution-parts-heading>span{font-weight:400;color:var(--text-secondary);font-size:12px}
.execution-part{border:1px solid var(--border-subtle);border-radius:8px;overflow:hidden;margin-bottom:16px}
.execution-part>header{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg-secondary);border-bottom:1px solid var(--border-subtle)}
.execution-part h3{margin:0;font-size:13px;font-weight:500;overflow-wrap:anywhere}
.execution-part-index{font-size:11px;font-family:var(--font-mono,monospace);color:var(--text-secondary)}
.execution-prompt-text{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:20px;font:13px/1.8 var(--font-mono,monospace);color:var(--text-primary);tab-size:2}
.execution-current{padding:28px 32px 40px;flex:1}
.execution-current>.execution-prompt-text{border:1px solid var(--border-subtle);border-radius:8px;margin-top:24px}
.execution-section-heading{display:flex;align-items:center;gap:8px}
.execution-description{font-size:13px;color:var(--text-secondary);margin:8px 0;line-height:1.7}
.execution-empty{display:flex;flex:1;min-height:400px;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:48px 24px;gap:12px}
.execution-empty-icon{display:grid;place-items:center;width:48px;height:48px;border:1px solid var(--border-subtle);border-radius:12px;color:var(--text-secondary);background:var(--bg-secondary);margin-bottom:4px}
.execution-empty h2{font-size:18px;font-weight:500;line-height:24px;margin:0}
.execution-empty p{font-size:13px;line-height:22px;color:var(--text-secondary);margin:0 0 8px}
.execution-empty>span{font-size:12px;color:var(--text-secondary);margin-top:4px}
.execution-empty .wand-ui-button{font-size:13px;gap:8px;border-radius:6px}
.execution-scope{border-top:1px solid var(--border-subtle);padding:16px 32px;color:var(--text-secondary);font-size:12px;line-height:20px;margin-top:auto}
.execution-scope summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;width:fit-content;border-radius:4px}
.execution-scope summary::-webkit-details-marker{display:none}
.execution-scope p{margin:12px 0 0;max-width:760px}
@media(max-width:1100px){.execution-workspace{grid-template-columns:212px minmax(0,1fr)}.execution-detail{padding:24px}.execution-toolbar{padding-inline:16px}.execution-readonly{display:none}}
@media(max-width:700px){.execution-heading{padding:24px 20px}.execution-heading h1{font-size:22px}.execution-toolbar{padding:8px 12px;gap:4px;flex-wrap:wrap}.execution-workspace{display:flex;flex-direction:column}.execution-records{border-right:0;border-bottom:1px solid var(--border-subtle);max-height:240px;overflow:auto}.execution-detail,.execution-current{padding:24px 20px}.execution-scope{padding:16px 20px}.execution-empty{min-height:360px}.execution-prompt-text{padding:16px;font-size:12px}.execution-metadata>div{grid-template-columns:68px minmax(0,1fr)}}
@media(max-width:1000px){.wand-knowledge-page .knowledge-directory{width:244px}.wand-knowledge-page .document-paper{padding:28px 32px 64px}.wand-knowledge-page .document-bar{padding-inline:20px}}
@media(max-width:700px){.wand-knowledge-page .knowledge-directory{width:auto;flex:1;border:0}.wand-knowledge-page.show-document .knowledge-directory,.wand-knowledge-page.show-directory .knowledge-document{display:none}.wand-knowledge-page .directory-back{display:inline-flex!important}.wand-knowledge-page .document-bar{padding:10px 12px;gap:8px;min-height:60px;border-bottom:1px solid var(--border-subtle)}.wand-knowledge-page .document-location{gap:6px}.wand-knowledge-page .document-location>span:last-child,.wand-knowledge-page .breadcrumb-divider{display:none}.wand-knowledge-page .document-actions{gap:4px}.wand-knowledge-page .document-paper{padding:26px 22px 48px}.wand-knowledge-page .document-paper>h1,.wand-knowledge-page .document-title-input{font-size:26px;margin-bottom:24px}.wand-knowledge-page .document-tree .ant-tree-treenode{min-height:44px}.wand-knowledge-page .library-note{font-size:12px}.wand-knowledge-page .document-footer{margin-top:32px;line-height:1.7}}
@media(max-width:360px){.wand-knowledge-page .document-location>span{max-width:70px}.wand-knowledge-page .document-paper{padding-inline:18px}}
@media(pointer:coarse){.wand-knowledge-page :is(.wand-ui-button,.wand-ui-icon-button,.wand-ui-input){min-height:44px}.wand-knowledge-page .knowledge-tabs .ant-tabs-tab{min-height:44px}}
@media(prefers-reduced-motion:reduce){.wand-knowledge-page *{scroll-behavior:auto!important}}
`;
