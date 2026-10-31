import { installStyleSheet } from "./styles";

export function installChatComposerStyles(): void {
  installStyleSheet("wand-chat-composer-layout", String.raw`
/* 一套输入面板：细边框圆角表面，正文在上，工具栏在下，面板外只放上下文。
   新建任务/会话、对话详情、工作区会话与团队群聊共用这组规则，各入口不再自定边框、
   圆角、阴影或分隔线；差异只留在各自的按钮与选择器里。 */
.composer-surface, .wand-composer-surface, .conversation-root .conversation-sender.ant-sender {
  min-width:0; border:1px solid var(--border-subtle); border-radius:14px;
  background:var(--bg-surface); box-shadow:none; padding:10px 12px 8px;
}
.composer-surface:focus-within, .wand-composer-surface:focus-within, .conversation-root .conversation-sender.ant-sender:focus-within,
.conversation-root .conversation-sender.ant-sender:has(textarea:focus) { border-color:var(--border-focus); box-shadow:none; }
.conversation-root .conversation-sender.ant-sender:has(textarea:focus)::before { content:none; }
/* 正文与工具栏之间的一条虚线分隔；获得焦点时只换颜色，不改几何。 */
.composer-input-divider { height:0; margin:8px 0 0; border-block-start:1px dashed var(--border-subtle); background:none; pointer-events:none; }
.composer-surface:has(textarea:focus) .composer-input-divider { border-block-start-color:var(--border-focus); box-shadow:none; }
.input-composer[data-pty-input-mode] .composer-input-divider { display:none; }
.conversation-root .conversation-sender .ant-sender-footer { margin-block-start:8px; padding:8px 0 0; border-block-start:1px dashed var(--border-subtle); }
.conversation-root .conversation-sender:has(textarea:focus) .ant-sender-footer { border-block-start-color:var(--border-focus); }
/* 发送/停止是一个圆角方形图标按钮，四个入口同一尺寸与圆角；文字留给 aria-label。 */
.conversation-root .conversation-submit.ant-btn,
.team-chat-compose-main .team-chat-send-action.ant-btn {
  width:var(--composer-control-height); min-width:var(--composer-control-height); height:var(--composer-control-height);
  padding:0; border-radius:10px;
}
.conversation-root .conversation-submit-labelled.ant-btn { width:var(--composer-control-height); min-width:var(--composer-control-height); padding:0; }
.conversation-submit-labels { display:none; }
/* 面板外的上下文行：目录、执行位置与用量，共用一行次要文字，靠左紧凑排列。 */
.wand-composer-context { display:flex; align-items:center; flex-wrap:wrap; gap:2px 4px; min-width:0; padding:6px 2px 0; color:var(--text-secondary); font-size:var(--font-size-xs); }
.wand-composer-context:empty { display:none; }
.wand-composer-context > * { flex:0 0 auto; max-width:min(260px,45%); }
.conversation-root .wand-composer-context > .ant-btn { flex:0 0 auto; max-width:min(260px,45%); }
.wand-composer-context > .composer-usage-line { position:static; inset:auto; height:auto; flex:1 1 auto; overflow:visible; }
/* 无状态与用量时不留空白：空行会把目录胶囊推到中间。 */
.wand-composer-context > .composer-usage-line:empty { display:none; }
/* 工具栏两组对齐；只让模型名缩短，思考值和发送动作始终完整。 */
.conversation-input-wrap { container-type:inline-size; }
.conversation-action-row { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:nowrap; min-height:var(--composer-control-height); }
.conversation-action-row > .ant-flex { min-width:0; flex-wrap:nowrap; align-items:center; }
.conversation-action-row > .ant-flex:first-child { flex:0 0 auto; }
.conversation-action-row > .ant-flex:last-child { flex:0 1 auto; justify-content:flex-end; gap:4px; }
.conversation-runtime-summary { display:flex; position:static; flex:0 1 auto; min-width:0; overflow:hidden; justify-content:flex-end; gap:0; flex-wrap:nowrap; font-size:var(--font-size-xs); color:var(--text-secondary); }
.conversation-root .conversation-runtime-summary .conversation-runtime-select { min-width:0; padding:0 5px; height:var(--composer-control-height); min-height:var(--composer-control-height); font-size:inherit; color:inherit; gap:4px; }
.conversation-root .conversation-runtime-summary .conversation-tool-select { flex:none; width:32px; padding:0; gap:0; }
.conversation-tool-select > .wand-ui-select-value, .conversation-tool-select > .wand-ui-icon { display:none; }
.composer-tool-logo { width:16px; height:16px; flex:none; }
.composer-employee-trigger.ant-btn { width:var(--composer-control-height,32px); min-width:var(--composer-control-height,32px); height:var(--composer-control-height,32px); padding:0; flex:none; }
.composer-employee-trigger .wand-employee-avatar { display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; vertical-align:middle; }
.composer-actions-right [data-composer-employee-host] { display:contents; }
.conversation-root .conversation-runtime-summary .conversation-model-select { flex:0 1 auto; max-width:240px; }
.conversation-root .conversation-runtime-summary .conversation-thinking-select { flex:none; width:auto; }
.conversation-runtime-summary .wand-ui-select-value { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.conversation-runtime-summary .wand-ui-icon { width:11px; height:11px; flex:none; }
@container (max-width:480px) { .conversation-root .conversation-runtime-summary .conversation-tool-select { display:none; } .conversation-config-trigger { max-width:72px; } }
@container (max-width:350px) { .composer-edit-action { display:none; } .conversation-root .conversation-runtime-summary .conversation-model-select { max-width:130px; } }
.task-comment-input-surface { width:100%; box-sizing:border-box; }
.task-comment-input-surface .ant-input { border:0; box-shadow:none; border-radius:0; padding:0; background:transparent; resize:vertical; }
.task-comment-toolbar { justify-content:space-between; border-top:1px dashed var(--border-subtle); padding-top:8px; margin-top:8px; }
.task-comment-toolbar-hint { font-size:var(--font-size-xs); }
.composer-surface { position:relative; }
.composer-surface, .wand-composer-surface, .conversation-input-wrap { --composer-control-height:32px; }
.wand-composer-surface .team-chat-sender.ant-sender { border:0; padding:0; border-radius:0; box-shadow:none; background:transparent; }
.wand-composer-surface .team-chat-sender .ant-sender-content { padding:0; min-height:60px; }
.wand-composer-surface .team-chat-sender .ant-sender-input { padding:0; font:inherit; line-height:1.5; }
.wand-composer-surface .team-chat-sender .ant-sender-footer { padding:8px 0 0; margin-top:8px; border-top:1px dashed var(--border-subtle); }
.team-chat-runtime { display:flex; align-items:center; gap:8px; min-width:0; font-size:var(--font-size-xs); color:var(--text-secondary); }
.team-chat-runtime > span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:220px; }
.team-chat-runtime > span:last-child { flex:none; }
.wand-composer-surface .composer-status-row { display:none; }
@media(max-width:640px) { .team-chat-runtime > span:first-child { max-width:110px; } }
.composer-surface :is(.composer-actions-left, .composer-actions-right, .composer-status-row) .ant-btn {
  height:var(--composer-control-height); min-height:var(--composer-control-height); display:inline-flex; align-items:center;
}
.composer-surface :is(#attach-btn, #send-input-button, .composer-pi-settings-toggle),
.composer-surface .composer-config-controls .ant-btn-icon-only { min-width:var(--composer-control-height); padding-inline:0; }
.composer-surface .ant-sender { background:transparent; }
.composer-surface .ant-sender-input { caret-color:var(--accent); }
.conversation-root .conversation-sender .ant-sender-content { padding:0; background:transparent; }
.conversation-root .conversation-sender .ant-sender-input { padding:0 6px 0 0; font:inherit; line-height:1.6; caret-color:var(--accent); word-break:break-word; overflow-wrap:anywhere; scrollbar-width:thin; scrollbar-color:var(--border-subtle) transparent; }
.conversation-root .conversation-sender .ant-sender-input::-webkit-scrollbar,
.input-textarea::-webkit-scrollbar { width:5px; }
.conversation-root .conversation-sender .ant-sender-input::-webkit-scrollbar-thumb,
.input-textarea::-webkit-scrollbar-thumb { background:var(--border-subtle); border-radius:4px; }
.conversation-root .conversation-sender .ant-sender-input::-webkit-scrollbar-thumb:hover,
.input-textarea::-webkit-scrollbar-thumb:hover { background:var(--text-tertiary); }
.conversation-root .conversation-sender .ant-sender-footer { background:transparent; }
.conversation-root .conversation-sender .ant-sender-suffix { background:transparent; }
.conversation-root .conversation-sender.ant-sender:focus-within { box-shadow:none; }
.conversation-root .conversation-composer-control.ant-btn { width:var(--composer-control-height); height:var(--composer-control-height); min-width:var(--composer-control-height); flex:none; padding:0; }
.conversation-root .conversation-submit.ant-btn { border-radius:var(--control-radius); }
.conversation-root .conversation-action-row { min-height:36px; height:auto; gap:8px; }
.conversation-root .conversation-input-hint { line-height:18px; }
.conversation-input-wrap .ant-sender-input { max-height:min(240px,35dvh) !important; }
.conversation-input-wrap:has(.composer-attachment-list) .ant-sender-input { max-height:min(240px,max(63px,calc(100dvh - 440px))) !important; }
.conversation-input-wrap[data-editor-expanded="true"] .ant-sender-input { max-height:min(500px,max(63px,calc(100dvh - 280px))) !important; }
.conversation-input-wrap[data-editor-expanded="true"]:has(.composer-attachment-list) .ant-sender-input { max-height:min(500px,max(63px,calc(100dvh - 380px))) !important; }
.composer-expand-editor.ant-btn { flex:none; width:var(--composer-control-height,32px); min-width:var(--composer-control-height,32px); height:var(--composer-control-height,32px); padding:0; }
.composer-editor-morph { display:grid; width:16px; height:16px; }
.composer-editor-morph > svg { grid-area:1/1; transition:opacity var(--motion-morph),transform var(--motion-morph); }
.composer-editor-morph > svg:last-child { opacity:0; transform:rotate(-90deg) scale(.85); }
.composer-editor-menu .composer-expand-editor { width:auto; min-width:0; padding-inline:8px; }
.composer-editor-menu .composer-expand-editor::after { content:"展开编辑"; margin-inline-start:6px; font-size:var(--font-size-xs); }
.composer-editor-menu .composer-expand-editor[aria-expanded="true"]::after { content:"收起编辑"; }
.new-work-permission.ant-btn { height:var(--composer-control-height); min-height:var(--composer-control-height); padding-inline:4px; gap:4px; }
.composer-editor-morph[data-expanded="true"] > svg:first-child { opacity:0; transform:rotate(90deg) scale(.85); }
.composer-editor-morph[data-expanded="true"] > svg:last-child { opacity:1; transform:none; }
@media(prefers-reduced-motion:reduce) { .composer-editor-morph > svg { transition:none; transform:none!important; } }
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
.input-composer[data-composer-expanded] .composer-main-row { grid-template-columns:minmax(0,1fr) auto; grid-template-rows:auto auto; gap:4px 8px; align-items:center; }
.input-composer[data-composer-expanded]:not([data-pty-input-mode]) .composer-inline-config { position:static; flex:0 1 auto; min-width:0; overflow:hidden; }
.input-composer .composer-session-context { padding:6px 2px 0; }
.input-composer > div { display:flex; flex-direction:column; }
.input-composer > div > .composer-session-context { order:3; }
.input-composer > div > .composer-top-row { order:0; }
.input-composer > div > .composer-surface { order:1; }
.input-composer .composer-session-context [data-composer-avatar-host] { display:contents; }
.input-composer .composer-session-context .composer-usage-line { position:static; inset:auto; height:24px; flex:1; overflow-x:auto; }
.input-composer .composer-surface { container-type:inline-size; }
.input-composer:not([data-pty-input-mode]) .composer-main-row { padding-top:0; }
.input-composer:not([data-pty-input-mode]) .composer-actions-left,
.input-composer:not([data-pty-input-mode]) .composer-actions-right { padding-top:8px; }
.input-composer .composer-input-wrap { border-bottom:1px dashed var(--border-subtle); padding-bottom:8px; }
.input-composer .composer-file-trigger.ant-btn { width:var(--composer-control-height); height:var(--composer-control-height); min-width:var(--composer-control-height); padding:0; border:0; background:transparent; box-shadow:none; }
.input-composer:not([data-pty-input-mode]) .composer-actions-left .composer-status-row { flex:0 1 auto; }
.input-composer:not([data-pty-input-mode]) .composer-status-line:not([data-tone]) { display:none; }
.input-composer:not([data-pty-input-mode]) .composer-status-row > [data-composer-config-host="mode"] { display:contents; }
@container (max-width:480px) { .input-composer .composer-inline-config [data-mode-control-pill="tool"] { display:none; } .input-composer .composer-inline-config [data-mode-control-pill="model"] { max-width:150px; } }
@container (max-width:350px) { .input-composer .composer-inline-config [data-mode-control-pill="model"] { max-width:100px; } }

.input-composer:not([data-pty-input-mode]) .composer-input-wrap { position:static; }
.input-composer[data-composer-expanded] .composer-actions-left > .ant-btn { flex:none; }
.input-composer[data-composer-expanded] .composer-actions-left > .composer-compact-entry { flex:1; min-width:44px; }
.input-composer .composer-config-controls-runtime { flex:0 1 auto; width:auto; gap:0!important; }
.composer-config-controls-runtime > [data-mode-control-pill="model"] { flex:0 1 auto; max-width:220px; min-width:0; }
.composer-config-controls-runtime > [data-mode-control-pill="thinking"] { flex:none; min-width:0; }
.composer-config-controls-runtime .wand-composer-select-trigger-tool { width:32px; min-width:32px; padding:0!important; }
.composer-config-controls-runtime .wand-composer-select-trigger-tool > .wand-ui-select-value,
.composer-config-controls-runtime .wand-composer-select-trigger-tool > .wand-ui-icon { display:none; }
.composer-config-controls-runtime .wand-composer-select-trigger-model .wand-ui-select-value { min-width:0; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.input-composer #attach-btn.ant-btn { border:0; background:transparent; box-shadow:none; padding:0; width:var(--composer-control-height); }
.input-composer[data-composer-expanded="true"] .composer-compact-entry { display:none; }
.composer-config-controls-runtime .wand-composer-select-trigger.ant-btn { background:transparent !important; border:0; box-shadow:none; padding-inline:4px; font-size:var(--font-size-xs); color:var(--text-secondary); }
.composer-config-controls-runtime .wand-composer-select-trigger.ant-btn:is(:hover,[data-popup-open]) { color:var(--accent); }
.composer-config-controls-runtime .wand-composer-select-trigger svg { width:10px; height:10px; opacity:.5; }
.composer-runtime-separator { flex:none; color:var(--text-tertiary); }
.input-composer[data-composer-expanded] .composer-input-wrap { grid-row:1; grid-column:1 / -1; }
.input-composer[data-composer-expanded] .composer-actions-left { grid-row:2; grid-column:1; }
.input-composer[data-composer-expanded] .composer-actions-right { grid-row:2; grid-column:2; flex-wrap:nowrap; }
.input-composer[data-composer-expanded] .composer-status-row > :not(#composer-status-line):not([data-composer-config-host="mode"]) { display:none; }
.input-composer .composer-status-row .wand-composer-select-trigger-mode { padding:0 4px; font-size:var(--font-size-xs); background:transparent; border:0; box-shadow:none; }
.input-composer:not([data-pty-input-mode]) .composer-input-wrap { min-height:60px; }
.input-composer[data-composer-expanded="false"] .composer-input-wrap { min-height:0; padding:0; border:0; }
/* 发送/停止是一个圆角方形图标按钮，四个入口同一尺寸与圆角；文字留给 aria-label。 */
.input-composer #send-input-button { width:var(--composer-control-height); min-width:var(--composer-control-height); height:var(--composer-control-height); padding:0; border-radius:10px; }
.input-composer #send-input-button > span:not(.ant-btn-icon) { display:none; }
.composer-send-icons { display:block; position:relative; width:15px; height:15px; }
.composer-send-icons > span { position:absolute; inset:0; display:flex; opacity:0; transform:scale(.9); transition:opacity var(--motion-morph),transform var(--motion-morph); }
.composer-send-icons > span[data-active="true"] { opacity:1; transform:none; }
@media (prefers-reduced-motion:reduce) { .composer-send-icons > span { transition:none; transform:none; } }
.input-composer[data-composer-expanded="true"] .composer-compact-entry { visibility:hidden; pointer-events:none; }
/* Collapsed editors must also release the identity layout's minimum height. */
.input-composer[data-composer-expanded="false"] .composer-input-wrap [data-composer-sender] { height:0; min-height:0; overflow:hidden; opacity:0; pointer-events:none; }
.input-composer[data-composer-expanded="false"] :is(.composer-editor-controls,.composer-status-row:not(:has([data-tone])),.composer-pi-settings-toggle-host) { display:none; }
.input-composer[data-composer-expanded] .input-textarea { min-height:36px; max-height:min(240px,35dvh); }
.input-composer[data-composer-expanded] .composer-input-wrap[data-editor-expanded="true"] .input-textarea { max-height:min(500px,55dvh); }
.input-composer[data-composer-expanded="false"] .composer-attachments-host { display:none; }
.input-composer[data-composer-expanded="true"] .composer-actions-left .composer-status-row { flex-wrap:nowrap; }
.input-composer[data-composer-expanded] .composer-actions-left { flex-wrap:nowrap; }
/* PTY has two complete views. The footer anchors never move during the swap. */
.input-composer[data-pty-input-mode] .composer-surface { margin-block-start:0; }
.input-composer[data-pty-input-mode] .composer-surface::before { content:none; }
.input-composer[data-pty-input-mode] :is(.composer-floating-avatar,.composer-usage-line,.composer-compact-entry) { display:none; }
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
/* Resting PTY dock: one slim entry; the full key rows return on demand. */
.input-composer[data-pty-input-mode] .pty-dock-toggle.ant-btn { grid-row:2; grid-column:2; justify-self:end; width:var(--composer-control-height); height:var(--composer-control-height); padding:0; color:var(--text-secondary); }
.input-composer[data-pty-input-mode]:not([data-pty-collapsed]) .pty-dock-toggle.ant-btn { z-index:1; }
.input-composer[data-pty-input-mode][data-pty-collapsed] :is(.terminal-shortcuts,.pty-input-mode-toggle,.pty-modifier-buttons,.composer-actions-right,.composer-input-wrap) { display:none; }
.input-composer[data-pty-input-mode][data-pty-collapsed] .composer-main-row { grid-template-columns:auto; grid-template-rows:auto; }
.input-composer[data-pty-input-mode][data-pty-collapsed] .composer-surface { padding:2px; border-color:transparent; background:transparent; }
.input-composer[data-pty-input-mode][data-pty-collapsed] .pty-dock-toggle.ant-btn { grid-row:1; grid-column:1; justify-self:start; width:auto; height:28px; min-height:28px; padding-inline:8px; gap:6px; font-size:var(--font-size-xs); border-color:transparent; background:var(--bg-secondary); }
.input-composer[data-pty-input-mode][data-pty-collapsed] .pty-dock-toggle.ant-btn > span { display:inline-flex; align-items:center; gap:4px; }
.input-panel:has(.input-composer[data-pty-collapsed]) { padding-block-start:4px; padding-block-end:calc(4px + var(--input-safe-bottom) + var(--keyboard-offset, 0px)); }
@media (pointer:coarse) { .input-composer[data-pty-input-mode][data-pty-collapsed] .pty-dock-toggle.ant-btn { height:36px; min-height:36px; } }
.pty-extra-keys-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:4px; min-width:200px; }
.pty-extra-keys-grid .ant-btn { min-height:44px; }
.pty-input-mode-label { display:grid; }
.pty-draft-dot { width:4px; height:4px; border-radius:50%; background:currentColor; }
.pty-input-mode-label > span { display:flex; align-items:center; justify-content:center; gap:4px; grid-area:1 / 1; opacity:0; white-space:nowrap; transition:opacity var(--motion-morph) var(--ease-in-out-smooth); }
.pty-input-mode-label > span[data-active="true"] { opacity:1; }
.conversation-root .conversation-input-wrap[data-composer-expanded] .conversation-sender.ant-sender { padding:12px 12px 8px; }
.conversation-root .conversation-input-wrap[data-composer-expanded="false"] .ant-sender-content { height:0; min-height:0; overflow:hidden; opacity:0; pointer-events:none; }
.conversation-input-wrap[data-composer-expanded="false"] :is(.ant-sender-header,.composer-edit-action,.conversation-config-trigger) { display:none; }
.conversation-input-wrap[data-composer-expanded="false"] .ant-sender-footer { padding-top:0; }
.conversation-input-wrap[data-composer-expanded="true"] .composer-compact-entry { display:none; }
.conversation-composer:has([data-composer-expanded="false"]) > .conversation-input-hint { display:none; }
.conversation-root .conversation-action-row > .ant-flex { flex-wrap:nowrap; }
.conversation-runtime-summary > .ant-typography { min-width:0; }
.conversation-runtime-summary > .conversation-thinking-summary { flex:none; }
@media (pointer:coarse) { .conversation-composer > .conversation-input-hint { display:none; } }
@media (pointer:coarse) { .conversation-root .conversation-input-wrap[data-composer-expanded] .composer-expand-editor.ant-btn { min-height:44px; } }
@media (max-width:640px) {
  .composer-config-controls-runtime > [data-mode-control-pill="tool"] { display:none; }
  .input-composer[data-pty-input-mode] .composer-surface { --composer-control-height:44px; }
  .input-composer[data-pty-input-mode] .wand-composer-rail-submit { width:var(--composer-control-height); min-width:var(--composer-control-height); padding-inline:0; }
  .input-composer[data-pty-input-mode] .wand-composer-rail-submit > span { display:none; }
  .input-composer[data-composer-expanded="true"] .composer-actions-right { max-width:100%; }
  .conversation-input-wrap[data-composer-expanded="true"] .conversation-config-trigger { max-width:96px; overflow:hidden; }
}
@media (max-width:400px) {
  /* Keep the dock's collapse hit target out of the Ctrl/Shift targets. */
  .input-composer[data-pty-input-mode]:not([data-pty-collapsed]) .pty-modifier-buttons { grid-row:3; grid-column:1 / -1; justify-content:center; }
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
.composer-config-controls:not(.composer-config-controls-runtime) [data-mode-control-pill="model"] { min-width:120px; }
.composer-config-controls:not(.composer-config-controls-runtime) [data-mode-control-pill="thinking"] { min-width:68px; }
.composer-settings-scope { margin:0 0 8px; font-size:11px; line-height:1.5; color:var(--text-secondary); }
.conversation-root .wand-chat-message-content { font-size:14px; border-radius:var(--control-radius); }
.conversation-root .conversation-composer-control:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@media (pointer:coarse) {
  .composer-surface, .wand-composer-surface, .conversation-input-wrap { --composer-control-height:44px; }
  .conversation-work-choice .ant-btn, .conversation-heading > .ant-btn, .conversation-session-actions .ant-btn, .conversation-session-state > .ant-btn { min-height:44px; height:auto; }
}
@media (max-width:640px) {
  .conversation-root .conversation-action-row .conversation-input-hint { display:none; }
}
`);
}
