import { installStyleSheet } from "./styles";

export function installChatComposerStyles(): void {
  installStyleSheet("wand-chat-composer-layout", String.raw`
.conversation-heading { min-height:56px; padding-block:6px; }
.conversation-heading-title { font-size:14px; }
.conversation-heading > .ant-btn { min-height:32px; }
.conversation-root .conversation-composer-control.ant-btn { width:32px; height:32px; min-width:32px; flex:none; padding:0; }
.conversation-root .conversation-submit.ant-btn { border-radius:var(--control-radius); }
.conversation-root .conversation-action-row { min-height:36px; height:auto; gap:8px; }
.conversation-root .conversation-sender .ant-sender-footer { padding:0 10px 8px; }
.conversation-root .conversation-input-hint { line-height:18px; }
.conversation-root .conversation-work-choice { display:flex; align-items:center; flex-wrap:wrap; gap:4px 8px; margin-block:2px 4px; }
.conversation-work-choice .ant-btn { height:24px; padding:0 6px; font-size:12px; }
.conversation-work-choice .conversation-continue-work { min-width:0; max-width:100%; overflow:hidden; }
.conversation-continue-work > span { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.conversation-root .conversation-execution-summary { font-size:11px; line-height:18px; color:var(--text-secondary); overflow-wrap:anywhere; }
.conversation-root .conversation-cwd-summary { font-size:11px; line-height:18px; }
.conversation-action-menu { display:flex; flex-direction:column; align-items:stretch; gap:8px; }
.conversation-action-menu[hidden] { display:none; }
.conversation-action-menu .ant-typography { font-size:12px; line-height:1.5; margin:0; }
.conversation-action-menu > .ant-btn { justify-content:flex-start; }
.conversation-root .conversation-feedback { min-height:32px; font-size:12px; }
.conversation-root .conversation-work-choice .conversation-input-hint { display:inline; }
.composer-config-controls [data-mode-control-pill] { min-width:0; }
.composer-config-controls [data-mode-control-pill="tool"] { width:120px; }
.composer-config-controls [data-mode-control-pill="model"] { min-width:120px; }
.composer-config-controls [data-mode-control-pill="thinking"] { min-width:68px; }
.composer-settings-scope { margin:0 0 8px; font-size:11px; line-height:1.5; color:var(--text-secondary); }
.conversation-root .ant-bubble-content { font-size:14px; border-radius:var(--control-radius); }
.conversation-root .conversation-composer-control:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@media (pointer:coarse) {
  .conversation-root .conversation-composer-control.ant-btn { width:44px; height:44px; min-width:44px; }
  .conversation-work-choice .ant-btn, .conversation-heading > .ant-btn { min-height:44px; height:auto; }
}
@media (max-width:640px) {
  .conversation-root .conversation-action-row .conversation-input-hint { display:none; }
  .conversation-root .conversation-work-choice { align-items:flex-start; }
}
`);
}
