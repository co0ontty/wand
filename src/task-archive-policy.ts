import { isArchiveBlocked } from "./archive-policy.js";
import { AI_TEAM_ACTIVE_RUN_STATUSES } from "./ai-team-types.js";
import type { WandStorage } from "./storage.js";
import type { SessionRegistry } from "./session-registry.js";
import { taskHumanAccepted, type WandTask } from "./task-types.js";

/** Shared eligibility rule; callers supply either request snapshots or fresh mutation facts. */
export function taskArchiveEligible(task: WandTask, facts: {
  queuedComments: number;
  hasBlockedSession(): boolean;
  hasActiveTeam(): boolean;
}): boolean {
  return taskHumanAccepted(task) && facts.queuedComments === 0
    && !facts.hasBlockedSession() && !facts.hasActiveTeam();
}

/** Read live owners at the mutation boundary; a stale task label cannot hide active execution. */
export function canArchiveTask(storage: WandStorage, sessions: SessionRegistry | undefined, taskId: string): boolean {
  const task = storage.getWandTask(taskId);
  if (!task) return false;
  return taskArchiveEligible(task, {
    queuedComments: storage.countQueuedTaskCommentDispatchesForTask(task.id),
    hasBlockedSession: () => storage.listWandTaskSessionIds(task.id).some(id => {
      const session = sessions?.getSlim(id) ?? storage.getSessionSlim(id);
      return session ? isArchiveBlocked(session) : false;
    }),
    hasActiveTeam: () => [task.id, task.workspaceTaskId].some(id => Boolean(id && storage.listAiTeamRuns({
      taskId: id, statuses: AI_TEAM_ACTIVE_RUN_STATUSES, limit: 1,
    }).length)),
  });
}
