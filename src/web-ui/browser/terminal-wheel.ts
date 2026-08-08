export type TerminalWheelPagingState = {
  direction: -1 | 0 | 1;
  accumulatedPixels: number;
  lastEventAt: number;
  lastPageAt: number;
};

export type TerminalWheelLikeEvent = {
  deltaY: number;
  deltaMode: number;
};

export const TERMINAL_WHEEL_PAGE_THRESHOLD_PX = 80;
export const TERMINAL_WHEEL_PAGE_INTERVAL_MS = 80;
export const TERMINAL_WHEEL_GESTURE_GAP_MS = 180;

/**
 * Turn a vertical wheel/trackpad gesture into a discrete PTY page direction.
 *
 * Full-screen terminal applications render into xterm's alternate buffer, so
 * there is no browser-side scrollback for xterm to move through. Accumulating
 * small deltas keeps trackpads controllable while still making a conventional
 * mouse-wheel notch respond immediately.
 */
export function consumeTerminalWheelPage(
  event: TerminalWheelLikeEvent,
  state: TerminalWheelPagingState,
  viewportHeight: number,
  now: number = Date.now(),
): -1 | 0 | 1 {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return 0;

  var direction: -1 | 1 = event.deltaY < 0 ? -1 : 1;
  var deltaPixels = Math.abs(normalizeWheelDeltaPixels(event, viewportHeight));
  if (deltaPixels === 0) return 0;

  if (
    state.direction !== direction
    || now - state.lastEventAt > TERMINAL_WHEEL_GESTURE_GAP_MS
  ) {
    state.accumulatedPixels = 0;
  }

  state.direction = direction;
  state.lastEventAt = now;
  state.accumulatedPixels += deltaPixels;

  if (state.accumulatedPixels < TERMINAL_WHEEL_PAGE_THRESHOLD_PX) return 0;
  if (now - state.lastPageAt < TERMINAL_WHEEL_PAGE_INTERVAL_MS) return 0;

  state.accumulatedPixels %= TERMINAL_WHEEL_PAGE_THRESHOLD_PX;
  state.lastPageAt = now;
  return direction;
}

export function terminalWheelPageSequence(direction: -1 | 0 | 1): string {
  if (direction < 0) return "\u001b[5~";
  if (direction > 0) return "\u001b[6~";
  return "";
}

function normalizeWheelDeltaPixels(event: TerminalWheelLikeEvent, viewportHeight: number): number {
  // DOM_DELTA_LINE / DOM_DELTA_PAGE are 1 / 2. Keep the numeric values here so
  // this helper stays testable outside a browser DOM.
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * Math.max(1, viewportHeight);
  return event.deltaY;
}
