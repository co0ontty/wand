import { sessionPersistValues } from "./mappers.js";
import { sessionRuntimeMetadataValues } from "./mappers.js";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "../password-manager.js";
import { ConversationTurn, SessionSnapshot, StructuredSessionState } from "../types.js";
import { SessionRow, sessionSelectFields, sessionPersistFields, sessionPersistAssignments, sessionRuntimeMetadataAssignments, mapSessionCore, sessionRowQuery } from "./mappers.js";
import type { WandStorage } from "../storage.js";
import { SYSTEM_AI_AUXILIARY_PURPOSES, SYSTEM_AI_CALL_PREFIX } from "../system-ai-call.js";

const AUXILIARY_HISTORY_PATTERNS = SYSTEM_AI_AUXILIARY_PURPOSES.map(purpose => `${SYSTEM_AI_CALL_PREFIX}${purpose}:?*`);

/** Session storage: one domain of the WandStorage facade. Shares the connection and the facade's transaction. */
export class SessionRepository {
  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

  listGithubIssueBindings(owner: string, repo: string, issueNumber: number): Array<{ sessionId: string; boundAt: string }> {
    const rows = this.db.prepare(
      `SELECT session_id, bound_at FROM github_issue_bindings
       WHERE owner = ? AND repo = ? AND issue_number = ? ORDER BY bound_at ASC`,
    ).all(owner, repo, issueNumber) as unknown as Array<{ session_id: string; bound_at: string }>;
    return rows.map((row) => ({ sessionId: row.session_id, boundAt: row.bound_at }));
  }

  bindGithubIssueSession(owner: string, repo: string, issueNumber: number, sessionId: string): void {
    if (!this.getSession(sessionId)) throw new Error("未找到该会话。");
    this.db.prepare(
      `INSERT OR IGNORE INTO github_issue_bindings (owner, repo, issue_number, session_id, bound_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(owner, repo, issueNumber, sessionId, nowIso());
  }

  unbindGithubIssueSession(owner: string, repo: string, issueNumber: number, sessionId: string): void {
    this.db.prepare(
      `DELETE FROM github_issue_bindings WHERE owner = ? AND repo = ? AND issue_number = ? AND session_id = ?`,
    ).run(owner, repo, issueNumber, sessionId);
  }

  listSessionsByWorkspaceTask(taskId: string): SessionSnapshot[] {
    const rows = this.db
      .prepare(
        `${sessionRowQuery("SELECT")}
         FROM command_sessions
         WHERE workspace_task_id = ?
         ORDER BY started_at DESC`
      )
      .all(taskId) as unknown as SessionRow[];
    return rows.map((row) => this.mapSessionRow(row));
  }

  /**
   * 同 `listSessionsByWorkspaceTask`，但不读 `output`/`messages` 大字段。
   *
   * 侧栏的目录组、任务详情、自动命名只需要元数据；完整行会把整个会话消息
   * 历史 JSON 解析一遍（单会话可达十几 MB），每轮轮询都会卡住事件循环。
   */
  listSessionsByWorkspaceTaskSlim(taskId: string): SessionSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT ${sessionSelectFields(true)}
         FROM command_sessions
         WHERE workspace_task_id = ?
         ORDER BY started_at DESC`
      )
      .all(taskId) as unknown as SessionRow[];
    return rows.map((row) => this.mapSessionRow(row));
  }

  setSessionWorkspaceTaskId(sessionId: string, taskId: string | null): void {
    this.s.moveSessionToWorkspaceTask(sessionId, taskId);
  }

  /** Completion/read state is independent of runner checkpoints and survives restarts. */
  getSessionCompletion(id: string): { completionRevision: number; viewedCompletionRevision: number } | null {
    const row = this.db.prepare(`SELECT completion_revision AS completionRevision,
      viewed_completion_revision AS viewedCompletionRevision FROM command_sessions WHERE id = ?`)
      .get(id) as { completionRevision: number; viewedCompletionRevision: number } | undefined;
    return row ? { ...row } : null;
  }

  recordSessionCompletion(id: string): ReturnType<WandStorage["getSessionCompletion"]> {
    const row = this.db.prepare(`UPDATE command_sessions SET completion_revision = completion_revision + 1
      WHERE id = ? RETURNING completion_revision AS completionRevision,
        viewed_completion_revision AS viewedCompletionRevision`)
      .get(id) as { completionRevision: number; viewedCompletionRevision: number } | undefined;
    return row ? { ...row } : null;
  }

  /** A delayed view of generation N must never consume a newer completion N+1. */
  markSessionCompletionViewed(id: string, revision: number): boolean {
    return this.db.prepare(`UPDATE command_sessions SET viewed_completion_revision = ?
      WHERE id = ? AND completion_revision = ? AND viewed_completion_revision < ?`)
      .run(revision, id, revision, revision).changes > 0;
  }

  saveSession(snapshot: SessionSnapshot): void {
    const isNew = !this.s.getSessionWorkspace(snapshot.id);
    // Existing sessions stay a single atomic statement: streaming checkpoints must not
    // take the write lock. Only a brand-new row also links its task membership, and
    // that link is one transaction with the insert so a crash cannot leave half of it.
    const upsert = (): void => {
      this.db
        .prepare(
          `INSERT INTO command_sessions (
           ${sessionPersistFields()}
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             ${sessionPersistAssignments()}`
        )
        .run(...sessionPersistValues(snapshot));
    };
    if (!isNew) {
      upsert();
      return;
    }
    this.s.transaction(() => {
      upsert();
      const task = snapshot.workspaceTaskId ? this.s.getWorkspaceTask(snapshot.workspaceTaskId) : null;
      if (task && task.workspaceId !== snapshot.workspaceId) {
        this.db.prepare("UPDATE command_sessions SET workspace_id = ? WHERE id = ?")
          .run(task.workspaceId, snapshot.id);
      }
      this.s.recordTaskSession(snapshot);
    });
  }

  /** Update runtime/scalar fields without serializing or rewriting messages/output. */
  updateSessionRuntimeMetadata(snapshot: SessionSnapshot): void {
    this.db
      .prepare(
        `UPDATE command_sessions SET
           ${sessionRuntimeMetadataAssignments()}
         WHERE id = ?`
      )
      .run(...sessionRuntimeMetadataValues(snapshot));
  }

  /** Compatibility alias for older callers; intentionally excludes output/messages. */
  saveSessionMetadata(snapshot: SessionSnapshot): void {
    this.updateSessionRuntimeMetadata(snapshot);
  }

  /** Checkpoint only the PTY/structured text output window. */
  checkpointSessionOutput(id: string, output: string, ptyOutputSeq?: number): void {
    if (ptyOutputSeq === undefined) {
      this.db.prepare("UPDATE command_sessions SET output = ? WHERE id = ?").run(output, id);
      return;
    }
    this.db.prepare("UPDATE command_sessions SET output = ?, pty_output_seq = ? WHERE id = ?")
      .run(output, ptyOutputSeq, id);
  }

  /**
   * Checkpoint the conversation payload once, optionally folding the matching
   * structured state/output into the same statement.
   */
  checkpointSessionMessages(
    id: string,
    messages: ConversationTurn[],
    structuredState?: StructuredSessionState | null,
    output?: string,
    ptyOutputSeq?: number,
  ): void {
    const assignments = ["messages = ?"];
    const values: Array<string | number | null> = [JSON.stringify(messages)];
    if (structuredState !== undefined) {
      assignments.push("structured_state = ?");
      values.push(structuredState ? JSON.stringify(structuredState) : null);
    }
    if (output !== undefined) {
      assignments.push("output = ?");
      values.push(output);
    }
    if (ptyOutputSeq !== undefined) {
      assignments.push("pty_output_seq = ?");
      values.push(ptyOutputSeq);
    }
    this.db
      .prepare(`UPDATE command_sessions SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...values, id);
  }

  getSession(id: string): SessionSnapshot | null {
    const row = this.db
      .prepare(
        `${sessionRowQuery("SELECT")}
         FROM command_sessions
         WHERE id = ?`
      )
      .get(id) as SessionRow | undefined;

    return row ? this.mapSessionRow(row) : null;
  }

  /** Full sessions (messages and output) for many ids, chunked; missing ids are skipped. */
  getSessionsByIds(ids: readonly string[]): SessionSnapshot[] {
    const byId = new Map<string, SessionSnapshot>();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const rows = this.db.prepare(`${sessionRowQuery("SELECT")}
        FROM command_sessions WHERE id IN (${chunk.map(() => "?").join(", ")})`).all(...chunk) as unknown as SessionRow[];
      for (const row of rows) byId.set(row.id, this.mapSessionRow(row));
    }
    return ids.flatMap((id) => {
      const session = byId.get(id);
      return session ? [session] : [];
    });
  }

  /** 同 `getSession`，但不读 `output`/`messages` 大字段（只取元数据的路径用）。 */
  /** Slim sessions (no output/messages) for many ids in chunked IN queries; order follows the input. */
  getSessionsSlimByIds(ids: readonly string[]): SessionSnapshot[] {
    const byId = new Map<string, SessionSnapshot>();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const rows = this.db.prepare(`SELECT ${sessionSelectFields(true)} FROM command_sessions
        WHERE id IN (${chunk.map(() => "?").join(", ")})`).all(...chunk) as unknown as SessionRow[];
      for (const row of rows) byId.set(row.id, this.mapSessionRow(row));
    }
    return ids.flatMap((id) => {
      const session = byId.get(id);
      return session ? [session] : [];
    });
  }

  getSessionSlim(id: string): SessionSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT ${sessionSelectFields(true)}
         FROM command_sessions
         WHERE id = ?`
      )
      .get(id) as SessionRow | undefined;

    return row ? this.mapSessionRow(row) : null;
  }

  getLatestSessionByClaudeSessionId(claudeSessionId: string): SessionSnapshot | null {
    const row = this.db
      .prepare(
        `${sessionRowQuery("SELECT")}
         FROM command_sessions
         WHERE claude_session_id = ?
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get(claudeSessionId) as SessionRow | undefined;

    return row ? this.mapSessionRow(row) : null;
  }

  loadSessions(): SessionSnapshot[] {
    const rows = this.db
      .prepare(
        `${sessionRowQuery("SELECT")}
         FROM command_sessions
         ORDER BY started_at DESC`
      )
      .all() as unknown as SessionRow[];

    return rows.map((row) => this.mapSessionRow(row));
  }

  /** List durable metadata without reading or parsing output/messages payloads. */
  loadSessionsSlim(): SessionSnapshot[] {
    const rows = this.db.prepare(
      `SELECT ${sessionSelectFields(true)} FROM command_sessions ORDER BY started_at DESC`
    ).all() as unknown as SessionRow[];
    return rows.map((row) => this.mapSessionRow(row));
  }

  mapSessionRow(row: SessionRow): SessionSnapshot {
    return mapSessionCore(row);
  }

  /** Metadata-only indexed scan. Running or ambiguous records never count toward the history cap. */
  excessSystemAiSessionIds(employeeId: string, keep: number): string[] {
    if (!Number.isInteger(keep) || keep < 0 || keep > 10_000) return [];
    const rows = this.db.prepare(`SELECT id FROM command_sessions
      WHERE (${AUXILIARY_HISTORY_PATTERNS.map(() => "automation_id GLOB ?").join(" OR ")})
        AND json_extract(session_options, '$.employeeId') = ?
        AND status IN ('exited', 'failed', 'stopped') AND ended_at IS NOT NULL
      ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?`).all(...AUXILIARY_HISTORY_PATTERNS, employeeId, keep) as Array<{ id: string }>;
    return rows.map(row => row.id);
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM command_sessions WHERE id = ?").run(id);
  }
}
