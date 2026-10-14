import { installStyleSheet } from "../styles";

/** Approved conversation surface; shared controls and all five themes retain ownership. */
export function installConversationHomeStyles(): void {
  installStyleSheet("wand-conversation-home", String.raw`
.conversation-root { --conversation-inset:clamp(16px,3vw,48px); background:var(--bg-primary); }
.conversation-root .conversation-heading { padding:20px var(--conversation-inset) 16px; border:0; }
.conversation-root .conversation-heading-title { height:auto; min-height:28px; font-size:20px; font-weight:600; }
.conversation-root .conversation-heading-context { margin-block-start:2px; font-size:13px; }
.conversation-root .conversation-message-scroll { padding-block:20px 28px; }
.conversation-root .conversation-message-scroll > * { padding-inline:var(--conversation-inset); }
.conversation-root .team-chat-stream { gap:20px; }
.conversation-root .conversation-session-reply { margin-block:4px 12px; }
.conversation-root .conversation-reply-context { font-size:12px; }
.conversation-root .conversation-reply-body { font-size:15px; line-height:1.8; }
.conversation-root .conversation-reply-body :is(p,ul,ol) { margin-block:0 16px; }
.conversation-root .conversation-reply-body :is(h1,h2,h3) { margin-block:24px 12px; line-height:1.4; }
.conversation-root .conversation-reply-body :is(pre,table) { max-width:100%; }
.conversation-root .conversation-reply-footer { padding-block:4px; font-size:12px; }
.conversation-root .conversation-reply-footer .ant-btn { color:var(--accent); font-weight:600; }
.conversation-continue-arrow { transform:rotate(90deg); }
.conversation-root .conversation-composer { padding:8px var(--conversation-inset) max(12px,var(--wand-safe-bottom,0px)); background:transparent; }
.conversation-root .conversation-input-wrap { margin-block-start:42px; }
.conversation-root .conversation-sender.ant-sender { border:0; border-radius:16px; background:var(--bg-surface); padding:16px 16px 10px; box-shadow:0 4px 20px color-mix(in srgb,var(--text-primary) 8%,transparent); }
.conversation-root .conversation-sender.ant-sender:focus-within { box-shadow:0 4px 20px color-mix(in srgb,var(--text-primary) 8%,transparent),0 0 0 2px var(--border-focus); }
.conversation-root .conversation-sender.ant-sender:has(textarea:focus)::before { content:none; }
.conversation-root .conversation-companion.ant-btn { position:absolute; inset-inline-start:-12px; inset-block-start:-62px; width:80px; height:62px; padding:0; border:0; background:transparent; z-index:1; }
.conversation-root .conversation-companion .composer-floating-avatar { inset:0; width:80px; height:80px; pointer-events:none; }
.conversation-root .conversation-input-wrap > .composer-usage-line { inset-inline:76px 0; inset-block-start:-30px; overflow:visible; }
.conversation-root .conversation-input-hint { display:block; padding:6px 8px 0; font-size:11px; }
.conversation-root .conversation-action-row { gap:8px; }
.conversation-root .conversation-action-row > .ant-flex { min-width:0; flex-wrap:wrap; }
.conversation-root .conversation-submit-labelled.ant-btn { width:auto; min-width:32px; padding-inline:12px; gap:6px; }
.conversation-submit-label { font-size:12px; }
.conversation-config-trigger.ant-btn { height:32px; min-height:32px; padding-inline:6px; font-size:12px; }
.conversation-preference-details { width:min(340px,calc(100vw - 48px)); max-height:45dvh; overflow:auto; }
.conversation-preference-details .conversation-continue-work { width:100%; max-width:100%; display:flex; justify-content:flex-start; gap:0; overflow:hidden; }
.conversation-preference-details .ant-typography { white-space:normal; overflow-wrap:anywhere; }
.conversation-group-mosaic { display:grid; align-content:center; gap:1px; padding:2px; border-radius:12px; background:var(--bg-tertiary); box-sizing:border-box; overflow:hidden; }
.conversation-group-cell { position:relative; aspect-ratio:1; min-width:0; min-height:0; display:grid; place-items:center; overflow:hidden; border-radius:4px; }
.conversation-group-cell > span { position:absolute; display:block; transform-origin:center; }
/* Conversation view shares the app-wide scale and fills the window like every other page. */
@media (max-width:640px) {
  .conversation-root .conversation-heading { padding-block:10px; }
  .conversation-root .conversation-heading-title { font-size:17px; }
  .conversation-root .conversation-message-scroll { padding-block:12px 20px; }
  .conversation-root .conversation-sender.ant-sender { padding:12px 10px 8px; border-radius:12px; }
  .conversation-root .conversation-submit-label { display:none; }
  .conversation-root .conversation-submit-labelled.ant-btn { padding-inline:0; width:var(--composer-control-height); }
  .conversation-root .conversation-input-hint { display:none; }
}
`);
}
