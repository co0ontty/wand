import process from "node:process";

/**
 * Process-level diagnostics for the session/daemon runtime. Output keeps the
 * historical "[wand] " prefix so existing log scrapers are unaffected.
 */
const PREFIX = "[wand] ";
const RATE_WINDOW_MS = 30_000;
const MAX_RATE_KEYS = 256;

interface RateState {
  lastEmittedAt: number;
  suppressed: number;
}

const rateStates = new Map<string, RateState>();

export function logInfo(message: string): void {
  process.stderr.write(`${PREFIX}${message}\n`);
}

/**
 * For per-frame or per-event conditions that can repeat on every message:
 * emits at most once per key per window and reports how many were suppressed.
 */
export function logRateLimited(key: string, message: string, windowMs = RATE_WINDOW_MS): void {
  const now = Date.now();
  let state = rateStates.get(key);
  if (!state) {
    if (rateStates.size >= MAX_RATE_KEYS) {
      const oldest = rateStates.keys().next().value;
      if (oldest !== undefined) rateStates.delete(oldest);
    }
    state = { lastEmittedAt: 0, suppressed: 0 };
    rateStates.set(key, state);
  }
  if (now - state.lastEmittedAt < windowMs) {
    state.suppressed += 1;
    return;
  }
  const suffix = state.suppressed > 0 ? ` (${state.suppressed} similar suppressed)` : "";
  state.suppressed = 0;
  state.lastEmittedAt = now;
  logInfo(`${message}${suffix}`);
}
