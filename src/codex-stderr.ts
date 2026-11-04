/** Codex/rmcp formats an unexpected HTTP response as a Rust debug string.
 * Treat that quoted response as opaque data, before any diagnostic persistence.
 * No challenge-provider keywords or HTML parsing are needed to omit the body.
 */
const RESPONSE = /UnexpectedServerResponse\("HTTP ([1-5]\d{2}):/;
const MAX_RECORD_CHARS = 4096;

export function createCodexStderrReader(emit: (text: string) => void): { push(text: string): void; finish(): void } {
  let pending = "";
  let oversized = false;
  let response = false;
  let escaped = false;
  let quote = false;
  let closed = false;
  let ended = false;

  const flushRecord = (newline: boolean): void => {
    if (oversized) emit("[codex] stderr record exceeded 4096 characters; omitted.\n");
    else if (pending) emit(pending + (newline ? "\n" : ""));
    else if (newline) emit("\n");
    pending = "";
    oversized = false;
  };

  return {
    push(text: string): void {
      if (ended) return;
      for (const char of text) {
        if (response) {
          // Rust's debug string escapes quotes/backslashes. Only its closing
          // quote + parenthesis ends the opaque response; incomplete records
          // remain suppressed through EOF, including literal newline chunks.
          if (!closed) {
            if (escaped) { escaped = false; quote = false; }
            else if (char === "\\") { escaped = true; quote = false; }
            else if (quote && char === ")") { closed = true; quote = false; }
            else quote = char === '"';
          }
          if (closed && char === "\n") { response = false; closed = false; }
          continue;
        }
        if (char === "\n") { flushRecord(true); continue; }
        if (oversized) continue;
        pending += char;
        const match = char === ":" ? RESPONSE.exec(pending) : null;
        if (match) {
          emit(`[codex] HTTP ${match[1]} transport response; remote body omitted.\n`);
          pending = "";
          response = true;
          escaped = false;
          quote = false;
          closed = false;
        } else if (pending.length > MAX_RECORD_CHARS) {
          // Never retain a tail from an oversized record: it may start inside
          // an opaque response whose envelope no longer fits in the buffer.
          pending = "";
          oversized = true;
        }
      }
    },
    finish(): void {
      if (ended) return;
      ended = true;
      if (!response) flushRecord(false);
      pending = "";
    },
  };
}
