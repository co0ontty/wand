export const scheduledTaskStyles = String.raw`

.scheduled-tasks-page { position:absolute; inset:0; z-index:8; display:flex; flex-direction:column; min-height:0; min-width:0; background:var(--bg-primary); color:var(--text-primary); }
:where(.scheduled-tasks-page,.scheduled-calendar-detail-popover) :where(h1,h2,h3,p) { margin:0; }
:where(.scheduled-tasks-page,.scheduled-calendar-detail-popover) code { font:12px/1.55 var(--font-mono); overflow-wrap:anywhere; }
.scheduled-tasks-header { min-height:var(--wand-page-header-height); padding:12px var(--wand-page-inset); border-bottom:1px solid var(--border-subtle); flex-shrink:0; }
.scheduled-tasks-header h1 { font-size:var(--wand-page-title-size); line-height:1.4; }
.scheduled-tasks-header .scheduled-create-trigger { width:144px; flex-shrink:0; }
.scheduled-tasks-body { flex:1; min-height:0; overflow:auto; padding:0 var(--wand-page-inset); }
.scheduled-tasks-content { max-width:1440px; width:100%; }
.scheduled-editor { padding:20px 0; max-width:860px; }
.scheduled-global-scope-label { color:var(--text-secondary); font-size:12px; white-space:nowrap; }
.scheduled-task-save { width:156px; }
.scheduled-inline-confirm { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:14px 0; border-top:1px solid var(--border-subtle); }
.scheduled-inline-confirm p { flex-basis:100%; }
@starting-style { .scheduled-calendar-layer[data-active="true"] { opacity:0; } }
.scheduled-read-state { color:var(--text-secondary); font-size:12px; padding:6px 0; }
.scheduled-task-form { max-width:720px; display:flex; flex-direction:column; gap:24px; }
.scheduled-task-form .ant-form-item { margin-bottom:0; }
.scheduled-task-form .wand-ui-select-trigger,.scheduled-task-form .ant-picker { width:100%; }
.scheduled-task-plan-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.scheduled-task-prompt { min-height:180px; }
.scheduled-task-prompt textarea,textarea.scheduled-task-prompt { resize:none; }
.scheduled-task-form-actions { padding-top:8px; flex-wrap:wrap; }
/* One continuous next-task block, without sub-panels or repeated captions. */
.scheduled-next-section { margin-top:16px; }
.scheduled-next-task-panel { overflow:hidden; }
.scheduled-next-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; }
.scheduled-next-heading h2 { display:flex; align-items:center; flex-wrap:wrap; gap:14px; font-size:12px; font-weight:400; color:var(--text-secondary); }
.scheduled-next-schedule { display:inline-flex; align-items:baseline; gap:6px; color:var(--text-primary); }
.scheduled-next-schedule time { font-size:18px; font-weight:600; font-variant-numeric:tabular-nums; }
.scheduled-next-more-trigger.wand-ui-icon-button { width:28px; height:28px; }
.scheduled-next-work { display:grid; grid-template-columns:56px minmax(0,1fr); align-items:start; gap:12px; }
.scheduled-next-identity { padding-top:1px; }
.scheduled-employee-face { display:inline-flex; flex-shrink:0; line-height:0; vertical-align:middle; }
.scheduled-next-description { min-width:0; }
.scheduled-next-description h3 { font-size:16px; font-weight:600; line-height:1.5; overflow-wrap:anywhere; }
.scheduled-next-prompt { max-width:90ch; white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; line-height:1.75; margin-top:6px; }
.scheduled-next-metadata { display:flex; align-items:baseline; flex-wrap:wrap; gap:3px 12px; margin-top:9px; color:var(--text-secondary); font-size:12px; }
.scheduled-next-metadata > span { display:inline-flex; align-items:center; gap:5px; min-width:0; overflow-wrap:anywhere; }
.scheduled-next-run-note { display:flex; align-items:center; flex-wrap:wrap; gap:4px 8px; margin-top:8px; color:var(--text-secondary); font-size:12px; }
.scheduled-next-run-note[data-tone="danger"] { color:var(--danger); }
.scheduled-next-empty { display:flex; gap:12px; align-items:center; min-height:110px; }
.scheduled-next-empty > svg { color:var(--text-secondary); flex-shrink:0; }
.scheduled-next-empty strong { font-size:14px; font-weight:500; }
.scheduled-next-empty p { color:var(--text-secondary); font-size:12px; margin-top:4px; }

.scheduled-list-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:16px 0 10px; }
.scheduled-filter-count { font-variant-numeric:tabular-nums; font-size:12px; color:var(--text-secondary); margin-left:5px; }
.scheduled-search-tools { display:flex; align-items:center; gap:8px; min-width:0; }
.scheduled-search-tools .wand-ui-search { width:240px; }
.scheduled-search-tools .wand-ui-icon-button { width:32px; height:32px; }
.scheduled-problem-link.wand-ui-button { color:var(--danger); }
.scheduled-list-context { padding-bottom:8px; color:var(--text-secondary); font-size:12px; }
.scheduled-schedule-view-host { display:grid; position:relative; min-width:0; }
.scheduled-schedule-view-pane { grid-area:1 / 1; min-width:0; width:100%; }
.scheduled-schedule-view-pane[data-active="true"] { position:relative; opacity:1; visibility:visible; transition:opacity var(--motion-normal) var(--ease-in-out-smooth); }
.scheduled-schedule-view-pane[data-active="false"] { position:absolute; inset:0 0 auto; opacity:0; visibility:hidden; pointer-events:none; transition:opacity var(--motion-quick-exit) var(--ease-in-out-smooth), visibility var(--motion-quick-exit); }
.scheduled-agenda-group + .scheduled-agenda-group { margin-top:12px; }
.scheduled-agenda-group-heading { padding:3px 0; }
.scheduled-agenda-group-heading h3 { color:var(--text-secondary); font-size:12px; font-weight:500; }
.scheduled-agenda-group .ant-list-item.scheduled-agenda-task { display:block; padding:0; }
.scheduled-agenda-task > article { width:100%; min-width:0; }
.scheduled-task-summary { display:grid; grid-template-columns:56px 48px minmax(0,1fr) auto; gap:12px; align-items:center; padding:10px 4px 10px 0; }
.scheduled-agenda-task:hover .scheduled-task-summary { background:var(--bg-hover); }
.scheduled-task-time { align-self:center; font-variant-numeric:tabular-nums; }
.scheduled-task-time time { font-size:16px; font-weight:500; }
.scheduled-task-time > strong { color:var(--text-secondary); font-weight:400; font-size:16px; }
.scheduled-task-row-avatar { align-self:center; }
.scheduled-task-info { min-width:0; }
.scheduled-task-title-button.wand-ui-button { max-width:100%; min-height:22px; height:auto; padding:0; justify-content:start; gap:7px; font-size:14px; font-weight:500; text-align:start; }
.scheduled-task-title-button > span:first-child { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.scheduled-task-chevron { display:inline-flex; flex-shrink:0; color:var(--text-secondary); transform:rotate(-90deg); transition:transform var(--motion-morph) var(--ease-out-expo); }
.scheduled-task-chevron[data-expanded="true"] { transform:rotate(0); }
.scheduled-task-target { display:flex; align-items:center; flex-wrap:wrap; gap:3px 12px; color:var(--text-secondary); font-size:12px; line-height:1.5; margin-top:3px; }
.scheduled-task-target > span { display:inline-flex; align-items:center; gap:5px; min-width:0; overflow-wrap:anywhere; }
.scheduled-plan-state { display:inline-flex; align-items:center; gap:5px; font-size:12px; }
.scheduled-plan-state i { width:4px; height:4px; border-radius:50%; background:currentColor; }
.scheduled-plan-state[data-tone="muted"] { color:var(--text-secondary); }
.scheduled-plan-state[data-tone="danger"] { color:var(--danger); }
.scheduled-run-state { display:inline-flex; align-items:center; gap:4px; font-size:12px; line-height:1.5; }
.scheduled-run-state[data-tone="completed"] { color:var(--success); }
.scheduled-run-state[data-tone="failed"] { color:var(--danger); }
.scheduled-run-state[data-tone="unknown"] { color:var(--warning); }
.scheduled-run-state[data-tone="running"] { color:var(--accent); }
.scheduled-run-state[data-tone="skipped"] { color:var(--text-secondary); }
.scheduled-task-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; }
.scheduled-task-actions .wand-ui-icon-button { width:28px; height:28px; }
.scheduled-switch-hitbox { display:grid; place-items:center; width:32px; height:28px; flex-shrink:0; cursor:pointer; }
.scheduled-switch-placeholder { width:32px; }
.scheduled-run-top .wand-ui-button svg[data-wand-icon="chevron"] { transform:rotate(-90deg); }
.scheduled-inline-details, .scheduled-editor-shell, .scheduled-history-expansion { display:grid; grid-template-rows:0fr; opacity:0; visibility:hidden; transition:grid-template-rows var(--motion-normal) var(--ease-out-expo), opacity var(--motion-quick-exit) var(--ease-in-out-smooth), visibility var(--motion-normal); }
.scheduled-inline-details[data-open="true"], .scheduled-editor-shell[data-open="true"], .scheduled-history-expansion[data-open="true"] { grid-template-rows:1fr; opacity:1; visibility:visible; transition-duration:var(--motion-normal); }
.scheduled-inline-details > div, .scheduled-editor-shell > div, .scheduled-history-expansion > div { min-height:0; overflow:hidden; }
.scheduled-row-detail-content { margin-left:68px; padding:0 16px 16px; background:var(--bg-secondary); }
.scheduled-task-details { display:grid; grid-template-columns:1fr 1.1fr; gap:28px; padding:16px 0 6px; }
.scheduled-task-details h2 { font-size:13px; font-weight:600; margin-bottom:10px; overflow-wrap:anywhere; }
.scheduled-detail-prompt > p { font-size:13px; line-height:1.85; white-space:pre-wrap; overflow-wrap:anywhere; max-width:66ch; }
.scheduled-detail-prompt dl { display:grid; grid-template-columns:72px minmax(0,1fr); gap:5px 12px; margin:14px 0 10px; font-size:12px; }
.scheduled-detail-prompt dt { color:var(--text-secondary); }
.scheduled-detail-prompt dd { margin:0; overflow-wrap:anywhere; }
.scheduled-detail-prompt > .wand-ui-button { padding-left:0; }
.scheduled-detail-history header { display:flex; justify-content:space-between; align-items:start; }
.scheduled-detail-history h2 span { margin-left:6px; color:var(--text-secondary); font-weight:400; }
.scheduled-detail-history ol { list-style:none; padding:0; margin:0; }
.scheduled-detail-history li { border-bottom:1px solid var(--border-subtle); padding:10px 0; }
.scheduled-detail-history li:first-child { padding-top:0; }
.scheduled-run-top { display:flex; flex-wrap:wrap; align-items:center; gap:10px; font-size:12px; }
.scheduled-run-top time { color:var(--text-secondary); font-variant-numeric:tabular-nums; }
.scheduled-run-top > .wand-ui-button { margin-left:auto; padding:0; height:20px; font-size:12px; }
.scheduled-detail-history li > code { color:var(--text-secondary); display:block; margin-top:3px; }
.scheduled-run-error { color:var(--danger); margin-top:6px; font-size:12px; }
.scheduled-run-error[data-tone="unknown"] { color:var(--warning); }
.scheduled-run-error[data-tone="skipped"] { color:var(--text-secondary); }
.scheduled-detail-footnote { color:var(--text-secondary); font-size:12px; margin-top:10px; }
.scheduled-page-foot { padding:14px 0; color:var(--text-secondary); font-size:12px; }
.scheduled-rule-note { display:inline-flex; align-items:center; gap:6px; }
.scheduled-cancel-confirm, .scheduled-session-preview { display:flex; flex-wrap:wrap; align-items:center; gap:12px; border-top:1px solid var(--border-subtle); padding:14px 0 0; font-size:12px; }
.scheduled-cancel-confirm > div, .scheduled-session-preview > div { flex:1; min-width:160px; }
.scheduled-cancel-confirm p, .scheduled-session-preview p { margin-top:4px; color:var(--text-secondary); }
.scheduled-session-preview { align-items:start; }
.scheduled-read-error { margin-bottom:12px; }
.scheduled-loading-list { padding:12px 0; }
.scheduled-loading-list .ant-skeleton { padding:12px; border-bottom:1px solid var(--border-subtle); }
.scheduled-agenda-empty { padding:24px 0; }
.ant-empty { padding:32px 0; }
.ant-empty p { margin-top:6px; color:var(--text-secondary); }
/* A heatmap is not an Ant chart primitive; cells reuse WandButton and Tooltip. */
.scheduled-detail-history { min-width:0; }
.scheduled-history-toggle.wand-ui-button { width:108px; height:24px; padding-inline:4px; justify-content:flex-end; }
.scheduled-latest-record { margin:0; padding:0; list-style:none; }
.scheduled-detail-history .scheduled-latest-record .scheduled-execution-record { padding:0; border-bottom:0; }
.scheduled-execution-record > code { display:block; margin-top:4px; color:var(--text-secondary); }
.scheduled-execution-heatmap { --heat-cell:18px; --heat-gap:4px; padding-top:16px; min-width:0; }
.scheduled-heat-summary { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px; font-size:12px; }
.scheduled-heat-summary > span:last-child { color:var(--text-secondary); }
.scheduled-heat-scroll { max-width:100%; overflow-x:auto; overscroll-behavior-inline:contain; }
.scheduled-heat-months { display:grid; grid-template-columns:22px repeat(12,var(--heat-cell)); column-gap:var(--heat-gap); width:max-content; font-size:10px; color:var(--text-secondary); margin-bottom:5px; }
.scheduled-heat-months span { white-space:nowrap; overflow:visible; }
.scheduled-heat-layout { display:flex; align-items:start; gap:var(--heat-gap); width:max-content; }
.scheduled-heat-weekdays { display:grid; grid-template-rows:repeat(7,var(--heat-cell)); row-gap:var(--heat-gap); width:22px; flex-shrink:0; color:var(--text-secondary); font-size:10px; }
.scheduled-heat-weekdays > span { display:flex; align-items:center; }
.scheduled-heat-board { display:grid; grid-template-columns:repeat(12,var(--heat-cell)); grid-template-rows:repeat(7,var(--heat-cell)); gap:var(--heat-gap); }
.scheduled-heat-board .scheduled-heat-cell.wand-ui-button { width:var(--heat-cell); min-width:var(--heat-cell); height:var(--heat-cell); padding:0; border:1px solid var(--border-subtle); border-radius:4px; background:var(--bg-elevated); box-shadow:none; font-size:10px; line-height:1; color:var(--text-secondary); }
.scheduled-heat-board .scheduled-heat-cell[disabled] { opacity:.4; }
.scheduled-heat-board .scheduled-heat-cell[data-outcome="completed"], .scheduled-heat-legend i[data-outcome="completed"] { background:color-mix(in srgb,var(--success) 28%,var(--bg-surface)); border-color:var(--success); }
.scheduled-heat-board .scheduled-heat-cell[data-outcome="completed"][data-level="2"], .scheduled-heat-board .scheduled-heat-cell[data-outcome="completed"][data-level="3"] { background:var(--success); }
.scheduled-heat-board .scheduled-heat-cell[data-outcome="failed"], .scheduled-heat-legend i[data-outcome="failed"] { background:color-mix(in srgb,var(--danger) 24%,var(--bg-surface)); border-color:var(--danger); }
.scheduled-heat-board .scheduled-heat-cell[data-outcome="running"], .scheduled-heat-board .scheduled-heat-cell[data-outcome="pending"], .scheduled-heat-legend i[data-outcome="running"] { background:var(--accent-muted); border-color:var(--accent); }
.scheduled-heat-board .scheduled-heat-cell[data-outcome="unknown"], .scheduled-heat-legend i[data-outcome="unknown"] { background:var(--bg-elevated); border-color:var(--warning); color:var(--warning); }
.scheduled-heat-board .scheduled-heat-cell[data-outcome="mixed"], .scheduled-heat-legend i[data-outcome="mixed"] { background:var(--warning-muted); border-color:var(--warning); color:var(--warning); }
.scheduled-heat-board .scheduled-heat-cell[data-outcome="skipped"], .scheduled-heat-legend i[data-outcome="skipped"] { background:var(--bg-secondary); border-color:var(--text-secondary); border-style:dashed; }
.scheduled-heat-board .scheduled-heat-cell[aria-pressed="true"] { outline:2px solid var(--border-focus); outline-offset:2px; }
.scheduled-heat-legend { display:flex; flex-wrap:wrap; gap:5px 10px; margin-top:12px; font-size:11px; color:var(--text-secondary); }
.scheduled-heat-legend > span { display:inline-flex; align-items:center; gap:4px; }
.scheduled-heat-legend i { display:inline-block; width:9px; height:9px; border:1px solid var(--border-default); border-radius:2px; }
.scheduled-heat-help { font-size:11px; line-height:1.6; color:var(--text-secondary); margin-top:9px; }
.scheduled-heat-day-detail { margin-top:14px; padding-top:12px; border-top:1px solid var(--border-subtle); }
.scheduled-heat-day-detail > header { display:flex; justify-content:space-between; gap:12px; margin-bottom:8px; }
.scheduled-heat-day-detail h3 { font-size:12px; font-weight:500; }
.scheduled-heat-day-detail header > span { font-size:12px; color:var(--text-secondary); }
.scheduled-heat-day-detail ol { margin:0; padding:0; list-style:none; }
@media (pointer:coarse) {
  .scheduled-history-toggle.wand-ui-button { min-height:44px; width:120px; }
  .scheduled-execution-heatmap { --heat-cell:44px; }
}
/* Ant owns the month date matrix. The week axis is custom geometry because
   Calendar has no time-grid API; both paint the same CalendarEntry objects. */
.scheduled-calendar-view { min-width:0; padding-top:6px; }
.scheduled-calendar-toolbar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px 12px; margin-bottom:8px; }
.scheduled-calendar-navigation { display:flex; align-items:center; gap:5px; min-width:0; }
.scheduled-calendar-navigation h2 { font-size:16px; font-weight:600; white-space:nowrap; }
.scheduled-calendar-navigation .wand-ui-icon-button { width:28px; height:28px; }
.scheduled-calendar-forward { transform:rotate(-90deg); }
.scheduled-calendar-range .ant-segmented-item-label { min-height:28px; line-height:28px; padding-inline:10px; }
.scheduled-calendar-explanation { display:flex; align-items:center; flex-wrap:wrap; gap:8px 16px; font-size:11px; color:var(--text-secondary); margin-bottom:10px; }
.scheduled-calendar-explanation > span { display:inline-flex; align-items:center; gap:5px; }
.scheduled-calendar-explanation > span:last-child { margin-left:auto; }
.scheduled-calendar-explanation i { width:11px; height:8px; border:1px solid var(--success); background:var(--success-muted); border-radius:2px; }
.scheduled-calendar-explanation i[data-kind="planned"] { border:1px dashed var(--accent); background:var(--accent-muted); }
.scheduled-calendar-canvases { position:relative; display:grid; min-width:0; }
.scheduled-calendar-layer { grid-area:1 / 1; min-width:0; width:100%; }
.scheduled-calendar-layer[data-active="true"] { position:relative; opacity:1; visibility:visible; transition:opacity var(--motion-normal) var(--ease-in-out-smooth); }
.scheduled-calendar-layer[data-active="false"] { position:absolute; inset:0 0 auto; opacity:0; visibility:hidden; pointer-events:none; transition:opacity var(--motion-quick-exit) var(--ease-in-out-smooth), visibility var(--motion-quick-exit); }
.scheduled-calendar-month-scroll { width:100%; overflow-x:auto; overscroll-behavior-inline:contain; border:1px solid var(--border-subtle); border-radius:var(--control-radius); background:var(--bg-surface); }
.scheduled-schedule-month-calendar { min-width:1120px; }
.scheduled-schedule-month-calendar .ant-picker-panel { background:transparent; }
.scheduled-schedule-month-calendar .ant-picker-content { table-layout:fixed; }
.scheduled-schedule-month-calendar td.ant-picker-cell { padding:0; vertical-align:top; }
.scheduled-schedule-month-calendar th { font-size:12px; font-weight:500; padding-block:9px; }
.scheduled-month-cell { height:max(124px,calc((100dvh - 280px) / 6)); padding:4px; border-top:1px solid var(--border-subtle); border-inline-end:1px solid var(--border-subtle); }
.scheduled-month-date-button.wand-ui-button { width:26px; height:26px; min-width:26px; padding:0; margin:0 0 3px; border-radius:50%; font-size:12px; }
.scheduled-schedule-month-calendar .ant-picker-cell-selected .scheduled-month-date-button { background:var(--accent-muted); color:var(--accent); }
.scheduled-schedule-month-calendar .scheduled-month-date-button[aria-current="date"] { background:var(--accent-solid); color:var(--text-inverse); }
.scheduled-month-cell-events { display:flex; flex-direction:column; gap:3px; }
.scheduled-calendar-event.wand-ui-button { display:flex; align-items:center; justify-content:start; gap:4px; width:100%; height:28px; min-height:28px; padding:1px 4px; border:1px solid var(--border-subtle); border-inline-start-width:3px; border-radius:4px; text-align:start; box-shadow:none; color:var(--text-primary); }
.scheduled-calendar-face { display:inline-flex; width:22px; height:22px; flex:0 0 22px; line-height:0; }
.scheduled-calendar-event-copy { display:flex; align-items:center; min-width:0; flex:1; gap:5px; }
.scheduled-calendar-event-meta { display:contents; }
.scheduled-calendar-event-meta > time { order:0; flex-shrink:0; font-size:10px; line-height:1.4; font-variant-numeric:tabular-nums; }
.scheduled-calendar-event-meta > span { order:2; flex-shrink:0; font-size:10px; line-height:1.4; }
.scheduled-calendar-event-title { order:1; flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:11px; line-height:1.4; }
.scheduled-calendar-event.wand-ui-button[data-state="completed"] { border-color:var(--success); background:var(--success-muted); }
.scheduled-calendar-event.wand-ui-button[data-state="failed"], .scheduled-calendar-event.wand-ui-button[data-state="blocked"] { border-color:var(--danger); background:var(--danger-muted); }
.scheduled-calendar-event.wand-ui-button[data-state="running"], .scheduled-calendar-event.wand-ui-button[data-state="pending"] { border-color:var(--accent); background:var(--accent-muted); }
.scheduled-calendar-event.wand-ui-button[data-state="unknown"], .scheduled-calendar-event.wand-ui-button[data-state="waiting"] { border-color:var(--warning); background:var(--warning-muted); }
.scheduled-calendar-event.wand-ui-button[data-state="skipped"] { border-color:var(--text-secondary); background:var(--bg-secondary); color:var(--text-secondary); }
.scheduled-calendar-event.wand-ui-button[data-entry-kind="planned"] { border-style:dashed; }
.scheduled-calendar-event.wand-ui-button[aria-pressed="true"] { outline:2px solid var(--border-focus); outline-offset:1px; }
.scheduled-calendar-more.wand-ui-button { height:18px; padding:0 3px; justify-content:start; font-size:10px; }
.scheduled-week-scroll { height:calc(100dvh - 280px); min-height:340px; width:100%; overflow:auto; overscroll-behavior:contain; border:1px solid var(--border-subtle); border-radius:var(--control-radius); background:var(--bg-surface); }
.scheduled-week-canvas { min-width:1204px; width:100%; }
.scheduled-week-days { position:sticky; top:0; z-index:3; display:grid; grid-template-columns:56px repeat(7,minmax(0,1fr)); height:48px; background:var(--bg-surface); border-bottom:1px solid var(--border-subtle); }
.scheduled-week-zone { display:grid; place-items:center; position:sticky; left:0; background:var(--bg-surface); color:var(--text-secondary); font-size:10px; z-index:4; }
.scheduled-week-date.wand-ui-button { height:48px; padding:3px 0; display:flex; flex-direction:column; justify-content:center; align-items:center; gap:1px; border-radius:0; border-inline-start:1px solid var(--border-subtle); }
.scheduled-week-date > span { font-size:10px; color:var(--text-secondary); }
.scheduled-week-date > strong { font-size:14px; font-weight:500; }
.scheduled-week-date[aria-pressed="true"] { background:var(--accent-muted); }
.scheduled-week-date strong[data-today="true"] { color:var(--accent); }
.scheduled-week-hours { height:1536px; position:relative; }
.scheduled-week-hour-row { position:absolute; width:100%; height:64px; border-top:1px solid var(--border-subtle); }
.scheduled-week-hour-row > span { position:sticky; left:0; z-index:2; width:56px; height:100%; padding-top:3px; padding-right:7px; display:block; background:var(--bg-surface); color:var(--text-secondary); text-align:right; font-size:10px; font-variant-numeric:tabular-nums; }
.scheduled-week-day-lines { position:absolute; inset:0 0 0 56px; display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); pointer-events:none; }
.scheduled-week-day-lines > div { border-inline-start:1px solid var(--border-subtle); }
.scheduled-week-hours .scheduled-calendar-event { position:absolute; height:44px; z-index:1; transition-property:background-color,border-color,color,box-shadow; }
.scheduled-week-hours .scheduled-calendar-event::before { content:""; position:absolute; left:-5px; top:0; width:5px; height:2px; background:currentColor; }
.scheduled-week-hours .scheduled-calendar-event-meta > time { font-size:11px; }
.scheduled-week-hours .scheduled-calendar-event-title { font-size:12px; }
.scheduled-calendar-footnote { margin-top:10px; color:var(--text-secondary); font-size:11px; line-height:1.6; }
.scheduled-calendar-detail-popover .ant-popover-container { padding:16px; max-height:calc(100dvh - 48px); overflow:auto; overscroll-behavior:contain; }
.scheduled-calendar-selected-content { width:min(600px,calc(100vw - 64px)); }
.scheduled-calendar-selection-heading { display:flex; justify-content:space-between; align-items:center; gap:12px; padding-bottom:10px; border-bottom:1px solid var(--border-subtle); }
.scheduled-calendar-selection-heading > div { display:flex; flex-direction:column; gap:3px; }
.scheduled-calendar-selection-heading strong { font-size:13px; font-weight:500; }
.scheduled-calendar-selection-heading span { color:var(--text-secondary); font-size:12px; }
.scheduled-calendar-selected-content .scheduled-task-details { grid-template-columns:minmax(0,1fr); gap:14px; padding-top:12px; }
.scheduled-calendar-selected-content .scheduled-detail-prompt h2 { margin-bottom:6px; }
.scheduled-calendar-selected-content .scheduled-detail-prompt dl { margin-block:10px; }
.scheduled-calendar-selected-content .scheduled-execution-heatmap { padding-top:12px; }
@media(max-width:640px) {
  .scheduled-calendar-navigation { gap:2px; }
  .scheduled-calendar-navigation h2 { font-size:14px; }
  .scheduled-calendar-range .ant-segmented-item-label { padding-inline:8px; }
  .scheduled-calendar-toolbar { gap:6px; }
  .scheduled-calendar-detail-popover .ant-popover-container { padding:12px; }
  .scheduled-calendar-selected-content { width:calc(100vw - 48px); }
}
@media(pointer:coarse) {
  .scheduled-calendar-navigation .wand-ui-icon-button, .scheduled-calendar-navigation .wand-ui-button, .scheduled-calendar-selection-heading .wand-ui-icon-button { min-width:44px; min-height:44px; }
  .scheduled-month-date-button.wand-ui-button { width:44px; height:44px; }
  .scheduled-month-cell { height:max(196px,calc((100dvh - 280px) / 6)); }
  .scheduled-month-cell .scheduled-calendar-event { height:44px; }
  .scheduled-calendar-more.wand-ui-button { min-height:36px; }
  .scheduled-calendar-range .ant-segmented-item-label { min-height:44px; line-height:44px; }
}
@media(prefers-reduced-motion:reduce) {
  .scheduled-calendar-layer { transition:none !important; }
}

@media(max-width:760px) { .scheduled-task-details { grid-template-columns:minmax(0,1fr); gap:20px; } .scheduled-task-plan-grid { grid-template-columns:minmax(0,1fr); } }
@media(max-width:640px) { .scheduled-list-toolbar { flex-direction:column; align-items:stretch; gap:8px; padding-top:12px; } .scheduled-list-toolbar .wand-ui-stretch-tabs { align-self:flex-start; } .scheduled-search-tools .wand-ui-search { flex:1; width:auto; } }
@media(max-width:600px) {
.scheduled-task-summary { grid-template-columns:44px 36px minmax(0,1fr) 32px; gap:10px; padding:10px 0; }
.scheduled-switch-hitbox,.scheduled-switch-placeholder { display:none; }
.scheduled-task-title-button.wand-ui-button { align-items:start; white-space:normal; }
.scheduled-task-title-button > span:first-child { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; white-space:normal; }
.scheduled-task-chevron { margin-top:4px; } .scheduled-task-target { gap:3px 8px; }
.scheduled-task-actions { align-self:center; } .scheduled-task-actions .wand-ui-icon-button { width:32px; height:32px; }
.scheduled-row-detail-content { margin-left:0; padding-inline:12px; }
.scheduled-tasks-header .scheduled-create-trigger { width:36px; min-width:36px; padding-inline:0; } .scheduled-create-label { display:none; }
.scheduled-next-heading h2 { gap:10px; } .scheduled-next-schedule time { font-size:16px; }
.scheduled-next-work { grid-template-columns:40px minmax(0,1fr); gap:10px; } .scheduled-next-identity .scheduled-employee-face { margin-left:-8px; }
.scheduled-next-description h3 { font-size:15px; } .scheduled-next-metadata { gap:3px 8px; } .scheduled-next-metadata code { font-size:11px; }
.scheduled-task-date-popup .ant-picker-datetime-panel { flex-direction:column; }
.scheduled-task-date-popup .ant-picker-time-panel { border-inline-start:none; border-top:1px solid var(--border-subtle); }
.scheduled-task-date-popup .ant-picker-panel-container { max-width:calc(100vw - 24px); max-height:calc(100dvh - 24px); overflow:auto; }
}
@media(pointer:coarse) {
.scheduled-tasks-header .scheduled-create-trigger { min-width:44px; height:44px; }
.scheduled-task-title-button.wand-ui-button { min-height:44px; }
.scheduled-task-actions .wand-ui-icon-button,.scheduled-search-tools .wand-ui-icon-button,.scheduled-next-more-trigger.wand-ui-icon-button { min-width:44px; min-height:44px; }
.scheduled-switch-hitbox { width:44px; height:44px; }
}
@media(pointer:coarse) and (max-width:600px) { .scheduled-task-summary { grid-template-columns:44px 36px minmax(0,1fr) 44px; } }
@media(prefers-reduced-motion:reduce) { .scheduled-editor-shell,.scheduled-inline-details,.scheduled-history-expansion,.scheduled-task-chevron,.scheduled-schedule-view-pane { animation:none; transition:none; } }

`;
