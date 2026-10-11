import { installStyleSheet } from "./styles";

export function installChatComposerStyles(): void {
  installStyleSheet("wand-chat-composer-layout", String.raw`
.composer-surface,
.conversation-root .conversation-sender.ant-sender {
  min-width:0; border:0; border-block-start:1px solid var(--border-subtle);
  border-radius:0; background:transparent; box-shadow:none; padding-block-start:10px;
}
.composer-surface:has(textarea:focus),
.conversation-root .conversation-sender.ant-sender:has(textarea:focus) {
  border-block-start-color:var(--accent);
}
.composer-surface:has(textarea:focus)::before,
.conversation-root .conversation-sender.ant-sender:has(textarea:focus)::before {
  content:""; position:absolute; inset-block-start:0; inset-inline:0; height:2px;
  background:var(--accent); pointer-events:none;
}
.composer-surface { position:relative; }
.composer-surface, .conversation-input-wrap { --composer-control-height:32px; }
.composer-surface :is(.composer-actions-left, .composer-actions-right, .composer-status-row) .ant-btn,
.composer-surface .prompt-optimize-btn.ant-btn {
  height:var(--composer-control-height); min-height:var(--composer-control-height); display:inline-flex; align-items:center;
}
.composer-surface :is(#attach-btn, #voice-record-btn, #send-input-button, .composer-pi-settings-toggle),
.composer-surface .composer-config-controls .ant-btn-icon-only { min-width:var(--composer-control-height); padding-inline:0; }
.composer-surface .ant-sender { background:transparent; }
.composer-surface .ant-sender-input { caret-color:var(--accent); }
.conversation-root .conversation-sender .ant-sender-content { padding:0; background:transparent; }
.conversation-root .conversation-sender .ant-sender-input { padding:0; font:inherit; line-height:1.5; caret-color:var(--accent); }
.conversation-root .conversation-sender .ant-sender-footer { padding:6px 0 0; background:transparent; }
.conversation-root .conversation-sender .ant-sender-suffix { background:transparent; }
.conversation-root .conversation-sender.ant-sender:focus-within { box-shadow:none; }
.conversation-root .conversation-composer-control.ant-btn { width:var(--composer-control-height); height:var(--composer-control-height); min-width:var(--composer-control-height); flex:none; padding:0; }
.conversation-root .conversation-submit.ant-btn { border-radius:var(--control-radius); }
.conversation-root .conversation-action-row { min-height:36px; height:auto; gap:8px; }
.conversation-root .conversation-input-hint { line-height:18px; }
.conversation-input-wrap .ant-sender-input { max-height:min(168px,28dvh) !important; }
.conversation-input-wrap:has(.composer-attachment-list) .ant-sender-input { max-height:min(168px,max(63px,calc(100dvh - 440px))) !important; }
.conversation-input-wrap[data-editor-expanded="true"] .ant-sender-input { max-height:min(504px,max(63px,calc(100dvh - 340px))) !important; }
.conversation-input-wrap[data-editor-expanded="true"]:has(.composer-attachment-list) .ant-sender-input { max-height:min(504px,max(63px,calc(100dvh - 440px))) !important; }
.composer-expand-editor.ant-btn { flex:none; font-size:12px; padding-inline:6px; }
.composer-usage-caption.ant-btn { height:24px; min-height:24px; padding:0 4px; font:inherit; }
.composer-usage-details { display:grid; grid-template-columns:1fr; gap:6px; max-width:min(320px,calc(100vw - 48px)); }
.conversation-unavailable-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding-block:4px 8px; }
.conversation-unavailable-actions > .ant-typography:first-child { width:100%; }
.conversation-unavailable-actions > .wand-ui-select-trigger { min-width:min(160px,100%); max-width:100%; }
.conversation-composer:has(.conversation-unavailable-actions) { max-height:calc(100dvh - 88px); overflow:auto; }
.conversation-execution-failure { display:flex; flex-direction:column; align-items:flex-start; gap:8px; }
.conversation-execution-failure .ant-typography { margin:0; }
.conversation-execution-failure details { width:100%; }
.conversation-execution-failure summary { cursor:pointer; padding-block:6px; }
.conversation-execution-failure pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; margin:4px 0; }
.conversation-root .conversation-work-choice { min-height:32px; margin-block:0 4px; }
.conversation-mode-chip { padding:2px 8px; border-radius:var(--control-radius); background:var(--accent-muted); color:var(--text-primary); }
.conversation-preference-details { font-size:var(--font-size-xs); margin-block:0 4px; }
.conversation-preference-details summary { width:fit-content; padding-block:4px; cursor:pointer; color:var(--text-secondary); }
.conversation-preference-details[open] { max-height:24dvh; overflow:auto; }
.conversation-preference-details .ant-typography { display:block; overflow-wrap:anywhere; }
.conversation-work-choice { flex-wrap:wrap; }
.conversation-work-choice .conversation-continue-work { overflow:hidden; max-width:100%; justify-content:flex-start; text-align:start; gap:0; }
.conversation-continue-prefix { flex:none; }
.conversation-continue-title { display:block; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.conversation-work-choice .conversation-receiver { flex:none; min-height:0; font-weight:500; }
.conversation-work-choice .ant-btn { height:32px; padding:0 6px; font-size:12px; }
.conversation-work-choice .conversation-continue-work { flex:none; white-space:nowrap; }
.conversation-root .conversation-execution-summary { flex:1; min-width:0; font-size:12px; line-height:20px; color:var(--text-secondary); overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.conversation-root .conversation-cwd-summary { font-size:12px; line-height:20px; }
.conversation-action-menu { display:flex; flex-direction:column; align-items:stretch; gap:8px; }
.conversation-action-menu[hidden] { display:none; }
.conversation-action-menu .ant-typography { font-size:12px; line-height:1.5; margin:0; }
.conversation-action-menu > .ant-btn { justify-content:flex-start; }
.conversation-root .conversation-feedback { min-height:32px; font-size:12px; }
.composer-config-controls [data-mode-control-pill] { min-width:0; }
.composer-config-controls [data-mode-control-pill="tool"] { width:120px; }
.composer-config-controls [data-mode-control-pill="model"] { min-width:120px; }
.composer-config-controls [data-mode-control-pill="thinking"] { min-width:68px; }
.composer-settings-scope { margin:0 0 8px; font-size:11px; line-height:1.5; color:var(--text-secondary); }
.conversation-root .ant-bubble-content { font-size:14px; border-radius:var(--control-radius); }
.conversation-root .conversation-composer-control:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@media (pointer:coarse) {
  .composer-surface, .conversation-input-wrap { --composer-control-height:44px; }
  .composer-surface .prompt-optimize-btn { inset-block-start:-48px; }
  .conversation-work-choice .ant-btn, .conversation-heading > .ant-btn, .conversation-session-actions .ant-btn, .conversation-session-state > .ant-btn { min-height:44px; height:auto; }
}
@media (max-width:640px) {
  .conversation-root .conversation-action-row .conversation-input-hint { display:none; }
}
`);
}
