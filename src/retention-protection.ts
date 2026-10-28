import { AI_TEAM_ACTIVE_RUN_STATUSES } from "./ai-team-types.js";
import { isArchiveBlocked } from "./archive-policy.js";
import type { WandStorage } from "./storage.js";
import type { WandTask } from "./task-types.js";
import { TASK_RETENTION_ARCHIVE_VERSION } from "./task-retention.js";
import { parseTimestampMs } from "./time-utils.js";
import type { SessionSnapshot } from "./types.js";

function acceptedTask(task: WandTask): boolean {
  const acceptance = task.acceptance;
  return (task.status === "done" || task.status === "archived")
    && typeof acceptance?.acceptedAt === "string" && parseTimestampMs(acceptance.acceptedAt) !== null
    && typeof acceptance.evidence === "string" && !!acceptance.evidence.trim()
    && typeof acceptance.blocker === "string" && !acceptance.blocker.trim();
}

/** Iterative, order-independent propagation; shared histories and legacy cycles cannot evade a hold. */
function spread(graph: ReadonlyMap<string, ReadonlySet<string>>, seeds: Iterable<string>): Set<string> {
  const held = new Set(seeds), pending = [...held];
  for (let index = 0; index < pending.length; index += 1) {
    for (const next of graph.get(pending[index]!) ?? []) {
      if (held.has(next)) continue;
      held.add(next); pending.push(next);
    }
  }
  return held;
}

/** Read all ownership/execution facts before the first destructive action. Never loads transcripts or settings. */
export function createRetentionProtection(
  storage: WandStorage,
  sessions: readonly SessionSnapshot[],
  archivedMs: number | null,
  now: number,
) {
  const tasks = storage.listWandTasks(), runs = storage.listAiTeamRuns();
  const versions = storage.taskRetentionArchiveVersions();
  const byId = new Map(tasks.map(task => [task.id, task]));
  const byContainer = new Map(tasks.flatMap(task => task.workspaceTaskId ? [[task.workspaceTaskId, task] as const] : []));
  const graph = new Map<string, Set<string>>(), ancestors = new Map<string, Set<string>>();
  const taskNode = (id: string): string => `task:${id}`;
  const sessionNode = (id: string): string => `session:${id}`;
  const runNode = (id: string): string => `run:${id}`;
  const busy = new Set<string>(), unfinished = new Set<string>(), notPurgeReady = new Set<string>();
  const link = (left: string, right: string): void => {
    if (!graph.has(left)) graph.set(left, new Set());
    if (!graph.has(right)) graph.set(right, new Set());
    graph.get(left)!.add(right); graph.get(right)!.add(left);
  };

  for (const task of tasks) {
    const node = taskNode(task.id);
    if (!acceptedTask(task)) unfinished.add(node);
    const archivedAt = parseTimestampMs(task.archivedAt), acceptedAt = parseTimestampMs(task.acceptance?.acceptedAt);
    if (!acceptedTask(task) || task.status !== "archived" || archivedAt === null || acceptedAt === null
      || versions.get(task.id) !== TASK_RETENTION_ARCHIVE_VERSION || archivedMs === null
      || now - Math.max(archivedAt, acceptedAt) < archivedMs) notPurgeReady.add(node);
    if (task.parentTaskId) {
      link(node, taskNode(task.parentTaskId));
      ancestors.set(node, new Set([taskNode(task.parentTaskId)]));
      if (!byId.has(task.parentTaskId)) busy.add(node); // Unknown ancestry is not permission to detach history.
    }
    // Container-less archives can still have historical membership. Live membership comes from snapshots below.
    if (!task.workspaceTaskId) {
      for (const id of storage.listWandTaskSessionIds(task.id)) link(node, sessionNode(id));
    }
  }
  const checked = new Set<string>();
  for (const task of tasks) {
    const path = new Set<string>();
    let cursor: string | null = task.id;
    while (cursor && !checked.has(cursor)) {
      if (path.has(cursor)) { busy.add(taskNode(cursor)); break; }
      path.add(cursor); cursor = byId.get(cursor)?.parentTaskId ?? null;
    }
    for (const id of path) checked.add(id);
  }

  for (const session of sessions) {
    const node = sessionNode(session.id);
    if (isArchiveBlocked(session)) busy.add(node);
    if (session.workspaceTaskId) {
      const owner = byContainer.get(session.workspaceTaskId);
      if (owner) link(node, taskNode(owner.id));
      else busy.add(node);
    }
  }
  for (const fact of storage.taskCommentRetentionFacts()) {
    const node = taskNode(fact.taskId);
    if (fact.sessionId) link(node, sessionNode(fact.sessionId));
    if (fact.state !== "accepted" && fact.state !== "failed") busy.add(node);
  }
  const teamSessionIds = new Map<string, string[]>();
  for (const run of runs) {
    const node = runNode(run.id), ids = new Set<string>();
    if (run.chatSessionId) ids.add(run.chatSessionId);
    for (const step of storage.listAiTeamSteps(run.id)) if (step.sessionId) ids.add(step.sessionId);
    teamSessionIds.set(run.id, [...ids]);
    for (const id of ids) link(node, sessionNode(id));
    if (run.taskId) {
      const owner = byId.get(run.taskId) ?? byContainer.get(run.taskId);
      // A dangling historical id has no surviving task context to detach; active status is handled above.
      if (owner) link(node, taskNode(owner.id));
    }
    if (AI_TEAM_ACTIVE_RUN_STATUSES.includes(run.status)) busy.add(node);
  }

  const executionHeld = spread(graph, busy);
  const archiveHeld = spread(graph, [...busy, ...unfinished]);
  // A task-bound history must outlive the latest acceptance/archive grace window in its whole family.
  const purgeHeld = spread(graph, [...busy, ...notPurgeReady]);
  const unfinishedAncestors = spread(ancestors, unfinished);
  return {
    tasks, runs, teamSessionIds,
    canArchiveTask: (task: WandTask): boolean => task.status === "done" && acceptedTask(task)
      && !executionHeld.has(taskNode(task.id)) && !unfinishedAncestors.has(taskNode(task.id)),
    canPurgeTask: (id: string): boolean => !purgeHeld.has(taskNode(id)),
    canArchiveSession: (id: string): boolean => !archiveHeld.has(sessionNode(id)),
    canPurgeSession: (id: string): boolean => !purgeHeld.has(sessionNode(id)),
    canArchiveRun: (id: string): boolean => !archiveHeld.has(runNode(id)),
    canPurgeRun: (id: string): boolean => !purgeHeld.has(runNode(id)),
  };
}
