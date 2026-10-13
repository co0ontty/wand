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
/* One mounted editor opens upward from the compact action row. */
.input-composer[data-composer-expanded] [data-composer-sender],
.conversation-input-wrap[data-composer-expanded] .ant-sender-content {
  height:auto; interpolate-size:allow-keywords;
  transition:height var(--motion-normal) var(--ease-out-expo),opacity var(--motion-fast) var(--ease-in-out-smooth);
}
.composer-compact-entry.ant-btn { flex:1; min-width:0; height:var(--composer-control-height); padding-inline:8px; justify-content:flex-start; text-align:start; color:var(--text-secondary); overflow:hidden; }
.composer-compact-entry.ant-btn > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.input-composer[data-composer-expanded] .composer-main-row { grid-template-columns:auto minmax(0,1fr) auto; grid-template-rows:auto auto; gap:4px 8px; align-items:center; }
.input-composer[data-composer-expanded] .composer-input-wrap { grid-row:1; grid-column:1 / -1; }
.input-composer[data-composer-expanded] .composer-actions-left { grid-row:2; grid-column:1; }
.input-composer[data-composer-expanded] .composer-actions-right { grid-row:2; grid-column:3; flex-wrap:nowrap; }
.input-composer[data-composer-expanded] .composer-inline-config,
.input-composer[data-composer-expanded] .composer-status-row > :not(#composer-status-line),
.input-composer[data-composer-expanded] .composer-status-line:not([data-tone]),
.input-composer[data-composer-expanded] .composer-input-wrap:not([data-editor-expanded="true"]):not(:has(.has-clipped-draft)) .composer-editor-controls { display:none; }
.input-composer[data-composer-expanded] .composer-compact-entry { grid-row:2; grid-column:2; }
.input-composer[data-composer-expanded="true"] .composer-compact-entry { visibility:hidden; pointer-events:none; }
/* Collapsed editors must also release the identity layout's minimum height. */
.input-composer[data-composer-expanded="false"] .composer-input-wrap [data-composer-sender] { height:0; min-height:0; overflow:hidden; opacity:0; pointer-events:none; }
.input-composer[data-composer-expanded="false"] :is(.composer-editor-controls,.prompt-optimize-btn,.composer-status-row:not(:has([data-tone])),.composer-inline-config,.composer-pi-settings-toggle-host) { display:none; }
.input-composer[data-composer-expanded] .input-textarea { min-height:36px; max-height:min(112px,24dvh); }
.input-composer[data-composer-expanded] .composer-input-wrap[data-editor-expanded="true"] .input-textarea { max-height:min(504px,48dvh); }
.input-composer[data-composer-expanded="false"] .composer-attachments-host { display:none; }
.input-composer[data-composer-expanded="true"] .composer-actions-left .composer-status-row { flex-wrap:wrap; }
.input-composer[data-composer-expanded="true"] .composer-actions-left { flex-wrap:wrap; }
/* PTY has two complete views. The footer anchors never move during the swap. */
.input-composer[data-pty-input-mode] .composer-surface { margin-block-start:0; padding:8px; border:1px solid var(--border-default); border-radius:var(--control-radius); background:var(--bg-surface); }
.input-composer[data-pty-input-mode] .composer-surface:has(textarea:focus) { border-color:var(--border-focus); }
.input-composer[data-pty-input-mode] .composer-surface::before { content:none; }
.input-composer[data-pty-input-mode] :is(.composer-floating-avatar,.composer-usage-line,.prompt-optimize-btn,.composer-compact-entry) { display:none; }
.input-composer[data-pty-input-mode] .composer-main-row { grid-template-columns:auto minmax(0,1fr) auto; grid-template-rows:auto auto; gap:4px; align-items:end; }
.input-composer[data-pty-input-mode] .pty-input-mode-toggle { grid-row:2; grid-column:1; }
.input-composer[data-pty-input-mode] .composer-input-wrap { grid-row:1; grid-column:1 / -1; }
.input-composer[data-pty-input-mode] .composer-actions-left { position:absolute; inset-inline-end:4px; inset-block-start:4px; z-index:1; }
.input-composer[data-pty-input-mode] .composer-actions-left > :not(#attach-btn) { display:none; }
.input-composer[data-pty-input-mode="shortcuts"] .composer-actions-left { display:none; }
.input-composer[data-pty-input-mode] .composer-actions-right { grid-row:2; grid-column:3; position:relative; min-width:calc(var(--composer-control-height) * 2 + 4px); gap:4px; }
.input-composer[data-pty-input-mode] .pty-modifier-buttons { grid-row:2; grid-column:2; display:flex; gap:4px; }
.input-composer[data-pty-input-mode] .terminal-shortcuts:not([hidden]) { grid-row:1; grid-column:1 / -1; min-width:0; align-self:center; overflow:visible; }
.input-composer[data-pty-input-mode] .composer-input-wrap [data-composer-sender] { min-height:0; overflow:hidden; padding:8px calc(var(--composer-control-height) + 8px) 8px 4px; transition:height var(--motion-normal) var(--ease-out-expo),opacity var(--motion-normal) var(--ease-out-expo),clip-path var(--motion-normal) var(--ease-out-expo); }
.input-composer[data-pty-input-mode="shortcuts"] .composer-input-wrap [data-composer-sender] { height:0; opacity:0; pointer-events:none; clip-path:inset(0 0 0 12px); transition-duration:var(--motion-normal),var(--motion-quick-exit),var(--motion-normal); }
.input-composer[data-pty-input-mode="keyboard"] .composer-input-wrap [data-composer-sender] { height:auto; opacity:1; pointer-events:auto; clip-path:inset(0); }
.input-composer[data-pty-input-mode] .input-textarea { min-height:36px; max-height:min(112px,24dvh); white-space:pre-wrap; }
.input-composer[data-pty-input-mode] .terminal-shortcuts { opacity:0; pointer-events:none; clip-path:inset(0 0 0 12px); transition:opacity var(--motion-quick-exit) var(--ease-in-out-smooth),clip-path var(--motion-normal) var(--ease-out-expo); }
.input-composer[data-pty-input-mode="shortcuts"] .terminal-shortcuts { opacity:1; pointer-events:auto; clip-path:inset(0); transition-duration:var(--motion-normal),var(--motion-normal); }
.input-composer[data-pty-input-mode] .terminal-shortcuts-row { gap:4px; width:100%; position:relative; }
.input-composer[data-pty-input-mode] .terminal-shortcuts-row > button { height:var(--composer-control-height); }
.input-composer[data-pty-input-mode] .terminal-shortcuts-row > button[hidden] { display:none; }
.terminal-shortcuts-measure { position:absolute; inset-inline:0; inset-block-start:0; height:0; overflow:hidden; visibility:hidden; pointer-events:none; }
.input-composer[data-pty-input-mode] .terminal-shortcuts-probe { width:max-content; }
.pty-input-mode-toggle.ant-btn { width:calc(3em + 36px); height:var(--composer-control-height); min-height:var(--composer-control-height); flex:none; padding-inline:4px; gap:4px; }
.pty-modifier-toggle.ant-btn { width:max(44px,var(--composer-control-height)); height:var(--composer-control-height); padding-inline:4px; }
.pty-modifier-toggle.ant-btn[aria-pressed="true"] { background:var(--accent-muted); color:var(--text-primary); border-color:var(--accent); }
.pty-extra-keys-trigger.ant-btn { position:absolute; inset-inline-start:0; inset-block-end:0; width:var(--composer-control-height); height:var(--composer-control-height); padding:0; opacity:0; pointer-events:none; transition:opacity var(--motion-quick-exit) var(--ease-in-out-smooth); }
.input-composer[data-pty-input-mode="shortcuts"] .pty-extra-keys-trigger.ant-btn { opacity:1; pointer-events:auto; transition-duration:var(--motion-normal); }
.input-composer[data-pty-input-mode="shortcuts"] .wand-composer-rail-submit { opacity:0; pointer-events:none; }
.pty-extra-keys-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:4px; min-width:200px; }
.pty-extra-keys-grid .ant-btn { min-height:44px; }
.pty-input-mode-label { display:grid; }
.pty-draft-dot { width:4px; height:4px; border-radius:50%; background:currentColor; }
.pty-input-mode-label > span { display:flex; align-items:center; justify-content:center; gap:4px; grid-area:1 / 1; opacity:0; white-space:nowrap; transition:opacity var(--motion-morph) var(--ease-in-out-smooth); }
.pty-input-mode-label > span[data-active="true"] { opacity:1; }
.conversation-root .conversation-input-wrap[data-composer-expanded] .conversation-sender.ant-sender { padding:8px 10px; transition:padding var(--motion-normal) var(--ease-out-expo); }
.conversation-root .conversation-input-wrap[data-composer-expanded="false"] .ant-sender-content { height:0; min-height:0; overflow:hidden; opacity:0; pointer-events:none; }
.conversation-input-wrap[data-composer-expanded="false"] :is(.ant-sender-header,.composer-edit-action,.conversation-config-trigger) { display:none; }
.conversation-input-wrap[data-composer-expanded="false"] .ant-sender-footer { padding-top:0; }
.conversation-input-wrap[data-composer-expanded="true"] .composer-compact-entry { display:none; }
.conversation-composer:has([data-composer-expanded="false"]) > .conversation-input-hint { display:none; }
.conversation-root .conversation-action-row > .ant-flex { flex-wrap:nowrap; }
@media (pointer:coarse) { .conversation-root .conversation-input-wrap[data-composer-expanded] .composer-expand-editor.ant-btn { min-height:44px; } }
@media (max-width:640px) {
  .input-composer[data-pty-input-mode] .composer-surface { --composer-control-height:44px; }
  .input-composer[data-pty-input-mode] .wand-composer-rail-submit { width:var(--composer-control-height); min-width:var(--composer-control-height); padding-inline:0; }
  .input-composer[data-pty-input-mode] .wand-composer-rail-submit > span { display:none; }
  .input-composer[data-composer-expanded="true"] .composer-actions-right { max-width:100%; }
  .conversation-input-wrap[data-composer-expanded="true"] .conversation-config-trigger { max-width:96px; overflow:hidden; }
}
@media (prefers-reduced-motion:reduce) {
  .input-composer[data-pty-input-mode] :is(.composer-input-wrap [data-composer-sender],.terminal-shortcuts),
  .pty-input-mode-label > span, .pty-extra-keys-trigger.ant-btn,
  .input-composer[data-composer-expanded] [data-composer-sender],
  .conversation-input-wrap[data-composer-expanded] .ant-sender-content,
  .conversation-root .conversation-input-wrap[data-composer-expanded] .conversation-sender.ant-sender { transition:none; }
}
.composer-config-controls [data-mode-control-pill] { min-width:0; }
.composer-config-controls [data-mode-control-pill="tool"] { width:120px; }
.composer-config-controls [data-mode-control-pill="model"] { min-width:120px; }
.composer-config-controls [data-mode-control-pill="thinking"] { min-width:68px; }
.composer-settings-scope { margin:0 0 8px; font-size:11px; line-height:1.5; color:var(--text-secondary); }
.conversation-root .wand-chat-message-content { font-size:14px; border-radius:var(--control-radius); }
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
