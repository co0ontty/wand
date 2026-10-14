/** Shared execution facts for archive controls and server enforcement. An idle PTY shell is safe. */
export interface ArchiveSessionFacts {
  sessionKind?: string;
  runner?: string;
  status?: string;
  ptyBusy?: boolean;
  ptyCommandRunning?: boolean;
  inFlight?: boolean;
  structuredState?: { inFlight?: boolean } | null;
  permissionBlocked?: boolean;
  pendingEscalation?: unknown;
  queuedMessages?: readonly unknown[];
  queuedMessageCount?: number;
}

export function isArchiveBlocked(session: ArchiveSessionFacts): boolean {
  if (session.ptyBusy || session.ptyCommandRunning || session.inFlight || session.structuredState?.inFlight
    || session.permissionBlocked || session.pendingEscalation || session.queuedMessages?.length || session.queuedMessageCount) return true;
  if (["thinking", "initializing", "starting", "reconnecting", "permission-blocked", "waiting-input", "waiting_input"].includes(session.status ?? "")) return true;
  return session.status === "running" && (session.sessionKind === "structured" || session.runner === "claude-cli-print");
}
