import { DatabaseSync } from "node:sqlite";
import { USER_MEMORY_MAX_EVENTS, USER_MEMORY_RETENTION_MS, type UserMemoryEvent, type UserMemoryProfile, type UserMemoryState } from "../user-memory-types.js";
import { safeJsonParse } from "./mappers.js";
import type { WandStorage } from "../storage.js";

/** UserMemory storage: one domain of the WandStorage facade. Shares the connection and the facade's transaction. */
export class UserMemoryRepository {
  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

  /** No IO on input hot paths; queued observations still CAS against the database before writing. */
  userMemoryCaptureState(): Readonly<{ enabled: boolean; revision: number }> {
    return this.s.memoryCapture;
  }

  stopUserMemoryCapture(): void {
    this.s.memoryCapture = { ...this.s.memoryCapture, enabled: false };
  }

  getUserMemoryState(now = Date.now()): UserMemoryState {
    const row = this.db.prepare("SELECT * FROM user_memory_state WHERE id = 1").get()!;
    const candidate = safeJsonParse<UserMemoryProfile>(row.profile_json as string | null);
    let profile = candidate && candidate.expiresAt > now && Array.isArray(candidate.preferences)
      && candidate.preferences.length <= 10 && candidate.preferences.every((entry) =>
        entry && typeof entry.text === "string" && entry.text.length <= 160
        && Array.isArray(entry.evidenceIds) && entry.evidenceIds.length <= 5
        && entry.evidenceIds.every((id) => Number.isSafeInteger(id))) ? candidate : null;
    const ids = profile ? [...new Set(profile.preferences.flatMap((entry) => entry.evidenceIds))] : [];
    if (ids.length) {
      const count = this.db.prepare(`SELECT COUNT(*) AS total FROM user_memory_events
        WHERE id IN (${ids.map(() => "?").join(",")}) AND created_at > ? AND created_at <= ?`)
        .get(...ids, now - USER_MEMORY_RETENTION_MS, now)?.total;
      if (count !== ids.length) profile = null;
    }
    return {
      enabled: row.enabled === 1,
      revision: Number(row.revision),
      lastAttemptAt: Number(row.last_attempt_at),
      sourceId: Number(row.source_id),
      profile,
    };
  }

  listUserMemoryEvents(now = Date.now(), limit = 80): UserMemoryEvent[] {
    const rows = this.db.prepare(`SELECT id, feature, text, created_at FROM user_memory_events
      WHERE created_at > ? AND created_at <= ? ORDER BY id DESC LIMIT ?`)
      .all(now - USER_MEMORY_RETENTION_MS, now, Math.max(1, Math.min(limit, USER_MEMORY_MAX_EVENTS))) as
      Array<{ id: number; feature: string; text: string; created_at: number }>;
    return rows.reverse().map((row) => ({
      id: row.id, feature: row.feature, text: row.text, createdAt: row.created_at,
    }));
  }

  userMemoryFeatureCounts(now = Date.now()): Array<{ feature: string; count: number }> {
    return this.db.prepare(`SELECT feature, COUNT(*) AS count FROM user_memory_events
      WHERE created_at > ? AND created_at <= ? GROUP BY feature ORDER BY count DESC, feature`)
      .all(now - USER_MEMORY_RETENTION_MS, now) as Array<{ feature: string; count: number }>;
  }

  /** Only already-redacted, bounded observations reach this table. Queued writes use revision CAS. */
  appendUserMemoryEvent(
    feature: string, text: string, dedupKey: string, revision: number, now = Date.now(),
  ): void {
    this.s.transaction(() => {
      const state = this.getUserMemoryState(now);
      if (!state.enabled || state.revision !== revision) return;
      this.pruneUserMemory(now);
      const duplicate = this.db.prepare(`SELECT id FROM user_memory_events
        WHERE dedup_key = ? AND created_at > ? LIMIT 1`).get(dedupKey, now - 120_000);
      if (duplicate) return;
      this.db.prepare(`INSERT INTO user_memory_events (feature, text, dedup_key, created_at)
        VALUES (?, ?, ?, ?)`).run(feature, text, dedupKey, now);
      this.db.prepare(`DELETE FROM user_memory_events WHERE id NOT IN
        (SELECT id FROM user_memory_events ORDER BY id DESC LIMIT ?)`)
        .run(USER_MEMORY_MAX_EVENTS);
      this.pruneUserMemory(now);
    });
  }

  pruneUserMemory(now = Date.now()): void {
    this.db.prepare("DELETE FROM user_memory_events WHERE created_at <= ?")
      .run(now - USER_MEMORY_RETENTION_MS);
    const saved = this.db.prepare("SELECT profile_json FROM user_memory_state WHERE id = 1").get();
    if (saved?.profile_json && !this.getUserMemoryState(now).profile) {
      this.db.exec("UPDATE user_memory_state SET profile_json = NULL, source_id = 0 WHERE id = 1");
      this.s.ensureDefaultSiliconEmployee();
    }
  }

  setUserMemoryEnabled(enabled: boolean): void {
    this.s.transaction(() => {
      this.db.prepare(`UPDATE user_memory_state SET enabled = ?, revision = revision + 1,
        last_attempt_at = 0, source_id = 0, profile_json = NULL WHERE id = 1`).run(enabled ? 1 : 0);
      this.s.ensureDefaultSiliconEmployee();
    });
    this.s.memoryCapture = { enabled, revision: this.s.memoryCapture.revision + 1 };
  }

  clearUserMemory(): void {
    this.s.transaction(() => {
      this.db.exec(`DELETE FROM user_memory_events;
        UPDATE user_memory_state SET revision = revision + 1, last_attempt_at = 0,
          source_id = 0, profile_json = NULL WHERE id = 1;`);
      this.s.ensureDefaultSiliconEmployee();
    });
    this.s.memoryCapture = { ...this.s.memoryCapture, revision: this.s.memoryCapture.revision + 1 };
  }

  markUserMemoryAttempt(revision: number, now: number): boolean {
    return this.db.prepare(`UPDATE user_memory_state SET last_attempt_at = ?
      WHERE id = 1 AND enabled = 1 AND revision = ?`).run(now, revision).changes === 1;
  }

  /** Read fresh candidates inside the transaction; a late model result cannot undo user edits/clear. */
  applyUserMemoryProfile(
    profile: UserMemoryProfile, revision: number, sourceId: number, now = Date.now(),
  ): boolean {
    return this.s.transaction(() => {
      const state = this.getUserMemoryState(now);
      if (!state.enabled || state.revision !== revision || profile.expiresAt <= now) return false;
      const evidence = this.db.prepare("SELECT created_at FROM user_memory_events WHERE id = ?");
      for (const id of new Set(profile.preferences.flatMap((entry) => entry.evidenceIds))) {
        const row = evidence.get(id);
        if (!row || Number(row.created_at) <= now - USER_MEMORY_RETENTION_MS) return false;
      }
      this.db.prepare(`UPDATE user_memory_state SET profile_json = ?, source_id = ? WHERE id = 1`)
        .run(JSON.stringify(profile), sourceId);
      this.s.ensureDefaultSiliconEmployee();
      return true;
    });
  }
}
