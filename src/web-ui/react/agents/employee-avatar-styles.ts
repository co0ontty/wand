import { installStyleSheet } from "../styles";

const css = String.raw`
.wand-avatar-editor { min-width:0; }
.wand-avatar-editor-summary { flex-wrap:wrap; }
.wand-avatar-editor-trigger.ant-btn { flex:0 0 44px; width:44px; height:44px; padding:0; position:relative; overflow:visible; }
.wand-avatar-edit-mark { position:absolute; bottom:0; right:-2px; display:grid; place-items:center; width:16px; height:16px; border-radius:5px; background:var(--bg-elevated); color:var(--text-secondary); border:1px solid var(--border-subtle); }
.wand-avatar-upload-hint { display:block; margin-top:4px; font-size:11px; }
.wand-avatar-options:disabled { opacity:.65; }
.wand-avatar-options:disabled input { cursor:default; }
.wand-avatar-editor-caption { font-size:12px; }
.wand-avatar-sculpt { display:grid; grid-template-columns:172px minmax(0,1fr); gap:12px 18px; margin-top:12px; padding:14px; background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:8px; }
.wand-avatar-sculpt-preview { min-width:0; align-self:center; display:flex; flex-direction:column; align-items:center; gap:5px; }
.wand-avatar-sculpt-preview>.ant-typography { font-size:11px; }
.wand-avatar-sculpt-preview>.ant-btn { font-size:12px; }
.wand-avatar-sculpt-controls { display:flex; flex-direction:column; gap:10px; min-width:0; }
.wand-avatar-options { margin:0; padding:0; border:0; min-width:0; }
.wand-avatar-options legend { display:flex; gap:8px; align-items:baseline; width:100%; margin:0 0 5px; padding:0; font-size:12px; color:var(--text-primary); }
.wand-avatar-options legend>span { color:var(--text-secondary); font-size:11px; }
.wand-avatar-option-row { display:flex; flex-wrap:wrap; gap:4px; }
.wand-avatar-option { position:relative; width:32px; height:32px; cursor:pointer; display:grid; place-items:center; }
.wand-avatar-option input { appearance:none; position:absolute; margin:0; inset:0; width:100%; height:100%; border-radius:6px; border:1px solid transparent; background:transparent; cursor:pointer; }
.wand-avatar-option input:hover { background:var(--bg-hover); }
.wand-avatar-option input:checked { background:var(--accent-muted); border-color:var(--primary); }
.wand-avatar-option input:focus-visible { outline:2px solid var(--border-focus); outline-offset:2px; }
.wand-avatar-option-mark { width:22px; height:22px; display:grid; place-items:center; color:var(--text-secondary); pointer-events:none; position:relative; }
.wand-avatar-option-mark svg { width:20px; height:20px; fill:var(--text-secondary); stroke:currentColor; stroke-width:1.4; stroke-linejoin:round; stroke-linecap:round; }
.wand-avatar-color { width:18px; height:18px; border-radius:50%; box-shadow:inset 0 0 0 1px rgba(0,0,0,.12); }
.wand-avatar-option-name { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
.wand-avatar-sculpt-footer { grid-column:1/-1; padding-top:10px; border-top:1px solid var(--border-subtle); }
.wand-avatar-sculpt-footer>.ant-typography { font-size:11px; }
@media(max-width:600px) {
 .wand-avatar-sculpt { grid-template-columns:minmax(0,1fr); gap:12px; padding:12px; }
 .wand-avatar-sculpt-preview { flex-direction:row; flex-wrap:wrap; justify-content:center; }
 .wand-avatar-sculpt-preview>[data-plush-avatar] { flex:0 0 140px; }
 .wand-avatar-sculpt-preview>.ant-typography { display:none; }
 .wand-avatar-sculpt-controls { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
 .wand-avatar-options:nth-child(-n+2) { grid-column:1/-1; }
 .wand-avatar-editor-summary>.ant-btn { padding-inline:6px; }
}
@media(pointer:coarse) { .wand-avatar-option { width:44px; height:44px; } .wand-avatar-option-row { gap:2px; } }
@media(forced-colors:active) { .wand-avatar-option input:checked { border-color:Highlight; } .wand-avatar-color { border:1px solid CanvasText; } }
`;
export function installAvatarEditorStyles(): void { installStyleSheet("wand-avatar-editor-styles", css); }
