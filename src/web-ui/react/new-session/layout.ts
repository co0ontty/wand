import { installStyleSheet } from "../styles.js";

/** Form geometry only; the shared Ant controls and theme own interactive states. */
if (typeof document !== "undefined") installStyleSheet("wand-new-session-layout", String.raw`
.wand-new-session-library-dialog .ant-modal-body { scroll-padding-top: 180px; scroll-padding-bottom: 64px; }
.wand-new-session-summary {
  position: sticky; top: 0; z-index: 2; padding: 10px 0;
  background: var(--bg-elevated); border-bottom: 1px solid var(--border-subtle);
}
.wand-new-session-summary dl { display: grid; gap: 4px; margin: 0; font-size: 12px; }
.wand-new-session-summary dl > div { display: grid; grid-template-columns: 60px minmax(0, 1fr); gap: 8px; }
.wand-new-session-summary dt { color: var(--text-secondary); }
.wand-new-session-summary dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.wand-new-session-summary .wand-new-session-permission-warning { color: var(--danger); }
.wand-new-session-summary .wand-new-session-permission-detail { margin: 6px 0 0; font-size: 12px; line-height: 1.5; }
.wand-new-session-library-dialog .ant-input-affix-wrapper,
.wand-new-session-library-dialog .ant-input:not(.ant-input-affix-wrapper .ant-input),
.wand-new-session-library-dialog .wand-ui-select-trigger { min-height: 36px; }
.wand-new-session-library-dialog .ant-form-item { margin-bottom: 12px; }
.wand-new-session-primary-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.wand-new-session-primary-fields.is-single { grid-template-columns: minmax(0, 1fr); }
.wand-new-session-primary-fields .ant-form-item { margin-bottom: 0; }
.wand-execution-subject-picker .wand-ui-search { margin-bottom: 12px; }
.wand-execution-subject-picker .ant-form-item { margin-bottom: 0; }
.wand-execution-subject-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 12px; }
.wand-execution-subject-grid .ant-radio-wrapper { margin: 0; min-width: 0; padding-block: 4px; align-items: center; }
.wand-execution-subject-grid .ant-radio-wrapper > span:last-child { flex: 1; min-width: 0; }
.wand-execution-subject-label .ant-typography { font-size: 12px; }
.wand-execution-subject-label > svg, .wand-execution-subject-label > img { flex-shrink: 0; }
.wand-new-session-logo-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 8px; }
@media (max-width: 540px) {
  .wand-execution-subject-grid, .wand-new-session-primary-fields { grid-template-columns: minmax(0, 1fr); }
  .wand-new-session-logo-bar { flex-wrap: wrap; }
}
@media (pointer: coarse) {
  .wand-execution-subject-grid .ant-radio-wrapper { min-height: 44px; }
  .wand-new-session-logo-toggle { min-width: 44px; min-height: 44px; }
}
`);
