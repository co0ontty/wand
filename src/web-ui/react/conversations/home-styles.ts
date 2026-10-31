import { installStyleSheet } from "../styles";

/** Approved conversation surface; shared controls and all five themes retain ownership. */
export function installConversationHomeStyles(): void {
  installStyleSheet("wand-conversation-home", String.raw`
.conversation-root { --conversation-inset:clamp(16px,3vw,48px); background:var(--bg-primary); }
.conversation-root .conversation-heading { padding:20px var(--conversation-inset) 16px; border:0; }
/* 标题行头像位始终占位：会话详情到达前是占位块，到达后换成同一个 48px 头像。
   不占位时标题会先向右 56px、加载完再弹回，标题与发送按钮会跟着量尺寸。 */
.conversation-root .conversation-heading-copy { min-width:0; }
.conversation-root .conversation-heading-avatar-slot { width:48px; height:48px; flex:none; display:grid; place-items:center; }
/* 固定行高：回退字体到页面字体切换时，normal 行盒会从 28px 长到 33.4px，
   标题下的上下文和整块阅读区会一起下移（实测 5.42px）。 */
.conversation-root .conversation-heading-title { height:auto; min-height:28px; font-size:20px; line-height:1.5; font-weight:600; max-width:100%; }
/* 标题恒为单行：占位文案「选择一位员工，开始聊天」与真实标题长度不同，
   窄屏下换行与否不同会让标题行高度在详情到达时变化 20px（移动端 CLS 0.024）。 */
.conversation-root .conversation-heading-title-text { display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* antd 按钮默认 transition:all，把字号/内边距也算进过渡。本页样式由按需块安装，
   比首次渲染晚一帧生效，于是标题 16→20px、发送按钮 padding 0→12px 会真的「播放」
   240ms，整块阅读区与按钮跟着抖（弱网冷加载实测 0.0088）。几何只能瞬时到位，
   过渡只留给颜色、背景、边框与阴影。 */
.conversation-root .conversation-heading-title,
.conversation-root .conversation-submit-labelled.ant-btn,
.conversation-root .conversation-config-trigger.ant-btn {
  transition-property: color, background-color, border-color, box-shadow, opacity;
}
.conversation-root .conversation-heading-context { margin-block-start:2px; font-size:13px; }
/* 副标题同样恒为单行：占位文案与真实文案长度不同，窄屏下换行与否不同
   会让标题区高度在详情到达时变化 20px（移动端 CLS 0.018）。 */
.conversation-root .conversation-heading-context { display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.conversation-root .conversation-message-scroll { --conversation-scroll-pad-top:20px; position:relative; padding-block:var(--conversation-scroll-pad-top) 28px; }
.conversation-root .conversation-message-scroll > * { padding-inline:var(--conversation-inset); }
/* Keep the projection slot at the reading viewport height while the lazy message
   renderer or a newly selected conversation is mounting. Without this reservation
   the slot briefly collapses to 0 and moves the composer/heading. */
/* 投影槽在首帧就占满阅读视口：它之前会先按内容高度（甚至 0）出现，等消息列
   到位后再长到视口高度，于是滚动区、输入区和发送按钮各被重排一次（实测 0.032）。 */
.conversation-root .conversation-message-scroll > .sidebar-projection-swap { display:flex; flex:1 0 auto; flex-direction:column; min-height:100%; }
.conversation-root .conversation-message-scroll > .sidebar-projection-swap > .sidebar-projection-current { display:flex; flex:1 1 auto; flex-direction:column; min-height:0; }
/* 空态提示只在真的没有消息时出现；它一出现/消失会把整列上下推一次。
   它自身不参与阅读列的布局（绝对定位在阅读区起点），所以提示消失、真实消息到位时
   投影槽仍在同一位置——之前它是流内元素，撤掉时投影槽整体上移 70px（实测 0.0266）。
   读取失败时提示排在错误信息之后（:first-child 不成立），保持流内，避免盖住错误。 */
.conversation-root .conversation-message-scroll > .conversation-empty { overflow-anchor:none; margin-block:0; }
.conversation-root .conversation-message-scroll > .conversation-empty:first-child { position:absolute; inset-block-start:var(--conversation-scroll-pad-top); inset-inline:0; }
.conversation-root .team-chat-stream { gap:20px; }
/* 历史窗口的入口：首屏只挂最新一页，读者靠近顶部时才补更早的回合。 */
.conversation-history-more { display:flex; justify-content:center; padding-block:2px; }
.conversation-history-more .ant-btn { color:var(--text-secondary); font-size:var(--font-size-xs); }
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
.conversation-root .conversation-input-wrap { margin-block-start:0; }
.conversation-runtime-summary[hidden] { display:none; }
.conversation-directory-trigger.ant-btn { flex:0 1 160px; min-width:0; height:24px; min-height:24px; padding-inline:4px; font-size:var(--font-size-xs); color:var(--text-secondary); }
.conversation-directory-trigger > span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.conversation-directory-trigger svg { flex:none; }
.conversation-directory-picker { width:min(340px,calc(100vw - 48px)); max-height:60dvh; overflow:auto; }
.conversation-directory-picker .ant-typography { font-size:var(--font-size-xs); }
.conversation-root .conversation-action-row { gap:8px; }
.conversation-root .conversation-action-row > .ant-flex { min-width:0; flex-wrap:nowrap; }
.conversation-root .conversation-submit-labelled.ant-btn { width:var(--composer-control-height); min-width:var(--composer-control-height); padding:0; gap:0; }
/* 所有可能文案叠在同一格：按钮宽度取最长标签，加载/发送/停止状态切换不再改变几何。 */
.conversation-submit-labels { display:inline-grid; }
.conversation-submit-label { grid-area:1 / 1; font-size:12px; }
.conversation-submit-label:not([data-active]) { visibility:hidden; }
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
  .conversation-root .conversation-message-scroll { --conversation-scroll-pad-top:12px; padding-block:var(--conversation-scroll-pad-top) 20px; }
  .conversation-root .conversation-sender.ant-sender { padding:12px 10px 8px; border-radius:12px; }
  .conversation-root .conversation-submit-label { display:none; }
  .conversation-root .conversation-submit-labelled.ant-btn { padding-inline:0; width:var(--composer-control-height); }
  .conversation-root .conversation-input-hint { display:none; }
  .conversation-directory-trigger.ant-btn { flex:0 1 auto; max-width:160px; }
}
`);
}
