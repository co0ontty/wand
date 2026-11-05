import { DEFAULT_EMPLOYEE_ID } from "../ai-team-types.js";
import { DatabaseSync } from "node:sqlite";
import { USER_MEMORY_MAX_EVENTS, USER_MEMORY_RETENTION_MS, type UserMemoryEvent, type UserMemoryProfile, type UserMemoryState } from "../user-memory-types.js";
import { safeJsonParse } from "./mappers.js";
import type { WandStorage } from "../storage.js";

/** UserMemory storage: one domain of the WandStorage facade. Shares the connection and the facade's transaction. */
export class UserMemoryRepository {
  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

  private stopped = false;

  userMemoryCaptureState(employeeId = DEFAULT_EMPLOYEE_ID): Readonly<{ enabled: boolean; revision: number }> {
    const row = this.db.prepare("SELECT enabled, revision FROM employee_memory_state WHERE employee_id = ?").get(employeeId);
    const employee = this.s.getSiliconEmployeeDefinition(employeeId);
    return { enabled: !this.stopped && !!employee && !employee.archivedAt && row?.enabled === 1, revision: Number(row?.revision ?? 0) };
  }

  stopUserMemoryCapture(): void {
    this.stopped = true;
  }

  getUserMemoryState(now = Date.now(), employeeId = DEFAULT_EMPLOYEE_ID): UserMemoryState {
    const row = this.db.prepare("SELECT * FROM employee_memory_state WHERE employee_id = ?").get(employeeId);
    if (!row) return { enabled: false, revision: 0, lastAttemptAt: 0, sourceId: 0, profile: null };
    const candidate = safeJsonParse<UserMemoryProfile>(row.profile_json as string | null);
    let profile = candidate && candidate.expiresAt > now && Array.isArray(candidate.preferences)
      && candidate.preferences.length <= 10 && candidate.preferences.every((entry) =>
        entry && typeof entry.text === "string" && entry.text.length <= 160
        && Array.isArray(entry.evidenceIds) && entry.evidenceIds.length <= 5
        && entry.evidenceIds.every((id) => Number.isSafeInteger(id))) ? candidate : null;
    const ids = profile ? [...new Set(profile.preferences.flatMap((entry) => entry.evidenceIds))] : [];
    if (ids.length) {
      const count = this.db.prepare(`SELECT COUNT(*) AS total FROM employee_memory_events
        WHERE employee_id = ? AND id IN (${ids.map(() => "?").join(",")}) AND created_at > ? AND created_at <= ?`)
        .get(employeeId, ...ids, now - USER_MEMORY_RETENTION_MS, now)?.total;
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

  listUserMemoryEvents(now = Date.now(), limit = 80, employeeId = DEFAULT_EMPLOYEE_ID): UserMemoryEvent[] {
    const rows = this.db.prepare(`SELECT id, feature, text, created_at FROM employee_memory_events
      WHERE employee_id = ? AND created_at > ? AND created_at <= ? ORDER BY id DESC LIMIT ?`)
      .all(employeeId, now - USER_MEMORY_RETENTION_MS, now, Math.max(1, Math.min(limit, USER_MEMORY_MAX_EVENTS))) as
      Array<{ id: number; feature: string; text: string; created_at: number }>;
    return rows.reverse().map((row) => ({
      id: row.id, feature: row.feature, text: row.text, createdAt: row.created_at,
    }));
  }

  userMemoryFeatureCounts(now = Date.now(), employeeId = DEFAULT_EMPLOYEE_ID): Array<{ feature: string; count: number }> {
    return this.db.prepare(`SELECT feature, COUNT(*) AS count FROM employee_memory_events
      WHERE employee_id = ? AND created_at > ? AND created_at <= ? GROUP BY feature ORDER BY count DESC, feature`)
      .all(employeeId, now - USER_MEMORY_RETENTION_MS, now) as Array<{ feature: string; count: number }>;
  }

  /** Only already-redacted, bounded observations reach this table. Queued writes use revision CAS. */
  appendUserMemoryEvent(
    feature: string, text: string, dedupKey: string, revision: number, now = Date.now(), employeeId = DEFAULT_EMPLOYEE_ID,
  ): void {
    this.s.transaction(() => {
      const state = this.getUserMemoryState(now, employeeId);
      if (!this.userMemoryCaptureState(employeeId).enabled || !state.enabled || state.revision !== revision) return;
      this.pruneUserMemory(now, employeeId);
      const duplicate = this.db.prepare(`SELECT id FROM employee_memory_events
        WHERE employee_id = ? AND dedup_key = ? AND created_at > ? LIMIT 1`).get(employeeId, dedupKey, now - 120_000);
      if (duplicate) return;
      this.db.prepare(`INSERT INTO employee_memory_events (employee_id, feature, text, dedup_key, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(employeeId, feature, text, dedupKey, now);
      this.db.prepare(`DELETE FROM employee_memory_events WHERE employee_id = ? AND id NOT IN
        (SELECT id FROM employee_memory_events WHERE employee_id = ? ORDER BY id DESC LIMIT ?)`)
        .run(employeeId, employeeId, USER_MEMORY_MAX_EVENTS);
      this.pruneUserMemory(now, employeeId);
    });
  }

  pruneUserMemory(now = Date.now(), employeeId = DEFAULT_EMPLOYEE_ID): void {
    this.db.prepare("DELETE FROM employee_memory_events WHERE created_at <= ?")
      .run(now - USER_MEMORY_RETENTION_MS);
    if (!this.getUserMemoryState(now, employeeId).profile) {
      this.db.prepare("UPDATE employee_memory_state SET profile_json = NULL, source_id = 0 WHERE employee_id = ?").run(employeeId);
    }
  }

  setUserMemoryEnabled(enabled: boolean, employeeId = DEFAULT_EMPLOYEE_ID): void {
    if (!this.s.getSiliconEmployeeDefinition(employeeId)) throw new Error("员工不存在。");
    this.db.prepare(`INSERT INTO employee_memory_state (employee_id, enabled, revision) VALUES (?, ?, 1)
      ON CONFLICT(employee_id) DO UPDATE SET enabled = excluded.enabled, revision = revision + 1,
        last_attempt_at = 0, source_id = 0, profile_json = NULL`).run(employeeId, enabled ? 1 : 0);
  }

  clearUserMemory(employeeId = DEFAULT_EMPLOYEE_ID): void {
    this.s.transaction(() => {
      this.db.prepare("DELETE FROM employee_memory_events WHERE employee_id = ?").run(employeeId);
      this.db.prepare(`UPDATE employee_memory_state SET revision = revision + 1, last_attempt_at = 0,
        source_id = 0, profile_json = NULL WHERE employee_id = ?`).run(employeeId);
    });
  }

  markUserMemoryAttempt(revision: number, now: number, employeeId = DEFAULT_EMPLOYEE_ID): boolean {
    if (!this.userMemoryCaptureState(employeeId).enabled) return false;
    return this.db.prepare(`UPDATE employee_memory_state SET last_attempt_at = ?
      WHERE employee_id = ? AND enabled = 1 AND revision = ?`).run(now, employeeId, revision).changes === 1;
  }

  /** Read fresh candidates inside the transaction; a late model result cannot undo user edits/clear. */
  applyUserMemoryProfile(
    profile: UserMemoryProfile, revision: number, sourceId: number, now = Date.now(), employeeId = DEFAULT_EMPLOYEE_ID,
  ): boolean {
    return this.s.transaction(() => {
      const state = this.getUserMemoryState(now, employeeId);
      if (!this.userMemoryCaptureState(employeeId).enabled || !state.enabled || state.revision !== revision || profile.expiresAt <= now) return false;
      const evidence = this.db.prepare("SELECT created_at FROM employee_memory_events WHERE employee_id = ? AND id = ?");
      for (const id of new Set(profile.preferences.flatMap((entry) => entry.evidenceIds))) {
        const row = evidence.get(employeeId, id);
        if (!row || Number(row.created_at) <= now - USER_MEMORY_RETENTION_MS) return false;
      }
      this.db.prepare(`UPDATE employee_memory_state SET profile_json = ?, source_id = ? WHERE employee_id = ?`)
        .run(JSON.stringify(profile), sourceId, employeeId);
      return true;
    });
  }
}
