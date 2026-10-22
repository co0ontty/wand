type TerminalWriter = { write(data: string, done: () => void): void };
type WriteBatch = {
  chunks: string[];
  chars: number;
  tail: Promise<void>;
  current: () => boolean;
  consumed: Array<() => void>;
};
const pending = new WeakMap<TerminalWriter, WriteBatch>();
const MAX_BATCH_CHARS = 64 * 1024;

/**
 * Keep snapshot/resize barriers ordered, but do not pay one asynchronous xterm
 * parser turn for every network frame. Only adjacent, not-yet-started live
 * writes on the exact same queue tail may merge. No ANSI bytes are truncated.
 */
export function queueTerminalWrite(
  terminal: TerminalWriter,
  data: string,
  previous: Promise<unknown>,
  current: () => boolean,
  painted: () => void,
  consumed: () => void,
): Promise<void> {
  const existing = pending.get(terminal);
  if (existing && existing.tail === previous && existing.current() && current()
      && existing.chars + data.length <= MAX_BATCH_CHARS) {
    existing.chunks.push(data);
    existing.chars += data.length;
    existing.consumed.push(consumed);
    return existing.tail;
  }
  const batch: WriteBatch = { chunks: [data], chars: data.length, tail: Promise.resolve(), current, consumed: [consumed] };
  batch.tail = previous.catch(() => {}).then(async () => {
    if (pending.get(terminal) === batch) pending.delete(terminal);
    try {
      if (!current()) return; // Superseded by an authoritative checkpoint/teardown.
      await new Promise<void>((resolve, reject) => {
        try { terminal.write(batch.chunks.join(""), resolve); } catch (error) { reject(error); }
      });
      if (current()) painted();
    } finally {
      // ACK only after parsing, or after the old generation became obsolete.
      // One failed callback must not retain unrelated frames' flow-control credit.
      for (const acknowledge of batch.consumed) {
        try { acknowledge(); } catch { /* Connection may have closed. */ }
      }
    }
  });
  pending.set(terminal, batch);
  return batch.tail;
}
