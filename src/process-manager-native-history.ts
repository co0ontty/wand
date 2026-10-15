import type { SessionRecord } from "./process-manager.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SessionSnapshot } from "./types.js";
import { getProviderResumeCommandSessionId } from "./resume-policy.js";
import { type CodexHistorySession } from "./provider-history-scanner.js";
import { parseTimestampMs as parseTimeMs } from "./time-utils.js";

interface ClaudeProjectSessionCandidate {
  id: string;
  filePath: string;
  mtimeMs: number;
}

interface ClaudeProjectSessionDetails extends ClaudeProjectSessionCandidate {
  hasConversation: boolean;
  firstUserAtMs: number | null;
}

interface OpenCodeSessionCandidate {
  id: string;
  cwd: string;
  createdAtMs: number;
  updatedAtMs: number;
}
const REAL_CONVERSATION_MIN_LINES = 2;
const DISCOVERY_RECENT_WINDOW_MS = 10 * 60 * 1000;
const START_TIME_SKEW_MS = 30 * 1000;

function readClaudeProjectSessionDetails(filePath: string, id: string): ClaudeProjectSessionDetails | null {
  try {
    const stats = statSync(filePath);
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const fileSessionIds = new Set<string>();
    let hasAssistant = false;
    let hasUser = false;
    let firstUserAtMs: number | null = null;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as {
          sessionId?: string;
          type?: string;
          timestamp?: string;
          message?: {
            role?: string;
          };
        };
        if (parsed.sessionId) {
          fileSessionIds.add(parsed.sessionId);
        }
        if (parsed.type === "user" || parsed.message?.role === "user") {
          hasUser = true;
          if (firstUserAtMs === null && parsed.timestamp) {
            const parsedTime = Date.parse(parsed.timestamp);
            if (Number.isFinite(parsedTime)) firstUserAtMs = parsedTime;
          }
        }
        if (parsed.type === "assistant" || parsed.message?.role === "assistant") {
          hasAssistant = true;
        }
      } catch {
        continue;
      }
    }

    // Only reject if the file explicitly claims a DIFFERENT primary session ID.
    // A resumed session's JSONL may contain multiple session IDs across turns.
    // If no sessionId appears at all (early startup file), don't reject.
    if (fileSessionIds.size > 0 && !fileSessionIds.has(id)) {
      // Check if at least one line references this ID (partial match is ok)
      const hasAnyReference = lines.some((line) => line.includes(`"${id}"`));
      if (!hasAnyReference) {
        return null;
      }
    }

    return {
      id,
      filePath,
      mtimeMs: stats.mtimeMs,
      hasConversation: hasUser && hasAssistant && lines.length >= REAL_CONVERSATION_MIN_LINES,
      firstUserAtMs,
    };
  } catch {
    return null;
  }
}

function listClaudeProjectSessionCandidates(cwd: string): ClaudeProjectSessionCandidate[] {
  const projectDir = getClaudeProjectDir(cwd);
  try {
    return readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name.replace(/\.jsonl$/, ""))
      .filter((name) => UUID_V4_PATTERN.test(name))
      .map((id) => {
        const filePath = path.join(projectDir, `${id}.jsonl`);
        const stats = statSync(filePath);
        return { id, filePath, mtimeMs: stats.mtimeMs };
      });
  } catch {
    return [];
  }
}

export function listClaudeProjectSessionMtimes(cwd: string): Map<string, number> {
  return new Map(listClaudeProjectSessionCandidates(cwd).map((candidate) => [candidate.id, candidate.mtimeMs]));
}

function hasRecentProjectActivity(candidate: { mtimeMs: number }, startedAt: string): boolean {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return true;
  }
  return candidate.mtimeMs >= startedAtMs - START_TIME_SKEW_MS
    && candidate.mtimeMs <= Date.now() + DISCOVERY_RECENT_WINDOW_MS;
}

function selectClaudeProjectSessionForRecord(record: Pick<SessionRecord, "cwd" | "startedAt" | "knownClaudeProjectMtimes" | "messages">): ClaudeProjectSessionDetails | null {
  const knownMtimes = record.knownClaudeProjectMtimes ?? new Map<string, number>();
  // Only consider files created/touched AFTER this wand session started — those
  // are the ones a fresh `claude` invocation could have produced. Files that
  // existed before (knownMtimes entry present) are tolerated only if they
  // grew since we observed them, but we de-prioritize them below.
  const candidates = listClaudeProjectSessionCandidates(record.cwd)
    .filter((candidate) => {
      const previousMtime = knownMtimes.get(candidate.id);
      return previousMtime === undefined || candidate.mtimeMs > previousMtime;
    })
    .filter((candidate) => hasRecentProjectActivity(candidate, record.startedAt))
    .map((candidate) => readClaudeProjectSessionDetails(candidate.filePath, candidate.id))
    .filter((candidate): candidate is ClaudeProjectSessionDetails => Boolean(candidate?.hasConversation))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) {
    return null;
  }

  const hasUserTurn = record.messages.some((turn) => turn.role === "user"
    && turn.content.some((block) => block.type === "text" && block.text.trim().length > 0));
  if (!hasUserTurn) {
    return null;
  }

  // Prefer brand-new files (id not in knownMtimes at session start). When more
  // than one fresh candidate exists in parallel sessions, refuse to bind —
  // mis-binding another session's history is worse than waiting for the bridge
  // to capture the canonical session id from PTY output.
  const fresh = candidates.filter((candidate) => !knownMtimes.has(candidate.id));
  if (fresh.length === 1) {
    return fresh[0];
  }
  if (fresh.length > 1) {
    return null;
  }

  // Fallback: existing file that grew. Only bind if a single grown candidate.
  return candidates.length === 1 ? candidates[0] : null;
}

export function getLatestClaudeProjectSessionId(record: Pick<SessionRecord, "cwd" | "startedAt" | "knownClaudeProjectMtimes" | "messages">): string | null {
  return selectClaudeProjectSessionForRecord(record)?.id ?? null;
}

export function selectClaudeProjectSessionForTimeWindow(record: Pick<SessionSnapshot, "cwd" | "startedAt" | "endedAt" | "messages">): ClaudeProjectSessionDetails | null {
  const startedAtMs = parseTimeMs(record.startedAt);
  if (startedAtMs === null) return null;

  const endedAtMs = parseTimeMs(record.endedAt) ?? Date.now();
  const windowStart = startedAtMs - START_TIME_SKEW_MS;
  const windowEnd = endedAtMs + START_TIME_SKEW_MS;
  const fallbackWindowEnd = endedAtMs + DISCOVERY_RECENT_WINDOW_MS;

  const candidates = listClaudeProjectSessionCandidates(record.cwd)
    .map((candidate) => readClaudeProjectSessionDetails(candidate.filePath, candidate.id))
    .filter((candidate): candidate is ClaudeProjectSessionDetails => Boolean(candidate?.hasConversation))
    .filter((candidate) => {
      if (candidate.firstUserAtMs !== null) {
        return candidate.firstUserAtMs >= windowStart && candidate.firstUserAtMs <= windowEnd;
      }
      return candidate.mtimeMs >= windowStart && candidate.mtimeMs <= fallbackWindowEnd;
    })
    .sort((a, b) => {
      const aTime = a.firstUserAtMs ?? a.mtimeMs;
      const bTime = b.firstUserAtMs ?? b.mtimeMs;
      return Math.abs(aTime - startedAtMs) - Math.abs(bTime - startedAtMs);
    });

  return candidates.length === 1 ? candidates[0] : null;
}

export function listRecentClaudeProjectSessionIds(cwd: string, startedAt: string): string[] {
  return listClaudeProjectSessionCandidates(cwd)
    .filter((candidate) => hasRecentProjectActivity(candidate, startedAt))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((candidate) => candidate.id);
}

export function isClaudeSessionFileAvailable(cwd: string, claudeSessionId: string): boolean {
  const filePath = path.join(getClaudeProjectDir(cwd), `${claudeSessionId}.jsonl`);
  return Boolean(readClaudeProjectSessionDetails(filePath, claudeSessionId));
}

export function listCodexSessionMtimes(sessions: readonly CodexHistorySession[]): Map<string, number> {
  return new Map(sessions.map((session) => [session.claudeSessionId, session.mtimeMs]));
}

function isSameResolvedPath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

function isUsableCodexHistorySession(session: CodexHistorySession): boolean {
  return session.hasUser || session.hasConversation;
}

function selectCodexSessionForRecord(
  record: Pick<SessionRecord, "cwd" | "startedAt" | "knownCodexSessionMtimes">,
  sessions: readonly CodexHistorySession[],
): CodexHistorySession | null {
  const knownMtimes = record.knownCodexSessionMtimes ?? new Map<string, number>();
  const candidates = sessions
    .filter(isUsableCodexHistorySession)
    .filter((session) => isSameResolvedPath(session.cwd, record.cwd))
    .filter((session) => {
      const previousMtime = knownMtimes.get(session.claudeSessionId);
      return previousMtime === undefined || session.mtimeMs > previousMtime;
    })
    .filter((session) => hasRecentProjectActivity(session, record.startedAt))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) {
    return null;
  }

  const fresh = candidates.filter((session) => !knownMtimes.has(session.claudeSessionId));
  if (fresh.length === 1) {
    return fresh[0];
  }
  if (fresh.length > 1) {
    return null;
  }

  return candidates.length === 1 ? candidates[0] : null;
}

export function getLatestCodexSessionId(
  record: Pick<SessionRecord, "cwd" | "startedAt" | "knownCodexSessionMtimes">,
  sessions: readonly CodexHistorySession[],
): string | null {
  return selectCodexSessionForRecord(record, sessions)?.claudeSessionId ?? null;
}

function listOpenCodeSessionCandidates(): OpenCodeSessionCandidate[] {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  const dbPath = path.join(dataHome, "opencode", "opencode.db");
  if (!existsSync(dbPath)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const sessionColumns = db.prepare("PRAGMA table_info(session)").all() as Array<{ name?: unknown }>;
    const rootSessionFilter = sessionColumns.some((column) => column.name === "parent_id")
      ? "WHERE parent_id IS NULL"
      : "";
    const rows = db.prepare(
      `SELECT id, directory, time_created, time_updated FROM session ${rootSessionFilter} ORDER BY time_updated DESC LIMIT 500`,
    ).all() as Array<{ id: unknown; directory: unknown; time_created: unknown; time_updated: unknown }>;
    return rows.flatMap((row) => {
      if (typeof row.id !== "string" || typeof row.directory !== "string") return [];
      const createdAtMs = Number(row.time_created);
      const updatedAtMs = Number(row.time_updated);
      if (!Number.isFinite(createdAtMs) || !Number.isFinite(updatedAtMs)) return [];
      return [{ id: row.id, cwd: row.directory, createdAtMs, updatedAtMs }];
    });
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* best-effort read-only probe */ }
  }
}

export function listOpenCodeSessionMtimes(): Map<string, number> {
  return new Map(listOpenCodeSessionCandidates().map((session) => [session.id, session.updatedAtMs]));
}

export function selectOpenCodeSessionForRecord(
  record: Pick<SessionRecord, "cwd" | "startedAt" | "knownOpenCodeSessionMtimes">,
): OpenCodeSessionCandidate | null {
  const known = record.knownOpenCodeSessionMtimes ?? new Map<string, number>();
  const startedAtMs = Date.parse(record.startedAt);
  const candidates = listOpenCodeSessionCandidates()
    .filter((session) => isSameResolvedPath(session.cwd, record.cwd))
    .filter((session) => {
      const previous = known.get(session.id);
      return previous === undefined || session.updatedAtMs > previous;
    })
    .filter((session) => !Number.isFinite(startedAtMs) || session.updatedAtMs >= startedAtMs - START_TIME_SKEW_MS)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  if (candidates.length === 0) return null;
  const fresh = candidates.filter((session) => !known.has(session.id));
  if (fresh.length === 1) return fresh[0];
  return null;
}

export function selectOpenCodeSessionForTimeWindow(
  record: Pick<SessionRecord, "cwd" | "startedAt" | "endedAt">,
): OpenCodeSessionCandidate | null {
  const startedAtMs = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAtMs)) return null;
  const endedAtMs = Date.parse(record.endedAt ?? "");
  const windowEnd = (Number.isFinite(endedAtMs) ? endedAtMs : Date.now()) + START_TIME_SKEW_MS;
  const candidates = listOpenCodeSessionCandidates()
    .filter((session) => isSameResolvedPath(session.cwd, record.cwd))
    .filter((session) => session.updatedAtMs >= startedAtMs - START_TIME_SKEW_MS && session.updatedAtMs <= windowEnd)
    .filter((session) => session.createdAtMs <= windowEnd)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return candidates.length === 1 ? candidates[0] : null;
}

export function selectCodexSessionForTimeWindow(
  record: Pick<SessionRecord, "cwd" | "startedAt" | "endedAt">,
  sessions: readonly CodexHistorySession[],
): CodexHistorySession | null {
  const startedAtMs = parseTimeMs(record.startedAt);
  if (startedAtMs === null) return null;

  const endedAtMs = parseTimeMs(record.endedAt) ?? Date.now();
  const windowStart = startedAtMs - START_TIME_SKEW_MS;
  const windowEnd = endedAtMs + START_TIME_SKEW_MS;
  const candidates = sessions
    .filter(isUsableCodexHistorySession)
    .filter((session) => isSameResolvedPath(session.cwd, record.cwd))
    .filter((session) => {
      const firstUserAtMs = parseTimeMs(session.firstUserAt);
      if (firstUserAtMs !== null) {
        return firstUserAtMs >= windowStart && firstUserAtMs <= windowEnd;
      }
      return session.mtimeMs >= windowStart && session.mtimeMs <= endedAtMs + DISCOVERY_RECENT_WINDOW_MS;
    })
    .sort((a, b) => {
      const aTime = parseTimeMs(a.firstUserAt) ?? a.mtimeMs;
      const bTime = parseTimeMs(b.firstUserAt) ?? b.mtimeMs;
      return Math.abs(aTime - startedAtMs) - Math.abs(bTime - startedAtMs);
    });

  return candidates.length === 1 ? candidates[0] : null;
}

export function recoverCodexSessionIdFromHistory(
  snapshot: Pick<SessionSnapshot, "provider" | "command" | "cwd" | "startedAt" | "endedAt" | "claudeSessionId">,
  sessions: readonly CodexHistorySession[],
): string | null {
  if (snapshot.provider !== "codex" || snapshot.claudeSessionId) {
    return null;
  }
  return getProviderResumeCommandSessionId("codex", snapshot.command) ?? selectCodexSessionForTimeWindow(snapshot, sessions)?.claudeSessionId ?? null;
}

export function recoverClaudeSessionIdFromHistory(snapshot: Pick<SessionSnapshot, "provider" | "command" | "cwd" | "startedAt" | "endedAt" | "claudeSessionId" | "messages">): string | null {
  if (snapshot.provider !== "claude" || snapshot.claudeSessionId) {
    return null;
  }
  return getProviderResumeCommandSessionId("claude", snapshot.command) ?? selectClaudeProjectSessionForTimeWindow(snapshot)?.id ?? null;
}
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getClaudeProjectDir(cwd: string): string {
  // Claude Code encodes the project dir by replacing every non-alphanumeric
  // character (slash, dot, underscore, etc.) with "-", not just "/". Mirroring
  // only "/" misses paths like ".../vibe_coding/wand" → the scan looks in a
  // directory Claude never wrote to, so the session ID is never discovered.
  const normalized = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", normalized);
}
