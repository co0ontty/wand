/**
 * PTY turn-activity heuristics for provider CLIs other than Claude.
 *
 * Claude has `ClaudePtyBridge`, which parses the TUI and reports an exact
 * per-turn phase. Every other provider CLI writes an opaque TUI to the PTY, so
 * the server cannot parse a turn boundary out of the bytes. What is left is
 * output activity: a working CLI keeps redrawing (streamed tokens, spinner,
 * elapsed counters), while a finished turn returns to a static prompt and the
 * bytes stop. So a turn is opened on submit and closed once the session has been
 * silent for a quiet window, refreshed on every chunk.
 *
 * The principled alternative is to ask the OS whether the terminal's foreground
 * process group is blocked on a tty read (that is the real meaning of "waiting
 * for input"). It works for any provider and is immune to spinners, but it needs
 * the PTY-owning daemon (Render) to expose foreground-pgrp state, so it is left
 * as a follow-up. This module is the deliberate fallback.
 */

/**
 * Whether a PTY input chunk is a line submit rather than body text.
 *
 * The input contract sends the prompt text and the terminating Enter as two
 * separate chunks (`getTerminalSubmitChunks`), so a submit is a chunk made
 * purely of line terminators (plus whitespace). Pasted text that happens to end
 * in a newline carries body and is intentionally not treated as a submit: a TUI
 * may still be editing it, and a missed turn start only under-reports activity.
 */
export function isPtySubmitInput(input: string): boolean {
  if (!input || !/[\r\n]/.test(input)) return false;
  return input.replace(/[\r\n]/g, "").trim().length === 0;
}
