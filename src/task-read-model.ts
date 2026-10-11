import { isArchiveBlocked } from "./archive-policy.js";
import { AI_TEAM_ACTIVE_RUN_STATUSES } from "./ai-team-types.js";
import type { SessionRegistry } from "./session-registry.js";
import type { WandStorage } from "./storage.js";
import type { WandTask } from "./task-types.js";
import type { SessionSnapshot } from "./types.js";

/** Request-scoped projection, never an authority for mutations or a cross-request cache. */
export class TaskReadModel {
  readonly sessions: SessionSnapshot[];
  readonly sessionsById: Map<string, SessionSnapshot>;
  readonly sessionsByTask = new Map<string, SessionSnapshot[]>();
  readonly tasks;
  readonly cardsByContainer;
  readonly workspaces;
  readonly milestones;
  readonly activeTeamTasks;

  constructor(readonly storage: WandStorage, registry?: SessionRegistry, snapshots?: SessionSnapshot[]) {
    this.sessions = snapshots ?? registry?.listSlim() ?? storage.loadSessionsSlim();
    this.sessionsById = new Map(this.sessions.map(session => [session.id, session]));
    for (const session of this.sessions) {
      if (!session.workspaceTaskId) continue;
      const bucket = this.sessionsByTask.get(session.workspaceTaskId) ?? [];
      bucket.push(session);
      this.sessionsByTask.set(session.workspaceTaskId, bucket);
    }
    this.tasks = storage.listWandTasks();
    this.cardsByContainer = new Map(this.tasks.filter(task => task.workspaceTaskId).map(task => [task.workspaceTaskId!, task]));
    this.workspaces = new Map(storage.listWorkspaces().map(workspace => [workspace.id, workspace]));
    this.milestones = storage.listWandMilestones();
    this.activeTeamTasks = new Set(storage.listAiTeamRuns({ statuses: AI_TEAM_ACTIVE_RUN_STATUSES }).map(run => run.taskId));
  }

  taskSessions(task: WandTask): SessionSnapshot[] {
    if (task.workspaceTaskId) return this.sessionsByTask.get(task.workspaceTaskId) ?? [];
    // Archived legacy cards retain their old links; active membership uses the canonical column.
    return task.status === "archived" ? this.storage.listWandTaskSessionIds(task.id)
      .flatMap(id => this.sessionsById.get(id) ? [this.sessionsById.get(id)!] : []) : [];
  }

  canArchive(task: WandTask): boolean {
    return task.status !== "doing" && !this.taskSessions(task).some(isArchiveBlocked)
      && !this.activeTeamTasks.has(task.id) && !(task.workspaceTaskId && this.activeTeamTasks.has(task.workspaceTaskId));
  }

  milestone(id: string | null | undefined) {
    const milestone = id ? this.milestones.find(value => value.id === id) : this.milestones.find(value => value.isDefault);
    return { milestoneId: milestone?.id ?? null,
      milestone: milestone ? { id: milestone.id, name: milestone.name, isDefault: milestone.isDefault } : null };
  }
}
