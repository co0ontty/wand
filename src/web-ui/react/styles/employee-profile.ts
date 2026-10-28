import { installStyleSheet } from "../styles";

const css = String.raw`
.wand-teams-page .wand-employees-layout{padding:0;display:flex;min-height:0;overflow:hidden}
.wand-employee-workspace{display:flex;flex-direction:column;width:100%;height:100%;flex:1;min-width:0;min-height:0;background:var(--bg-primary)}
.wand-employee-workspace [hidden],[data-employee-profile] [hidden]{display:none}
.employee-directory{padding:20px var(--wand-page-inset);overflow:auto;min-height:0;flex:1;container:employeedirectory / inline-size}
.employee-directory-toolbar{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.employee-directory-toolbar .wand-ui-search{flex:1;min-width:160px;max-width:560px}
.employee-items{display:grid;grid-template-columns:minmax(0,1fr);column-gap:24px}
.employee-item{display:flex;align-items:center;gap:14px;width:100%;min-height:80px;padding:16px 4px;border:0;border-bottom:1px solid var(--border-subtle);background:transparent;color:var(--text-primary);text-align:left;cursor:pointer;font:inherit}
.employee-item:hover{background:var(--bg-hover)}
.employee-item:focus-visible{outline:2px solid var(--border-focus);outline-offset:-2px}
.employee-item>span:nth-child(2){min-width:0;flex:1}
.employee-item strong{display:block;font-size:14px;font-weight:600;overflow-wrap:anywhere}
.employee-item small{display:block;color:var(--text-secondary);font-size:13px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.employee-item>svg{flex:none;color:var(--text-secondary)}
.employee-archived-label{font-size:12px;font-weight:400;color:var(--text-secondary);margin-left:8px}
.wand-employee-workspace .no-results{padding:40px 0;color:var(--text-secondary)}
.employee-profile-content,[data-employee-profile]{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;background:var(--bg-primary);color:var(--text-primary);font-size:14px}
[data-employee-profile].wand-team-member{border:0;box-shadow:none;overflow:hidden}
.wand-employee-workspace .profile-header,[data-employee-profile] .profile-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:10px var(--wand-page-inset);min-height:var(--wand-page-header-height);flex:none;border-bottom:1px solid var(--border-subtle)}
.profile-heading{display:flex;align-items:center;gap:8px;min-width:0}
.profile-heading h2{margin:0;font-size:var(--wand-page-title-size);line-height:1.4;font-weight:600}
[data-employee-profile] .save-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
[data-employee-profile] .dirty{font-size:12px;color:var(--text-secondary);margin-right:8px}
[data-employee-profile] .profile-body{overflow:auto;min-height:0;flex:1;scrollbar-gutter:stable;overscroll-behavior:contain}
[data-employee-profile] .editor{width:100%;padding:24px var(--wand-page-inset) 48px;box-sizing:border-box;container:employeeeditor / inline-size}
[data-employee-profile] .editor>:is(.identity-summary,.form-section,.appearance,.ant-alert){max-width:1472px}
[data-employee-profile] .identity-summary{display:flex;align-items:center;gap:14px;margin-bottom:24px}
[data-employee-profile] .identity-summary>div{min-width:0;flex:1}
[data-employee-profile] .identity-summary strong{display:block;font-size:16px;font-weight:600;overflow-wrap:anywhere}
[data-employee-profile] .identity-summary small{display:block;color:var(--text-secondary);font-size:12px;margin-top:4px}
[data-employee-profile] .form-section{margin:0 0 24px;min-width:0;scroll-margin-top:16px}
[data-employee-profile] .identity-fields{display:flex;flex-direction:column;gap:20px}
[data-employee-profile] .wand-settings-library-field{margin:0;min-width:0}
[data-employee-profile] #role>.wand-settings-library-field+.wand-settings-library-field{margin-top:20px}
[data-employee-profile] #tools,[data-employee-profile] #advanced{padding-top:24px;border-top:1px solid var(--border-subtle)}
[data-employee-profile] .wand-team-candidates{padding:0;border:0}
[data-employee-profile] .wand-team-candidate{border-bottom:1px solid var(--border-subtle);padding:12px 0}
[data-employee-profile] .wand-team-candidate .ant-form-item{margin:0;min-width:0}
[data-employee-profile] .wand-team-candidate .task-board-native-field{max-width:100%}
[data-employee-profile] .advanced-details>summary{font-size:14px;font-weight:500;cursor:pointer;padding:8px 0}
[data-employee-profile] .advanced-content{display:flex;flex-direction:column;gap:20px;padding-top:20px}
[data-employee-profile] .appearance{max-width:100%;margin-bottom:24px;padding:0 0 24px;border-bottom:1px solid var(--border-subtle)}
.employee-profile-content>.is-new{width:100%;flex:1;min-height:0;box-sizing:border-box;padding:24px var(--wand-page-inset);overflow:auto;scrollbar-gutter:stable;overscroll-behavior:contain;border:0;border-radius:0;background:transparent;container:employeeeditor / inline-size}
.employee-profile-content>.is-new .wand-team-member-inner{max-width:1472px}
.employee-create-avatar{display:flex;align-items:center;gap:12px;padding-block:8px}
.employee-profile-content>.is-new .appearance{padding-block:16px;border-bottom:1px solid var(--border-subtle)}
.wand-object-profile-drawer:has([data-employee-profile]) .ant-drawer-body{display:flex;flex-direction:column;min-height:0;padding:0;overflow:hidden}
:where(.wand-employee-workspace,[data-employee-profile]) .aside-title{display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:500;line-height:28px}
:where(.wand-employee-workspace,[data-employee-profile]) .aside-title>span{display:flex;align-items:center;gap:7px}
:where(.wand-employee-workspace,[data-employee-profile]) .avatar-stage{text-align:center;padding:17px 0 11px}
:where(.wand-employee-workspace,[data-employee-profile]) .preview-state{display:flex;align-items:center;justify-content:center;gap:5px;color:var(--text-secondary);font-size:12px;line-height:18px;margin-top:5px}
:where(.wand-employee-workspace,[data-employee-profile]) .preview-state i{width:4px;height:4px;border-radius:50%;background:var(--text-secondary)}
:where(.wand-employee-workspace,[data-employee-profile]) .preview-state i[data-live=true]{background:var(--success)}
:where(.wand-employee-workspace,[data-employee-profile]) .avatar-modes{display:flex;justify-content:center;gap:7px;margin-bottom:3px}
:where(.wand-employee-workspace,[data-employee-profile]) .upload-note{display:block;text-align:center;font-size:12px;color:var(--text-secondary);margin-bottom:18px}
:where(.wand-employee-workspace,[data-employee-profile]) .option-group{border:0;border-top:1px solid var(--border-subtle);padding:11px 0 0;margin:15px 0 0;min-width:0}
:where(.wand-employee-workspace,[data-employee-profile]) .option-group legend{float:left;width:100%;display:flex;justify-content:space-between;font-size:12px;font-weight:500;padding:0;margin:0 0 9px}
:where(.wand-employee-workspace,[data-employee-profile]) .option-group legend>span{font-size:12px;font-weight:400;color:var(--text-secondary)}
:where(.wand-employee-workspace,[data-employee-profile]) .options{clear:both;display:flex;gap:5px}
:where(.wand-employee-workspace,[data-employee-profile]) .shape .options{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:7px}
:where(.wand-employee-workspace,[data-employee-profile]) .option{position:relative;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px;flex:1;border:1px solid transparent;border-radius:6px;padding:6px 1px;background:var(--bg-surface);cursor:pointer;min-width:0}
:where(.wand-employee-workspace,[data-employee-profile]) .option>span:last-child{font-size:12px;color:var(--text-secondary)}
:where(.wand-employee-workspace,[data-employee-profile]) .option[data-selected=true]{border-color:var(--accent-solid);background:var(--bg-active)}
:where(.wand-employee-workspace,[data-employee-profile]) .option input,:where(.wand-employee-workspace,[data-employee-profile]) .color-option input{position:absolute;opacity:0;width:1px;height:1px}
:where(.wand-employee-workspace,[data-employee-profile]) .option:has(input:focus-visible),:where(.wand-employee-workspace,[data-employee-profile]) .color-option:has(input:focus-visible){outline:2px solid var(--border-focus);outline-offset:3px}
:where(.wand-employee-workspace,[data-employee-profile]) .glasses .option,:where(.wand-employee-workspace,[data-employee-profile]) .hat .option{flex-direction:row;font-size:12px;padding:9px 2px}
:where(.wand-employee-workspace,[data-employee-profile]) .color-option{position:relative;cursor:pointer;display:grid;place-items:center;width:30px;height:30px;border:1px solid transparent;border-radius:50%}
:where(.wand-employee-workspace,[data-employee-profile]) .color-option>span{width:20px;height:20px;border-radius:50%;box-shadow:inset 0 0 0 1px #00000009}
:where(.wand-employee-workspace,[data-employee-profile]) .color-option[data-selected=true]{border-color:var(--accent-solid)}
:where(.wand-employee-workspace,[data-employee-profile]) .colors .options{justify-content:flex-start;gap:12px;flex-wrap:wrap}
:where(.wand-employee-workspace,[data-employee-profile]) .aside-foot{display:block;font-size:12px;color:var(--text-secondary);margin-top:18px}
:where(.wand-employee-workspace,[data-employee-profile]) .photo{object-fit:cover;border-radius:7px;flex:none}
:where(.wand-employee-workspace,[data-employee-profile]) .pixel{display:inline-flex;align-items:center;justify-content:center;flex:none}
:where(.wand-employee-workspace,[data-employee-profile]) .fixed-avatar{display:grid;grid-template-columns:18px 1fr;gap:5px;color:var(--text-secondary);padding:15px 0;border-top:1px solid var(--border-subtle)}
:where(.wand-employee-workspace,[data-employee-profile]) .fixed-avatar strong{font-size:12px;font-weight:500}
:where(.wand-employee-workspace,[data-employee-profile]) .fixed-avatar p{grid-column:2;font-size:12px;line-height:1.8;color:var(--text-secondary)}
:where(.wand-employee-workspace,[data-employee-profile]) .preserved{padding:15px 0;font-size:12px;color:var(--text-secondary);text-align:center}
:where(.wand-employee-workspace,[data-employee-profile]) .preserved p{margin-bottom:12px}
:where(.wand-employee-workspace,[data-employee-profile]) .feedback{padding:9px 28px;color:var(--success);background:var(--success-muted);font-size:12px}
:where(.wand-employee-workspace,[data-employee-profile]) .feedback.error{color:var(--danger);background:var(--danger-muted)}

.appearance-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
.appearance-controls{min-width:0}
@container employeedirectory (min-width:980px){.employee-items{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container employeedirectory (min-width:1440px){.employee-items{grid-template-columns:repeat(3,minmax(0,1fr))}}
@container employeeeditor (min-width:640px){
 .appearance-layout{grid-template-columns:200px minmax(0,1fr);align-items:start;max-width:1040px}
}
@container employeeeditor (min-width:1040px){
 :is([data-employee-profile] :is(.identity-fields,#role,.advanced-content),.is-new :is(.wand-team-member-inner,.wand-employee-advanced-inner))>.wand-settings-library-field>.ant-form-item-row{display:grid;grid-template-columns:200px minmax(0,1fr);column-gap:32px;align-items:start}
 :is([data-employee-profile],.is-new) .wand-settings-library-field .ant-form-item-label{padding-bottom:0;text-align:start;white-space:normal}
 :is([data-employee-profile],.is-new) .wand-settings-library-field .ant-form-item-label>label{white-space:normal;height:auto}
 :is([data-employee-profile],.is-new) .wand-settings-library-field .ant-form-item-control{min-width:0;max-width:1200px}
}
@media(max-width:600px){
 .employee-directory{padding-top:12px}
 .employee-directory-toolbar{gap:12px}
 .employee-directory-toolbar .wand-ui-search{flex-basis:100%}
 .employee-directory-toolbar>.ant-btn{margin-left:auto}
 [data-employee-profile] .profile-header{gap:6px}
 [data-employee-profile] .save-actions{margin-left:auto}
 [data-employee-profile] .dirty{flex-basis:100%;text-align:right;margin:0}
 [data-employee-profile] .editor{padding-top:20px}
 :where(.wand-employee-workspace,[data-employee-profile]) .shape .options{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media(pointer:coarse){
 [data-employee-profile] .option,[data-employee-profile] .color-option{min-height:44px;min-width:44px}
}
`;

export function installEmployeeProfileStyles(): void {
  installStyleSheet("wand-employee-profile-styles", css);
}
