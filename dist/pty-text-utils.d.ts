/**
 * Shared PTY text processing utilities for consistent ANSI stripping and noise filtering.
 */
/**
 * Hard cap on the in-memory PTY replay buffer. Shared between ProcessManager
 * and ClaudePtyBridge so a session keeps the same amount of history regardless
 * of which capture path is active.
 */
export declare const PTY_OUTPUT_MAX_SIZE = 200000;
/** Strip ANSI escape sequences and control characters from raw PTY output. */
export declare function stripAnsi(text: string): string;
/** Lines considered as UI noise that should be excluded from chat view. */
export declare function isNoiseLine(line: string): boolean;
/**
 * Append text to a windowed buffer, trimming from start if over max size.
 *
 * The cut point is chosen so it never lands inside:
 * - a UTF-16 surrogate pair (would corrupt the leading codepoint)
 * - an unterminated ANSI escape sequence (would feed orphan "[31m..."
 *   text to a downstream terminal renderer)
 *
 * The returned buffer may be slightly shorter than maxSize.
 */
export declare function appendWindow(buffer: string, chunk: string, maxSize: number): string;
/**
 * Strip a string down to the printable codepoints used for echo matching.
 * Removes control characters, whitespace and ANSI escapes; keeps all other
 * visible characters (including `/`, `()`, `:`, CJK, emoji, etc.) so that
 * echo alignment works for any user input.
 */
export declare function stripForEchoMatch(input: string): string;
/**
 * Given an index pointing at ESC (0x1b), return the index of the first
 * character AFTER the escape sequence. Handles CSI, OSC and simple ESC-
 * letter forms. Returns idx+1 if nothing matches (best-effort skip).
 */
export declare function skipAnsiSequence(text: string, idx: number): number;
export declare function hasExplicitConfirmSyntax(normalized: string): boolean;
export declare function hasPermissionActionContext(normalized: string): boolean;
/**
 * Detect Claude CLI slash-command selection menus (/model, /effort, /output-style, etc.).
 * These share "Enter to confirm" with permission prompts but are user-driven choices
 * that must never be auto-approved. Distinguishing footer: "Esc to exit" (vs permission
 * prompts' "Esc to cancel" / "Tab to amend").
 */
export declare function isSlashCommandMenu(normalized: string): boolean;
interface PermissionScore {
    score: number;
    matched: string[];
}
/** Minimum score threshold for fallback permission detection */
export declare const FALLBACK_SCORE_THRESHOLD = 8;
/**
 * Score how likely the recent output contains a permission prompt.
 * Evaluates the last few lines of normalized text against weighted keywords.
 */
export declare function scorePermissionLikelihood(normalized: string): PermissionScore;
/** Normalize prompt text for permission detection (strip ANSI, collapse whitespace). */
export declare function normalizePromptText(value: string): string;
export {};
