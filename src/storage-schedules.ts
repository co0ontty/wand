import type { DatabaseSync } from "node:sqlite";
import type { ScheduledTask, ScheduledTaskRun, ScheduledTaskRunFact } from "./scheduled-task-types.js";

/** Guard legacy non-ISO values before indexing: SQLite's special `now` input
 * must never make a read timestamp depend on the current clock. */
export const SCHEDULED_CLAIM_DATE_SQL = "CASE WHEN json_extract(run_json, '$.claimedAt') GLOB '????-??-??T*' THEN julianday(json_extract(run_json, '$.claimedAt')) ELSE NULL END";

/** Same SQLite connection and transaction owner as WandStorage; no separate lifecycle. */
export class ScheduledTaskRepository {
  constructor(private db: DatabaseSync, private transaction: <T>(action: () => T) => T) {}

  listScheduledTasks(includeCancelled = false): ScheduledTask[] {
    const rows = this.db.prepare(`SELECT task_json FROM scheduled_tasks ${includeCancelled ? "" : "WHERE cancelled_at IS NULL"} ORDER BY rowid DESC`)
      .all() as Array<{ task_json: string }>;
    return rows.map(row => JSON.parse(row.task_json) as ScheduledTask);
  }

  listDueScheduledTasks(now: string): ScheduledTask[] {
    const rows = this.db.prepare(`SELECT task_json FROM scheduled_tasks
      WHERE enabled = 1 AND cancelled_at IS NULL AND next_run_at <= ? ORDER BY rowid DESC`)
      .all(now) as Array<{ task_json: string }>;
    return rows.map(row => JSON.parse(row.task_json) as ScheduledTask);
  }

  getScheduledTask(id: string): ScheduledTask | null {
    const row = this.db.prepare("SELECT task_json FROM scheduled_tasks WHERE id = ?").get(id) as { task_json: string } | undefined;
    return row ? JSON.parse(row.task_json) as ScheduledTask : null;
  }

  createScheduledTask(task: ScheduledTask): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO scheduled_tasks(id, enabled, next_run_at, revision, cancelled_at, task_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(task.id, Number(task.enabled), task.nextRunAt, task.revision, task.cancelledAt, JSON.stringify(task)).changes === 1;
  }

  updateScheduledTask(task: ScheduledTask, expectedRevision: number): boolean {
    return this.db.prepare(`UPDATE scheduled_tasks SET enabled = ?, next_run_at = ?, revision = ?, cancelled_at = ?, task_json = ?
      WHERE id = ? AND revision = ?`).run(Number(task.enabled), task.nextRunAt, task.revision, task.cancelledAt,
      JSON.stringify(task), task.id, expectedRevision).changes === 1;
  }

  /** Claim and advance together before any execution can escape the process. */
  claimScheduledTaskRun(task: ScheduledTask, run: ScheduledTaskRun, nextRunAt: string | null): boolean {
    return this.transaction(() => {
      const current = this.getScheduledTask(task.id);
      if (!current?.enabled || current.cancelledAt || current.revision !== task.revision
        || current.nextRunAt !== run.scheduledAt || current.nextRunAt !== task.nextRunAt) return false;
      const result = this.db.prepare("INSERT OR IGNORE INTO scheduled_task_runs(id, task_id, scheduled_at, run_json) VALUES (?, ?, ?, ?)")
        .run(run.id, run.taskId, run.scheduledAt, JSON.stringify(run));
      if (result.changes !== 1) return false;
      const advanced: ScheduledTask = { ...current, nextRunAt, enabled: nextRunAt !== null,
        revision: current.revision + 1, updatedAt: run.claimedAt };
      this.db.prepare("UPDATE scheduled_tasks SET enabled = ?, next_run_at = ?, revision = ?, task_json = ? WHERE id = ?")
        .run(Number(advanced.enabled), nextRunAt, advanced.revision, JSON.stringify(advanced), task.id);
      return true;
    });
  }

  saveScheduledTaskRun(run: ScheduledTaskRun): void {
    this.db.prepare("UPDATE scheduled_task_runs SET run_json = ? WHERE id = ? AND task_id = ?")
      .run(JSON.stringify(run), run.id, run.taskId);
  }

  getScheduledTaskRun(id: string): ScheduledTaskRun | null {
    const row = this.db.prepare("SELECT run_json FROM scheduled_task_runs WHERE id = ?").get(id) as { run_json: string } | undefined;
    return row ? JSON.parse(row.run_json) as ScheduledTaskRun : null;
  }

  listOpenScheduledTaskRuns(taskId?: string): ScheduledTaskRun[] {
    const query = `SELECT run_json FROM scheduled_task_runs WHERE json_extract(run_json, '$.executionFinishedAt') IS NULL
      AND json_extract(run_json, '$.state') IN ('claimed', 'accepted', 'unknown')`;
    const rows = (taskId ? this.db.prepare(`${query} AND task_id = ? ORDER BY scheduled_at`).all(taskId)
      : this.db.prepare(`${query} ORDER BY scheduled_at`).all()) as Array<{ run_json: string }>;
    return rows.map(row => JSON.parse(row.run_json) as ScheduledTaskRun);
  }

  getOpenScheduledTaskRunsForSession(sessionId: string): ScheduledTaskRun[] {
    const rows = this.db.prepare(`SELECT run_json FROM scheduled_task_runs WHERE json_extract(run_json, '$.receipt.sessionId') = ?
      AND json_extract(run_json, '$.executionFinishedAt') IS NULL`)
      .all(sessionId) as Array<{ run_json: string }>;
    return rows.map(row => JSON.parse(row.run_json) as ScheduledTaskRun);
  }

  /** Date-indexed, lightweight facts; prompts never enter calendar/activity payloads. */
  listScheduledTaskRunFacts(from: string, to: string, taskId?: string, limit = 1001): ScheduledTaskRunFact[] {
    const bounded = Math.max(1, Math.min(5001, Math.floor(limit)));
    const date = SCHEDULED_CLAIM_DATE_SQL;
    const where = `${taskId ? "task_id = ? AND " : ""}${date} >= julianday(?) AND ${date} <= julianday(?)`;
    const args = taskId ? [taskId, from, to, bounded] : [from, to, bounded];
    const rows = this.db.prepare(`SELECT json_remove(run_json, '$.prompt') AS fact_json FROM scheduled_task_runs
      WHERE ${where} ORDER BY ${date} DESC, id DESC LIMIT ?`).all(...args) as Array<{ fact_json: string }>;
    return rows.map(row => JSON.parse(row.fact_json) as ScheduledTaskRunFact);
  }

  countInvalidScheduledTaskRunDates(taskId?: string): number {
    const where = `(${SCHEDULED_CLAIM_DATE_SQL}) IS NULL`;
    const row = (taskId ? this.db.prepare(`SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE task_id = ? AND ${where}`).get(taskId)
      : this.db.prepare(`SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE ${where}`).get()) as { count: number };
    return row.count;
  }

  latestScheduledTaskRun(taskId: string): ScheduledTaskRun | null {
    const row = this.db.prepare(`SELECT run_json FROM scheduled_task_runs WHERE task_id = ?
      ORDER BY (${SCHEDULED_CLAIM_DATE_SQL}) DESC, id DESC LIMIT 1`).get(taskId) as { run_json: string } | undefined;
    return row ? JSON.parse(row.run_json) as ScheduledTaskRun : null;
  }

  listScheduledTaskRuns(taskId?: string, limit = 50): ScheduledTaskRun[] {
    const bounded = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 50));
    const rows = (taskId
      ? this.db.prepare("SELECT run_json FROM scheduled_task_runs WHERE task_id = ? ORDER BY scheduled_at DESC LIMIT ?").all(taskId, bounded)
      : this.db.prepare("SELECT run_json FROM scheduled_task_runs ORDER BY scheduled_at DESC LIMIT ?").all(bounded)) as Array<{ run_json: string }>;
    return rows.map(row => JSON.parse(row.run_json) as ScheduledTaskRun);
  }

}
