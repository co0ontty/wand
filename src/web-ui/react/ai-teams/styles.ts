// 团队页与任务运行面板的样式，只打进按需加载的 ai-teams 脚本（见 ai-teams/chunk-entry.ts）。
// 公用头像由 Ant Avatar/Badge 渲染；这里只保留按需页的业务布局。
export const aiTeamsChunkStyles = String.raw`

/* ---------- 团队页：左列表、右详情 ---------- */
.wand-teams-layout {
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  flex: 1 1 auto;
  min-height: 0;
  border-top: 1px solid var(--border-subtle);
}
.wand-teams-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 14px 14px 18px 28px;
  overflow-y: auto;
  border-right: 1px solid var(--border-subtle);
}
.wand-teams-card[aria-pressed="true"] { border-color: var(--accent); }
.wand-teams-empty.is-detail { align-content: center; height: 100%; }

.wand-teams-detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  min-height: 0;
  padding: 18px 28px 32px;
  overflow-y: auto;
  animation: wand-settings-fade-in var(--transition-normal);
}
.wand-teams-detail > * { flex: 0 0 auto; width: 100%; max-width: 920px; }
.wand-teams-create-icon { transition: transform var(--transition-normal); }
.task-board-create-button[aria-pressed="true"] .wand-teams-create-icon { transform: rotate(45deg); }

.wand-teams-template-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
/* ---------- 团队编辑：成员组织图 + 协作设置 ---------- */
.wand-team-org { display: grid; gap: 22px; }
.wand-team-org-leader { position: relative; display: grid; justify-items: center; }
.wand-team-org-leader > .wand-team-member { width: min(100%, 420px); }
.wand-team-org-leader::after {
  content: "";
  position: absolute;
  top: 100%;
  left: 50%;
  width: 1px;
  height: 22px;
  background: var(--border-default);
}
.wand-team-org-members {
  position: relative;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  align-items: start;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--border-default);
}
/* 成员卡壳归通用卡片；下面两条只表达「负责人」与「展开中」两个业务状态。 */
.wand-team-member { min-width: 0; }
.wand-team-member[data-leader] { border-color: color-mix(in srgb, var(--warning) 45%, var(--border-subtle)); }
.wand-team-member[data-open] { grid-column: 1 / -1; border-color: var(--border-default); }
.wand-team-employee-invite { min-width: 0; }
.wand-team-employee-invite-inner { min-width: 0; min-height: 0; overflow: hidden; }
/* 选择器铺满所在字段：宽度约束属于业务布局。 */
.wand-team-select,
.wand-team-select .wand-ui-select-trigger { width: 100%; }
.wand-ai-team-duty { min-height: 58px; resize: none; }
.wand-ai-team-editor-footer .wand-settings-save-bar { flex: 1 1 auto; }

/* ---------- 新建员工：默认只填期望，手动字段收进高级配置 ---------- */
/* 创建 / 生成中标签长度不同，固定最小宽度保证提交按钮原地不位移。 */
.wand-employee-create-submit,
.wand-employee-save-submit { min-inline-size: 92px; }



.task-board-team-chat { display: grid; gap: 8px; }

/* 「主任务」：钉在群聊最上面的公告位，滚动时不动。 */
/* 主任务公告位：卡片壳与标题行归通用卡片，只保留这处公告的左侧强调边。 */
.team-chat-goal { border-left: 3px solid var(--accent); }
.task-board-team-chat-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 360px;
  padding: 4px 2px;
  overflow-y: auto;
  overscroll-behavior-y: contain;
}
.task-board-team-chat .team-chat-time-marker {
  align-self: center;
  margin: 6px 0 0;
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  line-height: var(--line-height-base);
}
.task-board-team-chat .chat-notice .team-chat-mention {
  display: inline;
  max-width: none;
  padding: 0;
  border-radius: 0;
  color: var(--accent);
  background: transparent;
  font-weight: inherit;
  white-space: inherit;
  overflow: visible;
}

/* ---------- 消息行（IM）：头像 + 署名行 + 气泡 / 全宽文档卡 ---------- */
/* 每条发言都看得出是谁说的：头像与名字在内容列外侧，自己的发言整行镜像靠右。 */
.task-board-team-chat .team-chat-msg {
  flex-direction: row;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  max-width: 100%;
}
/* 普通会话的消息行 hover 会上浮 1px；群聊这一行承载的是头像，一律不位移。 */
.task-board-team-chat .team-chat-msg:hover { transform: none; }
.task-board-team-chat .team-chat-msg[data-side="end"] { flex-direction: row-reverse; }
.task-board-team-chat .team-chat-msg-content {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}
.task-board-team-chat .team-chat-msg[data-side="end"] .team-chat-msg-content { align-items: flex-end; }
/* 短发言的气泡不到 560px；文档卡全宽铺开。 */
.task-board-team-chat .team-chat-msg[data-shape="bubble"] .team-chat-msg-content { max-width: min(100%, 560px); }
.task-board-team-chat .team-chat-msg[data-shape="document"] .team-chat-msg-content { max-width: 100%; }
/* 行距统一 12（设计 v2.5-A3）：普通会话的 .chat-message 自带 margin: 4px 0，
   叠上列表 gap: 12px 就是 20px，这里只把消息行自身的外边距清零。 */
.task-board-team-chat .chat-message.team-chat-msg { margin: 0; }
.task-board-team-chat .team-chat-msg-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
/* 署名行名字 12px/600（设计 v2.5-A1）；只覆盖群聊作用域，不动 content/styles.css 的共享 .avatar-name。 */
.task-board-team-chat .team-chat-msg-head .avatar-name {
  max-width: 160px;
  overflow: hidden;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 不可点的名字用正文色（设计 v2.5-A2）：只有 <button class="chat-author-link"> 才是动作色。 */
.task-board-team-chat .team-chat-msg-head span.avatar-name { color: var(--text-primary); }
.task-board-team-chat .team-chat-msg-head .chat-message-time { padding: 0; font-size: var(--font-size-2xs); }
/* @ 流转 token：动作色/软底均取主题真值，原文不改；正文用 CSS 24ch 视觉省略，
   Portal 全文层解除省略以便读/复制完整姓名（R2.4）。 */
.task-board-team-chat .team-chat-mention,
.team-chat-doc-layer .team-chat-mention {
  display: inline-block;
  max-width: min(24ch, 100%);
  overflow: hidden;
  padding: 0 4px;
  border-radius: var(--radius-xs);
  color: var(--accent);
  background: var(--accent-muted);
  font-weight: var(--font-weight-medium);
  text-overflow: ellipsis;
  vertical-align: baseline;
  white-space: nowrap;
}
.team-chat-doc-layer .team-chat-mention {
  max-width: 100%;
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
  overflow-wrap: anywhere;
}
.task-board-team-chat .team-chat-bubble-text,
.task-board-team-chat .team-chat-doc-text {
  margin: 0;
  font: inherit;
  font-size: inherit;
  line-height: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.task-board-team-chat .team-chat-attachments,
.team-chat-doc-layer .team-chat-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 100%;
  margin-bottom: 6px;
}
/* 附件与报告文件都是通用文件卡：这里只收窄宽度、把摘录截成固定行数。
   文件正文在公共预览里按需读取，卡片本身不读流。 */
.task-board-team-chat .team-chat-file-card { width: min(100%, 360px); overflow: hidden; }
.task-board-team-chat .team-chat-file-excerpt,
.team-chat-doc-layer .team-chat-file-excerpt {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  line-height: var(--line-height-base);
  white-space: pre-line;
  -webkit-line-clamp: 3;
}
.task-board-team-chat .team-chat-file-meta,
.team-chat-doc-layer .team-chat-file-meta {
  display: block;
  min-width: 0;
  color: var(--text-tertiary);
  font-size: var(--font-size-2xs);
  overflow-wrap: anywhere;
}

/* 文档卡：纸面与边框归通用气泡的 outlined 变体，这里只定全宽与内容排列。 */
.task-board-team-chat .team-chat-preview {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.task-board-team-chat .team-chat-doc .team-chat-preview { color: var(--text-secondary); }
.task-board-team-chat .team-chat-msg-empty { color: var(--text-secondary); }
.task-board-team-chat .team-chat-msg[data-side="end"] .team-chat-msg-empty { color: inherit; opacity: 0.78; }
/* ---------- 正在输出的成员（§4.9 live 卡片）---------- */
/* 两段式进场：署名先出现，卡片随后长出；收起倒放且固定窗口内滚。 */
@keyframes wand-team-live-grow {
  from { opacity: 0; transform: translateX(-10px); }
}
/* reduce-motion 仍派发 animationend 清理退场行，但所有帧都不含横向位移。 */
@keyframes wand-team-live-reduced {
  from { opacity: 0; transform: none; }
  to { opacity: 1; transform: none; }
}
.team-chat-live-row {
  display: grid;
  gap: 5px;
}
.team-chat-live-row[data-leaving] {
  animation: wand-team-live-grow var(--motion-quick-exit) var(--ease-in-out-smooth) reverse forwards;
}
.team-chat-live-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  animation: wand-team-live-grow var(--motion-fast) var(--ease-out-expo) both;
}
/* live 署名行不再放头像（设计 v2.2.4）：只留名字 + 步骤 chip + 状态 chip + 时刻，
   名字用弱化字号（它不承载「一条发言的署名」，是卡片自己的元信息），也不单独挂链接。 */
.team-chat-live-name {
  max-width: 160px;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: var(--font-size-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.team-chat-live-text {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@keyframes wand-team-msg-in {
  from { opacity: 0; translate: 0 4px; }
}
.task-board-team-chat .chat-message.team-chat-msg[data-arriving],
.task-board-team-chat .chat-message.chat-notice[data-arriving] {
  animation: wand-team-msg-in var(--motion-normal) var(--ease-out-expo);
}
.task-board-team-chat-input {
  position: relative;
  display: grid;
  gap: 8px;
  min-width: 0;
}
/* ---------- 全文弹层（Portal）：从触发点方向长出，关闭回到原位 ---------- */
/* 弹层渲染在 #overlay-root 里，物理上不在 .task-board-team-chat 这棵树里，
   所以它挂在自己的唯一前缀上（设计 G3），两边都不碰全局 .chat-*。 */
.wand-ui-dialog-content.wand-team-chat-doc-dialog {
  display: flex;
  width: min(720px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 32px));
  max-height: min(72vh, 640px);
  flex-direction: column;
  overflow: hidden;
}
.wand-ui-dialog-content.wand-team-chat-doc-dialog[data-open] {
  animation: team-chat-doc-in var(--motion-normal) var(--ease-out-expo);
}
.wand-ui-dialog-content.wand-team-chat-doc-dialog[data-ending-style] {
  animation: team-chat-doc-out var(--motion-quick-exit) var(--ease-in-out-smooth);
}
/* 修饰符只设两个自定义属性，translate 与 scale 是独立属性，可以同时动画；
   写成 transform 拼两块会互相覆盖，也会盖掉居中用的 translate(-50%, -50%)。 */
.wand-doc-dx-start { --wand-doc-dx: -10px; }
.wand-doc-dx-end { --wand-doc-dx: 10px; }
.wand-doc-dy-top { --wand-doc-dy: -10px; }
.wand-doc-dy-bottom { --wand-doc-dy: 10px; }
@keyframes team-chat-doc-in {
  from { opacity: 0; translate: var(--wand-doc-dx, 0) var(--wand-doc-dy, 0); scale: 0.98; }
}
@keyframes team-chat-doc-out {
  to { opacity: 0; translate: var(--wand-doc-dx, 0) var(--wand-doc-dy, 0); scale: 0.98; }
}
.team-chat-doc-layer { display: flex; flex: 1 1 auto; flex-direction: column; gap: 8px; min-height: 0; }
.team-chat-doc-layer-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.team-chat-doc-layer-name { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
.team-chat-doc-layer-text {
  flex: 1 1 auto;
  min-height: 40px;
  margin: 0;
  padding-right: 4px;
  overflow: auto;
  overscroll-behavior-y: contain;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-base);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* ---------- 独立群聊页（侧栏点群聊条目进入）---------- */
/* 主任务钉顶、消息层中间滚动、输入框沉底：整页不跳转，返回即收起。 */
.wand-team-chat-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  padding: 0 28px 20px;
}
.wand-team-chat-body > .task-board-team-chat {
  display: flex;
  width: 100%;
  max-width: 920px;
  min-height: 0;
  margin: 0 auto;
  flex: 1 1 auto;
  flex-direction: column;
}
.wand-team-chat-body .task-board-team-chat-list {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
}
.wand-team-chat-body .task-board-team-chat-input { flex: 0 0 auto; }
.wand-team-chat-body .team-chat-details[data-open] { max-height: 42vh; overflow-y: auto; overscroll-behavior-y: contain; }
.wand-team-chat-head-meta { display: flex; align-items: center; gap: 10px; }
/* 群聊页头部：面包屑用 variant="title"，末段就是页面 h1，这里只压小整行的导航字号。 */
.wand-team-chat-crumb { font-size: var(--font-size-sm); }
.wand-team-chat-heading-avatar { flex: 0 0 auto; display: inline-flex; align-items: center; }
.wand-team-chat-heading-avatar .wand-team-avatar-stack { padding-top: 0; }
.wand-team-chat-unconfirmed { color: var(--warning); font-size: var(--font-size-xs); }

@media (max-width: 760px) {
  .wand-team-chat-body { padding: 0 14px 16px; }
  .wand-teams-layout { grid-template-columns: minmax(0, 1fr); }
  .wand-teams-list { padding: 12px 14px; border-right: 0; }
  .wand-teams-detail { padding: 14px 14px 28px; }
  .wand-teams-page[data-detail] .wand-teams-list { display: none; }
  .wand-teams-page:not([data-detail]) .wand-teams-detail { display: none; }

}

@media (prefers-reduced-motion: reduce) {
  .wand-teams-create-icon,
  .wand-teams-detail,
  .task-board-team-chat .chat-message.team-chat-msg[data-arriving],
  .task-board-team-chat .chat-message.chat-notice[data-arriving] { animation: none; }
  /* Live rows still deliver their animation-end cleanup signal. */
  .task-board-team-chat .team-chat-live-head {
    animation-name: wand-team-live-reduced;
    animation-duration: calc(var(--motion-fast) * 0);
  }
  .task-board-team-chat .team-chat-live-row[data-leaving] {
    animation-name: wand-team-live-reduced;
    animation-duration: calc(var(--motion-quick-exit) * 0);
  }
}

/* ---------- 硅基员工列表与卡片样式 ---------- */
.wand-employees-layout {
  display: block !important;
  max-width: 960px;
  margin: 0 auto;
  padding: 16px 20px 40px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.wand-employee-card.is-archived {
  opacity: 0.65;
}
.wand-employee-card.is-system {
  border-color: color-mix(in srgb, var(--accent) 38%, var(--border-subtle));
  background: color-mix(in srgb, var(--accent) 4%, var(--bg-primary));
}
`;
