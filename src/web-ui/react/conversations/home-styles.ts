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
.conversation-root .conversation-companion.ant-btn { position:absolute; inset-inline-start:-12px; inset-block-start:-62px; width:80px; height:80px; padding:0; border:0; background:transparent; z-index:1; }
.conversation-root .conversation-companion .composer-floating-avatar { inset:0; width:80px; height:80px; }
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
.sidebar.sidebar-home .sidebar-navigation-rail { background:color-mix(in srgb,var(--bg-secondary) 70%,var(--border-subtle)); border:0; }
.sidebar.sidebar-home .sidebar-list-panel { background:var(--bg-secondary); border:0; }
.sidebar.sidebar-home .conversation-list-tools { background:var(--bg-secondary); }
.sidebar.sidebar-home .sidebar-header { padding-block:18px 12px; }
.sidebar.sidebar-home .sidebar-title { font-size:18px; letter-spacing:0; }
.sidebar.sidebar-home .conversation-row { padding-block:9px; border-radius:8px; }
.sidebar.sidebar-home .conversation-row[aria-current="page"] { background:var(--bg-active); }
.sidebar.sidebar-home .conversation-row-title { font-size:14px; }
.sidebar.sidebar-home .conversation-row-preview { font-size:12px; }
.sidebar.sidebar-home .conversation-row-more.ant-btn { bottom:12px; }
.sidebar.sidebar-home .conversation-navigation .wand-ui-icon-button[aria-current="page"] { color:var(--accent); }
/* The desktop reference is a framed conversation workspace, with its own scale.
   A mounted but hidden ConversationHome must never resize settings or terminals. */
@media (min-width:1024px) and (min-height:700px) {
  body:has(.app-container > .main-layout > .main-content-conversation) { background:color-mix(in srgb,var(--bg-secondary) 82%,var(--border-subtle)); }
  .app-container:has(> .main-layout > .main-content-conversation) {
    --conversation-frame-inline:clamp(16px,calc((100vw - 980px) * .07914),44px);
    --conversation-frame-top:clamp(18px,calc((100vw - 900px) * .063),40px);
    --conversation-frame-bottom:22px;
    --conversation-sidebar-width:clamp(380px,32.03vw,492px);
    --conversation-rail-width:clamp(72px,6.12vw,94px);
    --conversation-brand-size:clamp(36px,3.125vw,48px);
    --conversation-label-size:clamp(14px,1.18vw,18px);
    border:1px solid color-mix(in srgb,var(--border-subtle) 55%,transparent);
    border-radius:18px;
    box-shadow:0 8px 24px color-mix(in srgb,var(--text-primary) 10%,transparent);
  }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home.collapsed { --conversation-brand-size:24px; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .sidebar-navigation-rail { box-sizing:border-box; width:var(--conversation-rail-width); padding:16px 8px; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home .sidebar-rail-scroll > .sidebar-brand-mark { margin:6px auto 18px; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .conversation-navigation { gap:10px; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .sidebar-navigation-rail :is(.wand-ui-icon-button,.sidebar-list-error,[data-daemon-update-status]) { width:100%; min-width:0; height:clamp(60px,5.2vw,80px); }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .sidebar-nav-icon { height:32px; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) :is(.sidebar-nav-icon,.sidebar-profile-button) svg { width:28px !important; height:28px !important; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .sidebar-nav-label { font-size:var(--conversation-label-size); line-height:1.4; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .sidebar-header { padding:20px 20px 12px !important; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .sidebar-title { font-size:clamp(20px,1.56vw,24px); }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .sidebar-header-actions { gap:10px; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) :is(.conversation-create-button,.sidebar-compact-toggle) { width:auto; min-width:0; height:40px; padding-inline:4px; gap:8px; font-size:var(--conversation-label-size); font-weight:600; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) :is(.conversation-create-label,.sidebar-compact-toggle-label) { display:inline; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .sidebar-body { padding-inline:12px !important; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .conversation-search-host { padding:0 10px 12px; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .conversation-search-input { min-height:48px; font-size:var(--conversation-label-size); border-radius:12px; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .conversation-search-input input { font-size:inherit; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .conversation-list-section { padding:0 12px 10px; gap:8px; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .conversation-list-filter .ant-segmented-item-label { min-height:40px; padding:6px 10px; font-size:var(--conversation-label-size); }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .conversation-list-count { font-size:clamp(13px,1.1vw,17px); }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .conversation-row { min-height:78px; padding:10px 6px; gap:8px; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .conversation-row-avatar { width:56px; min-width:56px; height:56px; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .conversation-row-avatar > :first-child { transform:scale(1.14); }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .conversation-row-title { font-size:clamp(16px,1.3vw,20px); line-height:1.4; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .conversation-row-preview { font-size:clamp(14px,1.1vw,17px); line-height:1.5; }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .conversation-row-time { font-size:clamp(12px,.98vw,15px); }
  .app-container:has(> .main-layout > .main-content-conversation) .sidebar-home:not(.collapsed) .conversation-row-more.ant-btn { bottom:20px; }
  .main-content-conversation .conversation-root { --conversation-inset:clamp(28px,2.865vw,44px); --conversation-reading-inset:clamp(40px,5.47vw,84px); }
  .main-content-conversation .conversation-heading { padding-block:24px 20px; }
  .main-content-conversation .conversation-heading-title { font-size:clamp(21px,1.56vw,24px); }
  .main-content-conversation .conversation-heading-context { font-size:clamp(15px,1.18vw,18px); }
  .main-content-conversation .conversation-message-scroll { padding-block:28px; }
  .main-content-conversation .conversation-message-scroll > * { padding-inline:var(--conversation-reading-inset) var(--conversation-inset); }
  .main-content-conversation .conversation-reply-body { font-size:clamp(19px,1.5vw,23px); line-height:1.7; }
  .main-content-conversation .conversation-reply-body :is(p,ul,ol) { margin-block:0 24px; }
  .main-content-conversation .conversation-reply-body :is(h1,h2,h3) { font-size:1em; margin-block:24px; }
  .main-content-conversation .conversation-reply-footer { font-size:var(--conversation-label-size); }
  .main-content-conversation .conversation-reply-footer .ant-btn { height:40px; font-size:inherit; }
  .main-content-conversation .conversation-composer { padding:8px var(--conversation-inset) 12px; }
  .main-content-conversation .conversation-input-wrap { --composer-control-height:44px; margin-block-start:94px; }
  .main-content-conversation .conversation-sender.ant-sender { min-height:146px; padding:20px 22px 10px; border:1px solid var(--border-subtle); border-radius:18px; }
  .main-content-conversation .conversation-sender .ant-sender-input { font-size:clamp(18px,1.44vw,22px); line-height:1.45; }
  .main-content-conversation .conversation-sender .ant-sender-footer { padding-block-start:2px; }
  .main-content-conversation .conversation-action-row { min-height:44px; }
  .main-content-conversation .conversation-action-row :is(.composer-expand-editor,.conversation-config-trigger) { height:44px; min-height:44px; font-size:clamp(14px,1.1vw,17px); padding-inline:8px; }
  .main-content-conversation .conversation-action-row .conversation-morph-icon { width:26px !important; height:26px !important; }
  .main-content-conversation .conversation-action-row .conversation-composer-control svg { width:26px !important; height:26px !important; }
  .main-content-conversation .conversation-submit-labelled.ant-btn { min-height:48px; padding-inline:16px; }
  .main-content-conversation .conversation-submit-label { font-size:clamp(15px,1.3vw,20px); }
  .main-content-conversation .conversation-companion.ant-btn { inset-inline-start:-20px; inset-block-start:-106px; width:132px; height:132px; }
  .main-content-conversation .conversation-companion .composer-floating-avatar { width:132px; height:132px; display:flex; align-items:flex-start; justify-content:flex-start; text-align:start; }
  .main-content-conversation .conversation-companion .wand-employee-avatar[data-size="composer"] { transform:scale(1.8); transform-origin:0 0; }
  .main-content-conversation .conversation-root .conversation-input-wrap > .composer-usage-line { inset-inline:108px 0; inset-block-start:-42px; font-size:var(--conversation-label-size); }
  .main-content-conversation .composer-usage-caption.ant-btn { height:32px; font-size:inherit; }
  .main-content-conversation .conversation-input-hint { padding-block-start:8px; font-size:clamp(12px,1.04vw,16px); line-height:1.4; }
}
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
