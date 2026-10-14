export const scheduledTaskStyles = String.raw`
.scheduled-tasks-page { position:absolute; inset:0; z-index:8; display:flex; flex-direction:column; min-height:0; min-width:0; background:var(--bg-primary); }
.scheduled-tasks-header { padding:16px var(--wand-page-inset); border-bottom:1px solid var(--border-color); flex-shrink:0; }
.scheduled-tasks-header h1 { margin:0; font-size:var(--wand-page-title-size,18px); line-height:1.4; }
.scheduled-tasks-body { flex:1; min-height:0; overflow:auto; padding:24px var(--wand-page-inset); }
.scheduled-tasks-content { max-width:1100px; margin:0 auto; }
.scheduled-tasks-intro { margin-bottom:20px; }
.scheduled-tasks-tools { margin-bottom:16px; flex-wrap:wrap; }
.scheduled-task-list { border-top:1px solid var(--border-color); }
.scheduled-task-row { display:grid; grid-template-columns:minmax(180px,1fr) minmax(170px,.75fr) auto; gap:16px; align-items:start; padding:20px 0; border-bottom:1px solid var(--border-color); }
.scheduled-task-main,.scheduled-task-timing { min-width:0; }
.scheduled-task-title { display:block; font-size:inherit; font-weight:600; overflow-wrap:anywhere; }
.scheduled-task-preview { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; overflow-wrap:anywhere; color:var(--text-secondary); margin:6px 0 10px; white-space:pre-wrap; }
.scheduled-task-meta { gap:8px; flex-wrap:wrap; }
.scheduled-task-directory { display:flex; flex-direction:column; gap:4px; margin-top:8px; min-width:0; overflow-wrap:anywhere; }
.scheduled-task-directory code { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
.scheduled-task-time { font-variant-numeric:tabular-nums; }
.scheduled-task-timing { display:flex; flex-direction:column; gap:6px; }
.scheduled-task-actions { max-width:230px; justify-content:flex-end; flex-wrap:wrap; }
.scheduled-task-empty { padding:40px 0; }
.scheduled-task-form { max-width:720px; display:flex; flex-direction:column; gap:24px; }
.scheduled-task-form .ant-form-item { margin-bottom:0; }
.scheduled-task-form .wand-ui-select-trigger,.scheduled-task-form .ant-picker { width:100%; }
.scheduled-task-plan-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.scheduled-task-prompt { min-height:180px; }
.scheduled-task-prompt textarea,textarea.scheduled-task-prompt { resize:none; }
.scheduled-task-form-actions { padding-top:8px; flex-wrap:wrap; }
.scheduled-task-history-heading { margin:0 0 16px; }
.scheduled-task-prompt-detail { white-space:pre-wrap; overflow-wrap:anywhere; margin:0; color:var(--text-secondary); }
.scheduled-task-run { padding:16px 0; border-top:1px solid var(--border-color); }
.scheduled-task-run-error { white-space:pre-wrap; overflow-wrap:anywhere; margin:8px 0 0; }
@media(max-width:640px) {
 .scheduled-tasks-header { padding:12px var(--wand-page-inset); }
 .scheduled-tasks-body { padding:20px var(--wand-page-inset); }
 .scheduled-task-row { grid-template-columns:minmax(0,1fr); gap:12px; padding:20px 0; }
 .scheduled-task-actions { justify-content:flex-start; max-width:none; }
 .scheduled-task-plan-grid { grid-template-columns:minmax(0,1fr); }
 .scheduled-tasks-tools { align-items:flex-start; }
 .scheduled-task-date-popup .ant-picker-panel-container { max-width:calc(100vw - 24px); max-height:calc(100dvh - 24px); overflow:auto; }
 .scheduled-task-date-popup .ant-picker-datetime-panel { flex-direction:column; }
 .scheduled-task-date-popup .ant-picker-time-panel { border-inline-start:none; border-top:1px solid var(--border-color); }
 .scheduled-task-date-popup .ant-picker-time-panel-column { flex:1; }
}
`;
