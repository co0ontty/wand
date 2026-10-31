import type { DatabaseSync } from "node:sqlite";
import type { WandStorage } from "../storage.js";
import type { SessionSnapshot } from "../types.js";

/** Acceptance proves durable ownership of the input, not external tool execution. */
export interface StructuredInputReceipt {
  accepted: true;
  acceptanceId: string;
  sessionId: string;
  idempotencyKey: string;
  acceptedAt: string;
}

export class SessionInputRepository {
  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

  getStructuredInputReceipt(sessionId: string, key: string, signature: string): StructuredInputReceipt | null {
    const row = this.db.prepare(`SELECT signature, receipt_json FROM structured_input_acceptances
      WHERE session_id = ? AND idempotency_key = ?`).get(sessionId, key) as
      { signature: string; receipt_json: string } | undefined;
    if (!row) return null;
    if (row.signature !== signature) {
      throw Object.assign(new Error("该幂等键已用于不同的消息或操作，请核对原请求。"), { code: "idempotency_key_conflict" });
    }
    return JSON.parse(row.receipt_json) as StructuredInputReceipt;
  }

  /** Queue/user turn and receipt share the write lock and commit/rollback boundary. */
  acceptStructuredInput(snapshot: SessionSnapshot, signature: string, receipt: StructuredInputReceipt, userTurn = false): boolean {
    return this.s.transaction(() => {
      if (this.getStructuredInputReceipt(snapshot.id, receipt.idempotencyKey, signature)) return false;
      const exists = this.db.prepare("SELECT 1 FROM command_sessions WHERE id = ? AND session_kind = 'structured'").get(snapshot.id);
      if (!exists) throw new Error("未找到该结构化会话。");
      this.s.updateSessionRuntimeMetadata(snapshot);
      if (userTurn) this.s.checkpointSessionMessages(snapshot.id, snapshot.messages ?? [], snapshot.structuredState);
      this.db.prepare(`INSERT INTO structured_input_acceptances
        (session_id, idempotency_key, signature, receipt_json) VALUES (?, ?, ?, ?)`)
        .run(snapshot.id, receipt.idempotencyKey, signature, JSON.stringify(receipt));
      return true;
    });
  }
}
