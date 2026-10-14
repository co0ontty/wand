import type { StructuredCliPumpContext } from "./structured-exec-pump.js";
import type { StructuredRunnerObserver, StructuredRunnerTurnState } from "./structured-runner.js";

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
