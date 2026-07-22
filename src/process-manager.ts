import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { ChildProcess } from "node:child_process";
import { existsSync, unlinkSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

import pty, { IPty } from "node-pty";
import { WandStorage } from "./storage.js";
import { SessionLogger, ShortcutLogContext } from "./session-logger.js";
import { ApprovalPolicy, AutonomyPolicy, ChatOutputData, ConversationTurn, EscalationRequest, EscalationScope, ExecutionMode, ProcessEvent, ProcessEventHandler, SessionEvent, SessionProvider, SessionSnapshot, SessionSource, WandConfig } from "./types.js";
import { ClaudePtyBridge, type PermissionResolution } from "./claude-pty-bridge.js";
import { truncateMessagesForTransport } from "./message-truncator.js";
import { appendWindow, hasExplicitConfirmSyntax, hasPermissionActionContext, normalizePromptText, PTY_OUTPUT_MAX_SIZE } from "./pty-text-utils.js";
import { buildChildEnv, isRunningAsRoot } from "./env-utils.js";
import { ensureNodePtyHelperExecutable } from "./ensure-node-pty-helper.js";
import { buildLanguageDirective, buildManagedAutonomyDirective } from "./language-prompt.js";
import { prepareSessionWorktree } from "./git-worktree.js";
import { getProviderCommandSessionId, getProviderResumeCommandSessionId } from "./resume-policy.js";
import { normalizeThinkingEffort, thinkingEffortToClaudeCliEffort, thinkingEffortToClaudeSlashEffort, thinkingEffortToCodexReasoningEffort, thinkingEffortToOpenCodeVariant } from "./structured-provider-common.js";
import { SessionTopicCoordinator } from "./session-topic.js";
import { getErrorMessage } from "./error-utils.js";
import { resolveSystemAiContext } from "./session-ai-context.js";
import { resolveSessionCwd } from "./session-cwd.js";
import {
  ProviderHistoryScanner,
  type ClaudeHistorySession,
  type CodexHistorySession,
  type OpenCodeHistorySession,
  type QoderHistorySession,
} from "./provider-history-scanner.js";

export type {
  ClaudeHistorySession,
  CodexHistorySession,
  OpenCodeHistorySession,
  QoderHistorySession,
} from "./provider-history-scanner.js";

function resolveProviderFromCommand(command: string): SessionProvider {
  if (/^codex\b/.test(command.trim())) return "codex";
  if (/^opencode\b/.test(command.trim())) return "opencode";
  if (/^grok\b/.test(command.trim())) return "grok";
  return /^qodercli\b/.test(command.trim()) ? "qoder" : "claude";
}

/**
 * Tokenize the restricted shell-command subset accepted by the command
 * allowlist. Commands still run through a login shell, so accepting raw string
 * prefixes here would let an allowed executable be followed by another command
 * (`claude; evil`) or be replaced with a similarly-named binary
 * (`claude-malicious`).
 *
 * Quoted and escaped operator characters are retained as ordinary argument
 * data. Unquoted shell control operators and command substitutions are rejected
 * because they can introduce additional executable commands.
 */
function tokenizeAllowedCommand(value: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | null = null;

  const pushToken = () => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === "\n" || char === "\r") {
      return null;
    }

    if (quote === "single") {
      if (char === "'") {
        quote = null;
      } else {
        token += char;
      }
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "\\") {
        const escaped = value[index + 1];
        if (escaped === undefined || escaped === "\n" || escaped === "\r") return null;
        token += escaped === "$" || escaped === "`" || escaped === '"' || escaped === "\\"
          ? escaped
          : `\\${escaped}`;
        tokenStarted = true;
        index += 1;
        continue;
      }
      if (char === "`" || (char === "$" && value[index + 1] === "(")) {
        return null;
      }
      token += char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      pushToken();
      continue;
    }
    if (char === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (char === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (char === "\\") {
      const escaped = value[index + 1];
      if (escaped === undefined || escaped === "\n" || escaped === "\r") return null;
      token += escaped;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "<" || char === ">" || char === "`") {
      return null;
    }
    if (char === "$" && value[index + 1] === "(") {
      return null;
    }

    token += char;
    tokenStarted = true;
  }

  if (quote !== null) return null;
  pushToken();
  return tokens;
}

/** Exported for focused policy tests. */
export function isCommandAllowedByPrefixes(command: string, allowedPrefixes: readonly string[]): boolean {
  if (allowedPrefixes.length === 0) return true;

  const commandTokens = tokenizeAllowedCommand(command);
  if (!commandTokens || commandTokens.length === 0) return false;

  return allowedPrefixes.some((prefix) => {
    const prefixTokens = tokenizeAllowedCommand(prefix);
    if (!prefixTokens) return false;
    if (prefixTokens.length === 0 || prefixTokens.length > commandTokens.length) return false;
    return prefixTokens.every((token, index) => token === commandTokens[index]);
  });
}

export type { ProcessEvent, ProcessEventHandler } from "./types.js";

export class SessionInputError extends Error {
  constructor(
    message: string,
    readonly code: "SESSION_NOT_FOUND" | "SESSION_NOT_RUNNING" | "SESSION_NO_PTY",
    readonly sessionId: string,
    readonly sessionStatus?: SessionSnapshot["status"]
  ) {
    super(message);
    this.name = "SessionInputError";
  }
}


interface SessionRecord extends SessionSnapshot {
  provider: SessionProvider;
  processId: number | null;
  ptyProcess: IPty | null;
  stopRequested: boolean;
  confirmWindow: string;
  ptyPermissionBlocked: boolean;
  lastAutoConfirmAt: number;
  autoApprovePermissions: boolean;
  pendingEscalation: EscalationRequest | null;
  lastEscalationResult: SessionSnapshot["lastEscalationResult"];
  autonomyPolicy: AutonomyPolicy;
  approvalPolicy: ApprovalPolicy;
  allowedScopes: EscalationScope[];
  rememberedEscalationScopes: Set<EscalationScope>;
  rememberedEscalationTargets: Set<string>;
  /** 从存储加载的初始输出（用于重启后恢复） */
  storedOutput: string;
  /** Structured conversation messages derived from PTY chat output */
  messages: ConversationTurn[];
  /** Child process reference reserved for compatibility */
  childProcess: ChildProcess | null;
  /** PTY bridge for parsing output and emitting events */
  ptyBridge: ClaudePtyBridge | null;
  /** Current PTY dimensions, last applied by resize(). */
  ptyCols: number;
  ptyRows: number;
  /** Claude task ids visible before this session started */
  knownClaudeTaskIds?: Set<string>;
  /** Retry timer for discovering the real Claude resumable task id */
  claudeTaskDiscoveryTimer?: NodeJS.Timeout | null;
  /** Timer for delayed initial input delivery */
  initialInputTimer?: NodeJS.Timeout | null;
  /** Claude project jsonl mtimes visible before this session started */
  knownClaudeProjectMtimes?: Map<string, number>;
  /** Codex rollout mtimes visible before this session started */
  knownCodexSessionMtimes?: Map<string, number>;
  /** Retry timer for discovering the real Codex resumable thread id */
  codexSessionDiscoveryTimer?: NodeJS.Timeout | null;
  /** OpenCode sessions visible before this PTY started, keyed by provider session id. */
  knownOpenCodeSessionMtimes?: Map<string, number>;
  /** Retry timer for discovering the real OpenCode resumable session id. */
  openCodeSessionDiscoveryTimer?: NodeJS.Timeout | null;
  /** Auto-approval stats per session */
  approvalStats: { tool: number; command: number; file: number; total: number };
}

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

interface PersistedMessageState {
  count: number;
  signature: string;
}

interface SessionDirtyState {
  metadata: boolean;
  output: boolean;
  messages: boolean;
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

function listClaudeProjectSessionMtimes(cwd: string): Map<string, number> {
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

function getLatestClaudeProjectSessionId(record: Pick<SessionRecord, "cwd" | "startedAt" | "knownClaudeProjectMtimes" | "messages">): string | null {
  return selectClaudeProjectSessionForRecord(record)?.id ?? null;
}

function selectClaudeProjectSessionForTimeWindow(record: Pick<SessionSnapshot, "cwd" | "startedAt" | "endedAt" | "messages">): ClaudeProjectSessionDetails | null {
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

function listRecentClaudeProjectSessionIds(cwd: string, startedAt: string): string[] {
  return listClaudeProjectSessionCandidates(cwd)
    .filter((candidate) => hasRecentProjectActivity(candidate, startedAt))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((candidate) => candidate.id);
}

function isClaudeSessionFileAvailable(cwd: string, claudeSessionId: string): boolean {
  const filePath = path.join(getClaudeProjectDir(cwd), `${claudeSessionId}.jsonl`);
  return Boolean(readClaudeProjectSessionDetails(filePath, claudeSessionId));
}

function listCodexSessionMtimes(sessions: readonly CodexHistorySession[]): Map<string, number> {
  return new Map(sessions.map((session) => [session.claudeSessionId, session.mtimeMs]));
}

function isSameResolvedPath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

function isUsableCodexHistorySession(session: CodexHistorySession): boolean {
  return session.hasUser || session.hasConversation;
}

function parseTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function getLatestCodexSessionId(
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
    const rows = db.prepare(
      "SELECT id, directory, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT 500",
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

function listOpenCodeSessionMtimes(): Map<string, number> {
  return new Map(listOpenCodeSessionCandidates().map((session) => [session.id, session.updatedAtMs]));
}

function selectOpenCodeSessionForRecord(
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

function selectOpenCodeSessionForTimeWindow(
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

function selectCodexSessionForTimeWindow(
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

function recoverCodexSessionIdFromHistory(
  snapshot: Pick<SessionSnapshot, "provider" | "command" | "cwd" | "startedAt" | "endedAt" | "claudeSessionId">,
  sessions: readonly CodexHistorySession[],
): string | null {
  if (snapshot.provider !== "codex" || snapshot.claudeSessionId) {
    return null;
  }
  return getProviderResumeCommandSessionId("codex", snapshot.command) ?? selectCodexSessionForTimeWindow(snapshot, sessions)?.claudeSessionId ?? null;
}

function recoverClaudeSessionIdFromHistory(snapshot: Pick<SessionSnapshot, "provider" | "command" | "cwd" | "startedAt" | "endedAt" | "claudeSessionId" | "messages">): string | null {
  if (snapshot.provider !== "claude" || snapshot.claudeSessionId) {
    return null;
  }
  return getProviderResumeCommandSessionId("claude", snapshot.command) ?? selectClaudeProjectSessionForTimeWindow(snapshot)?.id ?? null;
}

function snapshotMessages(record: Pick<SessionRecord, "ptyBridge" | "messages">): ConversationTurn[] {
  return record.ptyBridge?.getMessages() ?? record.messages;
}

const MAX_SESSIONS = 200;
const ARCHIVE_AFTER_MS = 1000 * 60 * 60 * 24;
const CONFIRM_WINDOW_SIZE = 800;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getClaudeProjectDir(cwd: string): string {
  // Claude Code encodes the project dir by replacing every non-alphanumeric
  // character (slash, dot, underscore, etc.) with "-", not just "/". Mirroring
  // only "/" misses paths like ".../vibe_coding/wand" → the scan looks in a
  // directory Claude never wrote to, so the session ID is never discovered.
  const normalized = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", normalized);
}

/** Derive a short summary for a session from user messages or current task. */
function getLastMessageSignature(messages: ConversationTurn[]): string {
  const last = messages[messages.length - 1];
  if (!last) {
    return "";
  }
  const lastContent = JSON.stringify(last.content ?? []);
  return `${last.role}:${lastContent}`;
}

function getPersistedMessageState(messages: ConversationTurn[]): PersistedMessageState {
  return {
    count: messages.length,
    signature: getLastMessageSignature(messages),
  };
}

function shouldPersistMessages(
  lastState: PersistedMessageState | undefined,
  nextMessages: ConversationTurn[]
): boolean {
  if (nextMessages.length === 0) {
    return false;
  }
  const nextState = getPersistedMessageState(nextMessages);
  return !lastState
    || lastState.count !== nextState.count
    || lastState.signature !== nextState.signature;
}

function recoverMessagesFromSnapshot(snapshot: SessionSnapshot): ConversationTurn[] {
  return snapshot.messages ?? [];
}

function deriveSessionSummary(messages: ConversationTurn[]): string | undefined {
  // Prefer first user message as summary
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const block of msg.content) {
      if (block.type === "text" && block.text.trim()) {
        return block.text.trim().slice(0, 120);
      }
    }
    break;
  }
  return undefined;
}


export class ProcessManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly logger: SessionLogger;
  private readonly providerHistory = new ProviderHistoryScanner();
  /** 24h archive scan timer */
  private archiveTimer: NodeJS.Timeout | null = null;
  /** Per-session debounce timers for throttled persist calls */
  private readonly persistDebounceTimers = new Map<string, NodeJS.Timeout>();
  /** Last persisted message state per session — used to skip redundant message writes */
  private readonly lastPersistedMessageState = new Map<string, PersistedMessageState>();
  /** Columns that changed since the last per-session checkpoint. */
  private readonly dirtySessions = new Map<string, SessionDirtyState>();
  /** 启动时被识别为孤儿 PTY 并标记为 exited 的旧会话数（旧服务器进程已死） */
  private orphanRecoveredCount = 0;
  private readonly topicCoordinator = new SessionTopicCoordinator();
  private disposed = false;

  constructor(
    private readonly config: WandConfig,
    private readonly storage: WandStorage,
    configDir?: string
  ) {
    super();
    this.logger = new SessionLogger(configDir || path.join(process.env.HOME || process.cwd(), ".wand"), config.shortcutLogMaxBytes);
    let startupCodexHistory: CodexHistorySession[] | null = null;
    const getStartupCodexHistory = (): CodexHistorySession[] => {
      startupCodexHistory ??= this.providerHistory.listCodexHistorySessions();
      return startupCodexHistory;
    };

    for (const snapshot of this.storage.loadSessions()) {
      if ((snapshot.sessionKind ?? "pty") !== "pty") {
        continue;
      }
      this.lastPersistedMessageState.set(snapshot.id, getPersistedMessageState(snapshot.messages ?? []));
      const provider = snapshot.provider ?? resolveProviderFromCommand(snapshot.command);
      const isClaudeCmd = provider === "claude";
      const isCodexCmd = provider === "codex";
      const isOpenCodeCmd = provider === "opencode";
      const resumeCommandSessionId = getProviderCommandSessionId(provider, snapshot.command);
      const orphanEndedAt = snapshot.status === "running" ? new Date().toISOString() : null;
      const sessionIdFromHistory = isClaudeCmd
        ? recoverClaudeSessionIdFromHistory({
            ...snapshot,
            provider: "claude",
            endedAt: snapshot.endedAt ?? orphanEndedAt,
          })
        : isCodexCmd
          ? recoverCodexSessionIdFromHistory({
              ...snapshot,
              provider: "codex",
              endedAt: snapshot.endedAt ?? orphanEndedAt,
            }, getStartupCodexHistory())
          : isOpenCodeCmd
            ? selectOpenCodeSessionForTimeWindow({
                cwd: snapshot.cwd,
                startedAt: snapshot.startedAt,
                endedAt: snapshot.endedAt ?? orphanEndedAt,
              })?.id ?? null
          : null;
      const restoredSessionId = resumeCommandSessionId ?? snapshot.claudeSessionId ?? sessionIdFromHistory;
      // Sessions restored from storage have ptyProcess: null — the old server's PTY
      // belongs to a dead process. Mark running sessions as exited so the UI
      // reflects reality and users can start fresh sessions.
      if (snapshot.status === "running") {
        const recoveredMessages = recoverMessagesFromSnapshot(snapshot);
        const updated = {
          ...snapshot,
          sessionSource: snapshot.sessionSource ?? "interactive",
          status: "exited" as const,
          endedAt: orphanEndedAt,
          claudeSessionId: restoredSessionId ?? null,
          messages: recoveredMessages.length > 0 ? recoveredMessages : snapshot.messages,
        };
        this.storage.saveSession(updated);
        if (restoredSessionId && restoredSessionId !== snapshot.claudeSessionId) {
          const label = isCodexCmd ? "Codex thread" : isOpenCodeCmd ? "OpenCode session" : "Claude session";
          process.stderr.write(`[wand] Recovered ${label} ID for orphan PTY ${snapshot.id}: ${restoredSessionId}\n`);
        }
        this.sessions.set(snapshot.id, {
          ...updated,
          sessionSource: snapshot.sessionSource ?? "interactive",
          provider,
          processId: null,
          ptyProcess: null,
          stopRequested: false,
          confirmWindow: "",
          ptyPermissionBlocked: false,
          lastAutoConfirmAt: 0,
          // Preserve a user-toggled auto-approve setting across server restarts
          // instead of recomputing it from the command/mode pair.
          autoApprovePermissions: snapshot.autoApprovePermissions
            ?? this.shouldAutoApprovePermissions(snapshot.command, snapshot.mode, provider),
          pendingEscalation: snapshot.pendingEscalation ?? null,
          lastEscalationResult: snapshot.lastEscalationResult ?? null,
          autonomyPolicy: snapshot.autonomyPolicy ?? this.defaultAutonomyPolicy(snapshot.mode),
          approvalPolicy: snapshot.approvalPolicy ?? "ask-every-time",
          allowedScopes: snapshot.allowedScopes ?? [],
          rememberedEscalationScopes: new Set(),
          rememberedEscalationTargets: new Set(),
          storedOutput: snapshot.output,
          messages: snapshot.messages ?? [],
          childProcess: null,
          ptyBridge: null,
          knownClaudeTaskIds: undefined,
          claudeTaskDiscoveryTimer: null,
          knownClaudeProjectMtimes: isClaudeCmd ? listClaudeProjectSessionMtimes(updated.cwd) : undefined,
          knownCodexSessionMtimes: isCodexCmd ? listCodexSessionMtimes(getStartupCodexHistory()) : undefined,
          codexSessionDiscoveryTimer: null,
          knownOpenCodeSessionMtimes: isOpenCodeCmd ? listOpenCodeSessionMtimes() : undefined,
          openCodeSessionDiscoveryTimer: null,
          claudeSessionId: restoredSessionId ?? updated.claudeSessionId,
          approvalStats: snapshot.approvalStats ?? { tool: 0, command: 0, file: 0, total: 0 },
          titleGenerating: false,
          ptyCols: snapshot.ptyCols ?? 120,
          ptyRows: snapshot.ptyRows ?? 36,
        });
        this.orphanRecoveredCount += 1;
      } else {
        const updated = restoredSessionId && restoredSessionId !== snapshot.claudeSessionId
          ? { ...snapshot, claudeSessionId: restoredSessionId }
          : snapshot;
        if (updated !== snapshot) {
          this.storage.saveSessionMetadata(updated);
          const label = isCodexCmd ? "Codex thread" : isOpenCodeCmd ? "OpenCode session" : "Claude session";
          process.stderr.write(`[wand] Recovered ${label} ID for saved PTY ${snapshot.id}: ${restoredSessionId}\n`);
        }
        this.sessions.set(snapshot.id, {
          ...updated,
          provider,
          processId: null,
          ptyProcess: null,
          stopRequested: false,
          confirmWindow: "",
          ptyPermissionBlocked: false,
          lastAutoConfirmAt: 0,
          autoApprovePermissions: snapshot.autoApprovePermissions
            ?? this.shouldAutoApprovePermissions(snapshot.command, snapshot.mode, provider),
          pendingEscalation: snapshot.pendingEscalation ?? null,
          lastEscalationResult: snapshot.lastEscalationResult ?? null,
          autonomyPolicy: snapshot.autonomyPolicy ?? this.defaultAutonomyPolicy(snapshot.mode),
          approvalPolicy: snapshot.approvalPolicy ?? "ask-every-time",
          allowedScopes: snapshot.allowedScopes ?? [],
          rememberedEscalationScopes: new Set(),
          rememberedEscalationTargets: new Set(),
          storedOutput: snapshot.output,
          messages: snapshot.messages ?? [],
          childProcess: null,
          ptyBridge: null,
          knownClaudeTaskIds: undefined,
          claudeTaskDiscoveryTimer: null,
          knownClaudeProjectMtimes: isClaudeCmd ? listClaudeProjectSessionMtimes(updated.cwd) : undefined,
          knownCodexSessionMtimes: isCodexCmd ? listCodexSessionMtimes(getStartupCodexHistory()) : undefined,
          codexSessionDiscoveryTimer: null,
          knownOpenCodeSessionMtimes: isOpenCodeCmd ? listOpenCodeSessionMtimes() : undefined,
          openCodeSessionDiscoveryTimer: null,
          claudeSessionId: restoredSessionId ?? updated.claudeSessionId,
          approvalStats: snapshot.approvalStats ?? { tool: 0, command: 0, file: 0, total: 0 },
          titleGenerating: false,
          ptyCols: snapshot.ptyCols ?? 120,
          ptyRows: snapshot.ptyRows ?? 36,
        });
      }
    }
    this.archiveExpiredSessions();
    this.archiveTimer = setInterval(() => {
      try { this.archiveExpiredSessions(); } catch (err) {
        console.error(`[ProcessManager] archive scan failed: ${String(err)}`);
      }
    }, 60 * 1000);
    this.archiveTimer.unref?.();
  }

  on(_event: "process", listener: ProcessEventHandler): this {
    return super.on("process", listener);
  }

  /** 启动时被识别为孤儿 PTY 并标记为 exited 的旧会话数量（仅用于启动摘要展示）。 */
  getOrphanRecoveredCount(): number {
    return this.orphanRecoveredCount;
  }

  /** Stop all live work and flush pending state before storage is closed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.archiveTimer) {
      clearInterval(this.archiveTimer);
      this.archiveTimer = null;
    }
    const pendingPersistIds = new Set(this.persistDebounceTimers.keys());
    for (const timer of this.persistDebounceTimers.values()) clearTimeout(timer);
    this.persistDebounceTimers.clear();

    for (const record of this.sessions.values()) {
      const wasRunning = record.status === "running";
      if (record.ptyBridge) {
        record.messages = record.ptyBridge.getMessages();
      }
      this.cleanupRecord(record);
      if (wasRunning) {
        record.stopRequested = true;
        record.status = "stopped";
        record.exitCode = null;
        record.endedAt = new Date().toISOString();
        record.pendingEscalation = null;
        record.ptyPermissionBlocked = false;
      }
      if (wasRunning || pendingPersistIds.has(record.id)) {
        try { this.persist(record, { forceFullSave: wasRunning, metadataDirty: true }); } catch { /* best-effort shutdown flush */ }
      }
    }

    this.topicCoordinator.clear();
    this.removeAllListeners("process");
    this.logger.dispose();
  }

  private emitEvent(event: ProcessEvent): void {
    if (this.disposed) return;
    this.emit("process", event);
  }

  private cleanupOldSessions(): void {
    // Only clean up when well over the limit
    if (this.sessions.size < MAX_SESSIONS) return;

    const now = Date.now();
    const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const removable: string[] = [];

    for (const [id, record] of this.sessions) {
      // Only remove archived, non-running sessions older than 7 days
      if (record.status === "running") continue;
      if (!record.archived) continue;
      const ref = record.endedAt ?? record.startedAt;
      const refMs = Date.parse(ref);
      if (Number.isFinite(refMs) && now - refMs > STALE_MS) {
        removable.push(id);
      }
    }

    // Sort oldest first and remove enough to get back under the limit
    const toRemove = removable
      .sort((a, b) => {
        const ra = this.sessions.get(a);
        const rb = this.sessions.get(b);
        return (ra?.endedAt || "").localeCompare(rb?.endedAt || "");
      })
      .slice(0, this.sessions.size - MAX_SESSIONS + 1);

    for (const id of toRemove) {
      const record = this.sessions.get(id);
      if (record) {
        this.logger.deleteSession(id);
        if (record.provider === "claude") {
          this.deleteClaudeCache(record);
        }
      }
      this.sessions.delete(id);
      this.lastPersistedMessageState.delete(id);
      this.dirtySessions.delete(id);
      this.storage.deleteSession(id);
    }
    if (toRemove.length > 0) {
      this.providerHistory.invalidate();
    }
  }

  start(command: string, cwd: string | undefined, mode: ExecutionMode, initialInput?: string, opts?: { resumedFromSessionId?: string; autoRecovered?: boolean; worktreeEnabled?: boolean; provider?: SessionProvider; model?: string; reuseId?: string; cols?: number; rows?: number; thinkingEffort?: SessionSnapshot["thinkingEffort"]; sessionSource?: SessionSource; automationId?: string }): SessionSnapshot {
    if (this.disposed) throw new Error("ProcessManager has been disposed.");
    this.assertCommandAllowed(command);

    const baseCwd = resolveSessionCwd(cwd, this.config.defaultCwd);

    const id = opts?.reuseId || randomUUID();
    // When a session is being resumed under the same id, capture its prior
    // structured messages so the new bridge can present them as the chat
    // history. We deliberately do NOT carry over rawOutput — `claude --resume`
    // re-prints its own banner and replayed history into the new PTY, and
    // mixing the two would surface every line twice in the terminal view.
    let priorMessages: ConversationTurn[] = [];
    let inheritedSessionSource: SessionSource | undefined;
    let inheritedAutomationId: string | undefined;
    if (opts?.reuseId) {
      const oldRecord = this.sessions.get(id);
      if (oldRecord) {
        priorMessages = oldRecord.ptyBridge?.getMessages() ?? oldRecord.messages ?? [];
        inheritedSessionSource = oldRecord.sessionSource;
        inheritedAutomationId = oldRecord.automationId;
        this.cleanupRecord(oldRecord);
        this.sessions.delete(id);
      } else {
        const stored = this.storage.getSession(id);
        priorMessages = stored?.messages ?? [];
        inheritedSessionSource = stored?.sessionSource;
        inheritedAutomationId = stored?.automationId;
      }
    }
    const worktreeSetup = opts?.worktreeEnabled
      ? prepareSessionWorktree({ cwd: baseCwd, sessionId: id })
      : null;
    const resolvedCwd = worktreeSetup?.cwd ?? baseCwd;
    const provider = opts?.provider ?? resolveProviderFromCommand(command);
    const effectiveMode = provider === "codex" ? "full-access" : mode;
    const isClaudeProvider = provider === "claude";
    const selectedModel = opts?.model?.trim() || undefined;
    const initialThinkingEffort = normalizeThinkingEffort(opts?.thinkingEffort);
    let processedCommand = this.processCommandForMode(command, effectiveMode, provider, selectedModel, initialThinkingEffort);
    const isCodexProvider = provider === "codex";
    const isOpenCodeProvider = provider === "opencode";
    const existingProviderSessionId = getProviderCommandSessionId(provider, processedCommand)
      ?? getProviderCommandSessionId(provider, command);
    // Grok and Qoder accept caller-selected IDs for new conversations. Assigning
    // one up front avoids depending on provider-specific TUI rendering to learn
    // the durable ID later.
    const assignedProviderSessionId = !existingProviderSessionId && (provider === "grok" || provider === "qoder")
      ? randomUUID()
      : null;
    if (assignedProviderSessionId) {
      processedCommand = `${processedCommand} --session-id ${assignedProviderSessionId}`;
    }
    const knownClaudeTaskIds = isClaudeProvider ? new Set(listRecentClaudeProjectSessionIds(resolvedCwd, new Date().toISOString())) : null;
    const knownClaudeProjectMtimes = isClaudeProvider ? listClaudeProjectSessionMtimes(resolvedCwd) : null;
    const knownCodexSessionMtimes = isCodexProvider && !existingProviderSessionId
      ? listCodexSessionMtimes(this.providerHistory.listCodexHistorySessions())
      : null;
    const knownOpenCodeSessionMtimes = isOpenCodeProvider && !existingProviderSessionId
      ? listOpenCodeSessionMtimes()
      : null;
    const initialClaudeSessionId = existingProviderSessionId ?? assignedProviderSessionId;
    const startedAt = new Date().toISOString();

    const record: SessionRecord = {
      id,
      sessionSource: opts?.sessionSource ?? inheritedSessionSource ?? "interactive",
      automationId: opts?.automationId ?? inheritedAutomationId,
      provider,
      command,
      cwd: resolvedCwd,
      mode: effectiveMode,
      worktreeEnabled: Boolean(worktreeSetup),
      worktree: worktreeSetup?.worktree ?? null,
      autonomyPolicy: this.defaultAutonomyPolicy(effectiveMode),
      approvalPolicy: "ask-every-time",
      allowedScopes: [],
      status: "running",
      exitCode: null,
      startedAt,
      endedAt: null,
      output: "",
      archived: false,
      archivedAt: null,
      permissionBlocked: undefined,
      pendingEscalation: null,
      lastEscalationResult: null,
      claudeSessionId: initialClaudeSessionId,
      processId: null,
      ptyProcess: null,
      stopRequested: false,
      confirmWindow: "",
      ptyPermissionBlocked: false,
      lastAutoConfirmAt: 0,
      autoApprovePermissions: this.shouldAutoApprovePermissions(command, effectiveMode, provider),
      resumedFromSessionId: opts?.resumedFromSessionId ?? (opts?.reuseId ? opts.reuseId : null),
      autoRecovered: opts?.autoRecovered ?? false,
      rememberedEscalationScopes: new Set(),
      rememberedEscalationTargets: new Set(),
      storedOutput: "",
      messages: priorMessages,
      childProcess: null,
      ptyBridge: null,
      knownClaudeTaskIds: knownClaudeTaskIds ?? undefined,
      claudeTaskDiscoveryTimer: null,
      knownClaudeProjectMtimes: knownClaudeProjectMtimes ?? undefined,
      knownCodexSessionMtimes: knownCodexSessionMtimes ?? undefined,
      codexSessionDiscoveryTimer: null,
      knownOpenCodeSessionMtimes: knownOpenCodeSessionMtimes ?? undefined,
      openCodeSessionDiscoveryTimer: null,
      approvalStats: { tool: 0, command: 0, file: 0, total: 0 },
      selectedModel: selectedModel ?? null,
      thinkingEffort: initialThinkingEffort,
      // cols 上限 256：与 @wterm/dom WASM grid 的 maxCols 硬编码一致，
      // 防止服务端按 >256 cols 让 Claude 用 CSI 绝对列定位写到 wterm 实际
      // 渲染不到的列上（表现为"内容神奇复制下行"）。
      ptyCols: opts?.cols !== undefined ? clampDimension(opts.cols, 20, 256) : 120,
      ptyRows: opts?.rows !== undefined ? clampDimension(opts.rows, 10, 160) : 36,
    };

    if (isClaudeProvider) {
      record.ptyBridge = new ClaudePtyBridge({
        sessionId: id,
        isClaudeCommand: true,
        autoApprove: record.autoApprovePermissions,
        initialMessages: priorMessages,
      });
      record.ptyBridge.on("event", (event: SessionEvent) => {
        if (this.sessions.get(id) !== record) return;
        this.handleBridgeEvent(record, event);
      });
    }

    this.sessions.set(id, record);
    this.persist(record, { forceFullSave: true });
    if (initialClaudeSessionId && (provider === "claude" || provider === "codex")) {
      this.providerHistory.invalidate(provider);
    }
    this.cleanupOldSessions();


    const shellArgs = this.buildShellArgs(processedCommand);
    // Self-heal node-pty's spawn-helper +x bit before every spawn: a self-update
    // can re-drop it after this server already ran its startup chmod, which would
    // otherwise make every PTY launch throw "posix_spawnp failed." until restart.
    ensureNodePtyHelperExecutable();
    let child: import("node-pty").IPty;
    try {
      child = pty.spawn(this.config.shell, shellArgs, {
        cwd: resolvedCwd,
        env: buildChildEnv(this.config.inheritEnv !== false, {
          WAND_MODE: effectiveMode,
          WAND_AUTO_CONFIRM: record.autoApprovePermissions ? "1" : "0",
          WAND_AUTO_EDIT: effectiveMode === "auto-edit" ? "1" : "0"
        }),
        name: "xterm-color",
        // 使用 record 上由前端协商好的真实尺寸，避免"先 120 列、几百毫秒后再 resize"
        // 期间 provider TUI 用错列宽渲染出 \x1b[120G 这类绝对列定位序列。
        cols: record.ptyCols,
        rows: record.ptyRows
      });
    } catch (err) {
      console.error("[ProcessManager] pty.spawn threw", { sessionId: id, error: String(err) });
      record.status = "failed";
      record.exitCode = -1;
      record.endedAt = new Date().toISOString();
      record.ptyProcess = null;
      this.persist(record, { forceFullSave: true, metadataDirty: true });
      return this.snapshot(record);
    }

    record.processId = child.pid;
    record.ptyProcess = child;
    record.status = "running";

    child.onExit(({ exitCode }) => {
      const current = this.sessions.get(id);
      // A stopped session can be resumed under the same public id before the
      // old PTY has emitted its asynchronous exit event. Never let that stale
      // callback finalize or clear the replacement run.
      if (current !== record || current.ptyProcess !== child) return;
      if (current.claudeTaskDiscoveryTimer) {
        clearTimeout(current.claudeTaskDiscoveryTimer);
        current.claudeTaskDiscoveryTimer = null;
      }
      if (current.codexSessionDiscoveryTimer) {
        clearTimeout(current.codexSessionDiscoveryTimer);
        current.codexSessionDiscoveryTimer = null;
      }
      if (current.openCodeSessionDiscoveryTimer) {
        clearTimeout(current.openCodeSessionDiscoveryTimer);
        current.openCodeSessionDiscoveryTimer = null;
      }
      if (current.initialInputTimer) {
        clearTimeout(current.initialInputTimer);
        current.initialInputTimer = null;
      }
      if (current.ptyBridge) {
        current.ptyBridge.onExit(exitCode);
        current.ptyBridge.removeAllListeners();
      }
      current.pendingEscalation = null;
      current.ptyPermissionBlocked = false;
      this.captureClaudeSessionId(current, { allowTimeWindowFallback: true });
      this.captureCodexSessionId(current, { allowTimeWindowFallback: true });
      this.captureOpenCodeSessionId(current, { allowTimeWindowFallback: true });
      current.status = current.stopRequested ? "stopped" : exitCode === 0 ? "exited" : "failed";
      current.exitCode = current.stopRequested ? null : exitCode;
      current.endedAt = new Date().toISOString();
      current.ptyProcess = null;
      this.flushPersist(current, true);
      this.emitEvent({ type: "ended", sessionId: id, data: this.snapshot(current) });
    });

    if (record.ptyBridge) {
      record.ptyBridge.setPtyWrite((input: string) => {
        if (this.sessions.get(id) !== record || record.ptyProcess !== child) return;
        child.write(input);
      });
    }

    this.emitEvent({ type: "started", sessionId: id, data: this.snapshot(record) });
    if (initialInput) this.maybeGenerateSessionTopic(id, initialInput);

    let initialInputSent = false;
    const sendInitialInput = () => {
      if (initialInputSent || !initialInput) return;
      initialInputSent = true;
      const current = this.sessions.get(id);
      if (current !== record || current.ptyProcess !== child || current.status !== "running") {
        process.stderr.write(`[wand] Cannot send initial input: session not ready\n`);
        return;
      }
      process.stderr.write(`[wand] Sending initial input (${initialInput.length} chars)\n`);

      if (current.ptyBridge) {
        current.ptyBridge.onUserInput(initialInput);
      }

      child.write(initialInput);
      child.write("\r");
    };

    child.onData((chunk: string) => {
      const rec = this.sessions.get(id);
      // PTYs may still drain data after kill(). A replacement session can use
      // the same id, so both record identity and the concrete PTY handle must
      // match before accepting the chunk.
      if (rec !== record || rec.ptyProcess !== child) return;

      if (rec.ptyBridge) {
        rec.ptyBridge.processChunk(chunk);
        rec.output = rec.ptyBridge.getRawOutput();
      } else {
        rec.output = appendWindow(rec.output, chunk, PTY_OUTPUT_MAX_SIZE);
      }

      this.logger.appendPtyOutput(id, chunk);

      if (!rec.ptyBridge) {
        this.emitEvent({
          type: "output",
          sessionId: id,
          data: {
            incremental: true,
            chunk,
            permissionBlocked: this.isPermissionBlocked(rec),
          },
        });
      }

      const bridgeSessionId = rec.ptyBridge?.getClaudeSessionId();
      if (bridgeSessionId && bridgeSessionId !== rec.claudeSessionId) {
        rec.claudeSessionId = bridgeSessionId;
        this.markDirty(rec.id, { metadata: true });
        this.providerHistory.invalidate("claude");
        process.stderr.write(`[wand] Captured Claude session ID: ${bridgeSessionId}\n`);
      }

      if (!rec.claudeSessionId && rec.knownClaudeTaskIds) {
        rec.messages = snapshotMessages(rec);
        const discoveredTaskId = getLatestClaudeProjectSessionId({
          cwd: rec.cwd,
          startedAt: rec.startedAt,
          knownClaudeProjectMtimes: rec.knownClaudeProjectMtimes,
          messages: rec.messages
        });
        if (discoveredTaskId) {
          rec.claudeSessionId = discoveredTaskId;
          this.markDirty(rec.id, { metadata: true });
          rec.knownClaudeTaskIds.add(discoveredTaskId);
          process.stderr.write(`[wand] Captured Claude project session ID: ${discoveredTaskId}\n`);
        }
      }

      if (rec.autoApprovePermissions && !rec.ptyBridge && rec.provider === "claude") {
        this.autoConfirmWithRecord(rec, chunk, child);
      }

      if (initialInput && !initialInputSent && (chunk.includes("❯") || chunk.includes("›"))) {
        sendInitialInput();
      }

      this.schedulePersist(rec);
    });

    if (initialInput) {
      record.initialInputTimer = setTimeout(() => {
        record.initialInputTimer = null;
        if (!initialInputSent) sendInitialInput();
      }, 3000);
    }

    if (record.knownClaudeTaskIds) {
      const tryDiscoverClaudeTaskId = () => {
        if (this.disposed) return;
        const current = this.sessions.get(id);
        if (current !== record || current.ptyProcess !== child || current.status !== "running" || current.claudeSessionId || !current.knownClaudeTaskIds) {
          return;
        }
        if (getProviderResumeCommandSessionId("claude", current.command)) {
          current.claudeTaskDiscoveryTimer = null;
          return;
        }
        current.messages = snapshotMessages(current);
        const discoveredTaskId = getLatestClaudeProjectSessionId({
          cwd: current.cwd,
          startedAt: current.startedAt,
          knownClaudeProjectMtimes: current.knownClaudeProjectMtimes,
          messages: current.messages
        });
        if (discoveredTaskId) {
          current.claudeSessionId = discoveredTaskId;
          current.knownClaudeTaskIds.add(discoveredTaskId);
          current.claudeTaskDiscoveryTimer = null;
          process.stderr.write(`[wand] Discovered Claude resumable project session ID: ${discoveredTaskId}\n`);
          this.persist(current);
          return;
        }
        current.claudeTaskDiscoveryTimer = setTimeout(tryDiscoverClaudeTaskId, 1000);
      };
      record.claudeTaskDiscoveryTimer = setTimeout(tryDiscoverClaudeTaskId, 500);
    }

    if (record.knownCodexSessionMtimes) {
      const tryDiscoverCodexSessionId = () => {
        if (this.disposed) return;
        const current = this.sessions.get(id);
        if (current !== record || current.ptyProcess !== child || current.status !== "running" || current.claudeSessionId || !current.knownCodexSessionMtimes) {
          return;
        }
        if (getProviderResumeCommandSessionId("codex", current.command)) {
          current.codexSessionDiscoveryTimer = null;
          return;
        }
        if (this.captureCodexSessionId(current)) {
          current.codexSessionDiscoveryTimer = null;
          this.persist(current);
          return;
        }
        current.codexSessionDiscoveryTimer = setTimeout(tryDiscoverCodexSessionId, 1000);
      };
      record.codexSessionDiscoveryTimer = setTimeout(tryDiscoverCodexSessionId, 500);
    }

    if (record.knownOpenCodeSessionMtimes) {
      const tryDiscoverOpenCodeSessionId = () => {
        if (this.disposed) return;
        const current = this.sessions.get(id);
        if (current !== record || current.ptyProcess !== child || current.status !== "running" || current.claudeSessionId || !current.knownOpenCodeSessionMtimes) {
          return;
        }
        if (getProviderResumeCommandSessionId("opencode", current.command)) {
          current.openCodeSessionDiscoveryTimer = null;
          return;
        }
        if (this.captureOpenCodeSessionId(current)) {
          current.openCodeSessionDiscoveryTimer = null;
          this.persist(current);
          return;
        }
        current.openCodeSessionDiscoveryTimer = setTimeout(tryDiscoverOpenCodeSessionId, 1000);
        current.openCodeSessionDiscoveryTimer.unref?.();
      };
      record.openCodeSessionDiscoveryTimer = setTimeout(tryDiscoverOpenCodeSessionId, 500);
      record.openCodeSessionDiscoveryTimer.unref?.();
    }

    return this.snapshot(record);
  }


  list(): SessionSnapshot[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((session) => this.snapshot(session));
  }

  /** Return lightweight snapshots for the session list (no output/messages). */
  listSlim(): SessionSnapshot[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((session) => this.snapshotSlim(session));
  }

  hasClaudeSessionFile(cwd: string, claudeSessionId: string): boolean {
    return isClaudeSessionFileAvailable(cwd, claudeSessionId);
  }

  listClaudeHistorySessions(): ClaudeHistorySession[] {
    const allSessions = this.providerHistory.listClaudeHistorySessions();

    // Cross-reference with wand-managed sessions
    const managedClaudeIds = new Set<string>();
    for (const record of this.sessions.values()) {
      if (record.provider === "claude" && record.claudeSessionId) {
        managedClaudeIds.add(record.claudeSessionId);
      }
    }

    for (const session of allSessions) {
      if (managedClaudeIds.has(session.claudeSessionId)) {
        session.managedByWand = true;
      }
    }

    return allSessions;
  }

  deleteClaudeHistoryFiles(sessions: { claudeSessionId: string; cwd: string }[]): number {
    return this.providerHistory.deleteClaudeHistoryFiles(sessions);
  }

  listCodexHistorySessions(): CodexHistorySession[] {
    const allSessions = this.providerHistory.listCodexHistorySessions();

    // Cross-reference with wand-managed sessions（codex 的 thread id 存在 claudeSessionId 字段）
    const managedIds = new Set<string>();
    for (const record of this.sessions.values()) {
      if (record.provider === "codex" && record.claudeSessionId) {
        managedIds.add(record.claudeSessionId);
      }
    }
    for (const session of allSessions) {
      if (managedIds.has(session.claudeSessionId)) {
        session.managedByWand = true;
      }
    }

    return allSessions;
  }

  hasCodexSessionFile(threadId: string): boolean {
    return this.providerHistory.hasCodexSessionFile(threadId);
  }

  deleteCodexHistoryFiles(threadIds: string[]): number {
    return this.providerHistory.deleteCodexHistoryFiles(threadIds);
  }

  listOpenCodeHistorySessions(): OpenCodeHistorySession[] {
    return this.providerHistory.listOpenCodeHistorySessions();
  }

  deleteOpenCodeHistorySessions(sessionIds: string[]): number {
    return this.providerHistory.deleteOpenCodeHistorySessions(sessionIds);
  }

  listQoderHistorySessions(): QoderHistorySession[] {
    return this.providerHistory.listQoderHistorySessions();
  }

  deleteQoderHistoryFiles(sessionIds: string[]): number {
    return this.providerHistory.deleteQoderHistoryFiles(sessionIds);
  }

  private captureCodexSessionId(record: SessionRecord, options?: { allowTimeWindowFallback?: boolean }): boolean {
    if (record.provider !== "codex" || record.claudeSessionId) {
      return false;
    }
    const discoveredThreadId = record.knownCodexSessionMtimes
      ? getLatestCodexSessionId({
          cwd: record.cwd,
          startedAt: record.startedAt,
          knownCodexSessionMtimes: record.knownCodexSessionMtimes,
        }, this.providerHistory.listCodexHistorySessions())
      : null;
    const fallbackThreadId = discoveredThreadId
      ? null
      : options?.allowTimeWindowFallback
        ? selectCodexSessionForTimeWindow(record, this.providerHistory.listCodexHistorySessions())?.claudeSessionId ?? null
        : null;
    const threadId = discoveredThreadId ?? fallbackThreadId;
    if (!threadId) {
      return false;
    }
    record.claudeSessionId = threadId;
    record.knownCodexSessionMtimes?.set(threadId, Date.now());
    this.providerHistory.invalidate("codex");
    process.stderr.write(`[wand] Captured Codex thread ID: ${threadId}\n`);
    return true;
  }

  private captureOpenCodeSessionId(record: SessionRecord, options?: { allowTimeWindowFallback?: boolean }): boolean {
    if (record.provider !== "opencode" || record.claudeSessionId) return false;
    const discovered = record.knownOpenCodeSessionMtimes
      ? selectOpenCodeSessionForRecord(record)
      : null;
    const fallback = discovered
      ? null
      : options?.allowTimeWindowFallback
        ? selectOpenCodeSessionForTimeWindow(record)
        : null;
    const providerSessionId = discovered?.id ?? fallback?.id ?? null;
    if (!providerSessionId) return false;
    record.claudeSessionId = providerSessionId;
    record.knownOpenCodeSessionMtimes?.set(providerSessionId, discovered?.updatedAtMs ?? fallback?.updatedAtMs ?? Date.now());
    process.stderr.write(`[wand] Captured OpenCode session ID: ${providerSessionId}\n`);
    return true;
  }

  private captureClaudeSessionId(record: SessionRecord, options?: { allowTimeWindowFallback?: boolean }): boolean {
    if (record.provider !== "claude" || record.claudeSessionId) {
      return false;
    }
    record.messages = snapshotMessages(record);
    const discoveredSessionId = record.knownClaudeProjectMtimes
      ? getLatestClaudeProjectSessionId({
          cwd: record.cwd,
          startedAt: record.startedAt,
          knownClaudeProjectMtimes: record.knownClaudeProjectMtimes,
          messages: record.messages,
        })
      : null;
    const fallbackSessionId = discoveredSessionId
      ? null
      : options?.allowTimeWindowFallback
        ? selectClaudeProjectSessionForTimeWindow(record)?.id ?? null
        : null;
    const sessionId = discoveredSessionId ?? fallbackSessionId;
    if (!sessionId) {
      return false;
    }
    record.claudeSessionId = sessionId;
    record.knownClaudeProjectMtimes?.set(sessionId, Date.now());
    this.providerHistory.invalidate("claude");
    process.stderr.write(`[wand] Captured Claude session ID: ${sessionId}\n`);
    return true;
  }

  get(id: string): SessionSnapshot | null {
    const record = this.sessions.get(id);
    if (!record) {
      return this.storage.getSession(id) ?? null;
    }
    const result = this.snapshot(record);
    if (!record.output && record.storedOutput) {
      result.output = record.storedOutput;
    }
    return result;
  }

  /** Return only a session owned by this manager, without the SQLite fallback used by get(). */
  getOwned(id: string): SessionSnapshot | null {
    const record = this.sessions.get(id);
    if (!record) return null;
    const result = this.snapshot(record);
    if (!record.output && record.storedOutput) result.output = record.storedOutput;
    return result;
  }

  getPtyTranscript(id: string): string | null {
    return this.logger.readPtyOutput(id);
  }

  /**
   * Set the Claude model for an existing PTY session. Persists the selection
   * and, when the session is live, pipes a `/model <id>` slash command into
   * the PTY so Claude Code switches on the fly.
   */
  setSessionModel(id: string, model: string | null): SessionSnapshot {
    const record = this.mustGet(id);
    const normalized = model?.trim() || null;
    record.selectedModel = normalized;
    if (record.provider === "claude" && record.status === "running" && record.ptyProcess) {
      const value = normalized && normalized !== "default" ? normalized : "default";
      record.ptyProcess.write(`/model ${value}\r`);
    }
    this.persist(record);
    this.emitEvent({ type: "status", sessionId: id, data: { selectedModel: normalized } });
    return this.snapshot(record);
  }

  /**
   * Set the thinking-effort level for a PTY session. Interactive Claude supports
   * this through /effort; off maps to auto, which restores the model default.
   */
  setSessionThinkingEffort(id: string, effort: SessionSnapshot["thinkingEffort"]): SessionSnapshot {
    const record = this.mustGet(id);
    const normalized = normalizeThinkingEffort(effort);
    record.thinkingEffort = normalized;
    if (record.provider === "claude" && record.status === "running" && record.ptyProcess) {
      record.ptyProcess.write(`/effort ${thinkingEffortToClaudeSlashEffort(normalized)}\r`);
    }
    this.persist(record);
    this.emitEvent({ type: "status", sessionId: id, data: { thinkingEffort: normalized } });
    return this.snapshot(record);
  }

  /**
   * Switch the execution mode of a PTY session mid-flight. The already-launched
   * provider process keeps its original CLI flags, but wand's own permission
   * auto-approval (shouldAutoApprovePermissions / escalation handling) reads
   * record.mode, so this changes the permission posture for subsequent prompts.
   * Mirrors setSessionModel/setSessionThinkingEffort.
   */
  setSessionMode(id: string, mode: ExecutionMode): SessionSnapshot {
    const record = this.mustGet(id);
    record.mode = mode;
    record.autoApprovePermissions = this.shouldAutoApprovePermissions(
      record.command,
      mode,
      record.provider ?? "claude",
    );
    if (record.ptyBridge) {
      record.ptyBridge.setAutoApprove(record.autoApprovePermissions);
    }
    this.persist(record);
    this.emitEvent({
      type: "status",
      sessionId: id,
      data: { mode, autoApprovePermissions: record.autoApprovePermissions },
    });
    return this.snapshot(record);
  }

  sendInput(id: string, input: string, view?: "chat" | "terminal", shortcutKey?: string): SessionSnapshot {
    if (this.disposed) throw new Error("ProcessManager has been disposed.");
    const record = this.mustGet(id);

    if (record.status !== "running") {
      console.error(`[ProcessManager] Rejecting input: session ${id} not running (${record.status})`);
      throw new SessionInputError("Session is not running.", "SESSION_NOT_RUNNING", id, record.status);
    }

    // Update lifecycle

    if (!record.ptyProcess) {
      console.error(`[ProcessManager] Rejecting input: session ${id} has no PTY`);
      throw new SessionInputError("Session is not running.", "SESSION_NO_PTY", id, record.status);
    }
    if (view !== "terminal") this.maybeGenerateSessionTopic(id, input);

    // Log shortcut key interactions for auto-confirm and mode analysis
    if (shortcutKey) {
      const outputLines = record.output.split("\n");
      const tailLines = outputLines.slice(-15).join("\n");
      const ctx: ShortcutLogContext = {
        mode: record.mode,
        autoApprove: record.autoApprovePermissions,
        permissionBlocked: this.isPermissionBlocked(record),
        input,
      };
      this.logger.appendShortcutLog(id, shortcutKey, tailLines, ctx);
    }

    // Track user input via bridge for Chat mode
    if (record.ptyBridge) {
      record.ptyBridge.onUserInput(input);
    }

    record.ptyProcess.write(input);
    this.persist(record);
    return this.snapshot(record);
  }

  resize(id: string, cols: number, rows: number): SessionSnapshot {
    const record = this.mustGet(id);
    if (!record.ptyProcess || record.status !== "running") {
      return this.snapshot(record);
    }

    const safeCols = clampDimension(cols, 20, 256);
    const safeRows = clampDimension(rows, 10, 160);
    const changed = safeCols !== record.ptyCols || safeRows !== record.ptyRows;
    record.ptyProcess.resize(safeCols, safeRows);
    record.ptyCols = safeCols;
    record.ptyRows = safeRows;
    if (changed) {
      // Notify every subscribed client of the new authoritative dimensions so
      // any other tab/device can re-fit its terminal instead of rendering
      // wrap-broken output sized for someone else's viewport.
      this.emitEvent({
        type: "status",
        sessionId: id,
        data: { ptyCols: safeCols, ptyRows: safeRows },
      });
    }
    return this.snapshot(record);
  }

  stop(id: string): SessionSnapshot {
    const record = this.mustGet(id);
    if (record.status !== "running") {
      return this.snapshot(record);
    }

    if (record.claudeTaskDiscoveryTimer) {
      clearTimeout(record.claudeTaskDiscoveryTimer);
      record.claudeTaskDiscoveryTimer = null;
    }
    if (record.codexSessionDiscoveryTimer) {
      clearTimeout(record.codexSessionDiscoveryTimer);
      record.codexSessionDiscoveryTimer = null;
    }
    if (record.openCodeSessionDiscoveryTimer) {
      clearTimeout(record.openCodeSessionDiscoveryTimer);
      record.openCodeSessionDiscoveryTimer = null;
    }
    if (record.initialInputTimer) {
      clearTimeout(record.initialInputTimer);
      record.initialInputTimer = null;
    }

    record.stopRequested = true;
    // Kill any running child process (from JSON chat turns)
    if (record.childProcess) {
      record.childProcess.kill();
      record.childProcess = null;
    }
    // Kill the PTY process
    if (record.ptyProcess) {
      record.ptyProcess.kill();
    }

    // Immediately update status and clear PTY references so the session no longer
    // appears "running" and subsequent sendInput() calls are rejected cleanly.
    // Clearing the handle also makes a later onExit callback stale; stop() owns
    // the terminal state transition and persistence from this point onward.
    record.status = "stopped";
    record.exitCode = null;
    record.endedAt = new Date().toISOString();
    record.ptyProcess = null;
    // Update lifecycle before dropping the bridge so Claude project-session
    // discovery can still inspect the latest parsed turns.
    this.captureClaudeSessionId(record, { allowTimeWindowFallback: true });
    this.captureCodexSessionId(record, { allowTimeWindowFallback: true });
    this.captureOpenCodeSessionId(record, { allowTimeWindowFallback: true });
    if (record.ptyBridge) {
      record.messages = record.ptyBridge.getMessages();
      record.ptyBridge.removeAllListeners();
      record.ptyBridge = null;
    }

    this.flushPersist(record, true);
    return this.snapshot(record);
  }

  private cleanupRecord(record: SessionRecord): void {
    if (record.claudeTaskDiscoveryTimer) {
      clearTimeout(record.claudeTaskDiscoveryTimer);
      record.claudeTaskDiscoveryTimer = null;
    }
    if (record.codexSessionDiscoveryTimer) {
      clearTimeout(record.codexSessionDiscoveryTimer);
      record.codexSessionDiscoveryTimer = null;
    }
    if (record.openCodeSessionDiscoveryTimer) {
      clearTimeout(record.openCodeSessionDiscoveryTimer);
      record.openCodeSessionDiscoveryTimer = null;
    }
    if (record.initialInputTimer) {
      clearTimeout(record.initialInputTimer);
      record.initialInputTimer = null;
    }
    const pendingPersist = this.persistDebounceTimers.get(record.id);
    if (pendingPersist) {
      clearTimeout(pendingPersist);
      this.persistDebounceTimers.delete(record.id);
    }
    if (record.status === "running") {
      record.stopRequested = true;
      if (record.childProcess) {
        const child = record.childProcess;
        record.childProcess = null;
        child.kill();
      }
      if (record.ptyProcess) {
        const ptyProcess = record.ptyProcess;
        record.ptyProcess = null;
        ptyProcess.kill();
      }
    }
    if (record.ptyBridge) {
      record.ptyBridge.removeAllListeners();
      record.ptyBridge = null;
    }
  }

  delete(id: string): void {
    const record = this.mustGet(id);

    // Always clear pending timers
    if (record.claudeTaskDiscoveryTimer) {
      clearTimeout(record.claudeTaskDiscoveryTimer);
      record.claudeTaskDiscoveryTimer = null;
    }
    if (record.codexSessionDiscoveryTimer) {
      clearTimeout(record.codexSessionDiscoveryTimer);
      record.codexSessionDiscoveryTimer = null;
    }
    if (record.openCodeSessionDiscoveryTimer) {
      clearTimeout(record.openCodeSessionDiscoveryTimer);
      record.openCodeSessionDiscoveryTimer = null;
    }
    if (record.initialInputTimer) {
      clearTimeout(record.initialInputTimer);
      record.initialInputTimer = null;
    }
    const pendingPersist = this.persistDebounceTimers.get(id);
    if (pendingPersist) {
      clearTimeout(pendingPersist);
      this.persistDebounceTimers.delete(id);
    }

    // Kill live processes if still running
    if (record.status === "running") {
      try {
        record.stopRequested = true;
        // For native mode, kill the child process
        if ((record.mode === "native" || record.mode === "managed") && record.childProcess) {
          record.childProcess.kill();
        }
        // For PTY mode, kill the pty process
        if (record.ptyProcess) {
          record.ptyProcess.kill();
        }
      } catch {
        // Ignore and continue deleting persisted state.
      }
    }

    // Always clean up all state references, regardless of current status
    record.childProcess = null;
    record.ptyProcess = null;
    if (record.ptyBridge) {
      record.ptyBridge.removeAllListeners();
      record.ptyBridge = null;
    }

    // Delete from persistent storage BEFORE removing from in-memory map,
    // so a storage failure doesn't leave orphan records in the database.
    this.storage.deleteSession(id);
    this.logger.deleteSession(id);
    if (record.provider === "claude") {
      this.deleteClaudeCache(record);
    }
    this.sessions.delete(id);
    this.lastPersistedMessageState.delete(id);
    this.dirtySessions.delete(id);
    if (record.claudeSessionId) {
      if (record.provider === "codex") {
        this.providerHistory.invalidate("codex");
      } else {
        this.providerHistory.invalidate("claude");
      }
    }
  }

  private deleteClaudeCache(record: Pick<SessionRecord, "claudeSessionId" | "cwd">): void {
    if (!record.claudeSessionId) return;
    const id = record.claudeSessionId;

    // 1. Delete the project JSONL file
    const jsonlPath = path.join(getClaudeProjectDir(record.cwd), `${id}.jsonl`);
    try {
      if (existsSync(jsonlPath)) unlinkSync(jsonlPath);
    } catch {
      // Non-critical — best-effort
    }

    // 2. Delete related directories under ~/.claude/
    const claudeHome = path.join(os.homedir(), ".claude");
    for (const sub of ["session-env", "tasks", "todos"]) {
      const dir = path.join(claudeHome, sub, id);
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      } catch {
        // Non-critical — best-effort
      }
    }
  }

  runStartupCommands(): SessionSnapshot[] {
    return this.config.startupCommands.map((command) =>
      this.start(command, this.config.defaultCwd, this.config.defaultMode, undefined, { sessionSource: "startup" })
    );
  }

  private snapshot(record: SessionRecord): SessionSnapshot {
    // Get messages from bridge if available, otherwise use stored messages
    const messages = record.ptyBridge?.getMessages() ?? record.messages;
    return {
      id: record.id,
      sessionKind: "pty",
      sessionSource: record.sessionSource ?? "interactive",
      automationId: record.automationId,
      provider: record.provider,
      runner: "pty",
      command: record.command,
      cwd: record.cwd,
      mode: record.mode,
      worktreeEnabled: record.worktreeEnabled ?? false,
      worktree: record.worktree ?? null,
      worktreeMergeStatus: record.worktreeMergeStatus,
      worktreeMergeInfo: record.worktreeMergeInfo ?? null,
      autonomyPolicy: record.autonomyPolicy,
      approvalPolicy: record.approvalPolicy,
      allowedScopes: record.allowedScopes,
      status: record.status,
      exitCode: record.exitCode,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      output: record.output,
      archived: record.archived,
      archivedAt: record.archivedAt,
      permissionBlocked: this.isPermissionBlocked(record),
      pendingEscalation: record.pendingEscalation || undefined,
      lastEscalationResult: record.lastEscalationResult || undefined,
      claudeSessionId: record.claudeSessionId || null,
      messages: messages.length > 0 ? messages : undefined,
      resumedFromSessionId: record.resumedFromSessionId ?? undefined,
      autoRecovered: record.autoRecovered ?? false,
      // `false` is an intentional user setting and must survive metadata
      // persistence/restarts; truthiness would silently drop it.
      autoApprovePermissions: record.autoApprovePermissions,
      approvalStats: record.approvalStats.total > 0 ? record.approvalStats : undefined,
      currentTaskTitle: record.currentTaskTitle,
      summary: record.description ?? record.summary ?? deriveSessionSummary(messages),
      title: record.title,
      description: record.description,
      selectedModel: record.selectedModel ?? null,
      thinkingEffort: record.thinkingEffort ?? null,
      ptyCols: record.ptyCols,
      ptyRows: record.ptyRows,
    };
  }

  /** Lightweight snapshot for list views — omits output and messages. */
  private snapshotSlim(record: SessionRecord): SessionSnapshot {
    const snapshot = this.snapshot(record);
    return {
      ...snapshot,
      output: "",
      messages: undefined,
    };
  }

  private isPermissionBlocked(record: SessionRecord): boolean {
    return record.ptyPermissionBlocked || record.pendingEscalation !== null;
  }

  setSessionTopic(id: string, title: string, description: string): SessionSnapshot {
    const record = this.mustGet(id);
    record.title = title;
    record.description = description;
    const snapshot = this.snapshot(record);
    this.storage.updateSessionRuntimeMetadata({ ...snapshot, titleGenerating: undefined });
    this.emitEvent({ type: "output", sessionId: id, data: { title, description, summary: description } });
    return snapshot;
  }

  private setSessionTopicGenerating(id: string, titleGenerating: boolean): void {
    const record = this.sessions.get(id);
    if (!record || record.titleGenerating === titleGenerating) return;
    record.titleGenerating = titleGenerating;
    this.emitEvent({ type: "output", sessionId: id, data: { titleGenerating } });
  }

  /**
   * Persist worktree merge progress through the manager that owns the live
   * session record. Returning null lets callers fall back to another owner (or
   * directly to storage for a row that is not currently loaded by a manager).
   */
  setWorktreeMergeState(
    id: string,
    status: SessionSnapshot["worktreeMergeStatus"],
    info: SessionSnapshot["worktreeMergeInfo"],
  ): SessionSnapshot | null {
    const record = this.sessions.get(id);
    if (!record) return null;
    record.worktreeMergeStatus = status;
    record.worktreeMergeInfo = info ?? null;
    const snapshot = this.snapshot(record);
    this.storage.updateSessionRuntimeMetadata(snapshot);
    this.emitEvent({
      type: "status",
      sessionId: id,
      data: {
        sessionKind: "pty",
        worktreeMergeStatus: status,
        worktreeMergeInfo: snapshot.worktreeMergeInfo,
      },
    });
    return snapshot;
  }

  private maybeGenerateSessionTopic(id: string, input: string): void {
    const prompt = input.trim();
    const record = this.sessions.get(id);
    if (this.disposed || !prompt || !record) return;
    this.topicCoordinator.request(id, {
      messages: snapshotMessages(record),
      input: prompt,
      cwd: record.cwd,
      language: this.config.language,
      ai: resolveSystemAiContext(record, this.config),
      onGenerating: (generating) => {
        if (!this.disposed) this.setSessionTopicGenerating(id, generating);
      },
      onTopic: ({ title, description }) => {
        if (!this.disposed && this.sessions.has(id)) this.setSessionTopic(id, title, description);
      },
      onError: (error) => {
        console.error(`[ProcessManager] Failed to generate session topic ${id}:`, getErrorMessage(error));
      },
    });
  }

  private defaultAutonomyPolicy(mode: ExecutionMode): AutonomyPolicy {
    if (mode === "agent" || mode === "agent-max" || mode === "managed" || mode === "native" || mode === "full-access") {
      return "agent";
    }
    return "assist";
  }

  resolveEscalation(id: string, requestId: string, resolution?: PermissionResolution): SessionSnapshot {
    return this.resolvePermission(id, resolution ?? "approve_once", requestId);
  }

  approvePermission(id: string): SessionSnapshot {
    return this.resolvePermission(id, "approve_once");
  }

  denyPermission(id: string): SessionSnapshot {
    return this.resolvePermission(id, "deny");
  }

  toggleAutoApprove(id: string): SessionSnapshot {
    const record = this.mustGet(id);
    record.autoApprovePermissions = !record.autoApprovePermissions;
    if (record.ptyBridge) {
      record.ptyBridge.setAutoApprove(record.autoApprovePermissions);
    }
    this.persist(record);
    return this.snapshot(record);
  }

  /**
   * Canonical permission resolution method.
   * All other permission methods delegate to this.
   * @param resolution - "approve_once", "approve_turn", or "deny"
   * @param requestId - Optional escalation request ID for validation
   */
  resolvePermission(id: string, resolution: PermissionResolution, requestId?: string): SessionSnapshot {
    const record = this.mustGet(id);

    if (resolution !== "approve_once" && resolution !== "approve_turn" && resolution !== "deny") {
      throw new Error("Invalid permission resolution.");
    }

    // A permission response is only meaningful for the currently pending
    // prompt. In particular, never turn a stale/missing escalation request into
    // an unconditional Enter key sent to the live provider process.
    const pendingEscalation = record.pendingEscalation;
    if (!pendingEscalation) {
      throw new Error("Escalation request not found.");
    }
    if (requestId !== undefined && pendingEscalation.requestId !== requestId) {
      throw new Error("Escalation request not found.");
    }

    // Record escalation result for audit trail
    record.lastEscalationResult = {
      requestId: pendingEscalation.requestId,
      resolution,
      reason: pendingEscalation.reason,
    };

    // Handle "approve_turn" memory — only in ProcessManager for non-bridge sessions
    if (resolution === "approve_turn" && !record.ptyBridge) {
      record.rememberedEscalationScopes.add(pendingEscalation.scope);
      if (pendingEscalation.target) {
        record.rememberedEscalationTargets.add(pendingEscalation.target);
      }
    }

    // Resolve via bridge or direct PTY write
    if (record.ptyBridge) {
      record.ptyBridge.resolvePermission(resolution);
    } else if (record.ptyProcess && record.status === "running") {
      record.ptyProcess.write(resolution === "deny" ? "n\r" : "\r");
    }

    record.ptyPermissionBlocked = false;
    record.pendingEscalation = null;
    this.persist(record);
    return this.snapshot(record);
  }

  private persist(
    record: SessionRecord,
    options: {
      forceFullSave?: boolean;
      metadataDirty?: boolean;
      outputDirty?: boolean;
      messagesDirty?: boolean;
    } = {},
  ): void {
    this.markDirty(record.id, {
      metadata: options.metadataDirty ?? true,
      output: options.outputDirty,
      messages: options.messagesDirty,
    });
    // Update messages from bridge before persisting
    const messages = record.ptyBridge?.getMessages() ?? record.messages;
    if (messages !== record.messages) {
      record.messages = messages;
    }
    const snapshot = this.snapshot(record);
    const dirty = this.dirtySessions.get(record.id)!;
    if (shouldPersistMessages(this.lastPersistedMessageState.get(record.id), messages)) {
      dirty.messages = true;
    }
    const shouldSaveMessages = options.forceFullSave === true || dirty.messages;
    const shouldSaveMetadata = options.forceFullSave === true || dirty.metadata;

    if (options.forceFullSave === true) {
      this.storage.saveSession(snapshot);
    } else {
      if (dirty.metadata) this.storage.updateSessionRuntimeMetadata(snapshot);
      if (dirty.messages) {
        this.storage.checkpointSessionMessages(
          record.id,
          messages,
          snapshot.structuredState,
          dirty.output ? snapshot.output : undefined,
        );
        dirty.output = false;
      } else if (dirty.output) {
        this.storage.checkpointSessionOutput(record.id, snapshot.output);
      }
    }
    if (shouldSaveMessages) this.lastPersistedMessageState.set(record.id, getPersistedMessageState(messages));
    this.dirtySessions.delete(record.id);

    if (shouldSaveMetadata) {
      this.logger.saveMetadata(record.id, {
        id: record.id,
        command: record.command,
        status: record.status,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        claudeSessionId: record.claudeSessionId,
        resumedFromSessionId: record.resumedFromSessionId ?? null,
        autoRecovered: record.autoRecovered ?? false,
      });
    }
    if (shouldSaveMessages) {
      this.logger.saveMessages(record.id, messages);
    }
  }

  private markDirty(sessionId: string, next: Partial<SessionDirtyState>): SessionDirtyState {
    const dirty = this.dirtySessions.get(sessionId) ?? { metadata: false, output: false, messages: false };
    if (next.metadata) dirty.metadata = true;
    if (next.output) dirty.output = true;
    if (next.messages) dirty.messages = true;
    this.dirtySessions.set(sessionId, dirty);
    return dirty;
  }

  /**
   * Schedule a debounced persist call for the given record.
   * Multiple calls within the debounce window are coalesced into a single write.
   * Use this in hot paths (e.g. onData) to reduce I/O pressure.
   */
  private schedulePersist(record: SessionRecord): void {
    if (this.disposed) return;
    this.markDirty(record.id, { output: true });
    const existing = this.persistDebounceTimers.get(record.id);
    // This is a throttle window, not a quiet-period debounce: continuous PTY
    // output still reaches SQLite at least once per second.
    if (existing) return;
    const timer = setTimeout(() => {
      this.persistDebounceTimers.delete(record.id);
      if (this.disposed) return;
      this.persist(record, { metadataDirty: false });
    }, 1000);
    timer.unref?.();
    this.persistDebounceTimers.set(record.id, timer);
  }

  /**
   * Immediately persist any pending debounced write and clear the timer.
   * Use this at critical points (exit, stop, delete) to ensure no data loss.
   */
  private flushPersist(record: SessionRecord, forceFullSave = false): void {
    const existing = this.persistDebounceTimers.get(record.id);
    if (existing) {
      clearTimeout(existing);
      this.persistDebounceTimers.delete(record.id);
    }
    this.persist(record, {
      forceFullSave,
      metadataDirty: true,
      outputDirty: true,
      messagesDirty: forceFullSave,
    });
  }

  private archiveExpiredSessions(): void {
    const now = Date.now();
    for (const record of this.sessions.values()) {
      if (record.archived || record.status === "running") {
        continue;
      }
      const referenceTime = record.endedAt ?? record.startedAt;
      const endedAtMs = Date.parse(referenceTime);
      if (!Number.isFinite(endedAtMs) || now - endedAtMs < ARCHIVE_AFTER_MS) {
        continue;
      }
      record.archived = true;
      record.archivedAt = new Date(now).toISOString();
      this.persist(record);
    }
  }
  private assertCommandAllowed(command: string): void {
    if (!isCommandAllowedByPrefixes(command, this.config.allowedCommandPrefixes)) {
      throw new Error("Command is not allowed by current configuration.");
    }
  }

  /**
   * @deprecated Only retained for non-Claude-CLI sessions without ptyBridge.
   * For Claude CLI sessions, auto-approval is handled by ClaudePtyBridge.detectPermission().
   */
  private autoConfirmWithRecord(record: SessionRecord, output: string, ptyProcess: IPty): void {
    if (!record.autoApprovePermissions) {
      return;
    }
    record.confirmWindow = appendWindow(record.confirmWindow, output, CONFIRM_WINDOW_SIZE);
    const normalized = normalizePromptText(record.confirmWindow);
    const now = Date.now();

    const trustFolderPrompt =
      /\byes,\s*i\s*trust\s*this\s*folder\b/i.test(normalized) &&
      /\benter to confirm\b/i.test(normalized);

    const claudeConfirmPrompt =
      /\bdo you want to\b/i.test(normalized) &&
      (hasExplicitConfirmSyntax(normalized) || hasPermissionActionContext(normalized));

    // Check for Claude's tool permission prompt patterns
    const toolPermissionPrompt =
      /\bdo you want to\b/i.test(normalized) &&
      /\(yes\b/i.test(normalized);

    // Reduced cooldown for faster response
    if (now - record.lastAutoConfirmAt < 500) {
      return;
    }

    const shouldConfirm = trustFolderPrompt
      || claudeConfirmPrompt
      || toolPermissionPrompt
      || (hasExplicitConfirmSyntax(normalized)
        && hasPermissionActionContext(normalized));

    if (shouldConfirm) {
      record.lastAutoConfirmAt = now;
      // Always auto-confirm by sending Enter directly
      ptyProcess.write("\r");
    }
  }

  /**
   * Handle events from ClaudePtyBridge
   */
  private handleBridgeEvent(record: SessionRecord, event: SessionEvent): void {
    switch (event.type) {
      case "output.raw": {
        record.output = record.ptyBridge?.getRawOutput() ?? record.output;
        this.emitEvent({
          type: "output",
          sessionId: event.sessionId,
          data: {
            incremental: true,
            chunk: (event.data as { chunk: string }).chunk,
            permissionBlocked: this.isPermissionBlocked(record),
          },
        });
        break;
      }

      case "output.chat": {
        record.output = record.ptyBridge?.getRawOutput() ?? record.output;
        const rawMessages = record.ptyBridge?.getMessages() ?? [];
        const isStreaming = record.status === "running";
        const bridgeData = event.data as ChatOutputData | undefined;

        const data: Record<string, unknown> = {
          permissionBlocked: this.isPermissionBlocked(record),
        };
        // 透传 bridge 给出的 isResponding（true=流式中, false=本轮已完成）。
        // 前端用它检测 thinking→idle 边界并主动做一次终端 resync，把 provider TUI
        // 在流式渲染过程中残留的错位光标定位序列洗掉（等价于按一次右上角缩放）。
        if (bridgeData && typeof bridgeData.isResponding === "boolean") {
          data.isResponding = bridgeData.isResponding;
        }

        if (isStreaming && rawMessages.length > 0) {
          data.incremental = true;
          const lastTurn = rawMessages[rawMessages.length - 1];
          const truncatedLast = truncateMessagesForTransport([lastTurn], this.config.cardDefaults ?? {}, 0);
          data.lastMessage = truncatedLast[0];
          data.messageCount = rawMessages.length;
        } else {
          data.output = record.output;
          data.messages = truncateMessagesForTransport(rawMessages, this.config.cardDefaults ?? {}, rawMessages.length - 1);
        }
        this.emitEvent({
          type: "output",
          sessionId: event.sessionId,
          data,
        });
        break;
      }

      case "permission.prompt": {
        const data = event.data as { prompt: string; scope: EscalationScope; target?: string };
        record.pendingEscalation = {
          requestId: `bridge-${Date.now()}`,
          scope: data.scope,
          runner: "pty",
          source: "tool_permission_request",
          target: data.target,
          reason: data.prompt,
        };
        record.ptyPermissionBlocked = true;
        this.markDirty(record.id, { metadata: true });
        // Emit status event with full permission details for UI
        this.emitEvent({
          type: "status",
          sessionId: event.sessionId,
          data: {
            permissionBlocked: true,
            permissionRequest: {
              scope: data.scope,
              target: data.target,
              prompt: data.prompt,
            },
          },
        });
        break;
      }

      case "permission.resolved": {
        // Increment approval stats before clearing pendingEscalation
        const resolvedScope = record.pendingEscalation?.scope;
        if (resolvedScope) {
          if (resolvedScope === "run_command" || resolvedScope === "dangerous_shell") {
            record.approvalStats.command++;
          } else if (resolvedScope === "write_file") {
            record.approvalStats.file++;
          } else {
            record.approvalStats.tool++;
          }
          record.approvalStats.total++;
        }
        record.pendingEscalation = null;
        record.ptyPermissionBlocked = false;
        this.markDirty(record.id, { metadata: true });
        this.emitEvent({
          type: "status",
          sessionId: event.sessionId,
          data: {
            permissionBlocked: false,
            approvalStats: record.approvalStats,
          },
        });
        // Log auto-approve events to shortcut-interactions.jsonl for analysis
        const resolvedData = event.data as Record<string, unknown> | undefined;
        if (resolvedData?.autoApproved) {
          const outputLines = record.output.split("\n");
          const tailLines = outputLines.slice(-8).join("\n");
          this.logger.appendShortcutLog(record.id, "auto_approve", tailLines, {
            mode: record.mode,
            scope: resolvedScope ?? "unknown",
            autoApprove: record.autoApprovePermissions,
            permissionBlocked: true,
            input: "\r",
            approveType: resolvedData.approveType as string | undefined,
            score: resolvedData.score as number | undefined,
            matched: resolvedData.matched as string[] | undefined,
            falsePositive: resolvedData.falsePositive as boolean | undefined,
          });
        }
        break;
      }

      case "session.id":
        // Claude session ID captured - already handled in onData
        break;

      case "chat.turn":
        // Turn completed - persist full messages snapshot
        record.messages = record.ptyBridge?.getMessages() ?? record.messages;
        // Clear remembered permissions at turn boundaries
        record.ptyBridge?.clearRememberedPermissions();
        record.rememberedEscalationScopes.clear();
        record.rememberedEscalationTargets.clear();
        this.persist(record, { metadataDirty: true, outputDirty: true, messagesDirty: true });
        break;

      case "ended":
        // Session ended - handled in onExit
        break;
    }
  }

  private mustGet(id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) {
      console.error("[ProcessManager] Session lookup failed", { sessionId: id });
      throw new SessionInputError("Session not found.", "SESSION_NOT_FOUND", id);
    }
    return record;
  }

  private buildShellArgs(command: string): string[] {
    if (os.platform() === "win32") {
      return ["/d", "/s", "/c", command];
    }
    // -l: login shell — sources ~/.bash_profile, ~/.profile, etc., ensuring PATH
    //      and other env vars set by profile files are available.
    // -c: run the following command.
    // Using -ic (interactive + command) skips login-shell initialization on many
    // platforms, which causes commands that depend on profile-set env vars to fail
    // immediately with "command not found" — a silent exit before onExit is ready.
    return ["-lc", command];
  }

  private shouldAutoApprovePermissions(command: string, mode: ExecutionMode, provider: SessionProvider): boolean {
    if (provider !== "claude") {
      return false;
    }

    if (!/^(?:claude|npx\s+claude|[^\s]+\/claude)(?:\s|$)/.test(command)) {
      return false;
    }

    if (isRunningAsRoot()) {
      return true;
    }

    if (mode === "full-access" || mode === "auto-edit") {
      return true;
    }

    if (mode === "managed" || mode === "native") {
      return true;
    }

    return false;
  }

  private processCommandForMode(
    command: string,
    mode: ExecutionMode,
    provider: SessionProvider,
    model?: string,
    thinkingEffort?: SessionSnapshot["thinkingEffort"],
  ): string {
    if (provider === "codex") {
      let result = command;
      const trimmedModel = model?.trim();
      if (trimmedModel && trimmedModel !== "default" && !/--model\s/.test(command) && !/-m\s/.test(command)) {
        const escapedModel = trimmedModel.replace(/'/g, "'\\''");
        result += ` --model '${escapedModel}'`;
      }
      const reasoningEffort = thinkingEffortToCodexReasoningEffort(thinkingEffort ?? null);
      if (reasoningEffort && !/model_reasoning_effort\s*=/.test(command)) {
        result += ` -c 'model_reasoning_effort="${reasoningEffort}"'`;
      }
      if (mode === "full-access") {
        if (!/--dangerously-bypass-approvals-and-sandbox(?:\s|$)/.test(result)) {
          result += " --dangerously-bypass-approvals-and-sandbox";
        }
      }
      return result;
    }

    if (provider === "opencode") {
      let result = command;
      const trimmedModel = model?.trim();
      if (trimmedModel && trimmedModel !== "default" && !/--model(?:\s|=)/.test(result) && !/(?:^|\s)-m(?:\s|$)/.test(result)) {
        const escapedModel = trimmedModel.replace(/'/g, "'\\''");
        result += ` --model '${escapedModel}'`;
      }
      const variant = thinkingEffortToOpenCodeVariant(thinkingEffort ?? null);
      if (variant && !/--variant(?:\s|=)/.test(result)) {
        result += ` --variant '${variant.replace(/'/g, "'\\''")}'`;
      }
      if ((mode === "managed" || mode === "full-access" || mode === "auto-edit") && !/--auto(?:\s|$)/.test(result)) {
        result += " --auto";
      }
      return result;
    }

    if (provider === "grok") {
      let result = command;
      const trimmedModel = model?.trim();
      if (trimmedModel && trimmedModel !== "default" && !/--model(?:\s|=)/.test(result) && !/(?:^|\s)-m(?:\s|$)/.test(result)) {
        result += ` --model '${trimmedModel.replace(/'/g, "'\\''")}'`;
      }
      const effort = thinkingEffortToOpenCodeVariant(thinkingEffort ?? null);
      if (effort && !/--(?:reasoning-)?effort(?:\s|=)/.test(result)) {
        result += ` --effort '${effort.replace(/'/g, "'\\''")}'`;
      }
      if ((mode === "managed" || mode === "full-access" || mode === "auto-edit") && !/--(?:always-approve|yolo)(?:\s|$)/.test(result)) {
        result += " --always-approve";
      }
      return result;
    }

    if (provider === "qoder") {
      let result = command;
      const trimmedModel = model?.trim();
      if (trimmedModel && trimmedModel !== "default" && !/--model(?:\s|=)/.test(result)) {
        result += ` --model '${trimmedModel.replace(/'/g, "'\\''")}'`;
      }
      if ((mode === "managed" || mode === "full-access") && !/--(?:yolo|dangerously-skip-permissions|permission-mode)(?:\s|=|$)/.test(result)) {
        result += " --permission-mode bypass_permissions";
      } else if (mode === "auto-edit" && !/--permission-mode(?:\s|=)/.test(result)) {
        result += " --permission-mode accept_edits";
      }
      return result;
    }

    const isClaudeCmd = /^(?:claude|npx\s+claude|[^\s]+\/claude)(?:\s|$)/.test(command);
    if (!isClaudeCmd) return command;

    let result = command;

    const trimmedModel = model?.trim();
    if (trimmedModel && trimmedModel !== "default" && !/--model\s/.test(command)) {
      const escapedModel = trimmedModel.replace(/'/g, "'\\''");
      result += ` --model '${escapedModel}'`;
    }

    const claudeEffort = thinkingEffortToClaudeCliEffort(thinkingEffort ?? null);
    if (claudeEffort && !/--effort(?:\s|=|$)/.test(command)) {
      result += ` --effort ${claudeEffort}`;
    }

    const hasPermFlag = /--permission-mode\s/.test(command);

    if (!hasPermFlag) {
      if (isRunningAsRoot()) {
        if (mode === "managed" || mode === "full-access" || mode === "auto-edit") {
          result += " --permission-mode acceptEdits";
          result += " --allowedTools Bash Edit Write Read Glob Grep NotebookEdit WebFetch WebSearch";
        }
      } else {
        if (mode === "full-access" || mode === "managed") {
          result += " --permission-mode bypassPermissions";
        } else if (mode === "auto-edit") {
          result += " --permission-mode acceptEdits";
        }
      }
    }

    const language = this.config.language?.trim();
    const isChinese = language === "中文";

    if (mode === "managed") {
      const autonomousPrompt = buildManagedAutonomyDirective(isChinese);
      const escaped = autonomousPrompt.replace(/'/g, "'\\''");
      result += ` --append-system-prompt '${escaped}'`;
    }

    if (language) {
      // 与 structured-session-manager.ts 走同一个 buildLanguageDirective，保证 PTY 与
      // structured 两种 runner 用同一条强约束指令——避免"换个模式 Claude 又开始夹英文"。
      const langPrompt = buildLanguageDirective(language);
      if (langPrompt) {
        const escaped = langPrompt.replace(/'/g, "'\\''");
        result += ` --append-system-prompt '${escaped}'`;
      }
    }

    return result;
  }
}

function clampDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
