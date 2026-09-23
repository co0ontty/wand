import { state } from "./state";
import { parseJsonResponse } from "../react/http-adapter";

type HistorySnapshot = {
  version: number;
  data: string;
  pending: Array<{ type: string; data?: string }>;
  historyBefore?: number;
  historyRevision?: number;
  [key: string]: unknown;
};

type HistoryEntry = {
  base: HistorySnapshot;
  prefix: string;
  before: number;
  revision: number;
  live: string;
  loading: boolean;
};

const entries = new Map<string, HistoryEntry>();

function replaySnapshot(entry: HistoryEntry): HistorySnapshot {
  return {
    ...entry.base,
    data: entry.prefix + entry.base.data,
    pending: [...entry.base.pending, ...(entry.live ? [{ type: "data", data: entry.live }] : [])],
    historyBefore: entry.before,
  };
}

/** Reuse the exact cached baseline on remount; a new WS init has a new snapshot object. */
export function cachedTerminalHistory(id: string, snapshot: HistorySnapshot): HistorySnapshot | null {
  const entry = entries.get(id);
  return entry?.base === snapshot ? replaySnapshot(entry) : null;
}

/** Reset the history cursor on every authoritative WS init, never reuse old row indices. */
export function resetTerminalHistory(id: string, snapshot: HistorySnapshot | null): void {
  entries.delete(id);
  if (!snapshot || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.historyBefore)
    || !Number.isSafeInteger(snapshot.historyRevision)) return;
  entries.set(id, {
    base: snapshot, prefix: "", before: snapshot.historyBefore!,
    revision: snapshot.historyRevision!, live: "", loading: false,
  });
}

export function recordTerminalHistoryChunk(id: string, chunk: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.live += chunk;
  // Do not hold unbounded live TUI frames just to support an older scrollback cursor.
  if (entry.live.length > 200_000) {
    entries.delete(id);
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "resync", sessionId: id }));
    }
  }
}

/** The response is a page of ANSI rows, not a progressively larger snapshot. */
export async function loadTerminalHistory(
  id: string,
  apply: (snapshot: HistorySnapshot, addedRows: number) => boolean | Promise<boolean>,
): Promise<void> {
  const entry = entries.get(id);
  if (!entry || entry.loading || entry.before <= 0) return;
  entry.loading = true;
  const before = entry.before;
  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(id)}/pty-history?before=${before}&revision=${entry.revision}`,
      { credentials: "same-origin" },
    );
    if (response.status === 409) {
      entries.delete(id);
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: "resync", sessionId: id }));
      }
      return;
    }
    const page = await parseJsonResponse<any>(response);
    if (entries.get(id) !== entry || entry.before !== before
      || !Number.isSafeInteger(page.start) || page.start < 0 || page.start >= before
      || page.before !== before || page.revision !== entry.revision
      || typeof page.data !== "string" || (page.separator !== "" && page.separator !== "\r\n")) return;
    const prefix = page.data + page.separator + entry.prefix;
    const applied = await apply({
      ...replaySnapshot(entry), data: prefix + entry.base.data, historyBefore: page.start,
    }, before - page.start);
    // A tab switch or terminal teardown can occur while the request is in flight.
    // A page that was never rendered must remain fetchable on the next scroll.
    if (applied && entries.get(id) === entry && entry.before === before) {
      entry.prefix = prefix;
      entry.before = page.start;
    }
  } catch {
    // Network error: retain the cursor so the next upward scroll can retry.
  } finally {
    entry.loading = false;
  }
}

export function forgetTerminalHistory(id: string): void {
  entries.delete(id);
}
