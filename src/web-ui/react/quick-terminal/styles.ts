import { installStyleSheet } from "../styles";

export function installQuickTerminalStyles(): void {
  installStyleSheet("wand-quick-terminal", `
.quick-terminal-workspace { min-width:0; min-height:0; }
.quick-terminal-toolbar .wand-ui-icon-button { flex:none; }
.quick-terminal-split > .ant-splitter-panel { overflow:hidden; min-width:0; min-height:0; }
.quick-terminal-split[data-dragging="false"] > .ant-splitter-panel { transition:flex-basis var(--motion-normal) var(--ease-out-expo); }
.quick-terminal-panel { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; overflow:hidden; background:var(--bg-terminal); opacity:0; transition:opacity var(--motion-quick-exit) var(--ease-in-out-smooth); }
.quick-terminal-panel[data-open="true"] { opacity:1; transition-duration:var(--motion-normal); }
.quick-terminal-header { flex:none; min-width:0; min-height:40px; padding:4px 8px; box-sizing:border-box; background:var(--bg-primary); }
.quick-terminal-title, .quick-terminal-status, .quick-terminal-header .wand-ui-icon-button { flex:none; }
.quick-terminal-status { font-size:var(--font-size-xs); }
.quick-terminal-header .quick-terminal-directory { flex:1; min-width:0; font-size:var(--font-size-xs); color:var(--text-secondary); }
.quick-terminal-surface .pooled-terminal-wrap { width:100%; height:100%; overflow:hidden; }
@media(prefers-reduced-motion:reduce) { .quick-terminal-split > .ant-splitter-panel,.quick-terminal-panel { transition:none !important; } }
`);
}
