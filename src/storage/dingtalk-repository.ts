import type { DatabaseSync } from "node:sqlite";
import type { DingTalkRecordKind, DingTalkRun } from "../dingtalk-types.js";

/** Additive domain records. Secrets belong to the existing encrypted connector vault, never this table. */
export const DINGTALK_SCHEMA = `CREATE TABLE IF NOT EXISTS dingtalk_records (
  kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(kind, id)
); CREATE INDEX IF NOT EXISTS dingtalk_records_kind_updated ON dingtalk_records(kind, updated_at);
CREATE INDEX IF NOT EXISTS dingtalk_records_state ON dingtalk_records(kind, json_extract(data, '$.state'), id);
CREATE INDEX IF NOT EXISTS dingtalk_records_delivery ON dingtalk_records(kind, json_extract(data, '$.delivery'), updated_at, id);
CREATE INDEX IF NOT EXISTS dingtalk_records_binding_delivery ON dingtalk_records(kind, json_extract(data, '$.bindingId'), json_extract(data, '$.delivery'));`;

export class DingTalkRepository {
  constructor(private readonly db: DatabaseSync) {}
  getDingTalkRecord<T>(kind: DingTalkRecordKind, id: string): T | null {
    const row = this.db.prepare("SELECT data FROM dingtalk_records WHERE kind = ? AND id = ?").get(kind, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : null;
  }
  listDingTalkRecords<T>(kind: DingTalkRecordKind): T[] {
    return (this.db.prepare("SELECT data FROM dingtalk_records WHERE kind = ? ORDER BY updated_at, id LIMIT 10000").all(kind) as Array<{ data: string }>).map(row => JSON.parse(row.data) as T);
  }
  saveDingTalkRecord(kind: DingTalkRecordKind, id: string, value: unknown): void {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 512 * 1024) throw new Error("钉钉记录过大。");
    this.db.prepare(`INSERT INTO dingtalk_records(kind,id,data,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`).run(kind, id, data, new Date().toISOString());
  }
  /** Explicit mirror deletion removes body copies but retains content-free admission tombstones. */
  clearDingTalkGroupHistory(groupId: string): void {
    this.db.prepare(`UPDATE dingtalk_records SET data = json_remove(json_set(data, '$.state', 'unknown', '$.delivery', 'none'), '$.text', '$.error'), updated_at = ?
      WHERE kind = 'run' AND json_extract(data, '$.groupId') = ?`).run(new Date().toISOString(), groupId);
  }

  countDingTalkRecords(kind: DingTalkRecordKind): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM dingtalk_records WHERE kind = ?").get(kind) as { n: number }).n;
  }
  pendingDingTalkDeliveries(): DingTalkRun[] {
    return (this.db.prepare(`SELECT data FROM dingtalk_records WHERE kind = 'run'
      AND json_extract(data, '$.delivery') = 'pending' ORDER BY updated_at, id LIMIT 4`).all() as Array<{ data: string }>)
      .map(row => JSON.parse(row.data) as DingTalkRun);
  }
  runningDingTalkPage(after: string): DingTalkRun[] {
    return (this.db.prepare(`SELECT data FROM dingtalk_records WHERE kind = 'run'
      AND json_extract(data, '$.state') = 'running' AND id > ? ORDER BY id LIMIT 100`).all(after) as Array<{ data: string }>)
      .map(row => JSON.parse(row.data) as DingTalkRun);
  }
  /** Recovery never replays a model or a resource write. A request claim is the boundary before sending. */
  recoverDingTalkIntents(): void {
    this.db.exec(`UPDATE dingtalk_records SET data = json_set(data, '$.state', 'unknown')
      WHERE kind = 'job' AND json_extract(data, '$.state') = 'running';
      UPDATE dingtalk_records SET data = json_set(data, '$.state', 'unknown', '$.error', '服务重启，原接入步骤待核实；请继续原任务，不会重复创建资源。')
      WHERE kind = 'binding' AND json_extract(data, '$.state') IN ('creating', 'configuring', 'joining');
      UPDATE dingtalk_records SET data = json_set(data, '$.state', 'unknown', '$.error', '服务重启前已接受，请核对原执行，不会重复执行。')
      WHERE kind = 'run' AND json_extract(data, '$.state') = 'accepted';
      UPDATE dingtalk_records AS r SET data = json_set(data,
        '$.delivery', CASE
          WHEN EXISTS(SELECT 1 FROM dingtalk_records q WHERE q.kind = 'request' AND q.id = 'final:' || r.id AND json_extract(q.data, '$.state') = 'sent') THEN 'sent'
          WHEN EXISTS(SELECT 1 FROM dingtalk_records q WHERE q.kind = 'request' AND q.id = 'final:' || r.id) THEN 'unknown'
          ELSE 'pending' END,
        '$.state', CASE
          WHEN EXISTS(SELECT 1 FROM dingtalk_records q WHERE q.kind = 'request' AND q.id = 'final:' || r.id AND json_extract(q.data, '$.state') = 'sent') THEN CASE WHEN json_extract(r.data, '$.state') = 'failed' THEN 'failed' ELSE 'delivered' END
          WHEN EXISTS(SELECT 1 FROM dingtalk_records q WHERE q.kind = 'request' AND q.id = 'final:' || r.id) THEN 'unknown'
          ELSE CASE WHEN json_extract(r.data, '$.state') = 'failed' THEN 'failed' ELSE 'completed' END END)
      WHERE kind = 'run' AND json_extract(data, '$.delivery') = 'sending';
      UPDATE dingtalk_records AS b SET data = json_set(data, '$.state', 'unknown', '$.error', '此前回复送达未确认，请核实原群消息后恢复，不会重放旧任务。')
      WHERE kind = 'binding' AND json_extract(data, '$.state') != 'paused' AND json_extract(data, '$.removedAt') IS NULL
        AND EXISTS(SELECT 1 FROM dingtalk_records r WHERE r.kind = 'run' AND json_extract(r.data, '$.bindingId') = b.id
          AND json_extract(r.data, '$.delivery') = 'unknown'
          AND coalesce(json_extract(r.data, '$.bindingGeneration'), 'legacy') = coalesce(json_extract(b.data, '$.generation'), 'legacy'));`);
  }

  /** Claim before any I/O. An unknown outcome is retained across restarts, never automatically replayed. */
  claimDingTalkRecord(kind: DingTalkRecordKind, id: string, value: unknown): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO dingtalk_records(kind,id,data,updated_at) VALUES(?,?,?,?)")
      .run(kind, id, JSON.stringify(value), new Date().toISOString()).changes > 0;
  }
}
