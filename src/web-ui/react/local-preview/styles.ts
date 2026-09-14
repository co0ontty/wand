export const localPreviewStyles = String.raw`
.local-preview-link {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.local-preview-link:hover {
  color: var(--accent-hover);
}

.wand-local-preview-content {
  width: min(1180px, calc(100vw - 28px));
  max-width: none;
  height: min(840px, calc(100dvh - 28px));
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  overflow: hidden;
}

.wand-local-preview-form {
  display: grid;
  gap: 10px;
  padding-bottom: 12px;
  border-bottom: var(--tb-hairline) solid var(--border-default);
}

.wand-local-preview-modes {
  display: inline-flex;
  width: fit-content;
  gap: 4px;
  padding: 3px;
  border: var(--tb-hairline) solid var(--border-default);
  border-radius: 10px;
  background: var(--bg-secondary);
}

.wand-local-preview-mode {
  height: 27px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.wand-local-preview-mode.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm);
}

.wand-local-preview-field {
  display: grid;
  gap: 5px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.wand-local-preview-field input {
  width: 100%;
  height: 36px;
  padding: 0 10px;
  border: var(--tb-hairline) solid var(--border-default);
  border-radius: 9px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  font: inherit;
}

.wand-local-preview-error {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
}

.wand-local-preview-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wand-local-preview-actions a {
  display: inline-flex;
  align-items: center;
  text-decoration: none;
}

.wand-local-preview-frame,
.wand-local-preview-empty {
  min-height: 0;
  margin-top: 12px;
  border: var(--tb-hairline) solid var(--border-default);
  border-radius: 10px;
  background: var(--bg-primary);
}

.wand-local-preview-frame {
  width: 100%;
  height: 100%;
}

.wand-local-preview-empty {
  display: grid;
  place-content: center;
  gap: 6px;
  padding: 24px;
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
}

@media (max-width: 640px) {
  .wand-local-preview-content {
    width: calc(100vw - 16px);
    height: calc(100dvh - 16px);
  }

  .wand-local-preview-form { gap: 8px; }
  .wand-local-preview-field input { height: 42px; }
}
`;
