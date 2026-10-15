import { installStyleSheet } from "../styles";

// Feature layout only; Ant Design and the shared palette own control chrome.
const css = String.raw`
.wand-theme-picker { display:grid; grid-template-columns:repeat(auto-fit,minmax(104px,1fr)); gap:8px; width:100%; }
.wand-theme-choice.ant-radio-wrapper { display:flex; align-items:flex-start; margin:0; padding:10px 8px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); background:var(--bg-surface); }
.wand-theme-choice.ant-radio-wrapper-checked { border-color:var(--border-focus); background:var(--accent-muted); }
.wand-theme-choice.ant-radio-wrapper:hover { border-color:var(--border-focus); }
.wand-theme-choice.ant-radio-wrapper:focus-within { outline:2px solid var(--border-focus); outline-offset:2px; }
.wand-theme-choice>.ant-radio { margin-top:2px; }
.wand-theme-choice>span:last-child { flex:1; min-width:0; padding-inline-end:0; }
.wand-theme-preview { display:block; position:relative; height:34px; border:1px solid; border-radius:3px; overflow:hidden; margin-bottom:7px; }
.wand-theme-preview-sidebar { position:absolute; inset:0 auto 0 0; width:23%; }
.wand-theme-preview-lines { position:absolute; inset:8px 8px 8px 34%; display:flex; flex-direction:column; gap:4px; }
.wand-theme-preview-lines i { display:block; width:90%; height:2px; background:currentColor; opacity:.65; }
.wand-theme-preview-lines i:last-child { width:60%; }
.wand-theme-preview-selection { position:absolute; left:3px; top:9px; width:calc(23% - 6px); height:5px; border-radius:1px; }
.wand-theme-choice-label { display:flex; flex-wrap:wrap; gap:0 6px; font-size:12px; line-height:18px; }
.wand-theme-choice-status { color:var(--accent); min-height:18px; font-weight:500; }

.ant-modal:has(.wand-settings-library-nested-dialog) { width: min(800px, calc(100vw - var(--wand-safe-left, 0px) - var(--wand-safe-right, 0px) - 32px)) !important; max-width:100%; }
.wand-settings-library-overview { flex-shrink:0; }
.wand-settings-library-nested-dialog .ant-modal-body { max-height: 72dvh; overflow: auto; }
.wand-settings-library-overview,.wand-settings-library-toggle-row,.wand-settings-library-download-row,.wand-settings-library-update-deck,.wand-settings-library-group-members li,.wand-settings-library-system-ai-owner { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.wand-settings-library-overview { flex-wrap:wrap; font-size:12px; color:var(--text-secondary); }
.wand-settings-library-overview-pills,.wand-settings-library-button-row,.wand-settings-library-group-custom,.wand-settings-library-group-tools { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.wand-settings-library-app-access,.wand-settings-library-panel,.wand-settings-library-section-body,.wand-settings-library-preset-list,.wand-settings-library-group-content { display:flex; flex-direction:column; gap:16px; min-width:0; }
.wand-settings-library-panel-heading h2,.wand-settings-library-panel-heading p,.wand-settings-library-section p { margin:0; }
.wand-settings-library-toggle-row>div:not(.wand-ui-switch-row),.wand-settings-library-download-row>div,.wand-settings-library-update-deck>div { display:flex; flex-direction:column; gap:4px; min-width:0; }
.wand-settings-library-toggle-row>.wand-ui-switch-row { flex-shrink:0; }
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
.wand-settings-library-page-heading { min-height:var(--wand-page-header-height,56px); box-sizing:border-box; padding:8px var(--wand-page-inset,20px); gap:8px 16px; background:var(--bg-primary); }
.wand-settings-library-page-title { gap:8px; }
.wand-settings-library-page-title .wand-ui-icon-button { width:var(--wand-page-toolbar-height,36px); min-height:var(--wand-page-toolbar-height,36px); padding:0; flex-shrink:0; }
.wand-settings-library-page-heading h1 { font-size:var(--wand-page-title-size,18px); }
.wand-settings-library-page .wand-settings-library-directory { width:100%; max-width:1160px; margin-inline:auto; min-width:0; border:0; background:transparent; box-sizing:border-box; padding:16px var(--wand-page-inset,20px) 24px; container:wandsettingsdirectory / inline-size; }
.wand-settings-library-directory .wand-settings-library-search { max-width:560px; padding-inline:0; background:var(--bg-primary); }
.wand-settings-library-directory .ant-menu-root>.ant-menu-item-group { min-width:0; }
.wand-settings-library-directory .ant-menu-item { min-height:44px; padding-block:8px; }
.wand-settings-library-nav-copy { gap:2px; }
.wand-settings-library-page[data-compact=true] .wand-settings-library-directory .ant-menu-item { min-height:52px; }
.wand-settings-library-detail-content { width:100%; max-width:1120px; box-sizing:border-box; margin-inline:auto; padding:20px var(--wand-page-inset,20px) 28px; container:wandsettings / inline-size; }
.wand-settings-library-page[data-compact=true] .wand-settings-library-page-heading { padding:8px var(--wand-page-inset,12px); }
.wand-settings-library-page[data-compact=true] .wand-settings-library-detail-content { padding:16px var(--wand-page-inset,12px) 24px; }
.wand-settings-library-page[data-compact=true] .wand-settings-library-page-title .wand-ui-icon-button { min-height:var(--wand-page-toolbar-height,36px); }
.wand-settings-library-panel-heading { gap:4px; padding-bottom:16px; margin-bottom:0; }
.wand-settings-library-panel-heading h2 { font-size:18px; }
.wand-settings-library-panel-heading p { font-size:13px; line-height:1.55; }
.wand-settings-library-panel { gap:16px; }
.wand-settings-library-section { min-width:0; padding:20px 0; border:0; border-top:1px solid var(--border-subtle); background:transparent; }
.wand-settings-library-section-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; }
.wand-settings-library-section-heading h3 { margin:0; font-size:14px; font-weight:600; }
.wand-settings-library-section>p { margin-bottom:16px; color:var(--text-secondary); font-size:13px; line-height:1.55; }
.wand-settings-library-panel-heading h2 { display:none; }
.wand-settings-library-directory .ant-menu-item { margin:0; width:100%; border-radius:var(--radius-sm); min-height:64px; }
.wand-settings-library-directory .ant-menu-item-group-title { font-weight:600; padding-inline:16px; }
.wand-settings-library-nav-copy>span:first-child { font-weight:500; }
.wand-settings-library-nav-item>svg { display:block; transform:rotate(-90deg); }
.wand-settings-library-nav-description { font-size:13px; }
.wand-settings-library-panel { gap:0; }
.wand-settings-library-panel>.wand-settings-library-save-bar { padding-top:16px; }
.wand-settings-library-section-body { gap:16px; container:wandsettingsfields / inline-size; }
.wand-settings-library-section-body>.ant-btn { align-self:flex-start; max-width:100%; height:auto; min-height:32px; white-space:normal; }
.wand-settings-library-section-heading { flex-wrap:wrap; }
.wand-settings-library-toggle-row { padding-block:4px; align-items:flex-start; }
.wand-settings-library-toggle-row>div:first-child { flex:1; overflow-wrap:anywhere; }
.wand-settings-library-toggle-row strong { font-size:14px; font-weight:500; line-height:1.5; }
.wand-settings-library-toggle-row>div:first-child>span { color:var(--text-secondary); font-size:13px; line-height:1.6; }
.wand-settings-library-toggle-row .wand-ui-switch-row { margin-top:2px; }
.wand-settings-library-panel-heading p,.wand-settings-library-section p,.wand-settings-library-field .ant-form-item-label>label { overflow-wrap:anywhere; }
.wand-settings-library-field .ant-form-item-label>label { height:auto; }
.wand-settings-library-update-deck { justify-content:flex-start; }
.wand-settings-library-update-deck>div { flex:1; }
.wand-settings-library-update-deck-icon,.wand-settings-library-update-channel { flex-shrink:0; }
.wand-settings-library-about-list>div { display:flex; align-items:baseline; justify-content:space-between; gap:16px; }
.wand-settings-library-about-overview>.wand-settings-library-section { flex:1 1 480px; min-width:0; }
.wand-settings-library-about-downloads>.wand-settings-library-section { flex:1 1 280px; min-width:0; }
.wand-settings-library-version-table .ant-table-cell { overflow-wrap:anywhere; }
.wand-settings-library-cli-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr)); gap:0 24px; }
.wand-settings-library-cli-item { min-width:0; padding-block:8px; border-bottom:1px solid var(--border-subtle); }
.wand-settings-library-cli-item>span { min-width:0; overflow-wrap:anywhere; text-align:end; font-variant-numeric:tabular-nums; }
.wand-settings-library-connect { display:flex; flex-direction:column; gap:16px; }
.wand-settings-library-grid,.wand-settings-library-default-row { grid-template-columns:minmax(0,1fr); gap:12px 16px; }
.wand-settings-library-field .ant-form-item-label { padding-bottom:4px; }
.wand-settings-library-field .ant-form-item-explain { font-size:12px; line-height:1.5; }
.wand-settings-library-secret-toggle.ant-btn { height:24px; min-height:24px; padding-inline:6px; font-size:12px; }
.wand-settings-library-system-ai-owner-copy { min-width:0; overflow-wrap:anywhere; }
.wand-settings-library-system-ai-chain { list-style:none; padding:0; margin:8px 0; }
.wand-settings-library-system-ai-chain li { padding-block:3px; font-size:13px; }
/* The grouped directory becomes a quiet navigation rail on desktop details. */
.wand-settings-library-page[data-wide=true][data-detail=true] .wand-settings-library-directory { width:224px; max-width:224px; margin:0; padding:16px 12px 24px; border-inline-end:1px solid var(--border-subtle); }
.wand-settings-library-page[data-wide=true][data-detail=true] .wand-settings-library-directory .ant-menu-item { min-height:40px; padding-block:8px; }
.wand-settings-library-page[data-wide=true][data-detail=true] .wand-settings-library-nav-description,.wand-settings-library-page[data-wide=true][data-detail=true] .wand-settings-library-nav-item>svg { display:none; }
.wand-settings-library-page[data-wide=true][data-detail=true] .wand-settings-library-directory .ant-menu-item-group-title { padding-top:16px; }
.wand-settings-library-detail-content:has(.wand-employee-list) { height:100%; }
.wand-settings-library-detail-content>.wand-employee-list { min-height:100%; }
.wand-settings-library-page[data-wide=true] .wand-settings-library-directory { flex-shrink:0; }
.wand-settings-library-page[data-wide=true] .wand-settings-library-directory .ant-menu-root { display:block; }
@container wandsettings (min-width:820px) {
  :is(.wand-settings-library-panel,.wand-settings-library-detail-content)>.wand-settings-library-section { display:grid; grid-template-columns:192px minmax(0,1fr); grid-template-rows:min-content minmax(0,1fr); column-gap:24px; align-content:start; }
  :is(.wand-settings-library-panel,.wand-settings-library-detail-content)>.wand-settings-library-section>.wand-settings-library-section-heading { grid-column:1; grid-row:1; align-items:flex-start; margin-bottom:8px; }
  :is(.wand-settings-library-panel,.wand-settings-library-detail-content)>.wand-settings-library-section>p { grid-column:1; grid-row:2; align-self:start; margin-bottom:0; }
  :is(.wand-settings-library-panel,.wand-settings-library-detail-content)>.wand-settings-library-section>.wand-settings-library-section-body { grid-column:2; grid-row:1 / span 2; width:100%; }
}
@container wandsettingsfields (min-width:560px) {
  .wand-settings-library-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
}
@container wandsettingsfields (min-width:620px) {
  .wand-settings-library-default-row { grid-template-columns:repeat(3,minmax(0,1fr)); }
}
@container wandsettingsfields (min-width:640px) {
  .wand-settings-library-connect { display:grid; grid-template-columns:220px minmax(0,1fr); gap:16px 24px; align-items:start; }
  .wand-settings-library-connect-qr { grid-column:1; grid-row:1 / span 3; }
  .wand-settings-library-connect>:not(.wand-settings-library-connect-qr) { grid-column:2; }
}
@media (pointer:coarse) {
  .wand-settings-library-secret-toggle.ant-btn { min-height:32px; min-width:44px; }
}
`;

export function installSettingsLibraryStyles(): void {
  installStyleSheet("wand-settings-library-styles", css);
}
