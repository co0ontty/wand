export interface SessionCompletionState {
  /** Monotonic successful-completion generation, owned by storage rather than runner checkpoints. */
  completionRevision?: number;
  viewedCompletionRevision?: number;
}

/** Explicit navigation, not a list refresh choosing its preferred/default session. */
export function createSessionCompletionViewIntent(): {
  open(id: string): void;
  clear(): void;
  isOpen(id: string): boolean;
} {
  let openedId: string | null = null;
  return {
    open(id) { openedId = id; },
    clear() { openedId = null; },
    isOpen(id) { return openedId === id; },
  };
}

/** Delayed HTTP/WS projections may advance generations, but must never move them backwards. */
export function mergeSessionCompletionState(
  current: SessionCompletionState | null | undefined,
  incoming: SessionCompletionState,
): SessionCompletionState {
  if (incoming.completionRevision === undefined && incoming.viewedCompletionRevision === undefined) return {};
  return {
    completionRevision: Math.max(current?.completionRevision ?? 0, incoming.completionRevision ?? 0),
    viewedCompletionRevision: Math.max(current?.viewedCompletionRevision ?? 0, incoming.viewedCompletionRevision ?? 0),
  };
}

/** A presentation state only: never change the runner's lifecycle or input eligibility. */
export function isSessionJustCompleted(session: SessionCompletionState & {
  status?: string;
  archived?: boolean;
  ptyBusy?: boolean;
  inFlight?: boolean;
  structuredState?: { inFlight?: boolean } | null;
  permissionBlocked?: boolean;
  pendingEscalation?: unknown;
  providerCliExitCode?: number | null;
}): boolean {
  return (session.completionRevision ?? 0) > (session.viewedCompletionRevision ?? 0)
    && !session.archived
    && !session.ptyBusy
    && !session.inFlight
    && !session.structuredState?.inFlight
    && !session.permissionBlocked
    && !session.pendingEscalation
    && !(typeof session.providerCliExitCode === "number" && session.providerCliExitCode !== 0)
    && ["idle", "running", "exited"].includes(session.status ?? "");
}
