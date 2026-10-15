import type { ConversationReceipt } from "./conversation-types.js";
import type { ScheduledTaskRun, ScheduledTaskRunView } from "./scheduled-task-types.js";
import type { SessionSnapshot } from "./types.js";

export function sessionActive(session: SessionSnapshot): boolean {
  return session.status === "running" || Boolean(session.structuredState?.inFlight)
    || Boolean(session.pendingEscalation || session.permissionBlocked) || (session.queuedMessages?.length ?? 0) > 0;
}


/** Pure read projection; it never settles or replays a scheduled occurrence. */
export function scheduledExecutionStatus(run: Pick<ScheduledTaskRun, "state" | "executionOutcome" | "executionFinishedAt">, receipt: ConversationReceipt | null, session: SessionSnapshot | null): ScheduledTaskRunView["executionStatus"] {
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

/** Settles only observed facts; missing/unknown acceptance never authorizes replay. */
export function reconcileScheduledRun(
  run: ScheduledTaskRun, receipt: ConversationReceipt | null, session: SessionSnapshot | null, now: string,
  options: { recoverInactive: boolean; liveAccepted: boolean },
): ScheduledTaskRun {
  if (run.executionFinishedAt) return run;
    let updated: ScheduledTaskRun = { ...run, receipt };
    if (run.state === "claimed") {
      updated = { ...updated, state: receipt?.state === "accepted" ? "accepted" : receipt?.state === "rejected" ? "rejected" : "unknown",
        error: receipt?.error ?? (receipt?.state === "accepted" ? null : "本次执行的接收状态无法确认，请核对执行记录；不会自动重发。") };
    }
    if (session && session.endedAt && session.status !== "running" && !session.structuredState?.inFlight) {
      // A user may already have queued a follow-up. This ended turn still settles the scheduled occurrence.
      const failed = session.status === "failed" || session.status === "stopped" || Boolean(session.structuredState?.lastError)
        || receipt?.startup === "failed" || (session.exitCode !== null && session.exitCode !== 0);
      updated.executionOutcome = failed ? "failed" : "completed";
      updated.executionFinishedAt = session.endedAt;
      if (failed) updated.error = receipt?.error ?? session.structuredState?.lastError ?? updated.error;
    }
    else if (session && !sessionActive(session) && (session.status === "failed" || session.status === "stopped"
      || session.structuredState?.lastError)) {
      updated.error = receipt?.error ?? session.structuredState?.lastError ?? updated.error;
      updated.executionOutcome = "failed";
      updated.executionFinishedAt = now;
    }
    else if (updated.state === "rejected" || (!session && (updated.state === "unknown" || receipt?.state === "accepted"))
      || (receipt?.startup === "failed" && (!session || !sessionActive(session)))) {
      updated.executionOutcome = updated.state === "rejected" || receipt?.startup === "failed" ? "failed" : "unknown";
      updated.executionFinishedAt = now;
    }
    else if (options.recoverInactive && session && !sessionActive(session) && !session.endedAt && !options.liveAccepted
      && (updated.state === "accepted" || updated.state === "unknown")) {
      // After restart an initial idle snapshot proves neither dispatch nor completion. Preserve its receipt without replay.
      updated = { ...updated, state: "unknown", executionFinishedAt: now, executionOutcome: "unknown",
        error: updated.error ?? "本次执行尚未确认启动或结束，请核对会话；不会自动重发。" };
    }
  return updated;
}
