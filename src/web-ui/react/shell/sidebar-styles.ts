import { installStyleSheet } from "../styles";

// Business layout only; Ant Design owns the control chrome and state visuals.
export function installSidebarStyles(): void {
  installStyleSheet("wand-sidebar-layout", `
.sidebar-visually-hidden { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
.workspaces-panel { position:relative; }
/* A continuous directory list, with one indent per real ownership boundary. */
.sidebar .conversation-navigation { width:100%; }
.sidebar:not(.collapsed) .conversation-navigation > .wand-ui-stretch-tabs,
.sidebar:not(.collapsed) .conversation-navigation .ant-segmented { width:100%; }
.sidebar:not(.collapsed) .conversation-navigation .ant-segmented-group { display:flex; }
.sidebar:not(.collapsed) .conversation-navigation .ant-segmented-item { flex:1; text-align:center; }
.sidebar .sidebar-body { overscroll-behavior:contain; }
.sidebar-presentation-tools { position:sticky; top:0; z-index:2; background:var(--bg-surface); }
.sidebar-search-slot { display:grid; flex:1; min-width:0; align-items:center; min-height:32px; }
.sidebar-list-title, .sidebar-search-expand { grid-area:1 / 1; min-width:0; transition:opacity var(--motion-fast) var(--ease-in-out-smooth), visibility var(--motion-fast) var(--ease-in-out-smooth); }
.sidebar-search-expand { opacity:0; pointer-events:none; }
.is-searching .sidebar-search-expand { opacity:1; pointer-events:auto; }
.is-searching .sidebar-list-title { opacity:0; visibility:hidden; }
.sidebar-search-input input::-webkit-search-cancel-button { display:none; }
.sidebar-disclosure-chevron { display:inline-flex; flex-shrink:0; transform:rotate(-90deg); transition:transform var(--motion-fast) var(--ease-in-out-smooth); }
.sidebar-disclosure-chevron[data-open="true"] { transform:rotate(0deg); }
.sidebar .workspace-row-main { min-height:48px; }
.sidebar .workspace-row-title { font-weight:600; }
.sidebar .workspace-row-path { display:block; max-width:100%; line-height:1.5; }
.sidebar .workspace-row-count, .sidebar .workspace-task-count { color:var(--text-secondary); font-size:12px; font-variant-numeric:tabular-nums; }
.sidebar .workspace-tasks, .sidebar .workspace-task-sessions { margin-inline-start:14px; border-inline-start:1px solid var(--border-subtle); }
.sidebar .workspace-task-main, .sidebar .workspace-session-main { min-height:36px; }
.sidebar .workspace-session-name { font-size:14px; }
.sidebar .workspace-session-kind { color:var(--text-secondary); font-size:11px; }
.sidebar .workspace-loose-label { display:block; padding:8px 6px 4px; font-size:12px; }
.sidebar .workspace-loose-session-list { display:flex; flex-direction:column; gap:4px; }
.sidebar :is(.workspace-task-action,.workspace-task-chevron-btn) { width:28px; min-width:28px; height:32px; padding:0; flex-shrink:0; }
.sidebar .workspace-task-menu, .sidebar .workspace-menu-context { min-width:0; }
.workspace-menu-context { max-width:240px; overflow-wrap:anywhere; color:var(--text-secondary); font-size:12px; padding:4px 8px 8px; }
.sidebar .sidebar-footer-actions { align-items:center; }
@media (pointer:coarse) {
  .sidebar :is(.workspace-task-action,.workspace-task-chevron-btn) { width:32px; min-width:32px; height:44px; }
  .sidebar .workspace-task-main, .sidebar .workspace-session-main { min-height:44px; }
}
@media (prefers-reduced-motion:reduce) { .sidebar-list-title, .sidebar-search-expand, .sidebar-disclosure-chevron { transition:none; } }
.sidebar-full-list { opacity:1; visibility:visible; transition:opacity var(--motion-fast) var(--ease-in-out-smooth), visibility var(--motion-normal) var(--ease-in-out-smooth); }
.workspaces-panel-compact .sidebar-full-list { position:absolute; inset:0 auto auto 0; opacity:0; visibility:hidden; pointer-events:none; transition:opacity var(--motion-quick-exit) var(--ease-in-out-smooth), visibility var(--motion-quick-exit) var(--ease-in-out-smooth); }
.sidebar-projection-swap { position:relative; }
.sidebar-projection-current { opacity:1; transition:opacity var(--motion-fast) var(--ease-in-out-smooth); }
.sidebar-projection-swap[data-entering="true"] .sidebar-projection-current { opacity:0; }
.sidebar-projection-old { position:absolute; inset:0; pointer-events:none; opacity:0; transition:opacity var(--motion-quick-exit) var(--ease-in-out-smooth); }
@starting-style { .sidebar-projection-old { opacity:1; } }
@media (prefers-reduced-motion:reduce) { .sidebar-full-list, .sidebar-projection-current, .sidebar-projection-old { transition:none; } }
.wand-workspace-manage-check { display:inline-flex; flex:none; margin-inline-end:6px; pointer-events:none; }
.wand-sidebar-modal-form { display:grid; gap:16px; }
.wand-sidebar-modal-body { min-width:0; max-height:64dvh; overflow:auto; }
.wand-sidebar-modal-footer { display:flex; align-items:center; justify-content:flex-end; gap:8px; flex-wrap:wrap; }
.wand-task-create-input { width:100%; }
.wand-subject-provider { width:20px; height:20px; flex:none; }
.wand-workspace-tabs { flex:1; min-width:0; }
.wand-workspace-tab-label { display:inline-flex; align-items:center; gap:6px; max-width:240px; }
.wand-workspace-tab-label > span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* 窄屏：Ant 的标签溢出算法按“可见宽度 - 更多按钮”左移整个列表，实测 390px 下激活标签左侧被切
   51px（标题读不全），非激活标签完全看不到。缩窄标签 + 去掉 14px 的关闭×后，激活标签 100% 可见、
   旁边留 21px 邻标签提示，溢出标签仍能从“更多”下拉进。 */
@media (max-width: 640px) {
  .wand-workspace-tab-label { max-width:96px; }
  .wand-workspace-tabs .ant-tabs-tab-remove { display:none; }
}
.wand-attention-item { width:100%; height:auto; white-space:normal; text-align:start; justify-content:flex-start; }
/* 报错项正文是不带空格的 CJK 长串，默认 overflow-wrap:normal 时 min-content 会把
   侧栏撑到 350px（父级 296px，overflow 可见=>右侧 54px 被裁且无横向滚动）。
   anywhere 才会影响 min-content，break-word 不行。 */
.wand-attention-item strong, .wand-attention-item span { overflow-wrap:anywhere; }
/* 5 条报错展开后有 1900px+，整段插在侧栏里会把会话列表顶到屏幕外（实测导航 y≈2038）。
   侧栏空间有限，面板自己滚，保持“就地展开”不变。 */
.home-attention.is-sidebar { max-height:min(50dvh, 520px); overflow-y:auto; overscroll-behavior:contain; }
.wand-worktree-selection { display:flex; align-items:flex-start; width:100%; margin-block:8px; }
`);
}
