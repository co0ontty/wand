import { DatabaseSync } from "node:sqlite";
import type { AgentActivityItem, Mission, MissionAttempt, MissionReviewComment, MissionReviewStatus, MissionStatus } from "../mission-types.js";
import { nowIso } from "../password-manager.js";
import type { WandStorage } from "../storage.js";
import { mapMissionRow, mapMissionAttemptRow, mapMissionReviewCommentRow, mapAgentActivityRow } from "./internal.js";

/** Mission storage: one domain of the WandStorage facade. Shares the connection and the facade's transaction. */
export class MissionRepository {
  constructor(private readonly db: DatabaseSync, _s: WandStorage) {}

  saveMission(mission: Mission): void {
    this.db.prepare(
      `INSERT INTO missions (
         id, title, prompt, cwd, status, base_ref, shared_directories, copy_paths, created_at, updated_at, task_id, milestone_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, prompt = excluded.prompt, cwd = excluded.cwd,
         status = excluded.status, base_ref = excluded.base_ref,
         shared_directories = excluded.shared_directories, copy_paths = excluded.copy_paths,
         updated_at = excluded.updated_at, task_id = excluded.task_id,
         milestone_id = excluded.milestone_id`
    ).run(
      mission.id,
      mission.title,
      mission.prompt,
      mission.cwd,
      mission.status,
      mission.worktree.baseRef ?? null,
      JSON.stringify(mission.worktree.sharedDirectories ?? []),
      JSON.stringify(mission.worktree.copyPaths ?? []),
      mission.createdAt,
      mission.updatedAt,
      mission.taskId ?? null,
      mission.milestoneId ?? null,
    );
  }

  getMission(id: string): Mission | null {
    const row = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapMissionRow(row) : null;
  }

  listMissions(includeArchived = false): Mission[] {
    const rows = this.db.prepare(
      `SELECT * FROM missions ${includeArchived ? "" : "WHERE status <> 'archived'"} ORDER BY updated_at DESC`
    ).all() as unknown as Record<string, unknown>[];
    return rows.map(mapMissionRow);
  }

  updateMissionStatus(id: string, status: MissionStatus, updatedAt = nowIso()): void {
    this.db.prepare("UPDATE missions SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, id);
  }

  saveMissionAttempt(attempt: MissionAttempt): void {
    this.db.prepare(
      `INSERT INTO mission_attempts (
         id, mission_id, session_id, provider, state, branch, worktree_path, base_ref,
         summary, error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id, state = excluded.state, branch = excluded.branch,
         worktree_path = excluded.worktree_path, base_ref = excluded.base_ref,
         summary = excluded.summary, error = excluded.error, updated_at = excluded.updated_at`
    ).run(
      attempt.id, attempt.missionId, attempt.sessionId, attempt.provider, attempt.state,
      attempt.branch, attempt.worktreePath, attempt.baseRef, attempt.summary, attempt.error,
      attempt.createdAt, attempt.updatedAt,
    );
  }

  getMissionAttempt(id: string): MissionAttempt | null {
    const row = this.db.prepare("SELECT * FROM mission_attempts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapMissionAttemptRow(row) : null;
  }

  getMissionAttemptBySession(sessionId: string): MissionAttempt | null {
    const row = this.db.prepare("SELECT * FROM mission_attempts WHERE session_id = ?").get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapMissionAttemptRow(row) : null;
  }

  listMissionAttempts(missionId: string): MissionAttempt[] {
    const rows = this.db.prepare("SELECT * FROM mission_attempts WHERE mission_id = ? ORDER BY created_at ASC").all(missionId) as unknown as Record<string, unknown>[];
    return rows.map(mapMissionAttemptRow);
  }

  saveMissionReviewComment(comment: MissionReviewComment): void {
    this.db.prepare(
      `INSERT INTO mission_review_comments (
         id, mission_id, attempt_id, file_path, line, side, body, status, created_at, sent_at, resolved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         file_path = excluded.file_path, line = excluded.line, side = excluded.side,
         body = excluded.body, status = excluded.status, sent_at = excluded.sent_at,
         resolved_at = excluded.resolved_at`
    ).run(
      comment.id, comment.missionId, comment.attemptId, comment.filePath, comment.line,
      comment.side, comment.body, comment.status, comment.createdAt, comment.sentAt, comment.resolvedAt,
    );
  }

  listMissionReviewComments(missionId: string, attemptId?: string): MissionReviewComment[] {
    const rows = attemptId
      ? this.db.prepare("SELECT * FROM mission_review_comments WHERE mission_id = ? AND attempt_id = ? ORDER BY created_at ASC").all(missionId, attemptId)
      : this.db.prepare("SELECT * FROM mission_review_comments WHERE mission_id = ? ORDER BY created_at ASC").all(missionId);
    return (rows as unknown as Record<string, unknown>[]).map(mapMissionReviewCommentRow);
  }

  updateMissionReviewStatus(ids: string[], status: MissionReviewStatus, at = nowIso()): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    const timestampColumn = status === "sent" ? "sent_at" : status === "resolved" ? "resolved_at" : null;
    const timestampSql = timestampColumn ? `, ${timestampColumn} = ?` : "";
    this.db.prepare(`UPDATE mission_review_comments SET status = ?${timestampSql} WHERE id IN (${placeholders})`)
      .run(status, ...(timestampColumn ? [at] : []), ...ids);
  }

  upsertAgentActivity(item: AgentActivityItem): void {
    this.db.prepare(
      `INSERT INTO agent_activity (
         session_id, mission_id, attempt_id, state, title, summary, provider, cwd, updated_at, read_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         mission_id = excluded.mission_id, attempt_id = excluded.attempt_id,
         state = excluded.state, title = excluded.title, summary = excluded.summary,
         provider = excluded.provider, cwd = excluded.cwd, updated_at = excluded.updated_at,
         read_at = CASE WHEN agent_activity.state = excluded.state THEN agent_activity.read_at ELSE excluded.read_at END`
    ).run(
      item.sessionId, item.missionId, item.attemptId, item.state, item.title,
      item.summary, item.provider, item.cwd, item.updatedAt, item.readAt,
    );
  }

  listAgentActivity(): AgentActivityItem[] {
    const rows = this.db.prepare(
      `SELECT * FROM agent_activity
       ORDER BY CASE state WHEN 'needs_permission' THEN 0 WHEN 'needs_input' THEN 1 WHEN 'working' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
                updated_at DESC`
    ).all() as unknown as Record<string, unknown>[];
    return rows.map(mapAgentActivityRow);
  }

  markAgentActivityRead(sessionId?: string): void {
    const at = nowIso();
    if (sessionId) this.db.prepare("UPDATE agent_activity SET read_at = ? WHERE session_id = ?").run(at, sessionId);
    else this.db.prepare("UPDATE agent_activity SET read_at = ? WHERE read_at IS NULL").run(at);
  }
}
