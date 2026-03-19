import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionSnapshot } from "./types.js";

export const DEFAULT_DB_FILE = "wand.db";

export interface PersistedAuthSession {
  token: string;
  expiresAt: number;
}

export function resolveDatabasePath(configPath: string): string {
  return path.resolve(path.dirname(configPath), DEFAULT_DB_FILE);
}

export function ensureDatabaseFile(dbPath: string): boolean {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const created = !existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS command_sessions (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      output TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT
    );
  `);
  ensureCommandSessionSchema(db);
  db.close();
  return created;
}

export class WandStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS command_sessions (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        output TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT
      );
    `);
    ensureCommandSessionSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  saveAuthSession(token: string, expiresAt: number): void {
    this.db
      .prepare(
        `INSERT INTO auth_sessions (token, expires_at)
         VALUES (?, ?)
         ON CONFLICT(token) DO UPDATE SET expires_at = excluded.expires_at`
      )
      .run(token, expiresAt);
  }

  getAuthSession(token: string): PersistedAuthSession | null {
    const row = this.db
      .prepare("SELECT token, expires_at FROM auth_sessions WHERE token = ?")
      .get(token) as { token: string; expires_at: number } | undefined;

    if (!row) {
      return null;
    }

    return {
      token: row.token,
      expiresAt: row.expires_at
    };
  }

  deleteAuthSession(token: string): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
  }

  deleteExpiredAuthSessions(now: number): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(now);
  }

  saveSession(snapshot: SessionSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO command_sessions (
           id, command, cwd, mode, status, exit_code, started_at, ended_at, output
           , archived, archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           command = excluded.command,
           cwd = excluded.cwd,
           mode = excluded.mode,
           status = excluded.status,
           exit_code = excluded.exit_code,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           output = excluded.output,
           archived = excluded.archived,
           archived_at = excluded.archived_at`
      )
      .run(
        snapshot.id,
        snapshot.command,
        snapshot.cwd,
        snapshot.mode,
        snapshot.status,
        snapshot.exitCode,
        snapshot.startedAt,
        snapshot.endedAt,
        snapshot.output,
        snapshot.archived ? 1 : 0,
        snapshot.archivedAt
      );
  }

  loadSessions(): SessionSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT id, command, cwd, mode, status, exit_code, started_at, ended_at, output, archived, archived_at
         FROM command_sessions
         ORDER BY started_at DESC`
      )
      .all() as Array<{
      id: string;
      command: string;
      cwd: string;
      mode: SessionSnapshot["mode"];
      status: SessionSnapshot["status"];
      exit_code: number | null;
      started_at: string;
      ended_at: string | null;
      output: string;
      archived: number;
      archived_at: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      command: row.command,
      cwd: row.cwd,
      mode: row.mode,
      status: row.status,
      exitCode: row.exit_code,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      output: row.output,
      archived: Boolean(row.archived),
      archivedAt: row.archived_at
    }));
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM command_sessions WHERE id = ?").run(id);
  }
}

function ensureCommandSessionSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(command_sessions)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("archived")) {
    db.exec("ALTER TABLE command_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("archived_at")) {
    db.exec("ALTER TABLE command_sessions ADD COLUMN archived_at TEXT");
  }
}
