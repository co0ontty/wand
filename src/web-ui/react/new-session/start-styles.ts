import { installStyleSheet } from "../styles";

export function installNewWorkStyles(): void {
  installStyleSheet("wand-new-work", `
.new-work-page { position:absolute; inset:0; z-index:8; display:flex; flex-direction:column; min-width:0; min-height:0; background:var(--bg-primary); }
.new-work-heading { min-height:var(--wand-page-header-height); padding:0 var(--wand-page-inset); border-bottom:1px solid var(--border-subtle); flex-shrink:0; }
.new-work-kind { padding:0 var(--wand-page-inset); }
.new-work-context { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; padding:24px var(--wand-page-inset); }
.new-work-sentence { display:flex; flex-wrap:wrap; justify-content:center; align-items:center; gap:8px; font-size:18px; max-width:100%; }
.new-work-person.ant-btn { height:auto; min-height:44px; gap:8px; font-size:inherit; }
.new-work-person-name { max-width:min(240px,45vw); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.new-work-directory.ant-btn { min-width:0; max-width:min(520px,80vw); font-size:inherit; color:var(--text-link); }
.new-work-directory.ant-btn > span:not(.wand-ui-icon) { overflow:hidden; text-overflow:ellipsis; }
.new-work-subject { width:min(560px,calc(100vw - 48px)); max-height:60vh; overflow:auto; }
.new-work-paths { width:min(440px,calc(100vw - 48px)); max-height:60vh; overflow:auto; }
.new-work-paths > .ant-btn { justify-content:flex-start; overflow:hidden; }
.new-work-composer { width:100%; max-width:940px; margin-inline:auto; padding-inline:var(--wand-page-inset); padding-block:24px; flex-shrink:0; }
@media(max-width:639px) { .new-work-sentence { font-size:16px; } .new-work-composer { padding-block:16px; } }
`);
}
