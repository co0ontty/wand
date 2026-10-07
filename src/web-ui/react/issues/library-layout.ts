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
`);
