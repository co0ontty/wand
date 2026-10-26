import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WandStorage } from "../storage.js";
import type { ApnsEnvironment } from "../apns-client.js";

export const APNS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS apns_devices (
    id TEXT PRIMARY KEY, token TEXT NOT NULL, environment TEXT NOT NULL, topic TEXT NOT NULL,
    server_id TEXT NOT NULL, credential_digest TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1, expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS apns_devices_active ON apns_devices(enabled, expires_at);
  CREATE TABLE IF NOT EXISTS apns_events (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL,
    revision TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS apns_deliveries (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, reason TEXT,
    UNIQUE(event_id, device_id)
  );
  CREATE INDEX IF NOT EXISTS apns_deliveries_due ON apns_deliveries(state, next_at);
`;
export type ApnsEventKind = "completed" | "permission";
export interface ApnsDevice {
  id: string; token: string; environment: ApnsEnvironment; topic: string; server_id: string;
  credential_digest: string; generation: number; enabled: number; expires_at: number;
}
export interface ApnsDelivery {
  id: string; event_id: string; device_id: string; generation: number; attempts: number; expires_at: number;
  session_id: string; kind: ApnsEventKind; revision: string;
}
export function apnsDigest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

/** The revocation capability is stored as a digest only, never returned by a read endpoint. */
export class ApnsRepository {
  constructor(private readonly db: DatabaseSync, private readonly storage: WandStorage) {}

  register(input: { secret: string; token: string; environment: ApnsEnvironment; topic: string; serverId: string; credentialDigest: string }, now: number): void {
    this.storage.transaction(() => {
      const id = apnsDigest(input.secret);
      const previous = this.device(id);
      const changed = !previous || previous.token !== input.token || previous.environment !== input.environment
        || previous.topic !== input.topic || previous.server_id !== input.serverId || previous.credential_digest !== input.credentialDigest || !previous.enabled;
      // Same physical device may have saved two origins for this same server. Only the latest binding delivers.
      const duplicates = this.db.prepare("SELECT id FROM apns_devices WHERE token = ? AND environment = ? AND topic = ? AND id != ? AND enabled = 1")
        .all(input.token, input.environment, input.topic, id) as Array<{ id: string }>;
      for (const device of duplicates) this.revokeDigest(device.id);
      if (changed) this.cancelPending(id);
      this.db.prepare(`INSERT INTO apns_devices (id, token, environment, topic, server_id, credential_digest, generation, enabled, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?) ON CONFLICT(id) DO UPDATE SET
        token = excluded.token, environment = excluded.environment, topic = excluded.topic, server_id = excluded.server_id,
        credential_digest = excluded.credential_digest, generation = apns_devices.generation + ?, enabled = 1, expires_at = excluded.expires_at`)
        .run(id, input.token, input.environment, input.topic, input.serverId, input.credentialDigest, now + 14 * 86_400_000, changed ? 1 : 0);
    });
  }

  revoke(secret: string): void { this.storage.transaction(() => this.revokeDigest(apnsDigest(secret))); }
  private revokeDigest(id: string): void {
    this.db.prepare("UPDATE apns_devices SET enabled = 0, token = '' WHERE id = ?").run(id);
    this.cancelPending(id);
  }
  private cancelPending(id: string): void {
    this.db.prepare("UPDATE apns_deliveries SET state = 'canceled', reason = 'BindingChanged' WHERE device_id = ? AND state = 'pending'").run(id);
  }
  device(id: string): ApnsDevice | null {
    return (this.db.prepare("SELECT * FROM apns_devices WHERE id = ?").get(id) as unknown as ApnsDevice | undefined) ?? null;
  }

  enqueue(sessionId: string, kind: ApnsEventKind, revision: string, credentialDigest: string, topic: string, environment: ApnsEnvironment, now: number): boolean {
    return this.storage.transaction(() => {
      const eventId = apnsDigest(JSON.stringify([sessionId, kind, revision]));
      const inserted = this.db.prepare("INSERT OR IGNORE INTO apns_events (id, session_id, kind, revision, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(eventId, sessionId, kind, revision, now);
      if (!inserted.changes) return true;
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM apns_deliveries WHERE state = 'pending'").get() as { n: number };
      if (count.n >= 1000) return false; // bounded best-effort queue; never delay execution for a notification.
      const devices = this.db.prepare(`SELECT id, generation FROM apns_devices WHERE enabled = 1 AND expires_at > ?
        AND credential_digest = ? AND topic = ? AND environment = ? LIMIT ?`)
        .all(now, credentialDigest, topic, environment, 1000 - count.n) as Array<{ id: string; generation: number }>;
      const expiresAt = now + (kind === "permission" ? 15 * 60_000 : 60 * 60_000);
      for (const device of devices) {
        this.db.prepare(`INSERT INTO apns_deliveries (id, event_id, device_id, generation, next_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), eventId, device.id, device.generation, now, expiresAt);
      }
      return devices.length < 1000 - count.n;
    });
  }

  due(now: number): ApnsDelivery | null {
    return (this.db.prepare(`SELECT d.id, d.event_id, d.device_id, d.generation, d.attempts, d.expires_at,
      e.session_id, e.kind, e.revision FROM apns_deliveries d JOIN apns_events e ON e.id = d.event_id
      WHERE d.state = 'pending' AND d.next_at <= ? ORDER BY d.next_at, d.rowid LIMIT 1`).get(now) as unknown as ApnsDelivery | undefined) ?? null;
  }
  finish(id: string, state: "accepted" | "canceled" | "failed", reason: string): void {
    this.db.prepare("UPDATE apns_deliveries SET state = ?, reason = ? WHERE id = ? AND state = 'pending'").run(state, reason, id);
  }
  retry(id: string, attempts: number, next: number, reason: string): void {
    this.db.prepare("UPDATE apns_deliveries SET attempts = ?, next_at = ?, reason = ? WHERE id = ? AND state = 'pending'").run(attempts, next, reason, id);
  }
  invalidateDevice(id: string, generation: number): void {
    // A late APNs rejection for an old token must never disable its replacement.
    const current = this.device(id);
    if (current?.generation === generation) this.revokeDigest(id);
  }
  sweep(now: number): void {
    this.storage.transaction(() => {
      this.db.prepare("UPDATE apns_devices SET enabled = 0, token = '' WHERE expires_at <= ?").run(now);
      this.db.prepare("UPDATE apns_deliveries SET state = 'canceled', reason = 'Expired' WHERE expires_at <= ? AND state = 'pending'").run(now);
      this.db.prepare("DELETE FROM apns_deliveries WHERE expires_at < ?").run(now - 7 * 86_400_000);
      this.db.prepare("DELETE FROM apns_events WHERE created_at < ? AND id NOT IN (SELECT event_id FROM apns_deliveries)").run(now - 7 * 86_400_000);
      this.db.prepare("DELETE FROM apns_devices WHERE expires_at < ?").run(now - 7 * 86_400_000);
    });
  }
}
