import { installStyleSheet } from "../styles";

let chatSurfaceInstalled = false;

export function installChatSurfaceStyles(): void {
  if (chatSurfaceInstalled) return;
  chatSurfaceInstalled = true;
  installStyleSheet("wand-chat-library-layout", CHAT_SURFACE_STYLES);
}

const CHAT_SURFACE_STYLES = String.raw`
    .wand-chat-message { display:flex; gap:8px; min-width:0; max-width:100%; color:var(--text-primary); font-size:var(--font-size-sm); line-height:1.5; }
    .wand-chat-message[data-chat-role="user"] { flex-direction:row-reverse; }
    .wand-chat-message-avatar { flex:none; }
    .wand-chat-message-body { display:flex; flex-direction:column; gap:4px; min-width:0; max-width:100%; width:100%; }
    .wand-chat-message[data-chat-role="user"] > .wand-chat-message-body { width:auto; margin-inline-start:auto; }
    .wand-chat-message-header, .wand-chat-message-footer { font-size:var(--font-size-xs); color:var(--text-secondary); }
    .wand-chat-message-content { min-width:0; overflow-wrap:anywhere; }
    :where(.wand-chat-message[data-chat-role="user"]) > :where(.wand-chat-message-body) > .wand-chat-message-content,
    :where(.wand-chat-message[data-chat-surface="preview"]) > :where(.wand-chat-message-body) > .wand-chat-message-content { padding:8px 12px; background:var(--bg-secondary); border-radius:16px; }
    :where(.wand-chat-message[data-chat-surface="document"]) > :where(.wand-chat-message-body) > .wand-chat-message-content { padding:12px 16px; border:1px solid var(--border-subtle); border-radius:var(--radius-lg); background:var(--bg-surface); }
    .chat-disclosure-trigger { display:flex; align-items:center; gap:8px; width:100%; min-width:0; box-sizing:border-box; border:0; border-radius:var(--radius-md); background:transparent; color:inherit; font:inherit; cursor:pointer; }
    .chat-disclosure-trigger:hover { background:var(--bg-hover); }
    .chat-disclosure-trigger:active { background:var(--bg-active); }
    .chat-disclosure-trigger:focus-visible { outline:2px solid var(--border-focus); outline-offset:2px; }
    .chat-thinking-content { padding:4px 0 14px 28px; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--text-secondary); font-size:var(--font-size-sm); line-height:1.75; }
    .team-chat-live-output .chat-process-summary { min-height:44px; }
    .team-chat-live-summary-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:start; }
    .chat-thinking-label { flex:1; text-align:start; }
    .chat-thinking-status { font-size:var(--font-size-xs); color:var(--text-secondary); }

    .chat-message[data-x-presentation="bubble"], .chat-activity[data-x-presentation] { display:block; width:100%; min-width:0; padding:0; }
    .chat-message.assistant-reply-collapsed > :not(.assistant-reply-host) { display:none; }
    .chat-message-text, .chat-activity-thinking-content { white-space:pre-wrap; overflow-wrap:anywhere; }
    .chat-process-summary.chat-disclosure-trigger { height:auto; min-height:36px; padding:6px 0; border-radius:0; border-bottom:1px solid var(--border-subtle); background:transparent; text-align:left; justify-content:flex-start; white-space:normal; color:var(--text-secondary); font-size:var(--font-size-xs); }
    .chat-process-summary.chat-disclosure-trigger > div { flex:1; min-width:0; }
    .chat-process-summary:not(button) { display:inline-flex; align-items:center; gap:6px; min-width:0; }
    /* One semantic activity icon; only live work receives a restrained pulse. */
    .chat-process-summary-dot { flex:0 0 14px; width:14px; height:14px; display:inline-flex; align-items:center; justify-content:center; color:var(--text-secondary); }
    .chat-activity[data-live="true"] .chat-process-summary-dot,
    .chat-activity.is-command-running .chat-process-summary-dot,
    .chat-activity.is-thinking-running .chat-process-summary-dot { color:var(--accent); }
    .chat-activity[data-live="true"] .chat-process-summary-dot,
    .chat-activity.is-command-running .chat-process-summary-dot,
    .chat-activity.is-thinking-running .chat-process-summary-dot { animation:wand-activity-mark-flow var(--motion-spin) var(--ease-in-out-smooth) infinite; }
    /* Android: 呼吸是 1600ms 单程 + Reverse（3.2s 一周）；这里沿用 Web 既有的持续周期 token。 */
    @keyframes wand-activity-mark-flow { 0%, 100% { opacity:.3; } 50% { opacity:1; } }
    .chat-activity-meta { display:inline-flex; flex-wrap:wrap; align-items:baseline; gap:6px; }
    .chat-activity-command-time { color:var(--text-secondary); font-variant-numeric:tabular-nums; }
    .chat-activity-error { color:color-mix(in srgb,var(--ant-color-error-text-active,var(--danger)) 80%,var(--text-primary)); }
    .chat-activity-menu { display:block; opacity:1; pointer-events:auto; }
    .chat-activity-menu-inner { overflow:visible; }
    /* Android：摘要下方按内容长高，最多占聊天视口的 1/3（120–240px），内部滚动。 */
    .chat-activity-timeline { max-height:var(--chat-activity-panel-height,240px); box-sizing:border-box; overflow:auto; overscroll-behavior:contain; overflow-anchor:none; scrollbar-gutter:stable; padding:4px; }
    .wand-chat-entry { display:flex; align-items:flex-start; gap:8px; min-width:0; }
    .wand-chat-entry-body { flex:1; min-width:0; }
    .chat-call-detail { min-width:0; overflow-wrap:anywhere; }
    .chat-call { position:relative; padding:2px 0; }
    .chat-call-mark { display:inline-flex; align-items:center; justify-content:center; flex:0 0 20px; width:20px; height:22px; color:var(--text-secondary); }
    .chat-call[data-status="error"] .chat-call-mark { color:var(--danger); }
    .chat-call[data-status="running"] .chat-call-mark { color:var(--accent); }
    .chat-call[data-status="pending"] .chat-call-mark { color:var(--warning); }
    /* 行高按内容档位固定：调用行留出「标签 + 输入 + 结果」三行，思考轮次单行紧凑
       （对齐 Android 的 ACTIVITY_CALL_ROW_MIN_HEIGHT / ACTIVITY_THINKING_ROW_MIN_HEIGHT）。 */
    .chat-call-button.chat-disclosure-trigger { height:auto; min-height:44px; padding:7px 6px; text-align:left; justify-content:flex-start; align-items:flex-start; white-space:normal; gap:8px; transition:background-color var(--motion-fast) var(--ease-in-out-smooth); }
    .chat-call[data-thinking-entry] .chat-call-button.chat-disclosure-trigger { min-height:36px; }
    .chat-call[data-thinking-entry] .chat-call-label { font-size:var(--font-size-xs); color:var(--text-secondary); }
    /* 行高亮：运行中与已展开用品牌色 5%，失败行用危险色 5%（对齐 Android activityEntryHighlight）。 */
    .chat-call[data-status="running"] .chat-call-button { background:color-mix(in srgb,var(--accent) 3%,transparent); }
    .chat-call[data-status="error"] .chat-call-label { color:var(--danger); }
    .chat-call-copy { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
    .chat-call-line { display:flex; align-items:baseline; gap:6px; min-width:0; line-height:18px; }
    .chat-call-time, .chat-call-preview, .chat-call-result { font-family:var(--font-mono); font-size:var(--font-size-2xs); line-height:16px; color:var(--text-muted); }
    .chat-call-label, .chat-call-preview, .chat-call-result { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .chat-call-label { white-space:normal; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
    .chat-call-meta { display:flex; align-items:center; gap:10px; font-size:var(--font-size-2xs); color:var(--text-secondary); line-height:16px; }
    .chat-call-line .chat-call-label { flex:1; min-width:0; }
    .chat-call-label { font-size:var(--font-size-sm); font-weight:var(--font-weight-medium); color:var(--text-primary); }
    .chat-call-state { flex:none; font-size:var(--font-size-2xs); color:var(--text-muted); }
    .chat-call-state[data-status="running"] { color:var(--accent); }
    .chat-call-state[data-status="pending"] { color:var(--warning); }
    .chat-call-state[data-status="error"] { color:var(--danger); }
    .chat-call-state[data-status="complete"] { color:var(--text-secondary); }
    .chat-call[data-status="running"] .chat-call-label, .chat-call[data-expanded="true"] .chat-call-label { color:var(--text-primary); }
    .chat-call-result[data-error] { color:var(--danger); }
    .chat-call[data-thinking-entry] .chat-call-preview, .chat-call[data-thinking-entry] .chat-call-result { white-space:normal; -webkit-line-clamp:2; -webkit-box-orient:vertical; display:-webkit-box; }
    .chat-disclosure-chevron { display:inline-flex; flex-shrink:0; margin-inline-start:auto; transition:transform var(--motion-normal) var(--ease-out-expo); }
    .chat-disclosure-chevron[data-expanded="true"] { transform:rotate(180deg); }
    .chat-disclosure-body { display:grid; grid-template-rows:0fr; opacity:0; transition:grid-template-rows var(--motion-normal) var(--ease-out-expo),opacity var(--motion-fast) var(--ease-in-out-smooth); }
    .chat-disclosure-body[data-expanded="true"] { grid-template-rows:1fr; opacity:1; }
    .chat-disclosure-body > div { min-height:0; overflow:hidden; }
    .chat-disclosure-body .chat-tool-body, .chat-disclosure-body .diff-body { padding:12px; }
    .chat-activity-detail-content { padding:8px 4px 12px; }
    .chat-activity-detail-section h4 { margin:0 0 6px; font-size:var(--font-size-xs); color:var(--text-secondary); font-weight:500; }
    .chat-activity-detail-section pre, .tool-use-content, .tool-use-result-content { white-space:pre-wrap; overflow-wrap:anywhere; font-family:var(--font-mono); max-height:320px; overflow:auto; font-size:var(--font-size-xs); }
    .chat-activity-thinking-content { padding:2px 0 12px 28px; color:var(--text-secondary); font-size:var(--font-size-sm); line-height:1.75; white-space:normal; }
    :is(.chat-activity-thinking-content, .chat-thinking-content) p { margin:0 0 10px; }
    :is(.chat-activity-thinking-content, .chat-thinking-content) p:last-child { margin-bottom:0; }
    .agent-run-body[aria-hidden="true"] { display:none; }
    /* 内联工具图片（Read 读图 / 工具结果截图）：图片拿到真实尺寸前是 0×0，所以加载期间由占位行
       给出反馈，加载完收掉、失败整块隐藏（对齐 Android WandAsyncToolImage 的 onError 不渲染）。
       图片是本地文件或内联 base64，没有可信的字节进度，转圈只表示「正在取图」。 */
    .inline-tool-image { display:block; min-width:0; margin:8px 0; }
    .inline-tool-image[data-image-state="error"] { display:none; }
    .inline-tool-image-loading { display:inline-flex; align-items:center; gap:8px; padding:8px 12px; border:1px dashed var(--border-subtle); border-radius:var(--radius-md); color:var(--text-secondary); font-size:var(--font-size-2xs); }
    .inline-tool-image-spinner { width:12px; height:12px; border-radius:50%; border:2px solid color-mix(in srgb,currentColor 22%,transparent); border-top-color:currentColor; animation:wand-tool-icon-spin var(--motion-spin) linear infinite; }
    .inline-tool-image[data-image-state="ready"] .inline-tool-image-loading { display:none; }
    .inline-tool-image-thumb { max-width:100%; max-height:320px; object-fit:contain; object-position:left center; cursor:pointer; }
    .inline-tool-image-thumb:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    .chat-tool-card, .inline-terminal, .inline-diff, .agent-run { width:100%; min-width:0; }
    .chat-tool-trigger.ant-btn { height:40px; min-width:0; justify-content:flex-start; text-align:left; gap:8px; padding:6px 8px; }
    /* Android ToolCard 头部：34dp 状态图标槽 + 标题/摘要两行 + 箭头，去掉右侧状态字样。 */
    .chat-tool-trigger-card.ant-btn { height:auto; min-height:54px; padding:10px 12px; gap:10px; align-items:center; }
    .chat-tool-icon-slot { position:relative; flex:none; width:34px; height:34px; border-radius:9px; display:grid; place-items:center; background:color-mix(in srgb,var(--text-muted) 11%,transparent); color:var(--text-secondary); transition:background-color var(--motion-fast) var(--ease-in-out-smooth), color var(--motion-fast) var(--ease-in-out-smooth); }
    .chat-tool-icon-slot[data-status="running"] { background:color-mix(in srgb,var(--accent) 11%,transparent); color:var(--accent); }
    .chat-tool-icon-slot[data-status="success"] { background:color-mix(in srgb,var(--success) 11%,transparent); color:var(--success); }
    .chat-tool-icon-slot[data-status="error"] { background:color-mix(in srgb,var(--danger) 11%,transparent); color:var(--danger); }
    .chat-tool-icon-progress, .chat-tool-icon-glyph { position:absolute; inset:0; display:grid; place-items:center; transition:opacity var(--motion-morph) var(--ease-out-expo), transform var(--motion-morph) var(--ease-out-expo); }
    .chat-tool-icon-progress { opacity:0; transform:rotate(90deg) scale(.78); }
    .chat-tool-icon-progress::before { content:""; box-sizing:border-box; width:16px; height:16px; border-radius:50%; border:2px solid color-mix(in srgb,currentColor 22%,transparent); border-top-color:currentColor; }
    /* 运行态：进度环淡入并转响，工具图标旋转缩小淡出；结果到达后沿同一曲线倒放（同一个实例）。 */
    .chat-tool-icon-slot[data-status="running"] .chat-tool-icon-progress { opacity:1; transform:none; }
    .chat-tool-icon-slot[data-status="running"] .chat-tool-icon-progress::before { animation:wand-tool-icon-spin var(--motion-spin) linear infinite; }
    .chat-tool-icon-slot[data-status="running"] .chat-tool-icon-glyph { opacity:0; transform:rotate(90deg) scale(.78); }
    @keyframes wand-tool-icon-spin { to { transform:rotate(360deg); } }
    .chat-tool-head { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; text-align:start; }
    .chat-tool-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .chat-tool-summary { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; font-family:var(--font-mono); font-size:var(--font-size-2xs); line-height:1.4; color:var(--text-secondary); }
    .chat-tool-subtitle { flex:1; min-width:0; text-align:left; font-size:var(--font-size-xs); }
    .chat-tool-error-preview { padding-inline:8px; font-size:var(--font-size-xs); }
    .decision-result-load { width:12em; max-width:100%; }
    .decision-tool-card[data-decision-result-window="true"] .tool-use-result-content { height:160px; overflow:auto; }
    .chat-tool-surface { border-bottom:1px solid var(--border-subtle); }
    /* Android 工具卡是一张 14dp 圆角的描边卡，不是只有一条分隔线的裸行。 */
    .chat-tool-surface.chat-tool-card-surface { border:1px solid var(--border-subtle); border-radius:var(--radius-lg); background:var(--bg-surface); overflow:hidden; }
    .ant-btn.agent-run-summary, .ant-btn.agent-run-agent { height:auto; text-align:left; white-space:normal; }
    /* 头部（时间 + 署名）与正文都占满整行；正文不再压成窄阅读栏。 */
    .assistant-reply-host { font-size:var(--font-size-sm); width:100%; min-width:0; }
    /* Metadata shares one compact row; full time/duration stays available on the clock. */
    .assistant-reply-head { display:flex; flex-direction:column; gap:6px; width:100%; min-width:0; }
    .chat-message-time { display:inline-flex; align-items:center; gap:8px; padding:2px 8px; font-family:var(--font-mono); font-size:var(--font-size-2xs); font-weight:var(--font-weight-medium); color:var(--text-secondary); font-variant-numeric:tabular-nums; }
    .chat-message.user .wand-chat-message-header { display:flex; justify-content:flex-end; }
    .assistant-reply-disclosure.ant-btn { height:auto; min-height:44px; padding:5px 8px; border-radius:var(--radius-md); justify-content:flex-start; gap:8px; text-align:left; color:var(--text-primary); }
    /* 收起态用弱底色交代「这里折起来了」，展开态回到透明标题行（对齐 Android AssistantReplyHeader）。 */
    .chat-message.assistant-reply-collapsed .assistant-reply-disclosure.ant-btn { background:color-mix(in srgb,var(--bg-secondary) 58%,transparent); }
    .assistant-author { display:inline-flex; align-items:center; gap:8px; flex:0 1 auto; min-width:0; }
    .assistant-author-name { font-size:var(--font-size-xs); font-weight:var(--font-weight-semibold); color:var(--text-primary); max-width:16em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .assistant-author-preview { flex:1; min-width:0; font-size:var(--font-size-2xs); font-weight:400; color:var(--text-secondary); text-align:start; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .assistant-author-space { flex:1; min-width:0; }
    .assistant-reply-action { flex:none; font-size:var(--font-size-2xs); font-weight:var(--font-weight-semibold); color:var(--text-primary); }
    @media (pointer:coarse) {
      .chat-message-time { padding-inline:0; }
    }
    .agent-run-surface .ant-card-head { min-height:0; padding:0; }
    .agent-run-surface .ant-card-head-title { padding:0; }
    .agent-run-summary.ant-btn { padding:10px 12px; gap:8px; align-items:flex-start; border-radius:var(--radius-md); }
    .agent-run-summary > .ant-badge { padding-block-start:3px; }
    .agent-run-summary-copy { display:flex; flex-direction:column; gap:4px; flex:1; min-width:0; }
    .agent-run-summary-line { display:flex; align-items:baseline; gap:8px; min-width:0; }
    .agent-run-title { flex:1; min-width:0; overflow-wrap:anywhere; font-size:var(--font-size-xs); font-weight:500; }
    .agent-run-status-label, .agent-run-agent-status { flex:none; font-size:var(--font-size-xs); }
    .agent-run-context { display:flex; gap:8px; flex-wrap:wrap; font-size:var(--font-size-2xs); font-weight:400; color:var(--text-secondary); }
    .agent-run-latest { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--font-size-xs); font-weight:400; }
    .agent-run-summary .chat-disclosure-chevron { padding-block-start:3px; }
    .agent-run-agent.ant-btn { padding:6px 8px; gap:8px; align-items:center; }
    .agent-run-agent.is-selected { background:var(--bg-secondary); }
    .agent-run-agent-copy { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; text-align:start; }
    .agent-run-agent-name { font-size:var(--font-size-xs); overflow-wrap:anywhere; }
    .agent-run-agent-type, .agent-run-output-label { font-size:var(--font-size-2xs); color:var(--text-secondary); }
    .agent-run-detail-task { min-width:0; overflow-wrap:anywhere; font-size:var(--font-size-xs); }
    .agent-run-output { min-width:0; overflow-wrap:anywhere; }
    .agent-run-process .ant-collapse-header { padding:6px 0 !important; color:var(--text-secondary); font-size:var(--font-size-xs); }
    .agent-run-process .ant-collapse-content-box { padding-inline:0 !important; }
    .agent-run-receipt-row { display:flex; flex-wrap:wrap; gap:4px 8px; font-size:var(--font-size-xs); }
    .agent-run-receipt-row code { overflow-wrap:anywhere; }
    /* 自己的发言：品牌色 13% 拼接底 + 品牌色 24% 描边 + 右下小圆角尾巴（对齐 Android UserBubble）。 */
    .chat-message.user .wand-chat-message-content { padding:8px 13px; /* 15px/21px：与 Android UserBubble 同一档正文 */ border-radius:20px 20px 6px 20px; border:1px solid color-mix(in srgb,var(--accent) 24%,transparent); background:color-mix(in srgb,var(--accent) 13%,var(--bg-surface)); font-size:15px; line-height:21px; }
    .chat-resource-selection { font-size:var(--font-size-xs); overflow-wrap:anywhere; }
    .chat-process-summary.chat-disclosure-trigger, .chat-activity-command-time, .chat-call-time, .chat-tool-subtitle.ant-typography, .chat-resource-selection { color:color-mix(in srgb,var(--text-secondary) 88%,var(--text-primary)); }
    @media (max-width:640px) { .chat-tool-trigger.ant-btn { min-height:44px; } }
    /* reduce-motion：不流动、不旋转，只保留状态色，和 Android WandStatusIconSlot / ToolActivityMark 一致。 */
    @media (prefers-reduced-motion:reduce) { .chat-disclosure-body, .chat-disclosure-chevron { transition:none; } .inline-tool-image-spinner { animation:none; } .chat-tool-icon-progress, .chat-tool-icon-glyph, .chat-call-button.chat-disclosure-trigger { transition:none; }
      .chat-activity[data-live="true"] .chat-process-summary-dot,
      .chat-activity.is-command-running .chat-process-summary-dot,
      .chat-activity.is-thinking-running .chat-process-summary-dot { animation:none; }
      .chat-tool-icon-slot[data-status="running"] .chat-tool-icon-progress { opacity:0; }
      .chat-tool-icon-slot[data-status="running"] .chat-tool-icon-progress::before { animation:none; }
      .chat-tool-icon-slot[data-status="running"] .chat-tool-icon-glyph { opacity:1; transform:none; } }
    .agent-run-detail, .agent-run-agent-body { display:grid; gap:12px; }
    .agent-run-body-inner { display:grid; gap:12px; }
    .ask-user-options { display:grid; gap:8px; }
    .diff-columns { display:flex; overflow:auto; }
    .diff-col { flex:1; min-width:0; white-space:pre-wrap; font-family:monospace; }
    .diff-remove { color:var(--danger); } .diff-add { color:var(--success); }
    .term-output { white-space:pre-wrap; overflow-wrap:anywhere; font-family:monospace; }
    .chat-messages img { max-width:100%; height:auto; }
    [data-composer-sender] { width:100%; min-width:0; }
    /* IM 层的转录（conversations/activity.tsx）直接铺在消息气泡里：与详情层共用同一批
       .chat-call / .chat-process-summary / .chat-tool-* 规则，只少一层有界内滚动与缩进。 */
    .chat-activity-inline { display:flex; flex-direction:column; gap:2px; }
    .chat-activity-rows { display:flex; flex-direction:column; gap:2px; padding-block:8px; }
    .conversation-tool-activity[data-status="pending"] .chat-call-state { color:var(--warning); }
    .conversation-tool-activity[data-status="error"] .chat-call-state { color:var(--danger); }
    .conversation-tool-activity[data-status="complete"] .chat-call-state { color:var(--text-secondary); }
    .chat-call-inline { display:flex; align-items:flex-start; gap:8px; }
    .chat-process-summary-plain { display:flex; align-items:center; gap:6px; width:100%; min-width:0; padding:6px 0; border:0; background:transparent; text-align:left; font:inherit; color:color-mix(in srgb,var(--text-secondary) 88%,var(--text-primary)); font-size:var(--font-size-xs); cursor:pointer; }
    .chat-call-button-plain { display:flex; align-items:flex-start; gap:8px; width:100%; min-width:0; padding:6px 4px; border:0; border-radius:var(--radius-md); background:transparent; text-align:left; font:inherit; color:inherit; cursor:pointer; }
    .chat-call-inline .chat-call-copy { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
    .chat-call-inline .chat-disclosure-chevron { margin-inline-start:auto; }
    .chat-call-inline .chat-disclosure-body { flex-basis:100%; }
  `;
