import type { StructuredCliPumpContext } from "./structured-exec-pump.js";
import type { StructuredRunnerObserver, StructuredRunnerTurnState } from "./structured-runner.js";
import { MAX_PROTOCOL_LINE_BYTES } from "./bounded-process-output.js";

/** Fresh execution and daemon replay must enforce the same protocol boundary. */
export class BoundedProtocolLineReader {
  private buffer = "";
  private bytes = 0;

  constructor(private readonly onLine: (line: string) => void) {}

  get atBoundary(): boolean { return this.buffer.length === 0; }

  push(text: string): void {
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf("\n", start);
      const part = text.slice(start, end < 0 ? undefined : end);
      this.bytes += Buffer.byteLength(part, "utf8");
      if (this.bytes > MAX_PROTOCOL_LINE_BYTES) {
        this.buffer = "";
        this.bytes = 0;
        throw new Error("CLI 协议单行超过 8 MiB 上限；本轮已停止，送达结果不能据此推定为未接受。");
      }
      this.buffer += part;
      if (end < 0) return;
      const line = this.buffer;
      this.buffer = "";
      this.bytes = 0;
      this.onLine(line);
      start = end + 1;
    }
  }

  finish(): void {
    const line = this.buffer;
    this.buffer = "";
    this.bytes = 0;
    if (line.trim()) this.onLine(line);
  }
}

/**
 * Shared stdout skeleton for CLIs that emit one JSON event per line.
 *
 * Blank lines are ignored. A line that is not JSON is reported through
 * onUnparsed and is never treated as protocol evidence. Plain-object events are
 * forwarded to observer.onEvent before the adapter's handleEvent runs, so the
 * raw event is always observable even when the reducer rejects it.
 */
export function createNdjsonLineHandler<S extends StructuredRunnerTurnState>(options: {
  observer: StructuredRunnerObserver;
  handleEvent(event: unknown, ctx: StructuredCliPumpContext<S>): void;
  onUnparsed(): void;
}): (line: string, ctx: StructuredCliPumpContext<S>) => void {
  const { observer } = options;
  return (line, ctx) => {
    if (!observer.isActive()) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      options.onUnparsed();
      return;
    }
    if (event && typeof event === "object" && !Array.isArray(event)) {
      observer.onEvent?.(event as Record<string, unknown>);
    }
    options.handleEvent(event, ctx);
  };
}
