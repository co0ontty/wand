/**
 * Shared PTY text processing utilities.
 * Used by both claude-pty-bridge.ts and message-parser.ts to ensure
 * consistent ANSI stripping and noise filtering.
 */

/** Strip ANSI escape sequences and control characters from raw PTY output. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")       // CSI sequences
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")    // OSC sequences
    .replace(/\x1b[><=ePX^_]/g, "")                  // Single-char escapes
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")    // Control chars (keep \t \n \r)
    .replace(/\r\n?/g, "\n");
}

/** Lines considered as UI noise that should be excluded from chat view. */
export function isNoiseLine(line: string): boolean {
  if (!line) return false;
  if (line.startsWith("────")) return true;
  if (line === "❯") return true;
  if (line.includes("esc to interrupt")) return true;
  if (line.includes("Claude Code v")) return true;
  if (/^Sonnet\b/.test(line)) return true;
  if (line.includes("Failed to install Anthropic")) return true;
  if (line.includes("Claude Code has switched")) return true;
  if (line.includes("? for shortcuts")) return true;
  if (line.includes("Claude is waiting")) return true;
  if (line.includes("[wand]")) return true;
  if (line.startsWith("0;") || line.startsWith("9;")) return true;
  if (line.includes("ctrl+g")) return true;
  if (line.includes("/effort")) return true;
  if (/^Using .* for .* session/.test(line)) return true;
  if (line.startsWith("Press ") && line.includes(" for")) return true;
  if (line.startsWith("type ") && line.includes(" to ")) return true;
  if (line.includes("auto mode is unavailable")) return true;
  if (/MCP server.*failed/i.test(line)) return true;
  if (line.includes("Germinating") || line.includes("Doodling") || line.includes("Brewing")) return true;
  if (line.includes("Permissions") && line.includes("mode")) return true;
  if (line.startsWith("●") && line.includes("·")) return true;
  if (line.startsWith("[>") || line.startsWith("[<")) return true;
  if (line.includes("Captured Claude session ID")) return true;
  if (line.includes("/effort")) return true;
  return false;
}

/** Append text to a windowed buffer, trimming from start if over max size. */
export function appendWindow(buffer: string, chunk: string, maxSize: number): string {
  const next = buffer + chunk;
  return next.length > maxSize ? next.slice(-maxSize) : next;
}

/** Normalize prompt text for permission detection (strip ANSI, collapse whitespace). */
export function normalizePromptText(value: string): string {
  return value
    .replace(/\u001b\[(\d+)C/g, (_match, count) => " ".repeat(Number(count) || 1))
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}
