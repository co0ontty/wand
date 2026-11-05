import { isArchiveBlocked } from "./archive-policy.js";
import { AI_TEAM_ACTIVE_RUN_STATUSES } from "./ai-team-types.js";
import type { WandStorage } from "./storage.js";
import type { SessionRegistry } from "./session-registry.js";
import type { WandTask } from "./task-types.js";

/**
 * 用户主动归档的唯一规则：不要求验收或人工确认（归档只是收起，可随时恢复），
 * 只挡住仍在执行、待答、排队或团队运行的工作，避免把进行中的执行藏进归档。
 * 自动归档（retention）另有更严的保护规则，不走这里。
 */
export function taskArchiveEligible(_task: WandTask, facts: {
  queuedComments: number;
  hasBlockedSession(): boolean;
  hasActiveTeam(): boolean;
}): boolean {
  return facts.queuedComments === 0
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
