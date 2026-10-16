import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { WandStorage } from "../storage.js";

export interface ManagedUpload {
  filePath: string;
  canonicalPath: string;
  cwd: string;
  canonicalCwd: string;
  sessionId: string;
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  createdAt: number;
  orphanedAt: number | null;
}

/** Upload receipts are provenance, not a filename/prefix guess or a conversation DTO. */
export class UploadRepository {
  constructor(private readonly db: DatabaseSync, private readonly owner?: Pick<WandStorage, "transaction">) {}

  recordManagedUpload(upload: Omit<ManagedUpload, "orphanedAt">): void {
    this.db.prepare(`INSERT INTO wand_uploads(file_path, canonical_path, cwd, canonical_cwd, session_id,
      device, inode, size, mtime_ms, ctime_ms, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(upload.filePath,
      upload.canonicalPath, upload.cwd, upload.canonicalCwd, upload.sessionId, upload.device, upload.inode,
      upload.size, upload.mtimeMs, upload.ctimeMs, upload.createdAt);
  }

  recordManagedUploads(uploads: Omit<ManagedUpload, "orphanedAt">[]): void {
    const save = () => { for (const upload of uploads) this.recordManagedUpload(upload); };
    if (this.owner) this.owner.transaction(save); else save();
  }

  listManagedUploads(limit = 100): ManagedUpload[] {
    return this.db.prepare(`SELECT file_path AS filePath, canonical_path AS canonicalPath, cwd,
      canonical_cwd AS canonicalCwd, session_id AS sessionId, device, inode, size,
      mtime_ms AS mtimeMs, ctime_ms AS ctimeMs, created_at AS createdAt,
      CASE WHEN orphaned_at IS NULL THEN NULL ELSE MAX(orphaned_at, COALESCE((SELECT MAX(created_at)
        FROM wand_upload_references r WHERE r.file_path=wand_uploads.file_path),0)) END AS orphanedAt
      FROM wand_uploads ORDER BY checked_at, created_at LIMIT ?`).all(Math.min(100, Math.max(1, limit))) as unknown as ManagedUpload[];
  }

  /** Keep original owners, shared workspaces, queues and exact historical file references. */
  managedUploadReferenced(upload: ManagedUpload): boolean {
    const escaped = JSON.stringify(upload.filePath).slice(1, -1);
    const canonical = JSON.stringify(upload.canonicalPath).slice(1, -1);
    if (this.db.prepare(`SELECT 1 FROM wand_upload_references r JOIN command_sessions s ON s.id=r.session_id
      WHERE r.file_path=? LIMIT 1`).get(upload.filePath)) return true;
    if (this.db.prepare(`SELECT 1 FROM command_sessions WHERE id=? OR cwd IN (?,?) OR (status='running' AND session_kind='structured')
      OR instr(output,?)>0 OR instr(output,?)>0 OR instr(COALESCE(messages,''),?)>0
      OR instr(COALESCE(messages,''),?)>0 OR instr(COALESCE(queued_messages,''),?)>0
      OR instr(COALESCE(queued_messages,''),?)>0 LIMIT 1`).get(upload.sessionId, upload.cwd, upload.canonicalCwd,
      upload.filePath, upload.canonicalPath, escaped, canonical, escaped, canonical)) return true;
    if (this.db.prepare("SELECT 1 FROM workspace_tasks WHERE cwd IN (?,?) LIMIT 1").get(upload.cwd, upload.canonicalCwd)) return true;
    if (this.db.prepare("SELECT 1 FROM conversation_messages WHERE instr(turn_json,?)>0 OR instr(turn_json,?)>0 LIMIT 1").get(escaped, canonical)) return true;
    // The team run stores delivered reports/attachment references even after its relay session is gone.
    if (this.db.prepare("SELECT 1 FROM ai_team_runs WHERE cwd IN (?,?) OR instr(objective,?)>0 OR instr(objective,?)>0 LIMIT 1")
      .get(upload.cwd, upload.canonicalCwd, upload.filePath, upload.canonicalPath)) return true;
    if (this.db.prepare(`SELECT 1 FROM ai_team_steps WHERE instr(report,?)>0 OR instr(report,?)>0
      OR instr(instructions,?)>0 OR instr(instructions,?)>0 OR report_path IN (?,?)
      OR instr(COALESCE(dispatch_info_json,''),?)>0 OR instr(COALESCE(dispatch_info_json,''),?)>0 LIMIT 1`)
      .get(upload.filePath, upload.canonicalPath, upload.filePath, upload.canonicalPath, upload.filePath, upload.canonicalPath, escaped, canonical)) return true;
    return false;
  }

  /** Pin an orphan before PTY/structured dispatch, including unknown delivery; no prompt content is persisted. */
  retainManagedUploadReferences(sessionId: string, requestJson: string, now = Date.now()): void {
    this.db.prepare(`INSERT INTO wand_upload_references(file_path,session_id,created_at)
      SELECT file_path,?,? FROM wand_uploads WHERE orphaned_at IS NOT NULL AND
      (instr(?,substr(json_quote(file_path),2,length(json_quote(file_path))-2))>0
        OR instr(?,substr(json_quote(canonical_path),2,length(json_quote(canonical_path))-2))>0)
      ON CONFLICT(file_path,session_id) DO UPDATE SET created_at=excluded.created_at`).run(sessionId, now, requestJson, requestJson);
  }

  observeManagedUpload(upload: ManagedUpload, referenced: boolean, now: number): void {
    this.db.prepare(`UPDATE wand_uploads SET checked_at=?, orphaned_at=CASE WHEN ? THEN NULL
      ELSE COALESCE(orphaned_at,?) END WHERE file_path=? AND inode=? AND device=?`).run(now, Number(referenced), now,
      upload.filePath, upload.inode, upload.device);
  }

  forgetManagedUpload(upload: ManagedUpload): void {
    const remove = () => {
      this.db.prepare("DELETE FROM wand_uploads WHERE file_path=? AND inode=? AND device=?").run(upload.filePath, upload.inode, upload.device);
      this.db.prepare("DELETE FROM wand_upload_references WHERE file_path=?").run(upload.filePath);
    };
    if (this.owner) this.owner.transaction(remove); else remove();
  }
}

/** Existing npm installations: no migrations, vault access or new database on CLI preview. */
export function openUploadCleanupStore(dbPath: string, write = false): { uploads: UploadRepository; close(): void } | null {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: !write });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wand_uploads'").get()) { db.close(); return null; }
    return { uploads: new UploadRepository(db), close: () => db.close() };
  } catch (error) { db.close(); throw error; }
}
