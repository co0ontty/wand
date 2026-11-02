import type { DatabaseSync } from "node:sqlite";
import type { WandStorage } from "../storage.js";
import type { SessionSnapshot } from "../types.js";
import { nowIso } from "../password-manager.js";
import { SessionMessageRepository } from "./session-messages-repository.js";

const CONVERSATION_CHANNELS = `SELECT session_id AS id FROM conversations
  UNION SELECT json_extract(instance_json, '$.communicationSessionId') FROM conversations
  UNION SELECT value FROM conversations, json_each(instance_json, '$.historySessionIds')`;

/** Referenced user history outlives its execution owner. Never registered with a runner. */
export class SessionHistoryRepository {
  readonly messages: SessionMessageRepository;
  constructor(private readonly db: DatabaseSync, private readonly storage: WandStorage) {
    this.messages = new SessionMessageRepository(db, storage, true);
  }

  private isReferenced(id: string): boolean {
    if (this.db.prepare(`SELECT 1 FROM conversation_messages
      WHERE json_extract(turn_json, '$.sessionLink.sessionId') = ? OR json_extract(turn_json, '$.author.sessionId') = ? LIMIT 1`).get(id, id)) return true;
    if (this.db.prepare(`WITH channels AS (${CONVERSATION_CHANNELS}) SELECT 1 FROM channels WHERE id = ? LIMIT 1`).get(id)) return true;
    // Group replies carry their exact member execution in author metadata. Inspect indexed metadata,
    // including a preserved channel, without hydrating its transcript or retaining any runner.
    for (const table of ["session_message_turns", "session_history_turns"]) {
      if (this.db.prepare(`WITH channels AS (${CONVERSATION_CHANNELS}) SELECT 1 FROM ${table}
        WHERE session_id IN (SELECT id FROM channels) AND
          (json_extract(metadata_json, '$.author.sessionId') = ? OR json_extract(metadata_json, '$.sessionLink.sessionId') = ?) LIMIT 1`).get(id, id)) return true;
    }
    // Pre-pagination channels have not been normalized until their first read/write.
    return !!this.db.prepare(`WITH channels AS (${CONVERSATION_CHANNELS})
      SELECT 1 FROM command_sessions s, json_each(CASE WHEN json_valid(s.messages) THEN s.messages ELSE '[]' END) t
      WHERE s.id IN (SELECT id FROM channels) AND NOT EXISTS (SELECT 1 FROM session_message_heads h WHERE h.session_id=s.id)
        AND (json_extract(t.value, '$.author.sessionId') = ? OR json_extract(t.value, '$.sessionLink.sessionId') = ?) LIMIT 1`).get(id, id);
  }

  /** Call inside/before every destructive storage path; failure must abort deletion. */
  preserveConversationSession(id: string, latest?: SessionSnapshot, reason = "session-delete"): void {
    this.storage.transaction(() => {
      if (!this.isReferenced(id) || this.getSessionHistory(id)) return;
      const stored = this.storage.getSessionDisplaySnapshot(id);
      if (!stored) return; // Missing old content is not a recoverable snapshot.
      if (latest?.messages !== undefined) this.storage.checkpointSessionMessages(id, latest.messages, latest.structuredState, latest.output);
      const head = this.db.prepare("SELECT turn_count FROM session_message_heads WHERE session_id = ?").get(id) as { turn_count: number } | undefined;
      if (!head || head.turn_count === 0) {
        const legacy = this.db.prepare("SELECT messages FROM command_sessions WHERE id = ?").get(id) as { messages: string | null };
        if (legacy.messages) {
          let parsed: unknown;
          try { parsed = JSON.parse(legacy.messages); } catch { throw new Error("历史消息格式损坏，无法安全保全，已取消删除。"); }
          if (!Array.isArray(parsed)) throw new Error("历史消息格式无效，无法安全保全，已取消删除。");
        }
      }
      this.storage.ensureSessionMessageRows(id);
      const source = latest ?? stored;
      const preservedAt = nowIso();
      // Keep display/history facts only. No resume IDs, worktrees, queues, prompts or execution settings.
      const snapshot: SessionSnapshot = {
        id, historyOnly: true, claudeSessionId: null, sessionKind: source.sessionKind, runner: source.runner, provider: source.provider,
        employeeId: source.employeeId, employeeName: source.employeeName, employeeAvatar: source.employeeAvatar,
        title: source.title, description: source.description, cwd: source.cwd, command: source.command, mode: source.mode,
        status: source.status === "running" ? "stopped" : source.status === "idle" ? "exited" : source.status,
        exitCode: source.exitCode, startedAt: source.startedAt, endedAt: source.endedAt ?? preservedAt,
        output: source.output, archived: true, archivedAt: source.archivedAt ?? preservedAt,
        selectedModel: source.selectedModel, thinkingEffort: source.thinkingEffort,
        structuredState: source.structuredState ? { provider: source.structuredState.provider, runner: source.structuredState.runner,
          lastError: source.structuredState.lastError, inFlight: false, activeRequestId: null } : undefined,
      };
      this.db.prepare(`INSERT INTO session_history_heads(session_id, turn_count, format_version, snapshot_json, preserved_at, reason)
        SELECT session_id, turn_count, format_version, ?, ?, ? FROM session_message_heads WHERE session_id = ?`)
        .run(JSON.stringify(snapshot), preservedAt, reason, id);
      this.db.prepare(`INSERT INTO session_history_turns SELECT * FROM session_message_turns WHERE session_id = ?`).run(id);
      this.db.prepare(`INSERT INTO session_history_blocks SELECT * FROM session_message_blocks WHERE session_id = ?`).run(id);
    });
  }

  getSessionHistory(id: string): SessionSnapshot | null {
    const row = this.db.prepare("SELECT snapshot_json FROM session_history_heads WHERE session_id = ?").get(id) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as SessionSnapshot : null;
  }

  /** Removing a conversation may release only snapshots with no surviving reference. */
  releaseUnreferencedSessionHistory(ids: readonly string[]): void {
    const pending = new Set(ids);
    for (const id of pending) {
      if (this.isReferenced(id)) continue;
      // Removing a channel can release member histories reachable only through that channel.
      for (const table of ["session_message_turns", "session_history_turns"]) {
        const rows = this.db.prepare(`SELECT json_extract(metadata_json, '$.author.sessionId') AS author,
          json_extract(metadata_json, '$.sessionLink.sessionId') AS link FROM ${table} WHERE session_id = ?`)
          .all(id) as Array<{ author: string | null; link: string | null }>;
        for (const row of rows) for (const source of [row.author, row.link]) if (source) pending.add(source);
      }
      this.db.prepare("DELETE FROM session_history_heads WHERE session_id = ?").run(id);
    }
  }
}
