export const restartOverlayStyles = String.raw`
.wand-restart-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(18, 13, 9, 0.78);
  backdrop-filter: blur(12px) saturate(120%);
  -webkit-backdrop-filter: blur(12px) saturate(120%);
  pointer-events: auto;
  animation: wand-restart-fade-in 180ms ease-out;
}

.wand-restart-surface {
  position: fixed;
  inset: 0;
  z-index: 101;
  box-sizing: border-box;
  display: flex;
  width: 100vw;
  height: 100dvh;
  max-height: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  overflow: auto;
  border: 0;
  border-radius: 0;
  padding:
    calc(24px + var(--wand-safe-top))
    calc(24px + var(--wand-safe-right))
    calc(24px + var(--wand-safe-bottom))
    calc(24px + var(--wand-safe-left));
  color: #fff;
  background: transparent;
  box-shadow: none;
  transform: none;
  pointer-events: auto;
  outline: none;
}

.wand-restart-surface[data-state="open"],
.wand-restart-surface[data-state="closed"] {
  animation: none;
}

.wand-restart-header {
  width: min(520px, 100%);
  text-align: center;
}

.wand-restart-header > div {
  min-width: 0;
}

.wand-restart-header > .wand-ui-button {
  display: none;
}

.wand-restart-title {
  margin: 0;
  color: #fff;
  font-size: clamp(1.35rem, 3.4vw, 1.8rem);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-tight);
}

.wand-restart-description {
  margin: 10px 0 0;
  color: rgba(255, 255, 255, 0.78);
  font-size: var(--font-size-sm);
  line-height: 1.65;
  white-space: pre-line;
}

.wand-restart-body {
  display: grid;
  width: min(520px, 100%);
  place-items: center;
  gap: 16px;
  margin-top: 22px;
  text-align: center;
}

.wand-restart-spinner {
  box-sizing: border-box;
  width: 42px;
  height: 42px;
  border: 3px solid rgba(255, 255, 255, 0.24);
  border-top-color: #fff;
  border-radius: 50%;
  animation: wand-restart-spin 800ms linear infinite;
}

.wand-restart-live {
  min-height: 1.6em;
  margin: 0;
  color: rgba(255, 255, 255, 0.88);
  font-size: var(--font-size-sm);
  line-height: 1.6;
  outline: none;
}

.wand-restart-progress {
  width: min(300px, 76vw);
  height: 4px;
  overflow: hidden;
  border: 0;
  border-radius: var(--radius-full);
  color: var(--accent);
  background: rgba(255, 255, 255, 0.16);
}

.wand-restart-progress::-webkit-progress-bar {
  border-radius: var(--radius-full);
  background: rgba(255, 255, 255, 0.16);
}

.wand-restart-progress::-webkit-progress-value {
  border-radius: var(--radius-full);
  background: var(--accent);
}

.wand-restart-progress::-moz-progress-bar {
  border-radius: var(--radius-full);
  background: var(--accent);
}

.wand-restart-attempts {
  color: rgba(255, 255, 255, 0.56);
  font-size: var(--font-size-xs);
}

.wand-restart-manual {
  min-width: 136px;
  margin-top: 2px;
}

@keyframes wand-restart-spin {
  to { transform: rotate(360deg); }
}

@keyframes wand-restart-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (max-width: 600px) {
  .wand-restart-surface {
    padding:
      calc(18px + var(--wand-safe-top))
      calc(18px + var(--wand-safe-right))
      calc(18px + var(--wand-safe-bottom))
      calc(18px + var(--wand-safe-left));
  }

  .wand-restart-description { font-size: var(--font-size-xs); }
  .wand-restart-body { gap: 14px; margin-top: 18px; }
  .wand-restart-spinner { width: 38px; height: 38px; }
  .wand-restart-manual { width: min(280px, 100%); }
}

@media (prefers-reduced-motion: reduce) {
  .wand-restart-backdrop { animation: none; }
  .wand-restart-spinner { animation-duration: 1.8s; }
}
`;
