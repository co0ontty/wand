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
`;

export function installSettingsLibraryStyles(): void {
  installStyleSheet("wand-settings-library-styles", css);
}
