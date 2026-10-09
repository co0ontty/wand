import { installStyleSheet } from "../styles";

/** Owned page/dialog geometry; Ant supplies all control and surface visuals. */
if (typeof document !== "undefined") installStyleSheet("wand-task-library-layout", String.raw`
/* Match the management-page frame without changing the board's scroll ownership. */
.task-board-native-page { padding:0 var(--wand-page-inset,20px) var(--wand-page-inset,20px); }
.task-board-workspace-header { min-height:var(--wand-page-header-height,56px); box-sizing:border-box; padding-block:8px; }
.task-board-heading-copy h1 { font-size:var(--wand-page-title-size,18px); }
.task-board-workspace-header .wand-ui-icon-button { min-width:var(--wand-page-toolbar-height,36px); min-height:var(--wand-page-toolbar-height,36px); }
.task-board-create-button.ant-btn { min-height:var(--wand-page-toolbar-height,36px); }
.task-board-card-title { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.task-board-card.is-open .task-board-card-title { display:block; -webkit-line-clamp:unset; overflow:visible; }
.task-board-toolbar { padding-block:8px; row-gap:8px; }
.task-board-toolbar-controls { grid-template-columns:minmax(180px,1fr) minmax(120px,180px) 140px auto auto; }
.task-board-toolbar-controls .ant-input-affix-wrapper,
.task-board-toolbar-controls .wand-ui-select-trigger { min-height:var(--wand-page-toolbar-height,36px); }
@container taskboard (max-width:600px) {
  .task-board-toolbar-controls { grid-template-columns:minmax(0,1fr) minmax(0,1fr) 36px 36px; }
}
@media (max-width:639px) {
  .task-board-native-page { padding:0 var(--wand-page-inset,12px) var(--wand-page-inset,12px); }
}
.ant-modal:has(.wand-task-library-dialog) { width: min(720px, calc(100vw - 32px)) !important; }
.ant-modal:has(.wand-task-library-dialog-wide) { width: min(1040px, calc(100vw - 32px)) !important; }
.wand-task-library-dialog .ant-modal-body {
  max-height: calc(100dvh - 180px - var(--wand-safe-top, 0px) - var(--wand-safe-bottom, 0px));
  overflow: auto;
}
.wand-task-library-dialog.is-expanded .task-board-create-body-input { min-height: 40dvh; }
/* 正文（新建会话的执行主体列表、快捷提交的改动清单）远比弹窗高，底部操作必须一直可见，
   否则用户要滚 1200px+ 才能看到「启动会话 / 仅提交」。sticky 在滚动容器内生效，只钉不搬家。 */
.wand-task-library-dialog .wand-dialog-sticky-actions {
  position: sticky; bottom: 0; z-index: 2; margin-top: 4px; padding-block: 8px;
  background: var(--bg-elevated); border-top: 1px solid var(--border-subtle);
}
/* Task creation uses three quiet sections and a stable field grid. */
.task-board-create-library-dialog .ant-modal-body { scrollbar-gutter: stable; }
.task-board-create-library-dialog .wand-ui-select-trigger { justify-content: space-between; text-align: left; }
.task-board-create-library-dialog .task-board-create-form { display: flex; flex-direction: column; gap: 16px; }
.task-board-create-library-dialog textarea { resize: none; }
.task-board-create-library-dialog .task-board-form-section { min-width: 0; }
.task-board-create-library-dialog .task-board-form-section-title { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.task-board-create-library-dialog .task-board-create-properties,
.task-board-create-library-dialog .task-board-create-assign-controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.task-board-create-library-dialog .ant-form-item { min-width: 0; margin-bottom: 0; }
.task-board-create-library-dialog .ant-form-item-label { padding-bottom: 4px; }
.task-board-create-library-dialog .ant-form-item-label > label { font-size: 12px; color: var(--text-secondary); }
.task-board-create-library-dialog .wand-ui-select-trigger,
.task-board-create-library-dialog .ant-input,
.task-board-create-library-dialog .ant-select,
.task-board-create-library-dialog .ant-picker { width: 100%; min-height: 36px; }
.task-board-create-library-dialog .task-board-create-assign { border: 0; box-shadow: none; border-top: 1px solid var(--border-subtle); border-radius: 0; }
.task-board-create-library-dialog .task-board-create-assign > .ant-card-body { padding: 12px 0 0; }
.task-board-create-library-dialog .task-board-create-assign-copy > strong { font-size: 13px; }
.task-board-create-library-dialog .task-board-create-assign-copy > span { font-size: 12px; color: var(--text-secondary); }
.task-board-create-library-dialog .task-board-create-permission-note { margin-top: 12px; }
.task-board-create-library-dialog .task-board-create-footer { position: sticky; bottom: 0; z-index: 2; padding-block: 8px; background: var(--bg-elevated); border-top: 1px solid var(--border-subtle); }
.task-board-create-library-dialog .task-board-defaults-choice { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin-top: 12px; }
.task-board-create-library-dialog .task-board-defaults-choice > .ant-typography { font-size: 12px; }
.task-board-native-page .task-board-no-results { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 32px 16px; }
.task-board-native-page .task-board-no-results h2 { margin: 0; font-size: 15px; }
.task-board-native-page .task-board-no-results p { max-width: 360px; margin: 0 0 4px; font-size: 13px; }
@media (max-width: 560px) {
  .task-board-create-library-dialog .task-board-create-properties,
  .task-board-create-library-dialog .task-board-create-assign-controls { grid-template-columns: minmax(0, 1fr); }
}
`);
