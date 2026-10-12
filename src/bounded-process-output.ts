/** Diagnostic tails are not protocol payloads; only diagnostics may be truncated. */
export const MAX_DIAGNOSTIC_CHARS = 64 * 1024;
export const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024;
export const MAX_AI_TEXT_BYTES = 4 * 1024 * 1024;

export function appendDiagnosticTail(previous: string, text: string): string {
  const tail = (previous + text).slice(-MAX_DIAGNOSTIC_CHARS);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}
