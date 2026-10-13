import { installStyleSheet } from "../styles";

const css = String.raw`
.wand-employee-card,.wand-employee-card.is-system { border-color:var(--border-subtle); background:var(--bg-elevated); box-shadow:none; }
.wand-employee-card[data-open] { border-color:var(--border-default); }
.wand-employee-card.is-archived { opacity:1; }
.wand-employee-card>.ant-card-body { padding:10px 12px; }
.wand-employee-card .wand-team-member-head { padding:2px 0; gap:10px !important; }
.wand-employee-name-line { min-width:0; }
.wand-employee-name-line>.ant-typography { flex:1; min-width:0; }
.wand-employee-name-line>.ant-tag { flex:0 0 auto; }
.wand-employee-meta-line { min-width:0; }
.wand-employee-meta-line>.ant-typography { min-width:0; font-size:12px; }
.wand-employee-meta-line>.wand-team-member-agent { flex:1 1 auto; }
.wand-employee-meta-line>.wand-employee-tags { flex:0 1 38%; }
.wand-employee-list .wand-teams-toolbar { min-height:var(--wand-page-toolbar-height,36px); }
.wand-employee-list .wand-teams-toolbar-search { max-width:400px; }
.wand-employee-card .wand-team-member-copy>.ant-typography { font-size:12px; }
.wand-employee-card .wand-employee-name-line>.ant-typography { font-size:14px; }
.wand-employee-card .wand-team-member-copy .ant-tag { margin-inline-end:0; font-size:11px; line-height:18px; }
.wand-employee-card .wand-team-member-inner { gap:12px !important; }
.wand-employee-card .ant-form-item { margin-bottom:0; }
.wand-employee-card textarea.ant-input { resize:none; }
.wand-team-candidates { min-width:0; padding-block:12px; border-block-start:1px solid var(--border-subtle); }
.wand-team-candidates-head { padding-bottom:4px; }
.wand-team-candidates-head>.ant-typography { font-size:12px; }
.wand-team-candidate { min-width:0; padding-block:10px; border-block-end:1px solid var(--border-subtle); }
.wand-team-candidate-tag { margin:4px 0 0; min-width:44px; text-align:center; }
.wand-team-candidate[data-duplicate=true] { border-color:var(--danger); }
.wand-team-candidate-inner { align-items:flex-start; }
.wand-team-candidate-tools { margin-top:2px; }
.wand-team-candidate .wand-ai-team-member-agent>div { min-width:0; }
.wand-team-candidate .task-board-native-field { max-width:100%; }
.wand-team-candidate .ant-form-item-control { min-width:0; }
.wand-team-candidate .wand-ui-select-trigger { min-width:0; max-width:100%; }
.wand-team-candidate .wand-ui-select-value { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wand-team-candidates-foot { padding-top:4px; }
`;

export function installEmployeeStyles(): void {
  installStyleSheet("wand-employee-refinement-styles", css);
}
