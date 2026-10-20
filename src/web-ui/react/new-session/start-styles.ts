import { installStyleSheet } from "../styles";

export function installNewWorkStyles(): void {
  installStyleSheet("wand-new-work", `
.new-work-page { position:absolute; inset:0; z-index:8; display:flex; flex-direction:column; min-width:0; min-height:0; overflow:auto; background:var(--bg-primary); }
.new-work-heading { min-height:44px; padding:0 var(--wand-page-inset); flex-shrink:0; }
.new-work-page-label { font-size:12px; color:var(--text-secondary); }
.new-work-context { flex:1 0 auto; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:20px; padding:24px var(--wand-page-inset); text-align:center; }
.new-work-context h1 { margin:0; max-width:100%; font-size:clamp(20px,2.5vw,28px); font-weight:400; line-height:1.7; color:var(--text-primary); overflow-wrap:anywhere; }
.new-work-context h1 > span { text-decoration:underline; text-decoration-color:var(--border-default); text-underline-offset:5px; }
.new-work-inline-trigger { display:inline-flex; align-items:center; justify-content:center; vertical-align:middle; border:1px solid transparent; background:transparent; padding:2px 8px; margin:0 8px; font:inherit; color:inherit; cursor:pointer; border-radius:20px; line-height:inherit; gap:6px; transition:all 0.15s ease; }
.new-work-inline-trigger:disabled { cursor:default; opacity:0.65; }
.new-work-inline-trigger:hover:not(:disabled) { background:var(--bg-secondary); border-color:var(--border-subtle); }
.new-work-inline-trigger:focus-visible { outline:2px solid var(--wand-accent, #3b82f6); outline-offset:2px; }
.new-work-inline-avatar { padding:2px 8px 2px 2px; }
.new-work-inline-avatar .wand-employee-avatar { transform:none; }
.new-work-inline-avatar-fallback { display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; border-radius:50%; background:var(--bg-secondary); color:var(--text-secondary); }
.new-work-inline-directory { border-radius:8px; padding:2px 8px; }
.new-work-inline-directory > span { text-decoration:underline; text-decoration-color:var(--border-default); text-underline-offset:5px; transition:color 0.15s ease, text-decoration-color 0.15s ease; }
.new-work-inline-directory:hover:not(:disabled) > span { text-decoration-color:var(--text-primary); color:var(--text-primary); }
.new-work-inline-task { border-radius:8px; padding:2px 8px; }
.new-work-inline-task-name { text-decoration:underline; text-decoration-color:var(--border-default); text-underline-offset:5px; transition:color 0.15s ease, text-decoration-color 0.15s ease; }
.new-work-inline-task:hover:not(:disabled) .new-work-inline-task-name { text-decoration-color:var(--text-primary); color:var(--text-primary); }
.new-work-inline-task-icon { color:var(--text-secondary); flex-shrink:0; transition:color 0.15s ease; }
.new-work-inline-task:hover:not(:disabled) .new-work-inline-task-icon { color:var(--text-primary); }
.new-work-inline-arrow { color:var(--text-secondary); opacity:0.8; transition:color 0.15s ease, opacity 0.15s ease, transform 0.15s ease; flex-shrink:0; }
.new-work-inline-trigger:hover:not(:disabled) .new-work-inline-arrow { color:var(--text-primary); opacity:1; }
.new-work-page .new-work-composer { width:100%; max-width:800px; box-sizing:border-box; margin-inline:auto; padding:0 var(--wand-page-inset) max(12px,var(--wand-safe-bottom,0px)); flex-shrink:0; }
.new-work-context-bar { display:flex; align-items:center; gap:4px; min-width:0; margin-inline:12px; padding:2px 8px 8px; border-radius:16px 16px 0 0; background:var(--bg-secondary); }
.new-work-location { display:flex; align-items:center; min-width:0; flex:1; gap:4px; }
.new-work-page .new-work-person.ant-btn { min-width:0; max-width:180px; height:32px; padding-inline:6px; gap:6px; font-size:12px; }
.new-work-person .wand-employee-avatar { transform:none; }
.new-work-person-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.new-work-page .new-work-directory.ant-btn { min-width:0; max-width:240px; height:32px; padding-inline:6px; font-size:12px; color:var(--text-primary); }
.new-work-directory.ant-btn > span:not(.wand-ui-icon) { overflow:hidden; text-overflow:ellipsis; }
.new-work-subject { width:min(560px,calc(100vw - 48px)); max-height:60dvh; overflow:auto; }
.new-work-paths { width:min(440px,calc(100vw - 48px)); max-height:60dvh; overflow:auto; }
.new-work-paths > .ant-btn { justify-content:flex-start; overflow:hidden; }
.new-work-page .conversation-input-wrap,
.new-work-page .conversation-input-wrap:has(.conversation-runtime-summary):not(:has(.composer-floating-avatar)) { margin-block-start:-1px; }
.new-work-page .conversation-sender.ant-sender { border:1px solid var(--border-subtle); border-radius:24px; padding:14px 12px 8px; }
.new-work-page .conversation-sender .ant-sender-input { min-height:48px; }
.new-work-page .conversation-sender .ant-sender-footer { padding-top:8px; }
.new-work-page .conversation-runtime-summary { position:static; width:auto; max-width:100%; height:auto; gap:2px; }
.new-work-page .conversation-runtime-summary .conversation-runtime-select { height:32px; min-height:32px; font-size:12px; }
.new-work-page .conversation-runtime-summary .conversation-tool-select { flex:0 1 96px; }
.new-work-page .conversation-runtime-summary .conversation-model-select { flex:0 1 180px; }
.new-work-page .conversation-runtime-summary .conversation-thinking-select { flex:0 1 108px; }
.new-work-page .conversation-action-row { gap:4px; }
.new-work-page .new-work-actions { flex:none; }
.new-work-page .new-work-send-actions { min-width:0; justify-content:flex-end; }
.new-work-submit-status { padding:0 12px 8px; font-size:12px; }
.new-work-submit-status [role="status"] { min-height:1.5em; }
.new-work-permission { display:inline-flex; align-items:center; gap:4px; font-size:12px; color:var(--text-secondary); white-space:nowrap; }
.new-work-permission[data-automatic="true"] { color:var(--warning); }
.new-work-page .conversation-submit.ant-btn { border-radius:50%; }
@media(max-width:700px) {
  .new-work-context { gap:16px; }
  .new-work-context-bar { margin-inline:8px; padding-inline:4px; }
  .new-work-page .new-work-person.ant-btn { max-width:140px; }
  .new-work-page .conversation-action-row { flex-wrap:wrap; }
  .new-work-page .new-work-send-actions { flex:1; }
  .new-work-page .conversation-runtime-summary { flex-wrap:wrap; justify-content:flex-end; }
  .new-work-page .conversation-runtime-summary .conversation-runtime-select { flex:0 1 auto; max-width:140px; }
  .new-work-page .new-work-actions .composer-edit-action { display:none; }
}
@media(pointer:coarse) {
  .new-work-page :is(.new-work-person,.new-work-directory,.conversation-runtime-summary .conversation-runtime-select) { min-height:44px; height:44px; }
}
`);
}
