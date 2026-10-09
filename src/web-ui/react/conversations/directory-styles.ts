import { installStyleSheet } from "../styles.js";

const css = String.raw`
.conversation-directory-header { min-height:var(--wand-page-header-height,56px); padding:10px var(--wand-page-inset,20px); border-bottom:1px solid var(--border-subtle); }
.conversation-directory-header h2.ant-typography { margin:0; font-size:var(--wand-page-title-size,18px); }
.conversation-directory-toolbar { padding:16px var(--wand-page-inset,20px) 12px; gap:12px; }
.conversation-directory-search { flex:1 1 240px; max-width:400px; min-width:0; }
.conversation-directory-manage { margin-inline-start:auto; }
.conversation-directory-body { padding:0 var(--wand-page-inset,20px) 24px; }
.conversation-directory .conversation-contact-row { min-height:64px; padding:6px 0; gap:10px; }
.conversation-directory .conversation-contact-copy.ant-btn { min-height:48px; padding-inline:4px; }
.conversation-contact-name { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; }
.conversation-directory .conversation-contact-duty { margin-top:2px; font-size:12px; }
.conversation-contact-engine { display:block; color:var(--text-secondary); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.conversation-directory .conversation-avatar-button { width:36px; height:36px; flex:0 0 auto; }
.conversation-directory .conversation-preset-row.ant-btn { min-height:60px; padding:8px 4px; }
.conversation-directory .conversation-preset-row .ant-typography { font-size:12px; }
.conversation-directory .conversation-preset-row .ant-typography:first-child { font-size:14px; }
@media (pointer:coarse) {
  .conversation-directory .conversation-avatar-button { width:44px; height:44px; }
}
@media (max-width:639px) {
  .conversation-directory-toolbar { gap:10px; }
  .conversation-directory-search { flex-basis:100%; max-width:none; order:2; }
}
`;

export function installDirectoryStyles(): void {
  installStyleSheet("wand-directory-refinement-styles", css);
}
