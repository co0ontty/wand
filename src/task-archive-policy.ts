import { isArchiveBlocked } from "./archive-policy.js";
import { AI_TEAM_ACTIVE_RUN_STATUSES } from "./ai-team-types.js";
import type { WandStorage } from "./storage.js";
import type { SessionRegistry } from "./session-registry.js";

/** Read live owners at the mutation boundary; a stale task label cannot hide active execution. */
export function canArchiveTask(storage: WandStorage, sessions: SessionRegistry | undefined, taskId: string): boolean {
  const task = storage.getWandTask(taskId);
  if (!task || task.status === "doing") return false;
  if (storage.listWandTaskSessionIds(task.id).some(id => {
    const session = sessions?.getSlim(id) ?? storage.getSessionSlim(id);
    return session ? isArchiveBlocked(session) : false;
  })) return false;
  return ![task.id, task.workspaceTaskId].some(id => id && storage.listAiTeamRuns({
    taskId: id, statuses: AI_TEAM_ACTIVE_RUN_STATUSES, limit: 1,
  }).length > 0);
}
