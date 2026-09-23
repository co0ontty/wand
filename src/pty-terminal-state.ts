import headless from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";

const { Terminal } = headless as unknown as { Terminal: typeof HeadlessTerminal };

export type PtyTerminalOperation =
  | { type: "data"; data: string }
  | { type: "resize"; cols: number; rows: number };

export interface PtyTerminalSnapshot {
  version: 1;
  data: string;
  cols: number;
  rows: number;
  pending: PtyTerminalOperation[];
  /** Web scrollback cursor, absent from the Render wire protocol. */
  historyBefore?: number;
  historyRevision?: number;
}

export interface PtyHistoryPage {
  data: string;
  separator: string;
  start: number;
  before: number;
  revision: number;
}

export const PTY_INITIAL_HISTORY_ROWS = 80;
const PTY_INITIAL_HISTORY_MAX_BYTES = 256 * 1024;
export const PTY_HISTORY_PAGE_ROWS = 80;
const PTY_HISTORY_PAGE_MAX_BYTES = 192 * 1024;

interface PendingOperation {
  id: number;
  operation: PtyTerminalOperation;
}

/**
 * Incoming PTY chunks are coalesced into one xterm write per flush. xterm's
 * write callback costs a timer turn per call, so one write per node-pty chunk
 * caps a session at roughly 1 MB/s of mirrored output; batching removes that
 * ceiling without changing what a snapshot contains (the delay below is far
 * shorter than the client's own output debounce).
 */
const WRITE_BATCH_MAX_CHARS = 64 * 1024;
const WRITE_BATCH_DELAY_MS = 16;
/**
 * Re-serializing the screen costs ~20ms and allocates a few hundred KB, so a
 * checkpoint must not run on a fixed cadence while a session streams. Writes
 * pause between turns, which is when a fresh baseline is actually useful; the
 * size bounds only exist so a session that never pauses stays bounded.
 */
const CHECKPOINT_QUIET_MS = 100;
const CHECKPOINT_PENDING_MAX_CHARS = 256 * 1024;
const CHECKPOINT_PENDING_MAX_OPS = 1024;

function pendingChars(pending: PendingOperation[]): number {
  let chars = 0;
  for (const entry of pending) {
    if (entry.operation.type === "data") chars += entry.operation.data.length;
  }
  return chars;
}

/**
 * Merge adjacent data operations so a snapshot exposes as few replay steps as
 * possible: clients write pending operations one awaited call at a time, and a
 * session that streamed without pausing can hold hundreds of them.
 */
function coalesceOperations(pending: PendingOperation[]): PtyTerminalOperation[] {
  const operations: PtyTerminalOperation[] = [];
  for (const { operation } of pending) {
    const last = operations.at(-1);
    if (operation.type === "data" && last?.type === "data") {
      operations[operations.length - 1] = { type: "data", data: last.data + operation.data };
      continue;
    }
    operations.push({ ...operation });
  }
  return operations;
}

/**
 * Server-side xterm screen model used only for reconnect snapshots. Live PTY
 * bytes still travel unchanged from node-pty to the browser terminal.
 */
export class PtyTerminalState {
  private readonly terminal: HeadlessTerminal;
  private readonly serializer = new SerializeAddon();
  private readonly unicode = new Unicode11Addon();
  private pending: PendingOperation[] = [];
  private buffered = "";
  private tail: Promise<void> = Promise.resolve();
  private flushTimer?: NodeJS.Timeout;
  private checkpointTimer?: NodeJS.Timeout;
  private checkpointQueued = false;
  private nextId = 1;
  private committedData = "";
  private committedCols: number;
  private committedRows: number;
  private committedHistoryBefore = 0;
  private committedRevision = 0;
  private revision = 0;
  private disposed = false;

  constructor(cols: number, rows: number, initialData = "") {
    this.committedCols = cols;
    this.committedRows = rows;
    this.terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
    this.terminal.loadAddon(this.serializer as never);
    this.terminal.loadAddon(this.unicode as never);
    this.terminal.unicode.activeVersion = "11";
    if (initialData) this.write(initialData);
  }

  write(data: string): void {
    if (this.disposed || !data) return;
    this.revision++;
    this.buffered += data;
    if (this.buffered.length >= WRITE_BATCH_MAX_CHARS) this.flushBuffered();
    else this.scheduleFlush();
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.revision++;
    // Bytes that arrived before the resize must land before it.
    this.flushBuffered();
    this.addPending({ type: "resize", cols, rows });
    this.tail = this.tail.then(() => {
      if (!this.disposed) this.terminal.resize(cols, rows);
    });
    this.scheduleCheckpoint();
  }

  snapshot(): PtyTerminalSnapshot {
    // Unflushed bytes would be invisible to a snapshot, so publish them as
    // pending operations the client replays after `data`.
    this.flushBuffered();
    return {
      version: 1,
      data: this.committedData,
      cols: this.committedCols,
      rows: this.committedRows,
      pending: coalesceOperations(this.pending),
      historyBefore: this.committedHistoryBefore,
      historyRevision: this.committedRevision,
    };
  }

  /** A bounded ANSI range preceding the committed baseline, never a cumulative snapshot. */
  async historyPage(before: number, revision: number, limit = PTY_HISTORY_PAGE_ROWS): Promise<PtyHistoryPage | null> {
    if (this.disposed || !Number.isSafeInteger(before) || !Number.isSafeInteger(revision)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > PTY_HISTORY_PAGE_ROWS) return null;
    // Wait for buffered writes/checkpoints. If output or resize changed the row indices,
    // the caller must resync rather than concatenate unrelated lines.
    await this.tail;
    if (this.revision !== revision || before > this.committedHistoryBefore || before <= 0) return null;
    const count = Math.min(before, limit);
    let start = before - count;
    let data = "";
    while (start < before) {
      data = this.serializer.serialize({ range: { start, end: before - 1 } });
      if (Buffer.byteLength(data, "utf8") <= PTY_HISTORY_PAGE_MAX_BYTES) break;
      if (start === before - 1) return null;
      start = Math.min(before - 1, start + Math.max(1, Math.ceil((before - start) / 2)));
    }
    return {
      data,
      separator: this.terminal.buffer.normal.getLine(before)?.isWrapped ? "" : "\r\n",
      start,
      before,
      revision,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    this.buffered = "";
    this.pending = [];
    this.terminal.dispose();
  }

  private addPending(operation: PtyTerminalOperation): void {
    this.pending.push({ id: this.nextId++, operation });
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.disposed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushBuffered();
    }, WRITE_BATCH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  /** Publish buffered bytes as one pending data operation and queue one write. */
  private flushBuffered(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const data = this.buffered;
    if (!data) return;
    this.buffered = "";
    this.addPending({ type: "data", data });
    this.tail = this.tail.then(() => new Promise<void>((resolve) => {
      if (this.disposed) return resolve();
      try {
        this.terminal.write(data, () => resolve());
      } catch {
        // A throwing write must not poison the ordering chain: every later
        // chunk would then be dropped without any signal.
        resolve();
      }
    }));
    this.scheduleCheckpoint();
  }

  private scheduleCheckpoint(): void {
    if (this.disposed || this.checkpointQueued) return;
    if (
      pendingChars(this.pending) >= CHECKPOINT_PENDING_MAX_CHARS
      || this.pending.length >= CHECKPOINT_PENDING_MAX_OPS
    ) {
      this.commitCheckpoint();
      return;
    }
    // Quiet-period trigger: one checkpoint after a streaming burst ends,
    // instead of one every 100ms while it runs.
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = undefined;
      this.commitCheckpoint();
    }, CHECKPOINT_QUIET_MS);
    this.checkpointTimer.unref?.();
  }

  private commitCheckpoint(): void {
    if (this.disposed || this.checkpointQueued) return;
    if (this.checkpointTimer) {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = undefined;
    }
    const cutoff = this.pending.at(-1)?.id ?? 0;
    if (!cutoff) return;
    const revision = this.revision;
    this.checkpointQueued = true;
    this.tail = this.tail.then(() => {
      if (this.disposed) return;
      try {
        let historyRows = PTY_INITIAL_HISTORY_ROWS;
        this.committedData = this.serializer.serialize({ scrollback: historyRows });
        while (historyRows > 0 && Buffer.byteLength(this.committedData) > PTY_INITIAL_HISTORY_MAX_BYTES) {
          historyRows = Math.floor(historyRows / 2);
          this.committedData = this.serializer.serialize({ scrollback: historyRows });
        }
        this.committedCols = this.terminal.cols;
        this.committedRows = this.terminal.rows;
        this.committedHistoryBefore = Math.max(0, this.terminal.buffer.normal.baseY - historyRows);
        // A newer write can arrive while the queued checkpoint drains. Only the
        // operations through cutoff are represented by this baseline.
        this.committedRevision = revision;
        this.pending = this.pending.filter((entry) => entry.id > cutoff);
      } catch {
        // Keep the mirror alive; the next checkpoint re-serializes.
      }
    }).then(() => {
      this.checkpointQueued = false;
      // Operations that arrived while this checkpoint drained still need a
      // baseline of their own once the writer goes quiet again.
      if (this.pending.length > 0) this.scheduleCheckpoint();
    });
  }
}
