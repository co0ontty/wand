import type { DatabaseSync } from "node:sqlite";
import type { ConversationOrganizationJob } from "../conversation-organize-contract.js";

/** Operation receipts, not a second source of tasks or membership. Task mutations share this transaction. */
export class ConversationOrganizationRepository {
  constructor(private readonly db: DatabaseSync) {}
  saveConversationOrganizationJob(job: ConversationOrganizationJob, requestToken?: string, scopeKey?: string): void {
    this.db.prepare(`INSERT INTO conversation_organization_jobs(id, request_token, scope_key, status, state_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,
      state_json=excluded.state_json, updated_at=excluded.updated_at`)
      .run(job.id, requestToken ?? job.id, scopeKey ?? "", job.status, JSON.stringify(job), new Date().toISOString());
  }
  getConversationOrganizationJob(id: string): ConversationOrganizationJob | null {
    const row = this.db.prepare("SELECT state_json FROM conversation_organization_jobs WHERE id=?").get(id) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as ConversationOrganizationJob : null;
  }
  getConversationOrganizationJobByToken(token: string): ConversationOrganizationJob | null {
    const row = this.db.prepare("SELECT state_json FROM conversation_organization_jobs WHERE request_token=?").get(token) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as ConversationOrganizationJob : null;
  }
  listRunningConversationOrganizationJobs(): ConversationOrganizationJob[] {
    return (this.db.prepare("SELECT state_json FROM conversation_organization_jobs WHERE status='running'").all() as Array<{ state_json: string }>).map(row => JSON.parse(row.state_json) as ConversationOrganizationJob);
  }
  getConversationOrganizationFingerprint(scope: string): string | null {
    const row = this.db.prepare("SELECT fingerprint FROM conversation_organization_cache WHERE scope_key=?").get(scope) as { fingerprint: string } | undefined;
    return row?.fingerprint ?? null;
  }
  saveConversationOrganizationFingerprint(scope: string, fingerprint: string): void {
    this.db.prepare(`INSERT INTO conversation_organization_cache(scope_key,fingerprint,updated_at) VALUES(?,?,?)
      ON CONFLICT(scope_key) DO UPDATE SET fingerprint=excluded.fingerprint, updated_at=excluded.updated_at`)
      .run(scope, fingerprint, new Date().toISOString());
  }
}
