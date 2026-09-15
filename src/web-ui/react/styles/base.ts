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

/* Wand 的语义 badge 是「淡色底 + 同色文字」的 chip（见 ui/badge.tsx，它用
   Appica 的 soft 变体拿形状与排版）。Appica 的角色变体把 *-muted 底配
   *-foreground，而 Wand 的 *-foreground 是「实心色上的文字色」（白），
   落在 14% 的淡色底上不可读，所以颜色在这一层接管。

   Appica 的 soft 变体把底色画在 ::before（负 z-index）上，根元素的
   background 会被它盖住，因此底色必须写在 ::before 上，文字色写在根元素上。 */
.wand-ui-badge-accent {
  border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border-default));
  color: var(--accent-active);
}

.wand-ui-badge-accent::before { background: var(--accent-muted); }

.wand-ui-badge-info {
  border: 1px solid color-mix(in srgb, var(--info) 22%, var(--border-default));
  color: var(--info);
}

.wand-ui-badge-info::before { background: var(--info-muted); }

.wand-ui-badge-success {
  border: 1px solid color-mix(in srgb, var(--success) 22%, var(--border-default));
  color: var(--success);
}

.wand-ui-badge-success::before { background: var(--success-muted); }

.wand-ui-badge-warning {
  border: 1px solid color-mix(in srgb, var(--warning) 22%, var(--border-default));
  color: var(--warning);
}

.wand-ui-badge-warning::before { background: var(--warning-muted); }

/* Skeleton visuals now come from @appica/ui-react/skeleton (see ui/skeleton.tsx). */

.wand-ui-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 0;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  pointer-events: auto;
}

.wand-ui-dialog-overlay[data-open] {
  animation: wand-ui-fade-in var(--transition-normal);
}

.wand-ui-dialog-overlay[data-ending-style] {
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

.wand-ui-dialog-content[data-open] {
  animation: wand-ui-dialog-in var(--transition-normal);
}

.wand-ui-dialog-content[data-ending-style] {
  animation: wand-ui-dialog-out var(--transition-fast);
}

/* Appica 的 viewport 是 position: fixed 的整屏容器。position: fixed 本身就会新建
   stacking context（即使 z-index 是 auto），于是业务 dialog 的 z-index 阶梯只剩层内
   比较：设置弹层 overlay 30 会盖住自己 popup 的 31，弹层被自己的遮罩罩住。
   退回非定位盒后，backdrop 与 popup 继续在 #overlay-root 里按业务 z-index 排序，
   与迁移前完全一致。viewport 自身只做一个居中的空容器，不需要定位。 */
.wand-ui-dialog-viewport {
  position: static;
}

/* Appica 在 popup 和 children 之间包了一层 flex 容器（自带 pb-6 / overflow-hidden），
   而业务 dialog 自己管 padding、滚动和 flex/grid 高度。让它不参与布局，
   popup 的 DOM 形状就与迁移前一致。按 Appica 的 slot 属性匹配而不是弹层类名：
   多数业务弹层（设置、任务、新建会话…）的 className 会整个替换掉默认值，
   它们身上并没有 wand-ui-dialog-content。 */
[data-slot="dialog-popup"] > [data-slot="dialog-content"] {
  display: contents;
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
  /* 两行标题不要留一个孤字在末行 */
  text-wrap: balance;
}

.wand-ui-dialog-description {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-base);
  text-wrap: pretty;
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

/* 视口只管定位和宽度：堆叠位移、进出手势、淡出都由 Base UI 的
   Toast（--toast-index / --toast-swipe-movement-*）驱动。 */
.wand-ui-toast-viewport {
  position: fixed;
  z-index: 20;
  top: calc(16px + var(--wand-safe-top));
  right: calc(16px + var(--wand-safe-right));
  box-sizing: border-box;
  width: min(390px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 32px));
  margin: 0;
  padding: 0;
  list-style: none;
  pointer-events: none;
}

/* 网格布局由 Toast 自己（grid-template-areas）负责，这里只提供 Wand 的外观。 */
.wand-ui-toast {
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

.wand-ui-toast-success { border-left-color: var(--success); }
.wand-ui-toast-warning { border-left-color: var(--warning); }
.wand-ui-toast-error { border-left-color: var(--danger); }

.wand-ui-toast-title {
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.wand-ui-toast-description {
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  white-space: pre-wrap;
}

.wand-ui-toast-close {
  border: 0;
  border-radius: var(--radius-xs);
  padding: 2px;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
}

.wand-ui-toast-close:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.wand-ui-popover-content,
.wand-ui-select-content {
  z-index: 10;
  /* Floating layers are portalled under #overlay-root (pointer-events: none);
     re-enable hit testing on the content itself or menu items are unhittable. */
  pointer-events: auto;
  box-sizing: border-box;
  border: 1px solid var(--float-border);
  border-radius: var(--float-radius);
  padding: var(--float-pad);
  color: var(--text-primary);
  background: var(--float-bg-glass);
  box-shadow: var(--float-shadow);
  backdrop-filter: blur(20px) saturate(125%);
  -webkit-backdrop-filter: blur(20px) saturate(125%);
}

.wand-ui-popover-content {
  width: min(320px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 24px));
  transform-origin: var(--transform-origin);
}

.wand-ui-select-content {
  transform-origin: var(--transform-origin);
}

@media (prefers-reduced-transparency: reduce) {
  .wand-ui-popover-content,
  .wand-ui-select-content {
    background: var(--float-bg);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}

.wand-ui-popover-arrow {
  fill: var(--bg-elevated);
}

.wand-ui-select-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
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
  transition: background var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.wand-ui-select-trigger:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-tertiary);
}

.wand-ui-select-trigger[data-placeholder] {
  color: var(--text-muted);
}

.wand-ui-select-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.wand-ui-select-content {
  max-height: min(360px, var(--available-height));
  min-width: var(--anchor-width);
  overflow: hidden;
}

.wand-ui-select-viewport {
  padding: 0;
}

.wand-ui-select-content.wand-ui-select-searchable {
  display: flex;
  flex-direction: column;
  min-width: max(var(--anchor-width, 0px), 220px);
}

.wand-ui-select-search {
  position: relative;
  flex: 0 0 auto;
  padding: 0 0 6px;
}

/* 图标现在是输入框的内联前置插槽（Appica 的 startSlot），不再绝对定位。 */
.wand-ui-select-search-icon {
  flex: 0 0 auto;
  color: var(--text-muted);
  pointer-events: none;
  transition: color var(--transition-fast);
}

.wand-ui-select-search:focus-within .wand-ui-select-search-icon {
  color: var(--accent);
}

.wand-ui-select-search-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 32px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 6px 10px;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--bg-secondary) 70%, transparent);
  font: inherit;
  font-size: var(--font-size-sm);
  outline: none;
  transition: border-color var(--transition-fast), background var(--transition-fast), box-shadow var(--transition-fast);
}

.wand-ui-select-search-input::placeholder {
  color: var(--text-muted);
}

.wand-ui-select-search-input:focus {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border-default));
  background: var(--bg-secondary);
  box-shadow: 0 0 0 2px var(--accent-muted);
}

.wand-ui-select-searchable .wand-ui-select-viewport {
  max-height: min(260px, calc(var(--available-height, 70vh) - 58px));
  overflow-y: auto;
  overscroll-behavior: contain;
}

.wand-ui-select-empty {
  padding: 14px 10px;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  text-align: center;
}

.wand-ui-select-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  min-height: var(--menu-item-height);
  border: 0;
  border-radius: var(--menu-item-radius);
  padding: var(--menu-item-padding);
  color: var(--text-primary);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: var(--menu-item-font-size);
  line-height: 1.3;
  text-align: left;
  user-select: none;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.wand-ui-select-item[data-highlighted] {
  outline: none;
  color: var(--accent-active);
  background: var(--accent-muted);
}

.wand-ui-select-item:active:not([data-disabled]) {
  background: color-mix(in srgb, var(--accent-muted) 70%, var(--bg-tertiary));
}

.wand-ui-select-item[data-disabled] {
  opacity: 0.45;
  cursor: not-allowed;
}

.wand-ui-select-item[data-selected] {
  color: var(--accent-active);
  font-weight: var(--font-weight-semibold);
}

/* ── 通用菜单行 ────────────────────────────────────────────────
   浮层里的「一行可点东西」只有这一个实现（WandMenuItem）。
   图标 / 主标签 / 右侧提示 三段式布局，行高、圆角、字号全部取
   --menu-* token，业务层不要再写自己的 .xxx-menu-item。 */
.wand-ui-menu {
  display: flex;
  flex-direction: column;
  gap: var(--menu-item-gap);
  min-width: 168px;
}

.wand-ui-menu-item {
  display: flex;
  align-items: center;
  gap: 9px;
  box-sizing: border-box;
  width: 100%;
  min-height: var(--menu-item-height);
  border: 0;
  border-radius: var(--menu-item-radius);
  padding: var(--menu-item-padding);
  color: var(--text-primary);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: var(--menu-item-font-size);
  font-weight: 500;
  line-height: 1.3;
  text-align: left;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.wand-ui-menu-item:hover:not(:disabled),
.wand-ui-menu-item:focus-visible {
  outline: none;
  color: var(--accent-active);
  background: var(--accent-muted);
}

.wand-ui-menu-item:active:not(:disabled) {
  background: color-mix(in srgb, var(--accent-muted) 70%, var(--bg-tertiary));
}

.wand-ui-menu-item:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.wand-ui-menu-item:disabled:hover {
  color: var(--text-primary);
  background: transparent;
}

.wand-ui-menu-item-icon {
  flex: 0 0 auto;
  color: currentColor;
  opacity: var(--menu-item-icon-opacity);
}

.wand-ui-menu-item:hover:not(:disabled) .wand-ui-menu-item-icon,
.wand-ui-menu-item:focus-visible .wand-ui-menu-item-icon {
  opacity: 1;
}

.wand-ui-menu-item-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wand-ui-menu-item-hint {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

.wand-ui-menu-item-danger {
  color: var(--danger);
}

.wand-ui-menu-item-danger:hover:not(:disabled),
.wand-ui-menu-item-danger:focus-visible {
  color: var(--danger-hover);
  background: var(--danger-muted);
}

.wand-ui-menu-separator {
  height: 1px;
  margin: 3px 6px;
  border: 0;
  background: var(--border-subtle);
}

.wand-ui-menu-label {
  padding: 6px 10px 4px;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.03em;
}

/* Tabs visuals now come from @appica/ui-react/tabs (see ui/tabs.tsx). */

.wand-ui-switch-row {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

/* Switch visuals now come from @appica/ui-react/switch (see ui/switch.tsx). */


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
