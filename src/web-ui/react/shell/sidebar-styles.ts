import { installStyleSheet } from "../styles";

// Shared sidebar geometry and semantic surface roles; Ant retains control behavior.
export function installSidebarStyles(): void {
  installStyleSheet("wand-sidebar-layout", String.raw`
.sidebar-visually-hidden { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
.workspaces-panel { position:relative; }
.sidebar-navigation-rail { width:56px; flex:none; min-height:0; padding:8px 4px; border-inline-end:1px solid var(--border-subtle); background:var(--sidebar-rail); }
.sidebar-rail-scroll { width:100%; flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; }
.sidebar-rail-scroll > .sidebar-brand-mark { display:block; margin:8px auto 16px; }
.sidebar-list-panel { flex:1; min-width:0; min-height:0; }
.sidebar-list-panel[hidden] { display:none; }
.sidebar.context-rail .sidebar-navigation-rail { border-inline-end:1px solid var(--border-subtle); }
.sidebar-navigation-rail :is(.wand-ui-icon-button,.sidebar-list-error,[data-daemon-update-status]) { width:44px; min-width:44px; height:44px; padding:0; flex:none; }
.sidebar .conversation-navigation .wand-ui-icon-button { height:48px; display:flex; flex-direction:column; gap:3px; border-radius:var(--control-radius); color:var(--text-secondary); }
.sidebar .conversation-navigation .wand-ui-icon-button[aria-current="page"] { color:var(--sidebar-accent); background:var(--sidebar-selected); }
.sidebar-nav-icon { display:flex; height:20px; align-items:center; justify-content:center; }
.sidebar-nav-label { font-size:10px; line-height:14px; font-weight:500; }
.sidebar:focus-visible { outline:2px solid var(--sidebar-accent); outline-offset:-2px; }
.sidebar .wand-ui-button:focus-visible { outline:2px solid var(--sidebar-accent); outline-offset:2px; }
.sidebar-list-panel { background:var(--sidebar-surface); border-inline-end:1px solid var(--border-subtle); }
.sidebar-rail-notices { margin-block:12px 4px; padding-block-start:12px; border-block-start:1px solid var(--border-subtle); }
.sidebar .sidebar-profile-button { margin-block-start:8px; display:flex; flex-direction:column; gap:3px; color:var(--text-secondary); }
.sidebar-notification-content { width:min(280px, calc(100vw - 64px)); max-height: min(480px, 65dvh); overflow:auto; }
/* Unified navigation owns both filter capsules; the list has its own scroll owner. */
.sidebar-unified .sidebar-navigation-rail { width:76px; padding:8px 10px; }
.sidebar-unified .sidebar-rail-scroll { display:flex; flex-direction:column; align-items:center; gap:4px; }
.sidebar-unified .sidebar-rail-scroll > .sidebar-brand-mark { flex:none; margin:6px auto; }
.sidebar-unified .conversation-navigation { align-items:center; }
.sidebar-unified .conversation-navigation .wand-ui-icon-button { height:40px; }
.sidebar-unified .sidebar-nav-label { display:none; }
.sidebar-unified .sidebar-rail-notices { width:100%; margin:4px 0; padding:4px 0 0; flex:none; }
.sidebar-unified .sidebar-profile-button { margin:0; }
.sidebar-filter-capsules { width:100%; display:flex; flex-direction:column; align-items:center; gap:8px; padding:12px 0; }
.sidebar-capsule-label { font-size:11px; line-height:16px; color:var(--text-secondary); white-space:nowrap; }
.sidebar-filter-capsule { display:flex; flex-direction:column; align-items:center; flex:none; gap:4px; padding:6px 3px; border:1px solid var(--border-subtle); border-radius:28px; background:var(--sidebar-surface); }
.sidebar-filter-capsule .wand-ui-icon-button { width:40px; min-width:40px; height:40px; border-radius:50%; }
.sidebar-filter-capsule [data-filter-active="true"] { color:var(--sidebar-accent); background:var(--sidebar-selected); }
.sidebar-filter-capsule [data-filter-active="true"]::after { content:""; position:absolute; inset-inline-end:3px; top:6px; width:4px; height:4px; border-radius:50%; background:currentColor; }
.sidebar-capsule-rest { width:40px; display:flex; flex-direction:column; align-items:center; gap:4px; max-height:min(240px, 32dvh); overflow-y:auto; overflow-x:hidden; scrollbar-width:none; }
.sidebar-workspace-symbol { position:relative; display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; }
.sidebar-workspace-symbol .sidebar-workspace-monogram { position:absolute; right:-3px; bottom:-2px; min-width:12px; max-width:22px; padding:0 2px; border-radius:3px; background:var(--sidebar-surface); font-size:9px; line-height:12px; font-weight:600; }
.sidebar-capsule-picker { display:flex; flex-direction:column; gap:12px; width:260px; max-width:calc(100vw - 36px); }
.sidebar-capsule-choice { display:flex; align-items:center; gap:8px; }
.unified-sidebar-section { display:flex; justify-content:space-between; padding:12px 8px 6px; font-size:11px; font-weight:600; color:var(--text-secondary); }
.sidebar-capsule-options { display:flex; flex-direction:column; gap:4px; max-height:300px; overflow:auto; }
.sidebar-capsule-options .ant-btn { width:100%; justify-content:space-between; min-height:36px; }
.sidebar-capsule-options .ant-btn > span:first-child { overflow:hidden; text-overflow:ellipsis; }
.unified-sidebar-list { display:flex; flex:1; flex-direction:column; min-height:0; min-width:0; }
.unified-sidebar-tools { flex:none; display:flex; flex-direction:column; gap:10px; padding:0 12px 12px; }
.unified-sidebar-tools .sidebar-new-task { width:100%; }
.unified-sidebar-tools .wand-ui-search { flex:1; min-width:0; }
.unified-sidebar-tools .conversation-list-filter-trigger { width:34px; min-width:34px; }
.unified-sidebar-tools .conversation-list-filter-trigger > span:last-child { display:none; }
.unified-sidebar-tools > [role="status"] { font-size:12px; }
.unified-sidebar-rows { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:0 8px 12px; scroll-padding-block:8px; }
.unified-sidebar-row { min-width:0; display:flex; align-items:center; border-radius:var(--control-radius); }
.unified-sidebar-row > .ant-btn:first-child { flex:1; min-width:0; }
.unified-sidebar-row .unified-sidebar-more { width:28px; min-width:28px; height:32px; flex:none; opacity:0; }
.unified-sidebar-row:hover .unified-sidebar-more, .unified-sidebar-row:focus-within .unified-sidebar-more { opacity:1; }
@media (pointer:coarse) { .unified-sidebar-row .unified-sidebar-more { opacity:1; } }
.unified-sidebar-row .im-sidebar-item-name { font-size:13px; }
.unified-sidebar-row .wand-sidebar-session-row { min-height:58px; }
.unified-sidebar-current { display:flex; flex-direction:column; align-items:flex-start; gap:4px; padding:8px; border-radius:var(--control-radius); background:var(--sidebar-selected); font-size:12px; }
.unified-sidebar-empty { padding:16px 8px; }
@media (pointer:coarse) { .sidebar-filter-capsule .wand-ui-icon-button { min-width:44px; width:44px; height:44px; } .sidebar-capsule-options .ant-btn { min-height:44px; } }
/* A continuous directory list, with one indent per real ownership boundary. */
.sidebar .conversation-navigation { width:100%; }
.sidebar:not(.collapsed) .conversation-navigation > .wand-ui-stretch-tabs,
.sidebar:not(.collapsed) .conversation-navigation .ant-segmented { width:100%; }
.sidebar:not(.collapsed) .conversation-navigation .ant-segmented-group { display:flex; }
.sidebar:not(.collapsed) .conversation-navigation .ant-segmented-item { flex:1; text-align:center; }
.sidebar .sidebar-body { overscroll-behavior:contain; scrollbar-gutter:stable; }
/* Keep navigation and header actions anchored when switching list modes. */
.sidebar-header-primary { min-height:32px; }
.sidebar-header-main { min-width:0; }
.sidebar-header-actions { flex-shrink:0; }
.sidebar-compact-toggle-label, .conversation-create-label { display:none; }
.sidebar-header-actions :is(.sidebar-more-trigger,.sidebar-compact-toggle,.sidebar-close,.conversation-create-button) { width:32px; min-width:32px; height:32px; padding:0; }
.sidebar-title { font-size:15px; letter-spacing:0; }
.sidebar-compact-toggle[aria-pressed="true"] .sidebar-collapse-direction { transform:rotate(180deg); }
.sidebar-new-task.ant-btn { height:34px; font-size:13px; }
.sidebar-status:empty { display:none; }
.sidebar-footer-actions { min-width:0; }
.sidebar-footer:has(#back-to-native-button,#switch-server-button) { flex-wrap:wrap; }
.sidebar .conversation-list-tools { position:sticky; top:0; z-index:2; background:var(--sidebar-surface); }
.sidebar-presentation-tools { position:sticky; top:0; z-index:2; background:var(--sidebar-surface); }
.sidebar-search-slot { display:grid; flex:1; min-width:0; align-items:center; min-height:32px; }
.sidebar-list-title, .sidebar-search-expand { grid-area:1 / 1; min-width:0; transition:opacity var(--motion-fast) var(--ease-in-out-smooth), visibility var(--motion-fast) var(--ease-in-out-smooth); }
.sidebar-search-expand { opacity:0; pointer-events:none; }
.is-searching .sidebar-search-expand { opacity:1; pointer-events:auto; }
.is-searching .sidebar-list-title { opacity:0; visibility:hidden; }
.sidebar-search-input input::-webkit-search-cancel-button { display:none; }
.sidebar-disclosure-chevron { display:inline-flex; flex-shrink:0; transform:rotate(-90deg); transition:transform var(--motion-fast) var(--ease-in-out-smooth); }
.sidebar-disclosure-chevron[data-open="true"] { transform:rotate(0deg); }
.sidebar .workspace-row-main { min-height:48px; }
.sidebar .workspace-row-title { font-size:13px; font-weight:600; }
.sidebar .workspace-row-path { display:block; max-width:100%; line-height:1.5; }
.sidebar .workspace-row-count, .sidebar .workspace-task-count, .sidebar .im-sidebar-group-count { color:var(--text-secondary); font-size:12px; font-variant-numeric:tabular-nums; white-space:nowrap; flex-shrink:0; }
.sidebar .workspace-row-count { min-width:2ch; text-align:end; }
.sidebar .sidebar-head-activity, .sidebar .im-sidebar-group-attention-slot { width:12px; flex:none; display:inline-flex; justify-content:center; }
.sidebar .wand-sidebar-group-toggle { min-height:48px; padding:6px; }
.sidebar .im-sidebar-group-title { min-width:0; font-size:13px; font-weight:600; }
.sidebar .im-sidebar-group-meta { display:inline-flex; align-items:center; gap:4px; flex:none; }
.sidebar .im-sidebar-group-action { display:inline-flex; flex:none; }
.sidebar .sidebar-recent-add { width:28px; min-width:28px; height:32px; padding:0; }
.sidebar .im-sidebar-group-inner { margin-inline-start:8px; border-inline-start:1px solid var(--border-subtle); }
.sidebar .sidebar-group-empty, .sidebar .sidebar-filter-empty { margin:0; padding:6px; font-size:12px; line-height:1.5; }
.sidebar .workspace-tasks { margin-inline-start:8px; border-inline-start:1px solid var(--border-subtle); }
.sidebar .workspace-task-sessions { margin-inline-start:6px; border-inline-start:1px solid var(--border-subtle); }
.sidebar .workspace-task-main, .sidebar .workspace-session-main { min-height:36px; }
.sidebar .workspace-task-main { flex:1 1 0; min-width:0; overflow:hidden; }
.sidebar .workspace-task-name { font-size:13px; white-space:nowrap; }
.sidebar .workspace-task-disclosure-slot { width:20px; height:32px; flex:none; display:inline-flex; align-items:center; }
.sidebar .workspace-task-disclosure.ant-btn { width:20px; min-width:20px; height:32px; padding:0; color:var(--text-secondary); }
.sidebar .sidebar-task-status { display:inline-flex; align-items:center; justify-content:flex-end; gap:3px; flex:0 0 auto; min-width:4em; white-space:nowrap; word-break:keep-all; font-size:12px; line-height:18px; color:var(--text-secondary); }
.sidebar .sidebar-task-status > * { flex:none; white-space:nowrap; }
.sidebar .sidebar-task-status.tone-accent { color:var(--success); }
.sidebar .sidebar-task-status.tone-warning { color:var(--warning); }
.sidebar .sidebar-task-status.tone-success { color:var(--success); }
.sidebar .workspace-task-children { margin-inline-start:8px; padding-inline-start:8px; border-inline-start:1px solid var(--border-subtle); }
.sidebar .workspace-session-name { font-size:13px; }
.sidebar .workspace-session-kind { color:var(--text-secondary); font-size:11px; }
.sidebar .workspace-loose-label { display:block; padding:8px 6px 4px; font-size:12px; }
.sidebar .workspace-loose-session-list { display:flex; flex-direction:column; gap:2px; }
.sidebar .sidebar-list-title { font-size:12px; color:var(--text-secondary); }
.sidebar .sidebar-view-switch .ant-segmented-item-label { padding-inline:8px; font-size:12px; }
.sidebar .sidebar-body { scroll-padding-block:100px 12px; }
.sidebar :is(.workspace-task-action,.workspace-task-chevron-btn) { width:28px; min-width:28px; height:32px; padding:0; flex-shrink:0; }
/* Only geometry and context: Dropdown owns the surface, divider, hover and danger states. */
.sidebar-menu-heading { display:grid; gap:2px; min-width:0; padding-block:2px; }
.sidebar-menu-heading strong, .sidebar-menu-heading span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sidebar-menu-heading strong { color:var(--text-primary); font-weight:var(--font-weight-semibold); }
.sidebar-menu-heading span { color:var(--text-secondary); font-size:var(--font-size-xs); }
.sidebar-menu-error { color:var(--danger); white-space:normal; overflow-wrap:anywhere; }
:is(.sidebar-row-menu,.sidebar-menu-submenus) .ant-dropdown-menu { max-width:min(288px, calc(100vw - 24px)); }
.sidebar-menu-submenus .ant-dropdown-menu-submenu-popup { min-width:min(224px, calc(100vw - 24px)); max-width:min(288px, calc(100vw - 24px)); }
.sidebar-menu-submenus .ant-dropdown-menu { max-height:min(360px, calc(100dvh - 24px)); overflow-y:auto; overscroll-behavior:contain; }
:is(.sidebar-row-menu,.sidebar-menu-submenus) :is(.ant-dropdown-menu-item,.ant-dropdown-menu-submenu-title) { height:auto; min-height:32px; }
.sidebar [data-sidebar-menu-open="true"] { border-radius:var(--control-radius); background:var(--sidebar-selected); }
.sidebar .sidebar-footer-actions { align-items:center; }
/* One sidebar scale across conversation and workspace pages, including the framed home. */
.sidebar .conversation-search-host { display:flex; align-items:center; gap:6px; padding:0 4px 6px; }
.sidebar .conversation-search-host > .conversation-search-input { flex:1; min-width:0; }
.sidebar .conversation-list-filter-trigger { flex:none; width:64px; min-width:64px; height:34px; padding-inline:6px; gap:4px; }
.conversation-list-filter-summary { min-width:0; min-height:28px; }
.conversation-list-filter-summary > .ant-typography { min-width:0; font-size:12px; }
.conversation-list-filter-summary > button { flex:none; font-size:12px; padding-inline:4px; }
.conversation-list-filter-panel { position:relative; width:420px; max-width:calc(100vw - 48px); display:flex; flex-direction:column; gap:12px; }
.conversation-list-filter-fields { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
.conversation-filter-field { min-width:0; display:flex; flex-direction:column; gap:6px; }
.conversation-filter-field-label { font-size:12px; color:var(--text-secondary); }
.conversation-filter-field .ant-select { width:100%; min-width:0; height:32px; }
.conversation-list-filter-activity { font-size:12px; color:var(--text-secondary); }
.conversation-list-filter-footer { flex:none; padding-top:10px; border-top:1px solid var(--border-subtle); }
@media (pointer:coarse), (max-width:640px) {
  .sidebar .conversation-list-filter-trigger, .conversation-list-filter-summary > button { min-height:44px; }
  .conversation-filter-field .ant-select { height:44px; }
  .conversation-list-filter-panel .ant-btn { min-height:44px; }
  .conversation-list-filter-panel .ant-select-item-option { min-height:44px; }
  .conversation-list-filter-activity { min-height:44px; }
  .conversation-list-filter-activity .ant-switch { min-width:44px; }
}
.sidebar .conversation-search-input { min-height:34px; font-size:12px; background:var(--bg-surface); }
.sidebar .conversation-list-section { padding:0 4px 10px; gap:6px; }
.sidebar .conversation-list-count { padding-inline:2px; color:var(--text-secondary); }
.sidebar .conversation-row:hover, .sidebar .conversation-row:focus-within { background:var(--sidebar-hover); }
.sidebar .conversation-row[aria-current="page"] { background:var(--sidebar-selected); }
.sidebar .conversation-row[aria-current="page"] .conversation-row-title { color:var(--sidebar-accent); }
.sidebar .conversation-row-open.ant-btn:hover { color:inherit; background:transparent; }
.sidebar .conversation-row-time { color:var(--text-secondary); }
.conversation-person-sessions { margin-inline-start:28px; border-inline-start:1px solid var(--border-subtle); padding-inline-start:4px; min-width:0; max-height:min(45dvh,360px); overflow-y:auto; overscroll-behavior:contain; }
.conversation-other-sessions { margin-top:8px; }
.conversation-other-toggle { width:100%; justify-content:flex-start; gap:8px; min-height:36px; color:var(--text-secondary); }
.conversation-other-toggle span:last-child { margin-inline-start:auto; }
.sidebar .im-sidebar-group:has(.sidebar-session-preview) .im-sidebar-group-inner { max-height:min(45dvh,360px); overflow-y:auto; overscroll-behavior:contain; }
.conversation-person-sessions .wand-sidebar-session-row { min-height:44px; }
.sidebar :is(.workspace-session-main,.workspace-task-main,.wand-sidebar-session-row)[aria-current="page"], .sidebar .wand-sidebar-session-row.active { color:var(--sidebar-accent); background:var(--sidebar-selected); }
.sidebar .conversation-navigation .wand-ui-icon-button:hover { background:var(--sidebar-hover); }
.sidebar .conversation-navigation .wand-ui-icon-button[aria-current="page"] { background:var(--sidebar-selected); }
.sidebar .conversation-navigation .wand-ui-icon-button[aria-current="page"]::before { content:""; position:absolute; inset-inline-start:0; inset-block:14px; width:2px; border-radius:2px; background:var(--sidebar-accent); }
.sidebar .conversation-list-filter { flex:1; min-width:0; }
.sidebar .conversation-list-filter .ant-segmented-item-label { padding-inline:6px; }
.sidebar .conversation-list-filter .ant-segmented-item-selected { color:var(--sidebar-accent); }
.sidebar .sidebar-activity-filter.ant-btn { flex:none; width:48px; height:28px; padding:0; border-radius:var(--radius-full); font-size:12px; color:var(--text-secondary); background:transparent; border-color:var(--border-subtle); }
.sidebar .sidebar-activity-filter.ant-btn[aria-pressed="true"] { color:var(--sidebar-accent); background:var(--sidebar-selected); border-color:color-mix(in srgb,var(--sidebar-accent) 45%,var(--border-subtle)); }
.sidebar .conversation-search-input:focus-within { border-color:var(--sidebar-accent); box-shadow:0 0 0 2px color-mix(in srgb,var(--sidebar-accent) 14%,transparent); }
.sidebar.collapsed .conversation-row { justify-content:center; padding:6px 0; min-height:48px; }
.sidebar.collapsed .sidebar-body { scrollbar-gutter:auto; }

@media (pointer:coarse), (max-width:640px) {
  .sidebar-header-actions :is(.sidebar-compact-toggle,.sidebar-close,.conversation-create-button) { width:44px; min-width:44px; height:44px; }
  .sidebar-new-task.ant-btn { min-height:44px; }
  .sidebar :is(.workspace-task-action,.workspace-task-chevron-btn) { width:32px; min-width:32px; height:44px; }
  .sidebar .workspace-task-main, .sidebar .workspace-session-main { min-height:44px; }
  .sidebar .workspace-task-disclosure-slot { width:36px; height:44px; }
  .sidebar .workspace-task-disclosure.ant-btn { width:36px; min-width:36px; height:44px; }
  .sidebar .sidebar-activity-filter.ant-btn { min-height:44px; }
  .sidebar .sidebar-recent-add { width:44px; min-width:44px; height:44px; }
  :is(.sidebar-row-menu,.sidebar-menu-submenus) :is(.ant-dropdown-menu-item,.ant-dropdown-menu-submenu-title) { min-height:44px; }
}
@media (max-width:640px) {
  :is(.sidebar-row-menu,.sidebar-menu-submenus) :is(.ant-dropdown-menu-item,.ant-dropdown-menu-submenu-title) { min-height:44px; }
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
  [data-session-tabs="task"] .wand-workspace-tabs .ant-tabs-tab-remove { display:none; }
}
.wand-attention-list { display:flex; flex-direction:column; gap:2px; margin:0; padding:0; list-style:none; }
.wand-attention-item { width:100%; height:auto; white-space:normal; text-align:start; justify-content:flex-start; }
/* 报错项正文是不带空格的 CJK 长串，默认 overflow-wrap:normal 时 min-content 会把
   侧栏撑到 350px（父级 296px，overflow 可见=>右侧 54px 被裁且无横向滚动）。
   anywhere 才会影响 min-content，break-word 不行。 */
.wand-attention-item strong, .wand-attention-item span { overflow-wrap:anywhere; }
/* 5 条报错展开后有 1900px+，整段插在侧栏里会把会话列表顶到屏幕外（实测导航 y≈2038）。
   侧栏空间有限，面板自己滚，保持“就地展开”不变。 */
.home-attention.is-sidebar { max-height:min(50dvh, 520px); overflow-y:auto; overscroll-behavior:contain; }
/* 空白对话区的报错条异步到达：绝对定位在左上角，不占纵向流，
   避免它一出现就把居中的欢迎内容顶下去（实测任务看板 CLS 0.0189）。 */
.blank-chat-attention { position:absolute; inset-block-start:24px; inset-inline-start:24px; z-index:1; }
.wand-worktree-selection { display:flex; align-items:flex-start; width:100%; margin-block:8px; }
@media (prefers-reduced-motion: no-preference) {
  #sessions-drawer.sidebar-refined[role="dialog"]:not([data-drawer-gesture="active"]) {
    animation: sidebar-drawer-slide-in var(--motion-normal, 220ms) cubic-bezier(0.16, 1, 0.3, 1);
  }
  .drawer-backdrop.open:not([data-drawer-gesture="active"]) {
    animation: sidebar-backdrop-fade-in var(--motion-normal, 220ms) cubic-bezier(0.16, 1, 0.3, 1);
  }
}
@keyframes sidebar-drawer-slide-in {
  from { transform: translate3d(-100%, 0, 0); }
  to { transform: translate3d(0, 0, 0); }
}
@keyframes sidebar-backdrop-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
`);
}
