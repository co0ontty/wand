/** Library visuals are installed by Ant Design/X. Only portal, safe-area,
 * layout and accessibility adaptations belong here. */
export const foundationStyles = String.raw`
#overlay-root { isolation: isolate; position: fixed; inset: 0; z-index: 20000; pointer-events: none; }
.wand-ui-mount { display: contents; }
.wand-ui-portals { position: fixed; inset: 0; pointer-events: none; }
/* Notification lists cover the viewport; only the actual notice owns clicks. */
.wand-ui-portals :is(.ant-modal-wrap, .ant-dropdown, .ant-dropdown-menu-submenu-popup, .ant-select-dropdown, .ant-popover, .ant-notification-notice) { pointer-events: auto; }
.wand-ui-dialog-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.wand-ui-dialog-description { white-space: pre-wrap; font-weight: normal; }
.wand-ui-dialog-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.wand-ui-switch-row { display: inline-flex; align-items: center; gap: 9px; }
.wand-ui-menu { display: flex; flex-direction: column; }
.wand-ui-menu-item { justify-content: flex-start; width: 100%; }
.wand-ui-menu-item-label { flex: 1; min-width: 0; text-align: start; }
.wand-ui-menu-item-hint, .wand-ui-dropdown-item-hint { margin-inline-start: auto; }
.wand-ui-badge { font-variant-numeric: tabular-nums; margin-inline-end: 0; }
.wand-ui-select-content { max-width: calc(100vw - var(--wand-safe-left, 0px) - var(--wand-safe-right, 0px) - 24px); }
.wand-ui-select-content .ant-dropdown-menu { max-height: min(360px, 60dvh); overflow-y: auto; overscroll-behavior: contain; }
.wand-ui-navigation-list { list-style: none; margin: 0; padding: 0; }
.wand-ui-navigation[data-orientation="horizontal"] .wand-ui-navigation-list { display: flex; }
.wand-ui-navigation-link { height: auto; justify-content: flex-start; text-align: start; }
.wand-ui-stretch-tabs { position: relative; isolation: isolate; }
.wand-ui-stretch-tabs .ant-segmented-thumb { visibility: hidden; }
.wand-ui-stretch-tabs .ant-segmented-item-selected { background: transparent; box-shadow: none; }
.wand-ui-stretch-tabs .ant-segmented-item { position: relative; z-index: 1; }
.wand-ui-stretch-indicator { position: absolute; z-index: 0; top: 2px; bottom: 2px; border-radius: inherit;
  background: var(--bg-elevated, #fffdfa); box-shadow: var(--shadow-sm); pointer-events: none;
  transition: left var(--motion-indicator) var(--ease-in-out-smooth), width var(--motion-indicator) var(--ease-in-out-smooth); }
`;

/** Shared keyframes and primitive-only responsive rules. */
export const sharedMotionStyles = String.raw`
@keyframes wand-ui-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes wand-ui-fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}

@keyframes wand-ui-dialog-in {
  from { opacity: 0; transform: translate(-50%, calc(-50% + 6px)); }
  to { opacity: 1; transform: translate(-50%, -50%); }
}

@keyframes wand-ui-dialog-out {
  from { opacity: 1; transform: translate(-50%, -50%); }
  to { opacity: 0; transform: translate(-50%, calc(-50% + 4px)); }
}

@keyframes wand-ui-scale-in {
  from { opacity: 0; transform: scale(0.98); }
  to { opacity: 1; transform: scale(1); }
}

@media (max-width: 520px) {
  .wand-ui-dialog-actions {
    flex-direction: column-reverse;
  }

  .wand-ui-dialog-actions .wand-ui-button {
    width: 100%;
  }
}


`;

/** Accessibility override intentionally remains last in the installed cascade. */
export const reducedMotionStyles = String.raw`
@media (prefers-reduced-motion: reduce) {
  /* The global duration blanket otherwise creates a transition of left/top on
     library popups. rc-trigger measures those coordinates synchronously. */
  :is(.ant-dropdown, .ant-dropdown-menu-submenu-popup, .ant-popover, .ant-picker-dropdown, .ant-select-dropdown) {
    transition-property: none !important;
    animation-duration: 0.01ms !important;
    transform: none !important;
  }
  .ant-modal { animation-duration: 0.01ms !important; transform: none !important; }
  #overlay-root *,
  #overlay-root *::before,
  #overlay-root *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`;
