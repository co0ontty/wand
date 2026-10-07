import { installStyleSheet } from "../styles";

// Feature layout only; Ant Design and the shared warm theme own control chrome.
const css = `
.wand-settings-library-page { position:absolute; inset:0; box-sizing:border-box; overflow:auto; overscroll-behavior:contain; pointer-events:auto; color:var(--text-primary); background:var(--bg-primary); padding:16px; padding-top:max(16px,var(--wand-safe-top,0px)); padding-bottom:max(16px,var(--wand-safe-bottom,0px)); padding-left:max(16px,var(--wand-safe-left,0px)); padding-right:max(16px,var(--wand-safe-right,0px)); }
.wand-settings-library-page-heading { margin-bottom:16px; }
.wand-settings-library-page-heading h1 { margin:0; font-size:var(--font-size-xl,24px); }
.wand-settings-library-page-content { display:flex; flex-direction:column; gap:16px; min-width:0; }
.wand-settings-library-page .wand-settings-library-tabs { flex:none; }
.wand-settings-library-page .ant-tabs-body-holder { overflow:visible; }
.wand-settings-library-page .wand-settings-library-app-access-form .wand-settings-library-field { flex:1; min-width:min(240px,100%); }
.ant-modal:has(.wand-settings-library-dialog) { width: min(1040px, calc(100vw - var(--wand-safe-left, 0px) - var(--wand-safe-right, 0px) - 32px)) !important; max-width:100%; }
.ant-modal:has(.wand-settings-library-nested-dialog) { width: min(800px, calc(100vw - var(--wand-safe-left, 0px) - var(--wand-safe-right, 0px) - 32px)) !important; max-width:100%; }
.wand-settings-library-dialog .ant-modal-body { height:min(760px, calc(100dvh - var(--wand-safe-top, 0px) - var(--wand-safe-bottom, 0px) - 160px)); display:flex; flex-direction:column; gap:16px; overflow:clip; }
.wand-settings-library-tabs { flex:1; min-height:0; }
.wand-settings-library-tabs .ant-tabs-body-holder { min-width:0; min-height:0; overflow:auto; }
.wand-settings-library-overview { flex-shrink:0; }
.wand-settings-library-nested-dialog .ant-modal-body { max-height: 72dvh; overflow: auto; }
.wand-settings-library-header,.wand-settings-library-overview,.wand-settings-library-toggle-row,.wand-settings-library-download-row,.wand-settings-library-update-deck,.wand-settings-library-group-members li,.wand-settings-library-system-ai-owner { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.wand-settings-library-overview { flex-wrap:wrap; }
.wand-settings-library-overview-pills,.wand-settings-library-button-row,.wand-settings-library-group-custom,.wand-settings-library-group-tools { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.wand-settings-library-app-access,.wand-settings-library-panel,.wand-settings-library-section-body,.wand-settings-library-preset-list,.wand-settings-library-group-content { display:flex; flex-direction:column; gap:16px; min-width:0; }
.wand-settings-library-panel-heading h2,.wand-settings-library-panel-heading p,.wand-settings-library-section p { margin:0; }
.wand-settings-library-grid,.wand-settings-library-default-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr)); gap:16px; }
.wand-settings-library-field { margin-bottom:0; min-width:0; }
.wand-settings-library-number,.wand-settings-library-select,.wand-settings-library-select>button { width:100%; }
.wand-settings-library-toggle-row>div,.wand-settings-library-download-row>div,.wand-settings-library-update-deck>div { display:flex; flex-direction:column; gap:4px; min-width:0; }
.wand-settings-library-toggle-row>button { flex-shrink:0; }
.wand-settings-library-save-bar { display:flex; flex-direction:column; align-items:flex-start; gap:12px; }
.wand-settings-library-action-label { display:grid; }
.wand-settings-library-action-label>span { grid-area:1/1; }
.wand-settings-library-action-measure { visibility:hidden; }
.wand-settings-library-group-members { padding:0; margin:0; list-style:none; }
.wand-settings-library-group-member-name { flex:1; min-width:0; overflow-wrap:anywhere; }
.wand-settings-library-group-custom>.ant-input { flex:1; min-width:120px; }
.wand-settings-library-system-ai-owner { align-items:flex-start; justify-content:flex-start; }
.wand-settings-library-system-ai-chain { padding-inline-start:24px; }
.wand-settings-library-route-rank { margin-inline-end:8px; }
.wand-settings-library-env-value,.wand-settings-library-default-summary,.wand-settings-library-connect-code,.wand-settings-library-section a,.wand-settings-library-preset-list code { overflow-wrap:anywhere; }
.wand-settings-library-connect-code-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.wand-settings-library-env-toolbar,.wand-settings-library-app-access-form { display:flex; gap:16px; align-items:center; flex-wrap:wrap; margin-bottom:16px; }
@media(max-width:760px) { .wand-settings-library-dialog .ant-tabs-body-holder { min-width:0; } .wand-settings-library-dialog .ant-card-head { flex-wrap:wrap; } }
`;

export function installSettingsLibraryStyles(): void {
  installStyleSheet("wand-settings-library-styles", css);
}
