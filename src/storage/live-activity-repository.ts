import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WandStorage } from "../storage.js";
import { apnsDigest } from "./apns-repository.js";
import type { ApnsEnvironment } from "../apns-client.js";
import type { LiveActivityCachedEntry } from "../live-activity-state.js";

export const LIVE_ACTIVITY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS apns_live_activities (
    id TEXT PRIMARY KEY, activity_id TEXT NOT NULL, token TEXT NOT NULL,
    server_id TEXT NOT NULL, credential_digest TEXT NOT NULL, topic TEXT NOT NULL, environment TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, blocked INTEGER NOT NULL DEFAULT 0,
    fact_revision INTEGER NOT NULL DEFAULT 0, prepared_revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    content_json TEXT NOT NULL DEFAULT '[]', signature TEXT NOT NULL DEFAULT '', last_timestamp INTEGER NOT NULL DEFAULT 0,
    last_sent_at INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
    pending_id TEXT, pending_payload TEXT, pending_signature TEXT, pending_event TEXT, pending_priority INTEGER,
    pending_next_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, outcome TEXT, reason TEXT
  );
  CREATE INDEX IF NOT EXISTS apns_live_due ON apns_live_activities(enabled, blocked, next_at);
`;
export interface LiveActivityRecord {
  id: string; activity_id: string; token: string; server_id: string; credential_digest: string;
  topic: string; environment: ApnsEnvironment; generation: number; enabled: number; blocked: number;
  fact_revision: number; prepared_revision: number;
  created_at: number; expires_at: number; content_json: string; signature: string; last_timestamp: number;
  last_sent_at: number; next_at: number; pending_id: string | null; pending_payload: string | null;
  pending_signature: string | null; pending_event: "update" | "end" | null; pending_priority: 5 | 10 | null;
  pending_next_at: number | null; attempts: number; outcome: string | null; reason: string | null;
}
export class LiveActivityRepository {
  constructor(private readonly db: DatabaseSync, private readonly storage: WandStorage) {}

  register(input: { secret: string; activityId: string; token: string; serverId: string; credentialDigest: string; topic: string; environment: ApnsEnvironment }, now: number): void {
    this.storage.transaction(() => {
      const id = apnsDigest(input.secret);
      const previous = this.get(id);
      const aliases = this.db.prepare("SELECT id FROM apns_live_activities WHERE id != ? AND enabled = 1 AND (activity_id = ? OR (token = ? AND topic = ? AND environment = ?))")
        .all(id, input.activityId, input.token, input.topic, input.environment) as Array<{ id: string }>;
      for (const alias of aliases) this.disable(alias.id, "Superseded");
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM apns_live_activities WHERE enabled = 1 AND expires_at > ? AND id != ?").get(now, id) as { n: number };
      if (count.n >= 64) throw new Error("Live Activity registration limit reached");
      const changed = !previous || !previous.enabled || previous.activity_id !== input.activityId || previous.token !== input.token
        || previous.server_id !== input.serverId || previous.credential_digest !== input.credentialDigest
        || previous.topic !== input.topic || previous.environment !== input.environment;
      const created = previous?.activity_id === input.activityId ? previous.created_at : now;
      this.db.prepare(`INSERT INTO apns_live_activities
        (id, activity_id, token, server_id, credential_digest, topic, environment, created_at, expires_at, next_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET activity_id = excluded.activity_id, token = excluded.token,
        server_id = excluded.server_id, credential_digest = excluded.credential_digest,
        topic = excluded.topic, environment = excluded.environment, enabled = 1, blocked = 0,
        created_at = excluded.created_at, expires_at = excluded.expires_at, next_at = MIN(apns_live_activities.next_at, excluded.next_at),
        generation = apns_live_activities.generation + ?`)
        .run(id, input.activityId, input.token, input.serverId, input.credentialDigest, input.topic, input.environment, created, created + 8 * 3_600_000, now, changed ? 1 : 0);
      if (changed) {
        this.db.prepare("UPDATE apns_live_activities SET pending_id = NULL, pending_payload = NULL, attempts = 0 WHERE id = ?").run(id);
        if (previous && (previous.activity_id !== input.activityId || previous.server_id !== input.serverId || previous.credential_digest !== input.credentialDigest)) {
          this.db.prepare("UPDATE apns_live_activities SET content_json = '[]', signature = '', last_timestamp = 0, last_sent_at = 0 WHERE id = ?").run(id);
        }
      }
    });
  }

  get(id: string): LiveActivityRecord | null {
    return (this.db.prepare("SELECT * FROM apns_live_activities WHERE id = ?").get(id) as unknown as LiveActivityRecord | undefined) ?? null;
  }
  revoke(secret: string): void { this.disable(apnsDigest(secret), "ClientRevoked"); }
  disable(id: string, reason: string, generation?: number): void {
    this.db.prepare(`UPDATE apns_live_activities SET enabled = 0, token = '', pending_id = NULL, pending_payload = NULL,
      outcome = 'closed', reason = ? WHERE id = ? ${generation === undefined ? "" : "AND generation = ?"}`)
      .run(reason, id, ...(generation === undefined ? [] : [generation]));
  }
  wake(now: number): void {
    this.db.prepare("UPDATE apns_live_activities SET blocked = 0, next_at = MIN(next_at, ?) WHERE enabled = 1").run(now);
  }
  dirty(now: number): void {
    // Coalesce facts, not deliveries. A redundant status heartbeat must not reset a transport retry budget.
    this.db.prepare(`UPDATE apns_live_activities SET next_at = CASE WHEN pending_id IS NULL THEN MIN(next_at, ?) ELSE next_at END, fact_revision = fact_revision + 1
      WHERE enabled = 1 AND blocked = 0`).run(now + 2000);
  }
  due(now: number): LiveActivityRecord | null {
    return (this.db.prepare("SELECT * FROM apns_live_activities WHERE enabled = 1 AND blocked = 0 AND next_at <= ? ORDER BY next_at, rowid LIMIT 1")
      .get(now) as unknown as LiveActivityRecord | undefined) ?? null;
  }
  defer(id: string, generation: number, next: number): void {
    this.db.prepare("UPDATE apns_live_activities SET next_at = ? WHERE id = ? AND generation = ? AND enabled = 1").run(next, id, generation);
  }
  prepare(record: LiveActivityRecord, update: { payload: string; signature: string; entries: LiveActivityCachedEntry[]; event: "update" | "end"; priority: 5 | 10; timestamp: number; nextAt: number }, now: number): LiveActivityRecord | null {
    const id = randomUUID();
    const result = this.db.prepare(`UPDATE apns_live_activities SET content_json = ?, last_timestamp = ?,
      pending_id = ?, pending_payload = ?, pending_signature = ?, pending_event = ?, pending_priority = ?, pending_next_at = ?,
      attempts = 0, prepared_revision = fact_revision, next_at = ? WHERE id = ? AND generation = ? AND enabled = 1`)
      .run(JSON.stringify(update.entries), update.timestamp, id, update.payload, update.signature, update.event,
        update.priority, update.nextAt, now, record.id, record.generation);
    return result.changes ? this.get(record.id) : null;
  }
  finish(record: LiveActivityRecord, outcome: "accepted" | "failed" | "rejected", reason: string, now: number): void {
    this.storage.transaction(() => {
      // A route revoke/token rotation/new state may have superseded this HTTP/2 request while it was in flight.
      const current = this.get(record.id);
      if (!current?.enabled || current.generation !== record.generation || current.pending_id !== record.pending_id) return;
      if (outcome === "accepted" && record.pending_event === "end") {
        this.db.prepare("UPDATE apns_live_activities SET enabled = 0, token = '', pending_id = NULL, pending_payload = NULL, outcome = 'accepted', reason = 'EndedByAPNs' WHERE id = ?").run(record.id);
        return;
      }
      const next = outcome === "accepted" ? record.pending_next_at ?? now + 60_000 : now + 60_000;
      const nextWithFacts = current.fact_revision > record.prepared_revision ? Math.min(next, now + 2000) : next;
      this.db.prepare(`UPDATE apns_live_activities SET signature = ?, last_sent_at = ?,
        next_at = ?, pending_id = NULL, pending_payload = NULL, outcome = ?, reason = ?, blocked = ?
        WHERE id = ? AND generation = ? AND pending_id = ?`)
        .run(record.pending_signature ?? "", now, nextWithFacts,
          outcome, reason, outcome === "rejected" ? 1 : 0, record.id, record.generation, record.pending_id);
    });
  }
  retry(record: LiveActivityRecord, reason: string, now: number): void {
    this.db.prepare(`UPDATE apns_live_activities SET attempts = attempts + 1, next_at = ?, outcome = 'retry', reason = ?
      WHERE id = ? AND generation = ? AND enabled = 1 AND pending_id = ?`)
      .run(now + Math.min(60_000, 2000 * 2 ** record.attempts), reason, record.id, record.generation, record.pending_id);
  }
  sweep(now: number): void {
    this.storage.transaction(() => {
      this.db.prepare("UPDATE apns_live_activities SET enabled = 0, token = '', pending_payload = NULL, pending_id = NULL, reason = 'Expired' WHERE expires_at <= ?").run(now);
      this.db.prepare("DELETE FROM apns_live_activities WHERE expires_at < ?").run(now - 7 * 86_400_000);
    });
  }
}
