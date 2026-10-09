import { installStyleSheet } from "../styles";

// Feature layout only; Ant Design and the shared warm theme own control chrome.
const css = String.raw`
.ant-modal:has(.wand-settings-library-nested-dialog) { width: min(800px, calc(100vw - var(--wand-safe-left, 0px) - var(--wand-safe-right, 0px) - 32px)) !important; max-width:100%; }
.wand-settings-library-overview { flex-shrink:0; }
.wand-settings-library-nested-dialog .ant-modal-body { max-height: 72dvh; overflow: auto; }
.wand-settings-library-overview,.wand-settings-library-toggle-row,.wand-settings-library-download-row,.wand-settings-library-update-deck,.wand-settings-library-group-members li,.wand-settings-library-system-ai-owner { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.wand-settings-library-overview { flex-wrap:wrap; font-size:12px; color:var(--text-secondary); }
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

/* Settings keep one section surface; field groups carry hierarchy without nested cards. */
.wand-settings-library-page-heading { padding:12px 20px; }
.wand-settings-library-page-heading h1 { font-size:18px; }
.wand-settings-library-page:not([data-compact=true]) .wand-settings-library-directory { width:216px; }
.wand-settings-library-directory .ant-menu-item { min-height:44px; padding-block:8px; }
.wand-settings-library-nav-copy { gap:2px; }
.wand-settings-library-page[data-compact=true] .wand-settings-library-directory .ant-menu-item { min-height:52px; }
.wand-settings-library-detail-content { max-width:720px; padding:20px 24px 28px; container:wandsettings / inline-size; }
.wand-settings-library-panel-heading { gap:4px; margin-bottom:4px; }
.wand-settings-library-panel-heading h2 { font-size:18px; }
.wand-settings-library-panel-heading p { font-size:13px; line-height:1.55; }
.wand-settings-library-panel { gap:12px; }
.wand-settings-library-section>.ant-card-head { min-height:42px; padding-inline:16px; }
.wand-settings-library-section>.ant-card-head .ant-card-head-title { padding-block:10px; font-size:14px; }
.wand-settings-library-section>.ant-card-body { padding:16px; }
.wand-settings-library-section>.ant-card-body>p { margin-bottom:12px; font-size:13px; line-height:1.55; }
.wand-settings-library-section-body { gap:12px; }
.wand-settings-library-grid,.wand-settings-library-default-row { grid-template-columns:minmax(0,1fr); gap:12px 16px; }
.wand-settings-library-field .ant-form-item-label { padding-bottom:4px; }
.wand-settings-library-field .ant-form-item-explain { font-size:12px; line-height:1.5; }
.wand-settings-library-secret-toggle.ant-btn { height:24px; min-height:24px; padding-inline:6px; font-size:12px; }
.wand-settings-library-system-ai-owner-copy { min-width:0; overflow-wrap:anywhere; }
.wand-settings-library-system-ai-chain { list-style:none; padding:0; margin:8px 0; }
.wand-settings-library-system-ai-chain li { padding-block:3px; font-size:13px; }
@container wandsettings (min-width:560px) {
  .wand-settings-library-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
}
@container wandsettings (min-width:620px) {
  .wand-settings-library-default-row { grid-template-columns:repeat(3,minmax(0,1fr)); }
}
@media (pointer:coarse) {
  .wand-settings-library-secret-toggle.ant-btn { min-height:32px; min-width:44px; }
}
`;

export function installSettingsLibraryStyles(): void {
  installStyleSheet("wand-settings-library-styles", css);
}
