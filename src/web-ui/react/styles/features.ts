/** Settings and Quick Commit business presentation. */
export const settingsAndQuickCommitStyles = String.raw`
.wand-settings-overlay,
.wand-settings-nested-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-overlay);
  backdrop-filter: blur(5px);
  pointer-events: auto;
}

.wand-settings-overlay { z-index: 30; }
.wand-settings-nested-overlay { z-index: 40; }

.wand-settings-dialog,
.wand-settings-nested-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 31;
  box-sizing: border-box;
  color: var(--text-primary);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-xl);
  transform: translate(-50%, -50%);
  pointer-events: auto;
}

.wand-settings-dialog {
  display: flex;
  flex-direction: column;
  width: min(1120px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 40px));
  height: min(820px, calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 40px));
  min-height: 520px;
  overflow: hidden;
  border-radius: var(--radius-lg);
}

.wand-settings-nested-dialog {
  z-index: 41;
  display: flex;
  flex-direction: column;
  width: min(760px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 32px));
  max-height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 32px);
  overflow: auto;
  border-radius: var(--radius-lg);
  padding-bottom: 18px;
}

.wand-settings-dialog[data-state="open"],
.wand-settings-nested-dialog[data-state="open"] {
  animation: wand-ui-dialog-in var(--transition-normal);
}

.wand-settings-header {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  border-bottom: 1px solid var(--border-subtle);
  padding: 18px 20px;
}

.wand-settings-title {
  margin: 0;
  font-size: var(--font-size-xl);
  line-height: var(--line-height-tight);
}

.wand-settings-description,
.wand-settings-panel-heading p,
.wand-settings-section-heading p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.wand-settings-loading,
.wand-settings-load-error {
  display: grid;
  flex: 1;
  place-content: center;
  justify-items: center;
  gap: 14px;
  padding: 28px;
  color: var(--text-secondary);
}

.wand-settings-readonly {
  flex: 0 0 auto;
  margin: 12px 18px 0;
  border: 1px solid var(--warning);
  border-radius: var(--radius-sm);
  padding: 9px 12px;
  color: var(--text-secondary);
  background: var(--warning-muted);
  font-size: var(--font-size-sm);
}

.wand-settings-tabs {
  display: grid;
  grid-template-columns: 238px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.wand-settings-tabs > .wand-ui-tabs-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-sizing: border-box;
  overflow: auto;
  border-right: 1px solid var(--border-subtle);
  padding: 14px 12px;
  background: var(--bg-secondary);
}

.wand-settings-tabs > .wand-ui-tabs-list .wand-ui-tabs-trigger {
  min-height: 54px;
  padding: 9px 11px;
  text-align: left;
}

.wand-settings-tab-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.wand-settings-tab-label strong {
  color: inherit;
  font-size: var(--font-size-sm);
}

.wand-settings-tab-label span {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wand-settings-tabs > .wand-ui-tabs-content {
  grid-column: 2;
  min-width: 0;
  min-height: 0;
  margin: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.wand-ui-popover-content.wand-shell-menu-popover {
  width: auto;
  padding: 4px;
}

.wand-settings-panel {
  box-sizing: border-box;
  width: 100%;
  max-width: 860px;
  margin: 0 auto;
  padding: 22px 24px 34px;
}

.wand-settings-panel-heading {
  margin-bottom: 20px;
}

.wand-settings-panel-heading h2,
.wand-settings-section-heading h3 {
  margin: 0;
  color: var(--text-primary);
}

.wand-settings-panel-heading h2 { font-size: var(--font-size-lg); }
.wand-settings-section-heading h3 { font-size: var(--font-size-base); }

.wand-settings-section {
  margin-bottom: 16px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  box-shadow: var(--shadow-xs);
}

.wand-settings-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--border-subtle);
  padding: 14px 16px;
}

.wand-settings-section-action { flex: 0 0 auto; }

.wand-settings-section-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
}

.wand-settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.wand-settings-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.wand-settings-field > label,
.wand-settings-file-grid label > span {
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.wand-settings-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  color: var(--text-primary);
  background: var(--bg-primary);
  font: inherit;
  font-size: var(--font-size-sm);
}

.wand-settings-input:focus,
.wand-settings-range:focus-visible,
.wand-settings-file-grid input:focus-visible {
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-muted);
}

.wand-settings-input[aria-invalid="true"] { border-color: var(--danger); }

.wand-settings-select .wand-ui-select-trigger { width: 100%; }

.wand-settings-field-hint,
.wand-settings-field-error,
.wand-settings-file-grid small {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}

.wand-settings-field-error { color: var(--danger); }

.wand-settings-toggle-row,
.wand-settings-download-row,
.wand-settings-cli-list > div,
.wand-settings-about-list > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}

.wand-settings-toggle-row > div,
.wand-settings-download-row > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.wand-settings-toggle-row strong,
.wand-settings-download-row strong { font-size: var(--font-size-sm); }
.wand-settings-toggle-row span,
.wand-settings-download-row span,
.wand-settings-cli-list span { color: var(--text-secondary); font-size: var(--font-size-xs); }

.wand-settings-status {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 9px 11px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  font-size: var(--font-size-sm);
  white-space: pre-wrap;
}

.wand-settings-status-success { border-color: var(--success); background: var(--success-muted); }
.wand-settings-status-warning { border-color: var(--warning); background: var(--warning-muted); }
.wand-settings-status-error { border-color: var(--danger); background: var(--danger-muted); }

.wand-settings-save-bar {
  position: sticky;
  bottom: -34px;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin: 18px -24px -34px;
  border-top: 1px solid var(--border-default);
  padding: 13px 24px calc(13px + var(--wand-safe-bottom));
  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
  backdrop-filter: blur(12px);
}

.wand-settings-save-bar .wand-settings-status { flex: 1; }

.wand-settings-button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.wand-settings-about-list,
.wand-settings-cli-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
}

.wand-settings-about-list > div,
.wand-settings-cli-list > div {
  border-bottom: 1px solid var(--border-subtle);
  padding-bottom: 9px;
}

.wand-settings-about-list > div:last-child,
.wand-settings-cli-list > div:last-child { border-bottom: 0; padding-bottom: 0; }
.wand-settings-about-list dt { color: var(--text-secondary); }
.wand-settings-about-list dd { margin: 0; max-width: 70%; overflow-wrap: anywhere; text-align: right; }

.wand-settings-connect-code {
  display: block;
  overflow: auto;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 10px;
  color: var(--text-primary);
  background: var(--bg-primary);
  font-size: var(--font-size-xs);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.wand-settings-qr-dialog { align-items: stretch; }
.wand-settings-qr-dialog canvas { align-self: center; max-width: calc(100% - 32px); height: auto; margin: 18px; border-radius: var(--radius-sm); }
.wand-settings-qr-dialog .wand-settings-connect-code { margin: 0 18px; }

.wand-settings-env-toolbar {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(240px, 1fr);
  gap: 14px;
  padding: 16px 18px;
}

.wand-settings-env-list {
  min-height: 180px;
  max-height: 55vh;
  margin: 0 18px;
  overflow: auto;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}

.wand-settings-env-row {
  display: grid;
  grid-template-columns: minmax(140px, .45fr) minmax(0, 1fr);
  gap: 12px;
  border-bottom: 1px solid var(--border-subtle);
  padding: 8px 10px;
  font-size: var(--font-size-xs);
}

.wand-settings-env-row span { overflow: hidden; color: var(--text-secondary); text-overflow: ellipsis; white-space: nowrap; }

.wand-settings-range { width: 100%; accent-color: var(--accent); }

.wand-settings-radio-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin: 0;
  border: 0;
  padding: 0;
}
.wand-settings-radio-group legend { width: 100%; margin-bottom: 4px; font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }
.wand-settings-radio-group label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.wand-settings-radio-group input { accent-color: var(--accent); }

.wand-settings-preset-list { display: grid; gap: 10px; }
.wand-settings-preset { display: flex; flex-direction: column; gap: 5px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); padding: 12px 14px; background: var(--bg-secondary); }
.wand-settings-preset code { color: var(--text-secondary); overflow-wrap: anywhere; }
.wand-settings-preset span { color: var(--text-muted); font-size: var(--font-size-xs); }

.wand-settings-empty { padding: 20px; color: var(--text-muted); text-align: center; font-size: var(--font-size-sm); }

.wand-settings-security-form { display: flex; flex-direction: column; gap: 14px; }
.wand-settings-file-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.wand-settings-file-grid label { display: flex; flex-direction: column; gap: 7px; border: 1px dashed var(--border-default); border-radius: var(--radius-sm); padding: 12px; }
.wand-settings-file-grid input { max-width: 100%; color: var(--text-secondary); font-size: var(--font-size-xs); }

.wand-quick-overlay {
  position: fixed;
  inset: 0;
  z-index: 0;
  background: rgba(20, 14, 8, 0.34);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  pointer-events: auto;
}

.wand-quick-dialog {
  position: fixed;
  z-index: 1;
  top: 50%;
  left: 50%;
  box-sizing: border-box;
  display: flex;
  width: min(720px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 32px));
  max-height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 32px);
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.58);
  border-radius: 24px;
  color: var(--text-primary);
  background: rgba(255, 252, 247, 0.94);
  box-shadow: var(--shadow-xl);
  transform: translate(-50%, -50%);
  pointer-events: auto;
  backdrop-filter: blur(36px) saturate(165%);
  -webkit-backdrop-filter: blur(36px) saturate(165%);
}

.wand-quick-dialog[data-state="open"] { animation: wand-ui-dialog-in var(--transition-normal); }
.wand-quick-dialog[data-state="closed"] { animation: wand-ui-dialog-out var(--transition-fast); }

.wand-quick-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 21px 22px 17px;
  border-bottom: 1px solid var(--border-subtle);
}

.wand-quick-title {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--font-size-xl);
  line-height: var(--line-height-tight);
}

.wand-quick-description {
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.wand-quick-header > .wand-ui-button {
  flex: 0 0 auto;
  width: 32px;
  min-width: 32px;
  min-height: 32px;
  padding: 0;
  border-radius: var(--radius-full);
}

.wand-quick-loading {
  padding: 42px 24px;
  color: var(--text-secondary);
  text-align: center;
}

.wand-quick-form {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.wand-quick-body {
  display: grid;
  min-height: 0;
  gap: 17px;
  overflow-y: auto;
  padding: 18px 22px 20px;
}

.wand-quick-files,
.wand-quick-editor,
.wand-quick-actions {
  min-width: 0;
  margin: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.48);
}

.wand-quick-actions { padding: 14px; }

.wand-quick-section-heading {
  display: flex;
  min-height: 35px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 11px;
  border-bottom: 1px solid var(--border-subtle);
}

.wand-quick-section-heading h3,
.wand-quick-actions legend {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.wand-quick-section-heading > span {
  min-width: 22px;
  border-radius: var(--radius-full);
  padding: 2px 7px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  font-size: var(--font-size-xs);
  text-align: center;
}

.wand-quick-file-list {
  display: grid;
  max-height: 148px;
  margin: 0;
  overflow-y: auto;
  padding: 5px 0;
  list-style: none;
}

.wand-quick-file-list li {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
  padding: 5px 11px;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.wand-quick-file-list li:hover { background: rgba(125, 91, 57, 0.05); }

.wand-quick-file-badge {
  display: inline-flex;
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-weight: var(--font-weight-bold);
}

.wand-quick-file-badge-added,
.wand-quick-file-badge-untracked { color: var(--success); background: var(--success-muted); }
.wand-quick-file-badge-modified { color: var(--warning); background: var(--warning-muted); }
.wand-quick-file-badge-deleted { color: var(--danger); background: var(--danger-muted); }
.wand-quick-file-badge-renamed { color: var(--info); background: var(--info-muted); }
.wand-quick-file-badge-ignored { color: var(--text-muted); }

.wand-quick-file-path {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wand-quick-submodule-badge {
  flex: 0 0 auto;
  border-radius: var(--radius-full);
  padding: 2px 7px;
  color: var(--info);
  background: var(--info-muted);
  font-size: 10px;
}

.wand-quick-empty {
  margin: 0;
  padding: 17px 12px;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  text-align: center;
}

.wand-quick-editor { padding-bottom: 12px; }
.wand-quick-editor .wand-quick-section-heading { margin-bottom: 12px; }

.wand-quick-field {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  align-items: start;
  gap: 12px;
  padding: 5px 12px;
}

.wand-quick-field > span {
  padding-top: 9px;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.wand-quick-field input,
.wand-quick-field textarea {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 9px 11px;
  color: var(--text-primary);
  background: var(--bg-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-base);
  resize: vertical;
}

.wand-quick-field input:focus,
.wand-quick-field textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-muted);
}

.wand-quick-actions legend { padding: 0 5px; }

.wand-quick-action-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.wand-quick-action-grid label {
  position: relative;
  display: grid;
  gap: 3px;
  min-width: 0;
  cursor: pointer;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 10px 12px 10px 36px;
  background: var(--bg-primary);
  transition: border-color var(--transition-fast), background var(--transition-fast), box-shadow var(--transition-fast);
}

.wand-quick-action-grid label:hover { border-color: var(--border-strong); }
.wand-quick-action-grid label.is-selected { border-color: var(--accent); background: var(--accent-muted); }
.wand-quick-action-grid label:focus-within { box-shadow: 0 0 0 2px var(--bg-primary), 0 0 0 4px var(--accent); }

.wand-quick-action-grid input {
  position: absolute;
  top: 13px;
  left: 13px;
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--accent-active);
}

.wand-quick-action-grid strong { font-size: var(--font-size-sm); }
.wand-quick-action-grid span { color: var(--text-muted); font-size: var(--font-size-xs); }

.wand-quick-submodule-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-top: 11px;
  padding: 10px 11px;
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
}

.wand-quick-submodule-toggle > div:first-child { display: grid; gap: 2px; }
.wand-quick-submodule-toggle strong { font-size: var(--font-size-sm); }
.wand-quick-submodule-toggle span { color: var(--text-muted); font-size: var(--font-size-xs); }

.wand-quick-error {
  margin: 0;
  border-radius: var(--radius-sm);
  padding: 9px 11px;
  color: var(--danger);
  background: var(--danger-muted);
  font-size: var(--font-size-sm);
}

.wand-quick-footer {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 22px calc(13px + var(--wand-safe-bottom));
  border-top: 1px solid var(--border-subtle);
  background: rgba(255, 252, 247, 0.9);
}

.wand-quick-footer > span { color: var(--text-muted); font-size: var(--font-size-xs); }
.wand-quick-footer > div { display: flex; gap: 8px; }

.wand-quick-result {
  display: grid;
  gap: 13px;
  overflow-y: auto;
  padding: 22px;
}

.wand-quick-result-pair {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}

.wand-quick-result-label { color: var(--text-muted); font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }

.wand-quick-result-flow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 11px;
}

.wand-quick-result-flow > div {
  min-width: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 10px;
  background: var(--bg-secondary);
}

.wand-quick-result-flow > span { color: var(--text-muted); }
.wand-quick-value-stack { display: grid; min-width: 0; gap: 4px; }
.wand-quick-value-stack > span { overflow: hidden; color: var(--text-secondary); font-size: var(--font-size-xs); text-overflow: ellipsis; white-space: nowrap; }
.wand-quick-result code { color: var(--accent-active); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--font-size-sm); }
.wand-quick-muted { color: var(--text-muted); font-size: var(--font-size-sm); }
.wand-quick-result-note { margin: 0; color: var(--text-secondary); font-size: var(--font-size-sm); }

.wand-quick-result-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

.wand-quick-pushed { color: var(--success); font-size: var(--font-size-sm); font-weight: var(--font-weight-semibold); }


`;

/** New Session, Folder Picker and Worktree business presentation. */
export const sessionPickerAndWorktreeStyles = String.raw`
.wand-new-session-overlay {
  position: fixed;
  inset: 0;
  z-index: 0;
  background: rgba(20, 14, 8, 0.34);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  pointer-events: auto;
}

.wand-new-session-dialog {
  position: fixed;
  z-index: 1;
  top: 50%;
  left: 50%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: min(560px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 32px));
  max-height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 32px);
  overflow: hidden;
  border: 0.5px solid rgba(255, 255, 255, 0.6);
  border-radius: 26px;
  color: var(--text-primary);
  background: rgba(255, 252, 247, 0.88);
  box-shadow: var(--shadow-xl);
  transform: translate(-50%, -50%);
  pointer-events: auto;
  backdrop-filter: blur(40px) saturate(180%);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
}

.wand-new-session-dialog[data-state="open"] {
  animation: wand-ui-dialog-in var(--transition-normal);
}

.wand-new-session-dialog[data-state="closed"] {
  animation: wand-ui-dialog-out var(--transition-fast);
}

.wand-new-session-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  min-height: 56px;
  padding: 18px 22px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.wand-new-session-header > div {
  min-width: 0;
}

.wand-new-session-header > .wand-ui-button {
  flex: 0 0 auto;
  width: 32px;
  min-width: 32px;
  min-height: 32px;
  padding: 0;
  border-radius: var(--radius-full);
}

.wand-new-session-title {
  margin: 0;
  color: var(--text-primary);
  font-size: 1.3125rem;
  font-weight: 700;
  letter-spacing: -0.022em;
  line-height: 1.2;
}

.wand-new-session-description {
  max-width: 44ch;
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: 0.8125rem;
  font-weight: 400;
  line-height: 1.5;
}

.wand-new-session-form {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.wand-new-session-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 28px;
}

.wand-new-session-field {
  margin-bottom: 14px;
}

.wand-new-session-field:last-of-type {
  margin-bottom: 16px;
}

.wand-new-session-fieldset {
  min-width: 0;
  padding: 0;
  border: 0;
}

.wand-new-session-field-label {
  display: block;
  margin-bottom: 8px;
  padding: 0;
  color: var(--text-secondary);
  font-size: 0.8125rem;
  font-weight: 600;
}

.wand-new-session-field-hint {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.wand-new-session-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.wand-new-session-choice {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  border: 1px solid rgba(125, 91, 57, 0.1);
  border-radius: 12px;
  padding: 12px 10px;
  color: inherit;
  background: rgba(255, 255, 255, 0.6);
  box-shadow: 0 1px 2px rgba(125, 91, 57, 0.03);
  cursor: pointer;
  outline: none;
  text-align: center;
  transition: background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}

.wand-new-session-choice:hover {
  border-color: rgba(125, 91, 57, 0.2);
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 4px 12px rgba(125, 91, 57, 0.08);
  transform: translateY(-1px);
}

.wand-new-session-choice.active {
  border: 0.5px solid rgba(255, 255, 255, 0.8);
  background: linear-gradient(180deg, rgba(255, 252, 247, 0.95) 0%, rgba(255, 240, 224, 0.82) 100%);
  box-shadow:
    0 0 0 1px rgba(197, 101, 61, 0.32),
    0 0 0 4px rgba(197, 101, 61, 0.14),
    0 8px 22px -4px rgba(197, 101, 61, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.95),
    inset 0 -1px 0 rgba(197, 101, 61, 0.08);
  transform: none;
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
}

.wand-new-session-choice:focus-visible:not(.active) {
  border-color: var(--accent);
  box-shadow: 0 0 0 1.5px var(--accent-muted);
}

.wand-new-session-choice-label {
  color: var(--text-primary);
  font-size: 0.8rem;
  font-weight: 600;
  line-height: 1.3;
}

.wand-new-session-choice-description {
  color: var(--text-muted);
  font-size: 0.68rem;
  line-height: 1.3;
}

.wand-new-session-choice.active .wand-new-session-choice-label {
  color: var(--accent);
}

.wand-new-session-choice.disabled {
  cursor: not-allowed;
  opacity: 0.45;
  pointer-events: none;
}

.wand-new-session-choice.disabled:hover {
  border-color: rgba(125, 91, 57, 0.2);
  background: rgba(255, 255, 255, 0.6);
}

.wand-new-session-choice.disabled .wand-new-session-choice-label,
.wand-new-session-choice.disabled .wand-new-session-choice-description {
  color: var(--text-muted);
}

.wand-new-session-choice.active.disabled {
  box-shadow: none;
}

.wand-new-session-suggestions-wrap {
  position: relative;
}

.wand-new-session-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 44px;
  border: 1px solid rgba(125, 91, 57, 0.14);
  border-radius: 12px;
  padding: 11px 14px;
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.78);
  box-shadow: inset 0 1px 1.5px rgba(125, 91, 57, 0.04);
  font-family: var(--font-mono);
  font-size: 0.875rem;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}

.wand-new-session-input:hover {
  border-color: rgba(125, 91, 57, 0.24);
  background: rgba(255, 255, 255, 0.92);
}

.wand-new-session-input:focus {
  border-color: var(--accent);
  background: #ffffff;
  box-shadow: inset 0 1px 1.5px rgba(125, 91, 57, 0.04), 0 0 0 3px var(--accent-muted);
}

.wand-new-session-input::placeholder {
  color: var(--text-muted);
}

.wand-new-session-suggestions {
  position: absolute;
  z-index: 50;
  top: calc(100% + 4px);
  right: 0;
  left: 0;
  max-height: 200px;
  overflow: hidden;
  border: 1px solid rgba(125, 91, 57, 0.14);
  border-radius: 12px;
  background: rgba(255, 252, 247, 0.96);
  box-shadow: 0 0 0 0.5px rgba(125, 91, 57, 0.05), 0 12px 28px -8px rgba(20, 14, 8, 0.18);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
}

.wand-new-session-suggestion {
  width: 100%;
  border: 0;
  padding: 10px 12px;
  color: var(--text-primary);
  background: transparent;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  text-align: left;
  transition: background var(--transition-fast);
}

.wand-new-session-suggestion:hover {
  background: rgba(232, 197, 174, 0.32);
}

.wand-new-session-suggestion small {
  display: block;
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 0.6875rem;
}

.wand-new-session-suggestion-path {
  display: block;
  font-family: var(--font-mono);
}

.wand-new-session-recent-paths {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}

.wand-new-session-recent-path {
  display: inline-flex;
  align-items: center;
  max-width: 180px;
  overflow: hidden;
  border: 1px solid rgba(125, 91, 57, 0.12);
  border-radius: 999px;
  padding: 2px 10px;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.55);
  box-shadow: 0 1px 2px rgba(125, 91, 57, 0.03);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  white-space: nowrap;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.16s ease;
}

.wand-new-session-recent-path:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: #fff7ef;
  transform: translateY(-1px);
}

.wand-new-session-recent-path-value {
  min-width: 0;
  max-width: 100%;
}

.wand-new-session-worktree {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: rgba(125, 91, 57, 0.04);
}

.wand-new-session-worktree > div:first-child {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.wand-new-session-worktree strong {
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.wand-new-session-worktree span {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--line-height-base);
}

.wand-new-session-worktree .wand-ui-switch-row {
  flex: 0 0 auto;
}

.wand-new-session-footer {
  display: block;
  flex: 0 0 auto;
  padding: 16px 28px 22px;
  border-top: 1px solid rgba(125, 91, 57, 0.08);
}

.wand-new-session-submit {
  width: 100%;
}

.wand-new-session-error {
  margin: 8px 0 0;
  border: 1px solid rgba(178, 79, 69, 0.2);
  border-radius: 10px;
  padding: 10px 12px;
  color: var(--danger);
  background: rgba(178, 79, 69, 0.1);
  font-size: 0.75rem;
  animation: wand-new-session-shake 0.3s ease;
}

@keyframes wand-new-session-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-4px); }
  75% { transform: translateX(4px); }
}

.wand-new-session-loading,
.wand-new-session-load-error {
  padding: 28px;
  color: var(--text-secondary);
  text-align: center;
}

.wand-new-session-load-error p {
  margin: 0 0 14px;
  color: var(--danger);
}

.wand-folder-picker-overlay {
  position: fixed;
  inset: 0;
  z-index: 0;
  background: rgba(20, 14, 8, 0.34);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  pointer-events: auto;
}

.wand-folder-picker-dialog {
  position: fixed;
  z-index: 1;
  top: 50%;
  left: 50%;
  box-sizing: border-box;
  display: flex;
  width: min(620px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 32px));
  max-height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 32px);
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.6);
  border-radius: 24px;
  color: var(--text-primary);
  background: rgba(255, 252, 247, 0.94);
  box-shadow: var(--shadow-xl);
  transform: translate(-50%, -50%);
  pointer-events: auto;
  backdrop-filter: blur(34px) saturate(165%);
  -webkit-backdrop-filter: blur(34px) saturate(165%);
}

.wand-folder-picker-dialog[data-state="open"] { animation: wand-ui-dialog-in var(--transition-normal); }
.wand-folder-picker-dialog[data-state="closed"] { animation: wand-ui-dialog-out var(--transition-fast); }

.wand-folder-picker-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--border-subtle);
  padding: 20px 22px 16px;
}

.wand-folder-picker-header > .wand-ui-button {
  flex: 0 0 auto;
  width: 32px;
  min-width: 32px;
  min-height: 32px;
  padding: 0;
  border-radius: var(--radius-full);
}

.wand-folder-picker-title {
  margin: 0;
  font-size: var(--font-size-xl);
  line-height: var(--line-height-tight);
}

.wand-folder-picker-description {
  max-width: 480px;
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.wand-folder-picker-form {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px 18px;
}

.wand-folder-picker-quick {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.wand-folder-picker-field {
  display: grid;
  gap: 6px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.wand-folder-picker-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 42px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 9px 11px;
  color: var(--text-primary);
  background: var(--bg-primary);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}

.wand-folder-picker-input:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-muted);
}

.wand-folder-picker-input[aria-invalid="true"] { border-color: var(--danger); }

.wand-folder-picker-options {
  min-height: 112px;
  max-height: min(310px, 42dvh);
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
}

.wand-folder-picker-option {
  appearance: none;
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 2px 8px;
  width: 100%;
  min-height: 48px;
  border: 0;
  border-bottom: 1px solid var(--border-subtle);
  padding: 8px 11px;
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.wand-folder-picker-option:last-child { border-bottom: 0; }
.wand-folder-picker-option:hover,
.wand-folder-picker-option.active,
.wand-folder-picker-option[aria-selected="true"] { background: var(--accent-muted); }
.wand-folder-picker-option:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.wand-folder-picker-option > span:first-child { grid-row: 1 / span 2; color: var(--text-muted); }
.wand-folder-picker-option > span:nth-child(2) { overflow: hidden; font-weight: var(--font-weight-semibold); text-overflow: ellipsis; white-space: nowrap; }
.wand-folder-picker-option code { grid-column: 2; overflow: hidden; color: var(--text-muted); font-size: var(--font-size-xs); text-overflow: ellipsis; white-space: nowrap; }

.wand-folder-picker-state {
  display: grid;
  min-height: 110px;
  place-items: center;
  padding: 16px;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  text-align: center;
}

.wand-folder-picker-error {
  margin: 0;
  border: 1px solid color-mix(in srgb, var(--danger) 32%, transparent);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  color: var(--danger);
  background: var(--danger-muted);
  font-size: var(--font-size-sm);
}

.wand-folder-picker-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.wand-folder-picker-footer > span {
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wand-folder-picker-footer > .wand-ui-button { flex: 0 0 auto; }

.wand-worktree-dialog {
  display: flex;
  width: min(620px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 32px));
  max-height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 32px);
  flex-direction: column;
  overflow: hidden;
  padding: 0;
}

.wand-worktree-header {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 20px 22px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.wand-worktree-header > div {
  min-width: 0;
}

.wand-worktree-header > .wand-ui-button {
  width: 32px;
  min-width: 32px;
  min-height: 32px;
  flex: 0 0 auto;
  border-radius: var(--radius-full);
  padding: 0;
}

.wand-worktree-title {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--font-size-xl);
  line-height: var(--line-height-tight);
}

.wand-worktree-description {
  max-width: 450px;
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.wand-worktree-body {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  overflow-y: auto;
  padding: 18px 22px 20px;
}

.wand-worktree-content {
  display: flex;
  min-height: 168px;
  flex-direction: column;
  gap: 10px;
}

.wand-worktree-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  background: var(--bg-secondary);
  font-size: var(--font-size-sm);
}

.wand-worktree-label,
.wand-worktree-row > span {
  min-width: 0;
  color: var(--text-secondary);
}

.wand-worktree-value {
  min-width: 0;
  color: var(--text-primary);
  overflow-wrap: anywhere;
  text-align: right;
}

.wand-worktree-value-warning { color: var(--warning); }
.wand-worktree-value-success { color: var(--success); }
.wand-worktree-value-error { color: var(--danger); }

.wand-worktree-commits {
  display: grid;
  gap: 7px;
}

.wand-worktree-commits-title {
  margin: 2px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
}

.wand-worktree-commit-list {
  display: grid;
  gap: 7px;
}

.wand-worktree-row code {
  color: var(--accent-active);
  background: transparent;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}

.wand-worktree-status,
.wand-worktree-error {
  margin: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 9px 11px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-base);
}

.wand-worktree-status-success {
  border-color: color-mix(in srgb, var(--success) 28%, transparent);
  color: var(--success);
  background: var(--success-muted);
}

.wand-worktree-status-warning {
  border-color: color-mix(in srgb, var(--warning) 30%, transparent);
  color: var(--warning);
  background: var(--warning-muted);
}

.wand-worktree-status-error,
.wand-worktree-error {
  border-color: color-mix(in srgb, var(--danger) 30%, transparent);
  color: var(--danger);
  background: var(--danger-muted);
}

.wand-worktree-actions {
  display: flex;
  flex: 0 0 auto;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border-subtle);
}

.wand-worktree-actions > .wand-ui-button {
  min-width: 120px;
}

@media (max-width: 760px) {
  .wand-quick-dialog {
    width: calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 14px);
    max-height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 14px);
    border-radius: var(--radius-md);
  }

  .wand-quick-header { padding: 16px 15px 13px; }
  .wand-quick-body { gap: 13px; padding: 13px 12px 16px; }
  .wand-quick-action-grid { grid-template-columns: minmax(0, 1fr); }
  .wand-quick-field { grid-template-columns: minmax(0, 1fr); gap: 5px; }
  .wand-quick-field > span { padding-top: 0; }
  .wand-quick-footer { align-items: stretch; flex-direction: column; padding: 11px 12px calc(11px + var(--wand-safe-bottom)); }
  .wand-quick-footer > div { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wand-quick-result { padding: 16px 12px; }
  .wand-quick-result-pair { grid-template-columns: minmax(0, 1fr); gap: 5px; }
  .wand-quick-result-flow { grid-template-columns: minmax(0, 1fr); }
  .wand-quick-result-flow > span { transform: rotate(90deg); text-align: center; }

  .wand-new-session-dialog {
    width: calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 20px);
    max-height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 20px);
    border-radius: var(--radius-md);
  }

  .wand-folder-picker-dialog {
    width: calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 20px);
    max-height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 20px);
    border-radius: var(--radius-md);
  }

  .wand-folder-picker-header { padding: 16px 15px 13px; }
  .wand-folder-picker-description { display: none; }
  .wand-folder-picker-form { gap: 10px; padding: 13px 12px calc(13px + var(--wand-safe-bottom)); }
  .wand-folder-picker-options { max-height: min(330px, 45dvh); }
  .wand-folder-picker-footer { align-items: stretch; flex-direction: column; }
  .wand-folder-picker-footer > .wand-ui-button { width: 100%; }

  .wand-worktree-dialog {
    width: calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 20px);
    max-height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 20px);
    border-radius: var(--radius-md);
  }

  .wand-worktree-header { padding: 16px 15px 13px; }
  .wand-worktree-description { display: none; }
  .wand-worktree-body { padding: 13px 12px calc(13px + var(--wand-safe-bottom)); }
  .wand-worktree-content { min-height: 0; }
  .wand-worktree-row { align-items: flex-start; flex-direction: column; gap: 4px; }
  .wand-worktree-value { text-align: left; }
  .wand-worktree-actions { align-items: stretch; flex-direction: column-reverse; }
  .wand-worktree-actions > .wand-ui-button { width: 100%; }

  .wand-settings-dialog {
    width: calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 12px);
    height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 12px);
    min-height: 0;
    border-radius: var(--radius-md);
  }

  .wand-settings-header { padding: 14px 15px; }
  .wand-settings-description { display: none; }

  .wand-settings-tabs {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  .wand-settings-tabs > .wand-ui-tabs-list {
    grid-row: 1;
    flex-direction: row;
    gap: 5px;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--border-subtle);
    padding: 8px;
    scrollbar-width: none;
  }

  .wand-settings-tabs > .wand-ui-tabs-list .wand-ui-tabs-trigger {
    flex: 0 0 auto;
    min-height: 36px;
    padding: 7px 11px;
  }

  .wand-settings-tab-label span { display: none; }
  .wand-settings-tabs > .wand-ui-tabs-content { grid-column: 1; grid-row: 2; }
  .wand-settings-panel { padding: 18px 14px 28px; }
  .wand-settings-grid, .wand-settings-file-grid, .wand-settings-env-toolbar { grid-template-columns: minmax(0, 1fr); }
  .wand-settings-section-heading { flex-direction: column; }
  .wand-settings-section-action { width: 100%; }
  .wand-settings-section-action .wand-ui-button { width: 100%; }
  .wand-settings-save-bar { bottom: -28px; margin: 16px -14px -28px; padding: 10px 14px calc(10px + var(--wand-safe-bottom)); }
  .wand-settings-save-bar { flex-direction: column; align-items: stretch; }
  .wand-settings-toggle-row, .wand-settings-download-row { align-items: flex-start; }
  .wand-settings-about-list dd { max-width: 62%; }
  .wand-settings-nested-dialog { width: calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 16px); max-height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 16px); }
}

@media (max-width: 640px) {
  .wand-new-session-header { padding: 16px 18px 14px; }
  .wand-new-session-title { font-size: 1.125rem; }
  .wand-new-session-body { padding: 14px 18px; }
  .wand-new-session-footer { padding: 10px 12px 14px; }
  .wand-new-session-input { font-size: 16px; }
}

@media (max-width: 390px) {
  .wand-new-session-footer { padding: 8px 10px 12px; }
}


`;
