import type { SessionSnapshot } from "./types.js";

/** Read-only execution facts, separate from a task's editable workflow stage. */
export type ExecutionStatus = "running" | "queued" | null;

export function sessionExecutionStatus(session: Pick<SessionSnapshot,
  "sessionKind" | "status" | "archived" | "structuredState" | "queuedMessages" | "ptyBusy" | "ptyCommandRunning" | "permissionBlocked" | "pendingEscalation"
>): ExecutionStatus {
  if (session.archived) return null;
  if (session.structuredState?.inFlight || session.ptyBusy || session.ptyCommandRunning) return "running";
  if (session.status === "failed" || session.status === "stopped" || session.structuredState?.lastError
    || session.permissionBlocked || session.pendingEscalation) return null;
  return session.sessionKind === "structured" && (session.queuedMessages?.length ?? 0) > 0 ? "queued" : null;
}

export function taskExecutionProjection(sessions: readonly Parameters<typeof sessionExecutionStatus>[0][], queuedComments = 0): {
  executionStatus: ExecutionStatus;
  queuedExecutionCount: number;
} {
  const visible = sessions.filter(session => !session.archived);
  const states = visible.map(sessionExecutionStatus);
  // Failed/explicitly stopped inputs stay available for reconciliation, not automatic execution.
  const queuedExecutionCount = Math.max(0, queuedComments) + visible.reduce((total, session, index) =>
    total + (states[index] ? session.queuedMessages?.length ?? 0 : 0), 0);
  return { executionStatus: states.includes("running") ? "running"
    : queuedComments > 0 || states.includes("queued") ? "queued" : null, queuedExecutionCount };
}
