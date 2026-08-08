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
}

interface PendingOperation {
  id: number;
  operation: PtyTerminalOperation;
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
  private tail: Promise<void> = Promise.resolve();
  private checkpointTimer?: NodeJS.Timeout;
  private nextId = 1;
  private committedData = "";
  private committedCols: number;
  private committedRows: number;
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
    const pending = this.addPending({ type: "data", data });
    this.tail = this.tail.then(() => new Promise<void>((resolve) => {
      if (this.disposed) return resolve();
      this.terminal.write(data, () => resolve());
    }));
    this.scheduleCheckpoint(pending.id);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    const pending = this.addPending({ type: "resize", cols, rows });
    this.tail = this.tail.then(() => {
      if (!this.disposed) this.terminal.resize(cols, rows);
    });
    this.scheduleCheckpoint(pending.id);
  }

  snapshot(): PtyTerminalSnapshot {
    return {
      version: 1,
      data: this.committedData,
      cols: this.committedCols,
      rows: this.committedRows,
      pending: this.pending.map(({ operation }) => ({ ...operation })),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    this.pending = [];
    this.terminal.dispose();
  }

  private addPending(operation: PtyTerminalOperation): PendingOperation {
    const pending = { id: this.nextId++, operation };
    this.pending.push(pending);
    return pending;
  }

  private scheduleCheckpoint(_operationId: number): void {
    if (this.checkpointTimer || this.disposed) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = undefined;
      const cutoff = this.pending.at(-1)?.id ?? 0;
      this.tail = this.tail.then(() => {
        if (this.disposed) return;
        this.committedData = this.serializer.serialize({ scrollback: 5000 });
        this.committedCols = this.terminal.cols;
        this.committedRows = this.terminal.rows;
        this.pending = this.pending.filter((entry) => entry.id > cutoff);
      });
    }, 100);
    this.checkpointTimer.unref?.();
  }
}
