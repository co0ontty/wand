/** Shared React UI primitives and overlay-root infrastructure. */
export const foundationStyles = String.raw`
#overlay-root {
  isolation: isolate;
  position: fixed;
  inset: 0;
  z-index: 20000;
  pointer-events: none;
}

.wand-ui-mount {
  display: contents;
}

.wand-ui-portals {
  position: fixed;
  inset: 0;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: var(--font-size-base);
  line-height: var(--line-height-base);
}

.wand-ui-button {
  appearance: none;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  box-sizing: border-box;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 36px;
  padding: 7px 14px;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  line-height: 1.2;
  transition: background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast), transform var(--transition-fast);
}

.wand-ui-button:hover:not(:disabled) {
  border-color: var(--border-default);
  background: var(--bg-elevated);
}

.wand-ui-button:active:not(:disabled) {
  transform: translateY(1px);
}

.wand-ui-button:focus-visible,
.wand-ui-select-trigger:focus-visible,
.wand-ui-switch:focus-visible,
.wand-ui-tabs-trigger:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--bg-primary), 0 0 0 4px var(--accent);
}

.wand-ui-button:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.wand-ui-button-primary {
  border-color: var(--accent-active);
  color: var(--text-inverse);
  background: var(--accent-active);
}

.wand-ui-button-primary:hover:not(:disabled) {
  border-color: var(--accent-active);
  background: var(--accent-active);
  filter: brightness(0.9);
}

.wand-ui-button-danger {
  border-color: var(--danger);
  color: var(--text-inverse);
  background: var(--danger);
}

.wand-ui-button-danger:hover:not(:disabled) {
  border-color: var(--danger);
  background: var(--danger);
  filter: brightness(0.9);
}

.wand-ui-button-outline,
.wand-ui-button-secondary {
  border-color: var(--border-default);
  background: var(--bg-secondary);
}

.wand-ui-button-ghost {
  color: var(--text-secondary);
  background: transparent;
}

.wand-ui-button-small {
  min-height: 30px;
  padding: 5px 10px;
  font-size: var(--font-size-xs);
}

.wand-ui-button-large {
  min-height: 42px;
  padding: 9px 18px;
  font-size: var(--font-size-base);
}

.wand-ui-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 0;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  pointer-events: auto;
}

.wand-ui-dialog-overlay[data-state="open"] {
  animation: wand-ui-fade-in var(--transition-normal);
}

.wand-ui-dialog-overlay[data-state="closed"] {
  animation: wand-ui-fade-out var(--transition-fast);
}

.wand-ui-dialog-content {
  position: fixed;
  z-index: 1;
  top: 50%;
  left: 50%;
  box-sizing: border-box;
  width: min(520px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 32px));
  max-height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 32px);
  overflow: auto;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: 20px;
  color: var(--text-primary);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-xl);
  transform: translate(-50%, -50%);
  pointer-events: auto;
}

.wand-ui-dialog-content[data-state="open"] {
  animation: wand-ui-dialog-in var(--transition-normal);
}

.wand-ui-dialog-content[data-state="closed"] {
  animation: wand-ui-dialog-out var(--transition-fast);
}

.wand-ui-dialog-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.wand-ui-dialog-icon {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-full);
  color: var(--info);
  background: var(--info-muted);
  font-weight: var(--font-weight-bold);
}

.wand-ui-dialog-icon-warning {
  color: var(--warning);
  background: var(--warning-muted);
}

.wand-ui-dialog-icon-danger {
  color: var(--danger);
  background: var(--danger-muted);
}

.wand-ui-dialog-icon-success {
  color: var(--success);
  background: var(--success-muted);
}

.wand-ui-dialog-icon-question {
  color: var(--accent);
  background: var(--accent-muted);
}

.wand-ui-dialog-heading {
  min-width: 0;
  flex: 1;
}

.wand-ui-dialog-title {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-tight);
}

.wand-ui-dialog-description {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  white-space: pre-wrap;
}

.wand-ui-dialog-body {
  margin-top: 16px;
}

.wand-ui-dialog-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 8px 11px;
  color: var(--text-primary);
  background: var(--bg-primary);
  font: inherit;
}

.wand-ui-dialog-input:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-muted);
}

.wand-ui-dialog-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

.wand-ui-toast-viewport {
  position: fixed;
  z-index: 20;
  top: calc(16px + var(--wand-safe-top));
  right: calc(16px + var(--wand-safe-right));
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-sizing: border-box;
  width: min(390px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 32px));
  margin: 0;
  padding: 0;
  list-style: none;
  pointer-events: none;
}

.wand-ui-toast {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px 12px;
  box-sizing: border-box;
  border: 1px solid var(--border-default);
  border-left: 3px solid var(--info);
  border-radius: var(--radius-md);
  padding: 12px 13px;
  color: var(--text-primary);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-lg);
  pointer-events: auto;
}

.wand-ui-toast[data-state="open"] {
  animation: wand-ui-toast-in var(--transition-spring);
}

.wand-ui-toast[data-state="closed"] {
  animation: wand-ui-toast-out var(--transition-fast);
}

.wand-ui-toast[data-swipe="move"] {
  transform: translateX(var(--radix-toast-swipe-move-x));
}

.wand-ui-toast[data-swipe="cancel"] {
  transform: translateX(0);
  transition: transform var(--transition-fast);
}

.wand-ui-toast[data-swipe="end"] {
  animation: wand-ui-toast-swipe-out var(--transition-fast);
}

.wand-ui-toast-success { border-left-color: var(--success); }
.wand-ui-toast-warning { border-left-color: var(--warning); }
.wand-ui-toast-error { border-left-color: var(--danger); }

.wand-ui-toast-title {
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.wand-ui-toast-description {
  grid-column: 1;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  white-space: pre-wrap;
}

.wand-ui-toast-close {
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: start;
  border: 0;
  border-radius: var(--radius-xs);
  padding: 2px 6px;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: var(--font-size-lg);
}

.wand-ui-toast-close:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.wand-ui-popover-content,
.wand-ui-select-content {
  z-index: 10;
  box-sizing: border-box;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 8px;
  color: var(--text-primary);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-lg);
}

.wand-ui-popover-content {
  width: min(320px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 24px));
}

.wand-ui-popover-content[data-state="open"],
.wand-ui-select-content[data-state="open"] {
  animation: wand-ui-scale-in var(--transition-fast);
}

.wand-ui-popover-arrow {
  fill: var(--bg-elevated);
}

.wand-ui-select-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  box-sizing: border-box;
  min-width: 160px;
  min-height: 38px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 7px 10px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  cursor: pointer;
  font: inherit;
  font-size: var(--font-size-sm);
}

.wand-ui-select-trigger[data-placeholder] {
  color: var(--text-muted);
}

.wand-ui-select-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.wand-ui-select-content {
  max-height: min(360px, var(--radix-select-content-available-height));
  min-width: var(--radix-select-trigger-width);
  overflow: hidden;
}

.wand-ui-select-viewport {
  padding: 2px;
}

.wand-ui-select-item {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 34px;
  border-radius: var(--radius-xs);
  padding: 5px 30px 5px 9px;
  color: var(--text-primary);
  cursor: default;
  font-size: var(--font-size-sm);
  user-select: none;
}

.wand-ui-select-item[data-highlighted] {
  outline: none;
  color: var(--accent);
  background: var(--accent-muted);
}

.wand-ui-select-item[data-disabled] {
  opacity: 0.45;
}

.wand-ui-select-indicator {
  position: absolute;
  right: 9px;
  color: var(--accent);
}

.wand-ui-select-scroll-button {
  display: grid;
  place-items: center;
  height: 24px;
  color: var(--text-muted);
}

.wand-ui-tabs-list {
  display: inline-flex;
  gap: 3px;
  border-radius: var(--radius-sm);
  padding: 3px;
  background: var(--bg-tertiary);
}

.wand-ui-tabs-trigger {
  border: 0;
  border-radius: var(--radius-xs);
  padding: 7px 11px;
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: var(--font-size-sm);
}

.wand-ui-tabs-trigger[data-state="active"] {
  color: var(--text-primary);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-xs);
}

.wand-ui-tabs-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.wand-ui-tabs-content {
  margin-top: 12px;
  outline: none;
}

.wand-ui-switch-row {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.wand-ui-switch {
  position: relative;
  flex: 0 0 auto;
  width: 42px;
  height: 24px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-full);
  padding: 0;
  background: var(--bg-tertiary);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}

.wand-ui-switch[data-state="checked"] {
  border-color: var(--accent);
  background: var(--accent);
}

.wand-ui-switch:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.wand-ui-switch-thumb {
  display: block;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-full);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-sm);
  transform: translateX(2px);
  transition: transform var(--transition-fast);
}

.wand-ui-switch-thumb[data-state="checked"] {
  transform: translateX(20px);
}


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
  from { opacity: 0; transform: translate(-50%, calc(-50% + 10px)) scale(0.98); }
  to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}

@keyframes wand-ui-dialog-out {
  from { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  to { opacity: 0; transform: translate(-50%, calc(-50% + 6px)) scale(0.99); }
}

@keyframes wand-ui-toast-in {
  from { opacity: 0; transform: translateX(18px) scale(0.98); }
  to { opacity: 1; transform: translateX(0) scale(1); }
}

@keyframes wand-ui-toast-out {
  from { opacity: 1; transform: translateX(0); }
  to { opacity: 0; transform: translateX(12px); }
}

@keyframes wand-ui-toast-swipe-out {
  from { transform: translateX(var(--radix-toast-swipe-end-x)); }
  to { transform: translateX(calc(100% + 16px)); }
}

@keyframes wand-ui-scale-in {
  from { opacity: 0; transform: scale(0.98); }
  to { opacity: 1; transform: scale(1); }
}

@media (max-width: 520px) {
  .wand-ui-dialog-content {
    width: calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 20px);
    max-height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 20px);
    border-radius: var(--radius-md);
    padding: 16px;
  }

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

