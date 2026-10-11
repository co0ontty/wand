import type { ConversationReceipt } from "./conversation-types.js";
import type { ScheduledTaskRun, ScheduledTaskRunView } from "./scheduled-task-types.js";
import type { SessionSnapshot } from "./types.js";

export function sessionActive(session: SessionSnapshot): boolean {
  return session.status === "running" || Boolean(session.structuredState?.inFlight)
    || Boolean(session.pendingEscalation || session.permissionBlocked) || (session.queuedMessages?.length ?? 0) > 0;
}


/** Pure read projection; it never settles or replays a scheduled occurrence. */
export function scheduledExecutionStatus(run: ScheduledTaskRun, receipt: ConversationReceipt | null, session: SessionSnapshot | null): ScheduledTaskRunView["executionStatus"] {
    let executionStatus: ScheduledTaskRunView["executionStatus"];
    if (run.state === "skipped") executionStatus = "skipped";
    else if (run.executionOutcome) executionStatus = run.executionOutcome;
    // Legacy settled records lack an immutable outcome; a later turn cannot establish their original result.
    else if (run.executionFinishedAt) executionStatus = run.state === "rejected" || receipt?.startup === "failed" ? "failed" : "unknown";
    else if (receipt?.state === "rejected" || run.state === "rejected") executionStatus = "failed";
    else if (session && sessionActive(session)) executionStatus = "running";
    else if (session?.status === "failed" || session?.structuredState?.lastError || receipt?.startup === "failed") executionStatus = "failed";
    else if (session?.endedAt) executionStatus = session.status === "stopped" ? "failed" : "completed";
    else if (run.state === "unknown" || receipt?.state === "pending" || (receipt?.state === "accepted" && !session)) executionStatus = "unknown";
    else executionStatus = "pending";
  return executionStatus;
}
