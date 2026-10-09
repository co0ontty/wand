import { installStyleSheet } from "../styles";

/** Owned dialog sizing/scrolling only; Ant supplies all control and surface visuals. */
if (typeof document !== "undefined") installStyleSheet("wand-task-library-layout", String.raw`
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
.task-board-create-library-dialog .task-board-form-section-title { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.task-board-create-library-dialog .task-board-create-properties,
.task-board-create-library-dialog .task-board-create-assign-controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; }
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
.task-board-create-library-dialog .task-board-create-footer { position: sticky; bottom: 0; z-index: 2; padding-block: 10px; background: var(--bg-elevated); border-top: 1px solid var(--border-subtle); }
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
