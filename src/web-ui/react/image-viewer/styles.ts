export const imageViewerStyles = String.raw`
.wand-image-viewer-overlay { z-index: 58; }

.wand-image-viewer-dialog {
  z-index: 59;
  display: flex;
  flex-direction: column;
  width: min(1320px, calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 32px));
  height: min(880px, calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 32px));
  max-width: none;
  max-height: none;
  padding: 0;
  overflow: hidden;
}

.wand-image-viewer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: 0 0 auto;
  padding: 9px 10px 9px 18px;
  border-bottom: 1px solid var(--border-subtle);
}

.wand-image-viewer-title {
  font-size: var(--font-size-sm);
}

.wand-image-viewer-hint {
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wand-image-viewer-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  min-height: 0;
  padding: 20px;
  overflow: auto;
  border: 0;
  color: inherit;
  background-color: var(--bg-secondary);
  background-image: linear-gradient(45deg, var(--bg-tertiary) 25%, transparent 25%), linear-gradient(-45deg, var(--bg-tertiary) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg-tertiary) 75%), linear-gradient(-45deg, transparent 75%, var(--bg-tertiary) 75%);
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-size: 16px 16px;
  cursor: zoom-in;
}

.wand-image-viewer-stage img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  box-shadow: var(--shadow-md);
}

.wand-image-viewer-stage.zoomed {
  align-items: flex-start;
  justify-content: flex-start;
  cursor: zoom-out;
}

.wand-image-viewer-stage.zoomed img {
  max-width: none;
  max-height: none;
}

@media (max-width: 768px) {
  .wand-image-viewer-dialog {
    width: calc(100vw - var(--wand-safe-left) - var(--wand-safe-right) - 12px);
    height: calc(100dvh - var(--wand-safe-top) - var(--wand-safe-bottom) - 12px);
  }
  .wand-image-viewer-header { padding: 10px 12px 10px 14px; }
  .wand-image-viewer-stage { padding: 10px; }
}
`;
