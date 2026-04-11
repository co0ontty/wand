import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { ChildProcess } from "node:child_process";
import { existsSync, unlinkSync, rmSync, openSync, readSync, closeSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";

import pty, { IPty } from "node-pty";
import { WandStorage } from "./storage.js";
import { SessionLogger, ShortcutLogContext } from "./session-logger.js";
import { ApprovalPolicy, AutonomyPolicy, ConversationTurn, EscalationRequest, EscalationScope, ExecutionMode, ProcessEvent, ProcessEventHandler, SessionEvent, SessionProvider, SessionSnapshot, WandConfig } from "./types.js";
import { SessionLifecycleManager } from "./session-lifecycle.js";
import { ClaudePtyBridge } from "./claude-pty-bridge.js";
import { appendWindow, hasExplicitConfirmSyntax, hasPermissionActionContext, normalizePromptText } from "./pty-text-utils.js";
import { prepareSessionWorktree } from "./git-worktree.js";
import {
  getResumeCommandSessionId,
  hasRealConversationMessages,
} from "./resume-policy.js";

function resolveProviderFromCommand(command: string): SessionProvider {
  return /^codex\b/.test(command.trim()) ? "codex" : "claude";
}

function isRunningAsRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

export type { ProcessEvent, ProcessEventHandler } from "./types.js";

/** Human-readable task information for the UI */
export interface TaskInfo {
  title: string;
  tool?: string;
}

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


/** A Claude Code session discovered by scanning ~/.claude/projects/ directories. */
export interface ClaudeHistorySession {
  claudeSessionId: string;
  projectDir: string;
  cwd: string;
  firstUserMessage: string;
  timestamp: string;
  mtimeMs: number;
  hasConversation: boolean;
  managedByWand: boolean;
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
  /** Current task title displayed in the UI (derived from tool_use blocks) */
  currentTask: TaskInfo | null;
  /** Debounce timer for task events */
  taskDebounceTimer: NodeJS.Timeout | null;
  /** Last emitted task title to avoid duplicate events */
  lastEmittedTask: string | null;
  /** Claude task ids visible before this session started */
  knownClaudeTaskIds?: Set<string>;
  /** Retry timer for discovering the real Claude resumable task id */
  claudeTaskDiscoveryTimer?: NodeJS.Timeout | null;
  /** Timer for delayed initial input delivery */
  initialInputTimer?: NodeJS.Timeout | null;
  /** Claude project jsonl mtimes visible before this session started */
  knownClaudeProjectMtimes?: Map<string, number>;
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
}

interface ResumeEligibility {
  hasClaudeSessionId: boolean;
  hasRealConversation: boolean;
  eligible: boolean;
}

interface PersistedMessageState {
  count: number;
  signature: string;
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

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as {
          sessionId?: string;
          type?: string;
          message?: {
            role?: string;
          };
        };
        if (parsed.sessionId) {
          fileSessionIds.add(parsed.sessionId);
        }
        if (parsed.type === "user" || parsed.message?.role === "user") {
          hasUser = true;
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
      hasConversation: hasUser && hasAssistant && lines.length >= REAL_CONVERSATION_MIN_LINES
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

function hasRecentProjectActivity(candidate: ClaudeProjectSessionCandidate, startedAt: string): boolean {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return true;
  }
  return candidate.mtimeMs >= startedAtMs - START_TIME_SKEW_MS
    && candidate.mtimeMs <= Date.now() + DISCOVERY_RECENT_WINDOW_MS;
}

function selectClaudeProjectSessionForRecord(record: Pick<SessionRecord, "cwd" | "startedAt" | "knownClaudeProjectMtimes" | "messages">): ClaudeProjectSessionDetails | null {
  const knownMtimes = record.knownClaudeProjectMtimes ?? new Map<string, number>();
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

  return candidates[0] ?? null;
}

/**
 * Broader fallback: find a JSONL file by mtime proximity when strict
 * mtime-correlation fails (e.g., file existed before session but Claude
 * wrote conversation content during this session).
 * Looks for the most recently modified file that was active near the
 * session's start time and has real conversation content.
 */
function selectClaudeProjectSessionByProximity(record: Pick<SessionRecord, "cwd" | "startedAt" | "knownClaudeProjectMtimes" | "messages">): ClaudeProjectSessionDetails | null {
  const hasUserTurn = record.messages.some((turn) => turn.role === "user"
    && turn.content.some((block) => block.type === "text" && block.text.trim().length > 0));
  if (!hasUserTurn) {
    return null;
  }

  const startedAtMs = Date.parse(record.startedAt);
  const now = Date.now();
  // Look for files modified from ~60s before session start up to now
  const proximityWindowMs = 60 * 1000;

  const candidates = listClaudeProjectSessionCandidates(record.cwd)
    .filter((candidate) => {
      if (!Number.isFinite(startedAtMs)) return true;
      return candidate.mtimeMs >= startedAtMs - proximityWindowMs
        && candidate.mtimeMs <= now + DISCOVERY_RECENT_WINDOW_MS;
    })
    .map((candidate) => readClaudeProjectSessionDetails(candidate.filePath, candidate.id))
    .filter((candidate): candidate is ClaudeProjectSessionDetails => Boolean(candidate?.hasConversation))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates[0] ?? null;
}

function getResumeEligibility(record: Pick<SessionRecord, "claudeSessionId" | "messages">): ResumeEligibility {
  const hasClaudeSessionId = Boolean(record.claudeSessionId);
  const hasRealConversation = hasRealConversationMessages(record.messages);
  return {
    hasClaudeSessionId,
    hasRealConversation,
    eligible: hasClaudeSessionId && hasRealConversation
  };
}

function hasResumeEligibleConversation(record: Pick<SessionRecord, "claudeSessionId" | "messages">): boolean {
  return getResumeEligibility(record).eligible;
}

function getLatestClaudeProjectSessionId(record: Pick<SessionRecord, "cwd" | "startedAt" | "knownClaudeProjectMtimes" | "messages">): string | null {
  // Try strict mtime-correlation first, then fall back to mtime proximity
  return selectClaudeProjectSessionForRecord(record)?.id
    ?? selectClaudeProjectSessionByProximity(record)?.id
    ?? null;
}

function listRecentClaudeProjectSessionIds(cwd: string, startedAt: string): string[] {
  return listClaudeProjectSessionCandidates(cwd)
    .filter((candidate) => hasRecentProjectActivity(candidate, startedAt))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((candidate) => candidate.id);
}

function findRealClaudeProjectSessionId(cwd: string, startedAt: string): string | null {
  // Strict mtime-based discovery first
  const candidates = listRecentClaudeProjectSessionIds(cwd, startedAt)
    .map((id) => {
      const filePath = path.join(getClaudeProjectDir(cwd), `${id}.jsonl`);
      return readClaudeProjectSessionDetails(filePath, id);
    })
    .filter((candidate): candidate is ClaudeProjectSessionDetails => Boolean(candidate?.hasConversation))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length > 0) return candidates[0].id;

  // Fallback: broader proximity search for files with conversation content
  const startedAtMs = Date.parse(startedAt);
  const now = Date.now();
  const proximityWindowMs = 60 * 1000;
  const proximityCandidates = listClaudeProjectSessionCandidates(cwd)
    .filter((candidate) => {
      if (!Number.isFinite(startedAtMs)) return true;
      return candidate.mtimeMs >= startedAtMs - proximityWindowMs
        && candidate.mtimeMs <= now + DISCOVERY_RECENT_WINDOW_MS;
    })
    .map((candidate) => readClaudeProjectSessionDetails(candidate.filePath, candidate.id))
    .filter((candidate): candidate is ClaudeProjectSessionDetails => Boolean(candidate?.hasConversation))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return proximityCandidates[0]?.id ?? null;
}

function isClaudeSessionFileAvailable(cwd: string, claudeSessionId: string): boolean {
  const filePath = path.join(getClaudeProjectDir(cwd), `${claudeSessionId}.jsonl`);
  return Boolean(readClaudeProjectSessionDetails(filePath, claudeSessionId));
}

/**
 * Reverse the normalization done by getClaudeProjectDir.
 * "-vol1-1000-yolo-claude-wand" → "/vol1/1000/yolo-claude/wand"
 * This is lossy (real hyphens become slashes), so we try all possible
 * interpretations and validate with existsSync, falling back to naive replacement.
 */
function invertNormalizedProjectDir(dirName: string): string {
  // The normalization is: path.resolve(cwd).replace(/\//g, "-")
  const naive = dirName.replace(/-/g, "/");
  if (existsSync(naive)) return naive;

  // BFS: at each hyphen position, try "/" (path separator) or "-" (literal hyphen).
  // Prune candidates that don't exist as directories, but only if at least one
  // candidate survives pruning. Otherwise keep all to allow deeper merges.
  const parts = dirName.split("-").filter(Boolean);
  if (parts.length === 0 || parts.length > 20) return naive;

  let candidates = ["/" + parts[0]];

  for (let i = 1; i < parts.length; i++) {
    const next: string[] = [];
    for (const prefix of candidates) {
      next.push(prefix + "/" + parts[i]);
      next.push(prefix + "-" + parts[i]);
    }

    if (i < parts.length - 1) {
      // Prune non-existent prefixes, but keep all if none exist
      const valid = next.filter((c) => { try { return existsSync(c); } catch { return false; } });
      candidates = valid.length > 0 ? valid : next;
    } else {
      candidates = next;
    }

    if (candidates.length > 200) candidates = candidates.slice(0, 200);
  }

  // Return the first candidate that exists, or the first one, or naive
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0] || naive;
}

/** Read only the first ~8KB of a JSONL file to extract summary metadata. */
function readClaudeSessionSummary(filePath: string, id: string, cwd: string): ClaudeHistorySession | null {
  try {
    const stats = statSync(filePath);
    const fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(8192);
    const bytesRead = readSync(fd, buffer, 0, 8192, 0);
    closeSync(fd);
    const chunk = buffer.toString("utf8", 0, bytesRead);
    const lines = chunk.split("\n").filter((line) => line.trim().length > 0);

    let timestamp = "";
    let firstUserMessage = "";
    let hasUser = false;
    let hasAssistant = false;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as {
          sessionId?: string;
          type?: string;
          timestamp?: string;
          content?: string;
          message?: { role?: string; content?: unknown };
        };
        if (!timestamp && parsed.timestamp) {
          timestamp = parsed.timestamp;
        }
        if (parsed.type === "user" || parsed.message?.role === "user") {
          hasUser = true;
          if (!firstUserMessage) {
            if (typeof parsed.content === "string" && parsed.content.trim()) {
              firstUserMessage = parsed.content.trim().slice(0, 120);
            } else if (parsed.message?.content && typeof parsed.message.content === "string") {
              firstUserMessage = parsed.message.content.trim().slice(0, 120);
            }
          }
        }
        if (parsed.type === "assistant" || parsed.message?.role === "assistant") {
          hasAssistant = true;
        }
      } catch {
        continue;
      }
    }

    // cwd is passed in from the caller
    return {
      claudeSessionId: id,
      projectDir: path.basename(path.dirname(filePath)),
      cwd,
      firstUserMessage,
      timestamp: timestamp || new Date(stats.mtimeMs).toISOString(),
      mtimeMs: stats.mtimeMs,
      hasConversation: hasUser && hasAssistant,
      managedByWand: false,
    };
  } catch {
    return null;
  }
}

/** Scan all ~/.claude/projects/ directories for session JSONL files. */
function listAllClaudeHistorySessions(): ClaudeHistorySession[] {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  try {
    const projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());

    const results: ClaudeHistorySession[] = [];
    for (const dir of projectDirs) {
      const dirPath = path.join(projectsDir, dir.name);
      const cwd = invertNormalizedProjectDir(dir.name);
      try {
        const files = readdirSync(dirPath, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => entry.name.replace(/\.jsonl$/, ""))
          .filter((name) => UUID_V4_PATTERN.test(name));

        for (const sessionId of files) {
          const filePath = path.join(dirPath, `${sessionId}.jsonl`);
          const summary = readClaudeSessionSummary(filePath, sessionId, cwd);
          if (summary) {
            results.push(summary);
          }
        }
      } catch {
        continue;
      }
    }

    return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

function shouldAutoResumeSession(record: Pick<SessionRecord, "status" | "claudeSessionId" | "messages" | "archived" | "resumedToSessionId" | "ptyProcess">): boolean {
  return record.status === "exited"
    && !record.archived
    && !record.resumedToSessionId
    && record.ptyProcess === null
    && hasResumeEligibleConversation(record);
}

function shouldBackfillClaudeSessionId(record: Pick<SessionRecord, "status" | "claudeSessionId" | "command" | "messages">): boolean {
  return record.status === "exited"
    && !record.claudeSessionId
    && /^claude\b/.test(record.command.trim())
    && hasRealConversationMessages(record.messages);
}

function snapshotMessages(record: Pick<SessionRecord, "ptyBridge" | "messages">): ConversationTurn[] {
  return record.ptyBridge?.getMessages() ?? record.messages;
}

const MAX_SESSIONS = 200;
const ARCHIVE_AFTER_MS = 1000 * 60 * 60 * 24;
const CONFIRM_WINDOW_SIZE = 800;

// Claude 会话 ID 格式：UUID v4
const CLAUDE_SESSION_ID_PATTERN = /"session_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function listClaudeTaskIds(): string[] {
  const tasksDir = path.join(os.homedir(), ".claude", "tasks");
  try {
    return readdirSync(tasksDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && UUID_V4_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function getClaudeProjectDir(cwd: string): string {
  const normalized = path.resolve(cwd).replace(/\//g, "-");
  return path.join(os.homedir(), ".claude", "projects", normalized);
}


function getLatestClaudeTaskId(excludeIds: Set<string>): string | null {
  const tasksDir = path.join(os.homedir(), ".claude", "tasks");
  try {
    const candidates = readdirSync(tasksDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && UUID_V4_PATTERN.test(entry.name) && !excludeIds.has(entry.name))
      .map((entry) => {
        const fullPath = path.join(tasksDir, entry.name);
        const stats = statSync(fullPath);
        return { id: entry.name, mtimeMs: stats.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return candidates[0]?.id ?? null;
  } catch {
    return null;
  }
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

function deriveSessionSummary(messages: ConversationTurn[], currentTaskTitle: string | null): string | undefined {
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
  if (currentTaskTitle) return currentTaskTitle.slice(0, 120);
  return undefined;
}


export class ProcessManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly logger: SessionLogger;
  private readonly lifecycleManager: SessionLifecycleManager;
  /** Per-session debounce timers for throttled persist calls */
  private readonly persistDebounceTimers = new Map<string, NodeJS.Timeout>();
  /** Last persisted message state per session — used to skip redundant message writes */
  private readonly lastPersistedMessageState = new Map<string, PersistedMessageState>();

  constructor(
    private readonly config: WandConfig,
    private readonly storage: WandStorage,
    configDir?: string
  ) {
    super();
    this.logger = new SessionLogger(configDir || path.join(process.env.HOME || process.cwd(), ".wand"), config.shortcutLogMaxBytes);
    
    // Initialize lifecycle manager
    this.lifecycleManager = new SessionLifecycleManager({
      onStateChange: (sessionId, oldState, newState) => {
        this.emitEvent({ type: "status", sessionId, data: { oldState, newState } });
      },
      onIdle: (_sessionId) => {},
      onArchived: (sessionId, reason) => {
        console.error(`[ProcessManager] Session ${sessionId} archived: ${reason}`);
      },
    });
    for (const snapshot of this.storage.loadSessions()) {
      if ((snapshot.sessionKind ?? "pty") !== "pty") {
        continue;
      }
      const provider = snapshot.provider ?? resolveProviderFromCommand(snapshot.command);
      const isClaudeCmd = provider === "claude";
      const resumeCommandSessionId = isClaudeCmd ? getResumeCommandSessionId(snapshot.command) : null;
      // Sessions restored from storage have ptyProcess: null — the old server's PTY
      // belongs to a dead process. Mark running sessions as exited so the UI
      // reflects reality and users can start fresh sessions.
      if (snapshot.status === "running") {
        const recoveredMessages = recoverMessagesFromSnapshot(snapshot);
        const updated = {
          ...snapshot,
          status: "exited" as const,
          endedAt: new Date().toISOString(),
          messages: recoveredMessages.length > 0 ? recoveredMessages : snapshot.messages,
        };
        this.storage.saveSession(updated);
        this.sessions.set(snapshot.id, {
          ...updated,
          provider,
          processId: null,
          ptyProcess: null,
          stopRequested: false,
          confirmWindow: "",
          ptyPermissionBlocked: false,
          lastAutoConfirmAt: 0,
          autoApprovePermissions: this.shouldAutoApprovePermissions(snapshot.command, snapshot.mode, provider),
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
          currentTask: null,
          taskDebounceTimer: null,
          lastEmittedTask: null,
          knownClaudeTaskIds: undefined,
          claudeTaskDiscoveryTimer: null,
          knownClaudeProjectMtimes: isClaudeCmd ? listClaudeProjectSessionMtimes(updated.cwd) : undefined,
          claudeSessionId: resumeCommandSessionId ?? updated.claudeSessionId,
          approvalStats: { tool: 0, command: 0, file: 0, total: 0 }
        });
        this.lifecycleManager.register(snapshot.id, "idle");
        console.error(`[ProcessManager] Restored session ${snapshot.id} marked as exited (PTY orphaned)`);
      } else {
        this.sessions.set(snapshot.id, {
          ...snapshot,
          provider,
          processId: null,
          ptyProcess: null,
          stopRequested: false,
          confirmWindow: "",
          ptyPermissionBlocked: false,
          lastAutoConfirmAt: 0,
          autoApprovePermissions: this.shouldAutoApprovePermissions(snapshot.command, snapshot.mode, provider),
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
          currentTask: null,
          taskDebounceTimer: null,
          lastEmittedTask: null,
          knownClaudeTaskIds: undefined,
          claudeTaskDiscoveryTimer: null,
          knownClaudeProjectMtimes: isClaudeCmd ? listClaudeProjectSessionMtimes(snapshot.cwd) : undefined,
          claudeSessionId: resumeCommandSessionId ?? snapshot.claudeSessionId,
          approvalStats: { tool: 0, command: 0, file: 0, total: 0 }
        });
        this.lifecycleManager.register(snapshot.id, "archived");
      }
    }
    // Defer expensive file-system scanning and auto-recovery so the server
    // can start responding to requests immediately.
    setImmediate(() => {
      this.backfillExitedClaudeSessionIds();
      this.autoRecoverExitedSessions();
    });
    this.archiveExpiredSessions();
  }

  on(event: "process", listener: ProcessEventHandler): this {
    return super.on("process", listener);
  }

  private emitEvent(event: ProcessEvent): void {
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
        this.deleteClaudeCache(record);
      }
      this.sessions.delete(id);
      this.lastPersistedMessageState.delete(id);
      this.storage.deleteSession(id);
    }
  }

  start(command: string, cwd: string | undefined, mode: ExecutionMode, initialInput?: string, opts?: { resumedFromSessionId?: string; autoRecovered?: boolean; worktreeEnabled?: boolean; provider?: SessionProvider }): SessionSnapshot {
    this.assertCommandAllowed(command);

    const baseCwd = cwd
      ? path.resolve(process.cwd(), cwd)
      : path.resolve(process.cwd(), this.config.defaultCwd);

    const id = randomUUID();
    const worktreeSetup = opts?.worktreeEnabled
      ? prepareSessionWorktree({ cwd: baseCwd, sessionId: id })
      : null;
    const resolvedCwd = worktreeSetup?.cwd ?? baseCwd;
    const provider = opts?.provider ?? resolveProviderFromCommand(command);
    const effectiveMode = provider === "codex" ? "full-access" : mode;
    const isClaudeProvider = provider === "claude";
    const processedCommand = this.processCommandForMode(command, effectiveMode, provider);
    const resumeCommandSessionId = isClaudeProvider
      ? getResumeCommandSessionId(processedCommand) ?? getResumeCommandSessionId(command)
      : null;
    const knownClaudeTaskIds = isClaudeProvider ? new Set(listRecentClaudeProjectSessionIds(resolvedCwd, new Date().toISOString())) : null;
    const knownClaudeProjectMtimes = isClaudeProvider ? listClaudeProjectSessionMtimes(resolvedCwd) : null;
    const initialClaudeSessionId = isClaudeProvider ? resumeCommandSessionId ?? null : null;
    const startedAt = new Date().toISOString();

    const record: SessionRecord = {
      id,
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
      resumedFromSessionId: opts?.resumedFromSessionId ?? null,
      autoRecovered: opts?.autoRecovered ?? false,
      rememberedEscalationScopes: new Set(),
      rememberedEscalationTargets: new Set(),
      storedOutput: "",
      messages: [],
      childProcess: null,
      ptyBridge: null,
      currentTask: null,
      taskDebounceTimer: null,
      lastEmittedTask: null,
      knownClaudeTaskIds: knownClaudeTaskIds ?? undefined,
      claudeTaskDiscoveryTimer: null,
      knownClaudeProjectMtimes: knownClaudeProjectMtimes ?? undefined,
      approvalStats: { tool: 0, command: 0, file: 0, total: 0 }
    };

    if (isClaudeProvider) {
      record.ptyBridge = new ClaudePtyBridge({
        sessionId: id,
        isClaudeCommand: true,
        autoApprove: record.autoApprovePermissions,
        approvalPolicy: record.approvalPolicy,
      });
      record.ptyBridge.on("event", (event: SessionEvent) => {
        this.handleBridgeEvent(record, event);
      });
    }

    this.sessions.set(id, record);
    this.persist(record);
    this.cleanupOldSessions();

    this.lifecycleManager.register(id, "initializing");

    const shellArgs = this.buildShellArgs(processedCommand);
    let child: import("node-pty").IPty;
    try {
      child = pty.spawn(this.config.shell, shellArgs, {
        cwd: resolvedCwd,
        env: {
          ...process.env,
          WAND_MODE: effectiveMode,
          WAND_AUTO_CONFIRM: effectiveMode === "full-access" ? "1" : "0",
          WAND_AUTO_EDIT: effectiveMode === "auto-edit" ? "1" : "0"
        },
        name: "xterm-color",
        cols: 120,
        rows: 36
      });
    } catch (err) {
      console.error("[ProcessManager] pty.spawn threw", { sessionId: id, error: String(err) });
      record.status = "failed";
      record.exitCode = -1;
      record.endedAt = new Date().toISOString();
      record.ptyProcess = null;
      this.lifecycleManager.archive(id, "Session spawn failed", "error");
      this.persist(record);
      return this.snapshot(record);
    }

    record.processId = child.pid;
    record.ptyProcess = child;
    record.status = "running";
    this.lifecycleManager.setState(id, "running");

    child.onExit(({ exitCode }) => {
      const current = this.sessions.get(id);
      if (!current) return;
      if (current.claudeTaskDiscoveryTimer) {
        clearTimeout(current.claudeTaskDiscoveryTimer);
        current.claudeTaskDiscoveryTimer = null;
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
      current.status = current.stopRequested ? "stopped" : exitCode === 0 ? "exited" : "failed";
      current.exitCode = current.stopRequested ? null : exitCode;
      current.endedAt = new Date().toISOString();
      current.ptyProcess = null;
      this.lifecycleManager.archive(id, `Session ${current.status}`, current.stopRequested ? "user" : "error");
      this.flushPersist(current);
      this.storage.saveSession(this.snapshot(current));
      this.emitEvent({ type: "ended", sessionId: id, data: this.snapshot(current) });
    });

    if (record.ptyBridge) {
      record.ptyBridge.setPtyWrite((input: string) => {
        if (record.ptyProcess) {
          record.ptyProcess.write(input);
        }
      });
    }

    this.emitEvent({ type: "started", sessionId: id, data: this.snapshot(record) });

    let initialInputSent = false;
    const sendInitialInput = () => {
      if (initialInputSent || !initialInput) return;
      initialInputSent = true;
      const current = this.sessions.get(id);
      if (!current || !current.ptyProcess || current.status !== "running") {
        process.stderr.write(`[wand] Cannot send initial input: session not ready\n`);
        return;
      }
      process.stderr.write(`[wand] Sending initial input (${initialInput.length} chars)\n`);

      if (current.ptyBridge) {
        current.ptyBridge.onUserInput(initialInput);
      }

      current.ptyProcess.write(initialInput);
      current.ptyProcess.write("\n");
    };

    child.onData((chunk: string) => {
      const rec = this.sessions.get(id);
      if (!rec) return;

      if (rec.ptyBridge) {
        rec.ptyBridge.processChunk(chunk);
        rec.output = rec.ptyBridge.getRawOutput();
      } else {
        rec.output = appendWindow(rec.output, chunk, 200_000);
      }

      this.logger.appendPtyOutput(id, chunk);

      if (!rec.ptyBridge) {
        this.emitEvent({
          type: "output",
          sessionId: id,
          data: {
            chunk,
            output: rec.output,
            permissionBlocked: this.isPermissionBlocked(rec),
          },
        });
      }

      const bridgeSessionId = rec.ptyBridge?.getClaudeSessionId();
      if (bridgeSessionId && bridgeSessionId !== rec.claudeSessionId) {
        rec.claudeSessionId = bridgeSessionId;
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
          rec.knownClaudeTaskIds.add(discoveredTaskId);
          process.stderr.write(`[wand] Captured Claude project session ID: ${discoveredTaskId}\n`);
        }
      }

      if (rec.autoApprovePermissions && !rec.ptyBridge && rec.provider === "claude") {
        this.autoConfirmWithRecord(rec, chunk, child);
      }

      if (initialInput && !initialInputSent && chunk.includes("❯")) {
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
        const current = this.sessions.get(id);
        if (!current || current.status !== "running" || current.claudeSessionId || !current.knownClaudeTaskIds) {
          return;
        }
        if (getResumeCommandSessionId(current.command)) {
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

    return this.snapshot(record);
  }


  list(): SessionSnapshot[] {
    this.archiveExpiredSessions();
    return Array.from(this.sessions.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((session) => this.snapshot(session));
  }

  /** Return lightweight snapshots for the session list (no output/messages). */
  listSlim(): SessionSnapshot[] {
    this.archiveExpiredSessions();
    return Array.from(this.sessions.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((session) => this.snapshotSlim(session));
  }

  hasClaudeSessionFile(cwd: string, claudeSessionId: string): boolean {
    return isClaudeSessionFileAvailable(cwd, claudeSessionId);
  }

  private claudeHistoryCache: { data: ClaudeHistorySession[]; expiresAt: number } | null = null;
  private static readonly HISTORY_CACHE_TTL_MS = 30_000;

  listClaudeHistorySessions(): ClaudeHistorySession[] {
    const now = Date.now();
    if (this.claudeHistoryCache && now < this.claudeHistoryCache.expiresAt) {
      return this.claudeHistoryCache.data;
    }

    const allSessions = listAllClaudeHistorySessions();

    // Cross-reference with wand-managed sessions
    const managedClaudeIds = new Set<string>();
    for (const record of this.sessions.values()) {
      if (record.claudeSessionId) {
        managedClaudeIds.add(record.claudeSessionId);
      }
    }

    for (const session of allSessions) {
      if (managedClaudeIds.has(session.claudeSessionId)) {
        session.managedByWand = true;
      }
    }

    this.claudeHistoryCache = { data: allSessions, expiresAt: now + ProcessManager.HISTORY_CACHE_TTL_MS };
    return allSessions;
  }

  deleteClaudeHistoryFiles(sessions: { claudeSessionId: string; cwd: string }[]): number {
    let deleted = 0;
    const claudeHome = path.join(os.homedir(), ".claude");
    for (const { claudeSessionId, cwd } of sessions) {
      if (!UUID_V4_PATTERN.test(claudeSessionId)) continue;
      const jsonlPath = path.join(
        getClaudeProjectDir(cwd),
        `${claudeSessionId}.jsonl`
      );
      try {
        unlinkSync(jsonlPath);
        deleted++;
      } catch {
        // Best-effort — file may already be gone
      }
      // Clean up related directories under ~/.claude/
      for (const sub of ["session-env", "tasks", "todos"]) {
        const dir = path.join(claudeHome, sub, claudeSessionId);
        try {
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        } catch {
          // Non-critical — best-effort
        }
      }
    }
    if (sessions.length > 0) {
      this.claudeHistoryCache = null;
    }
    return deleted;
  }

  get(id: string): SessionSnapshot | null {
    this.archiveExpiredSessions();
    const record = this.sessions.get(id);
    if (!record) {
      // Fallback: check SQLite for sessions that were evicted from memory
      return this.storage.getSession(id) ?? null;
    }
    // For sessions loaded from storage on startup, in-memory output starts empty.
    // Prefer in-memory output (live PTY data), fall back to stored output.
    if (!record.output && record.storedOutput) {
      record.output = record.storedOutput;
    }
    return this.snapshot(record);
  }

  getPtyTranscript(id: string): string | null {
    return this.logger.readPtyOutput(id);
  }

  sendInput(id: string, input: string, view?: "chat" | "terminal", shortcutKey?: string): SessionSnapshot {
    const record = this.mustGet(id);

    if (record.status !== "running") {
      console.error(`[ProcessManager] Rejecting input: session ${id} not running (${record.status})`);
      throw new SessionInputError("Session is not running.", "SESSION_NOT_RUNNING", id, record.status);
    }

    // Update lifecycle
    this.lifecycleManager.touch(id);
    this.lifecycleManager.startThinking(id);

    if (!record.ptyProcess) {
      console.error(`[ProcessManager] Rejecting input: session ${id} has no PTY`);
      throw new SessionInputError("Session is not running.", "SESSION_NO_PTY", id, record.status);
    }

    // Log shortcut key interactions for auto-confirm and mode analysis
    if (shortcutKey) {
      const outputLines = record.output.split("\n");
      const tailLines = outputLines.slice(-15).join("\n");
      const ctx: ShortcutLogContext = {
        mode: record.mode,
        autoApprove: record.autoApprovePermissions,
        permissionBlocked: record.ptyPermissionBlocked || !!record.pendingEscalation,
        input,
      };
      this.logger.appendShortcutLog(id, shortcutKey, tailLines, ctx);
    }

    // Track user input via bridge for Chat mode
    if (record.ptyBridge) {
      record.ptyBridge.onUserInput(input);
    }

    // Ensure input advances to a new line so subsequent PTY output doesn't overwrite it
    record.ptyProcess.write(input);
    if (view !== "terminal" && !input.endsWith("\n")) {
      record.ptyProcess.write("\n");
    }
    this.persist(record);
    return this.snapshot(record);
  }

  /** Emit a task event for a session, debounced to avoid flooding */
  private emitTask(record: SessionRecord, task: TaskInfo | null): void {
    // Clear existing debounce timer
    if (record.taskDebounceTimer) {
      clearTimeout(record.taskDebounceTimer);
      record.taskDebounceTimer = null;
    }

    // Don't re-emit the same task
    if (task && task.title === record.lastEmittedTask) return;

    if (task === null) {
      // Clear task after a delay — allows a brief display of "idle" state
      record.taskDebounceTimer = setTimeout(() => {
        record.currentTask = null;
        record.lastEmittedTask = null;
        this.emitEvent({ type: "task", sessionId: record.id, data: null });
      }, 2000);
      return;
    }

    // Debounce task changes by 100ms to avoid flickering on rapid tool switches
    record.taskDebounceTimer = setTimeout(() => {
      record.taskDebounceTimer = null;
      record.currentTask = task;
      record.lastEmittedTask = task.title;
      this.emitEvent({ type: "task", sessionId: record.id, data: task });
    }, 100);
  }

  resize(id: string, cols: number, rows: number): SessionSnapshot {
    const record = this.mustGet(id);
    if (!record.ptyProcess || record.status !== "running") {
      return this.snapshot(record);
    }

    const safeCols = clampDimension(cols, 20, 400);
    const safeRows = clampDimension(rows, 10, 160);
    record.ptyProcess.resize(safeCols, safeRows);
    return this.snapshot(record);
  }

  stop(id: string): SessionSnapshot {
    const record = this.mustGet(id);
    if (record.status !== "running") {
      return this.snapshot(record);
    }

    // Clear any pending task debounce timer
    if (record.taskDebounceTimer) {
      clearTimeout(record.taskDebounceTimer);
      record.taskDebounceTimer = null;
    }
    if (record.claudeTaskDiscoveryTimer) {
      clearTimeout(record.claudeTaskDiscoveryTimer);
      record.claudeTaskDiscoveryTimer = null;
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
    // The async onExit handler will re-persist but will find stopRequested already true.
    record.status = "stopped";
    record.exitCode = null;
    record.endedAt = new Date().toISOString();
    record.ptyProcess = null;
    if (record.ptyBridge) {
      record.ptyBridge.removeAllListeners();
      record.ptyBridge = null;
    }

    // Update lifecycle
    this.lifecycleManager.archive(id, "Session stopped by user", "user");
    this.persist(record);
    return this.snapshot(record);
  }

  delete(id: string): void {
    const record = this.mustGet(id);

    // Always clear pending timers
    if (record.taskDebounceTimer) {
      clearTimeout(record.taskDebounceTimer);
      record.taskDebounceTimer = null;
    }
    if (record.claudeTaskDiscoveryTimer) {
      clearTimeout(record.claudeTaskDiscoveryTimer);
      record.claudeTaskDiscoveryTimer = null;
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
    this.deleteClaudeCache(record);
    this.sessions.delete(id);
      this.lastPersistedMessageState.delete(id);
    this.lifecycleManager.unregister(id);
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
      this.start(command, this.config.defaultCwd, this.config.defaultMode)
    );
  }

  private snapshot(record: SessionRecord): SessionSnapshot {
    // Get messages from bridge if available, otherwise use stored messages
    const messages = record.ptyBridge?.getMessages() ?? record.messages;
    return {
      id: record.id,
      sessionKind: "pty",
      provider: record.provider,
      runner: "pty",
      command: record.command,
      cwd: record.cwd,
      mode: record.mode,
      worktreeEnabled: record.worktreeEnabled ?? false,
      worktree: record.worktree ?? null,
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
      resumedToSessionId: record.resumedToSessionId ?? undefined,
      autoRecovered: record.autoRecovered ?? false,
      autoApprovePermissions: record.autoApprovePermissions || undefined,
      approvalStats: record.approvalStats.total > 0 ? record.approvalStats : undefined,
      summary: deriveSessionSummary(messages, record.currentTask?.title ?? null),
      currentTaskTitle: record.status === "running" ? record.currentTask?.title ?? undefined : undefined,
    };
  }

  /** Lightweight snapshot for list views — omits output and messages. */
  private snapshotSlim(record: SessionRecord): SessionSnapshot {
    const messages = record.ptyBridge?.getMessages() ?? record.messages;
    return {
      id: record.id,
      sessionKind: "pty",
      provider: record.provider,
      runner: "pty",
      command: record.command,
      cwd: record.cwd,
      mode: record.mode,
      worktreeEnabled: record.worktreeEnabled ?? false,
      worktree: record.worktree ?? null,
      autonomyPolicy: record.autonomyPolicy,
      approvalPolicy: record.approvalPolicy,
      allowedScopes: record.allowedScopes,
      status: record.status,
      exitCode: record.exitCode,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      output: "",
      archived: record.archived,
      archivedAt: record.archivedAt,
      permissionBlocked: this.isPermissionBlocked(record),
      pendingEscalation: record.pendingEscalation || undefined,
      lastEscalationResult: record.lastEscalationResult || undefined,
      claudeSessionId: record.claudeSessionId || null,
      resumedFromSessionId: record.resumedFromSessionId ?? undefined,
      resumedToSessionId: record.resumedToSessionId ?? undefined,
      autoRecovered: record.autoRecovered ?? false,
      autoApprovePermissions: record.autoApprovePermissions || undefined,
      approvalStats: record.approvalStats.total > 0 ? record.approvalStats : undefined,
      summary: deriveSessionSummary(messages, record.currentTask?.title ?? null),
      currentTaskTitle: record.status === "running" ? record.currentTask?.title ?? undefined : undefined,
    };
  }

  private isPermissionBlocked(record: SessionRecord): boolean {
    return record.ptyBridge?.isPermissionBlocked() ?? record.pendingEscalation !== null;
  }

  private defaultAutonomyPolicy(mode: ExecutionMode): AutonomyPolicy {
    if (mode === "agent" || mode === "agent-max" || mode === "managed" || mode === "native" || mode === "full-access") {
      return "agent";
    }
    return "assist";
  }

  resolveEscalation(id: string, requestId: string, resolution?: "approve_once" | "approve_turn" | "deny"): SessionSnapshot {
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
  resolvePermission(id: string, resolution: "approve_once" | "approve_turn" | "deny", requestId?: string): SessionSnapshot {
    const record = this.mustGet(id);

    // Validate requestId if provided
    if (requestId && record.pendingEscalation) {
      if (record.pendingEscalation.requestId !== requestId) {
        throw new Error("Escalation request not found.");
      }
    }

    // Record escalation result for audit trail
    if (record.pendingEscalation) {
      record.lastEscalationResult = {
        requestId: record.pendingEscalation.requestId,
        resolution,
        reason: record.pendingEscalation.reason,
      };
    }

    // Handle "approve_turn" memory — only in ProcessManager for non-bridge sessions
    if (resolution === "approve_turn" && record.pendingEscalation && !record.ptyBridge) {
      record.rememberedEscalationScopes.add(record.pendingEscalation.scope);
      if (record.pendingEscalation.target) {
        record.rememberedEscalationTargets.add(record.pendingEscalation.target);
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

  private persist(record: SessionRecord): void {
    // Update messages from bridge before persisting
    const messages = record.ptyBridge?.getMessages() ?? record.messages;
    if (messages !== record.messages) {
      record.messages = messages;
    }
    const snapshot = this.snapshot(record);
    const shouldSaveMessages = shouldPersistMessages(this.lastPersistedMessageState.get(record.id), messages);
    // Persist full messages as soon as the structured conversation changes so
    // service restarts cannot roll the session back to an older tail message.
    if (shouldSaveMessages) {
      this.storage.saveSession(snapshot);
      this.lastPersistedMessageState.set(record.id, getPersistedMessageState(messages));
    } else {
      this.storage.saveSessionMetadata(snapshot);
    }
    this.logger.saveMetadata(record.id, {
      id: record.id,
      command: record.command,
      status: record.status,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      claudeSessionId: record.claudeSessionId,
      resumedFromSessionId: record.resumedFromSessionId ?? null,
      resumedToSessionId: record.resumedToSessionId ?? null,
      autoRecovered: record.autoRecovered ?? false,
    });
    if (shouldSaveMessages) {
      this.logger.saveMessages(record.id, messages);
    }
  }

  /**
   * Schedule a debounced persist call for the given record.
   * Multiple calls within the debounce window are coalesced into a single write.
   * Use this in hot paths (e.g. onData) to reduce I/O pressure.
   */
  private schedulePersist(record: SessionRecord): void {
    const existing = this.persistDebounceTimers.get(record.id);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.persistDebounceTimers.delete(record.id);
      this.persist(record);
    }, 1000);
    this.persistDebounceTimers.set(record.id, timer);
  }

  /**
   * Immediately persist any pending debounced write and clear the timer.
   * Use this at critical points (exit, stop, delete) to ensure no data loss.
   */
  private flushPersist(record: SessionRecord): void {
    const existing = this.persistDebounceTimers.get(record.id);
    if (existing) {
      clearTimeout(existing);
      this.persistDebounceTimers.delete(record.id);
    }
    this.persist(record);
  }

  private backfillExitedClaudeSessionIds(): void {
    for (const record of this.sessions.values()) {
      record.messages = snapshotMessages(record);
      if (!shouldBackfillClaudeSessionId(record)) {
        continue;
      }
      const discoveredSessionId = findRealClaudeProjectSessionId(record.cwd, record.startedAt);
      if (!discoveredSessionId) {
        continue;
      }
      record.claudeSessionId = discoveredSessionId;
      this.persist(record);
    }
  }

  /**
   * Auto-recover the most recent exited session that has a Claude session ID.
   * Only resumes one session per server start, using the most recent eligible
   * session. Sets `resumedToSessionId` on the original session and
   * `autoRecovered: true` on the new session.
   */
  private autoRecoverExitedSessions(): void {
    // Find eligible exited sessions
    const eligibleSessions: SessionRecord[] = [];
    for (const record of this.sessions.values()) {
      record.messages = snapshotMessages(record);
      if (shouldAutoResumeSession(record)) {
        eligibleSessions.push(record);
      }
    }

    if (eligibleSessions.length === 0) return;

    // Sort by startedAt descending (most recent first)
    eligibleSessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    // Only auto-recover the single most recent session
    const original = eligibleSessions[0];
    const isClaude = /^claude\b/.test(original.command.trim());
    if (!isClaude) return;

    // If no claudeSessionId is bound yet, try to discover it via proximity search
    if (!original.claudeSessionId) {
      const discovered = findRealClaudeProjectSessionId(original.cwd, original.startedAt);
      if (discovered) {
        original.claudeSessionId = discovered;
        process.stderr.write(`[wand] Backfilled Claude session ID for auto-recovery: ${discovered}\n`);
        this.persist(original);
      }
    }

    if (!original.claudeSessionId) {
      console.error(`[ProcessManager] Skipping auto-recovery: no Claude session ID for session ${original.id}`);
      return;
    }

    console.error(
      `[ProcessManager] Auto-recovering session ${original.id} with Claude session ID ${original.claudeSessionId}`
    );

    const resumeCommand = `${original.command.trim()} --resume ${original.claudeSessionId}`;
    let newRecord: SessionRecord | null = null;

    try {
      const snapshot = this.start(resumeCommand, original.cwd, original.mode, undefined, {
        resumedFromSessionId: original.id,
        autoRecovered: true
      });

      newRecord = this.sessions.get(snapshot.id) ?? null;
      if (!newRecord) return;

      // Set resumedToSessionId on the original session
      original.resumedToSessionId = snapshot.id;
      this.storage.saveSession(this.snapshot(original));

      console.error(
        `[ProcessManager] Auto-recovered session ${snapshot.id} from ${original.id}`
      );
    } catch (err) {
      console.error(`[ProcessManager] Auto-recovery failed: ${String(err)}`);
    }
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
    if (this.config.allowedCommandPrefixes.length === 0) {
      return;
    }

    const isAllowed = this.config.allowedCommandPrefixes.some((prefix) => command.startsWith(prefix));
    if (!isAllowed) {
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
      case "output.raw":
        // Sync record.output from bridge before emitting so the event carries fresh data
        record.output = record.ptyBridge?.getRawOutput() ?? record.output;
        // Emit output event for terminal view
        this.emitEvent({
          type: "output",
          sessionId: event.sessionId,
          data: {
            chunk: (event.data as { chunk: string }).chunk,
            output: record.output,
            messages: record.ptyBridge?.getMessages(),
            permissionBlocked: this.isPermissionBlocked(record),
          },
        });
        break;

      case "output.chat":
        // Sync record.output from bridge before emitting so the event carries fresh data
        record.output = record.ptyBridge?.getRawOutput() ?? record.output;
        // Emit output event with updated messages for chat view
        this.emitEvent({
          type: "output",
          sessionId: event.sessionId,
          data: {
            output: record.output,
            messages: record.ptyBridge?.getMessages(),
            permissionBlocked: this.isPermissionBlocked(record),
          },
        });
        break;

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
        this.lifecycleManager.stopThinking(record.id);
        this.lifecycleManager.waitingInput(record.id);
        this.persist(record);
        this.storage.saveSession(this.snapshot(record));
        break;

      case "ended":
        // Session ended - handled in onExit
        break;
    }
  }

  /** Check if a command is a Claude CLI command */
  private isClaudeCommand(command: string): boolean {
    const trimmed = command.trim();
    return /^claude\b/.test(trimmed);
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

  private processCommandForMode(command: string, mode: ExecutionMode, provider: SessionProvider): string {
    if (provider === "codex") {
      if (mode !== "full-access") {
        return command;
      }
      if (/--dangerously-bypass-approvals-and-sandbox(?:\s|$)/.test(command)) {
        return command;
      }
      return `${command} --dangerously-bypass-approvals-and-sandbox`;
    }

    const isClaudeCmd = /^(?:claude|npx\s+claude|[^\s]+\/claude)(?:\s|$)/.test(command);
    if (!isClaudeCmd) return command;

    let result = command;

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

    if (mode === "managed") {
      const autonomousPrompt = "You are running in a fully managed, autonomous mode. The user may not be available to respond to questions or confirmations in a timely manner. You MUST make all decisions independently — choose the best approach yourself instead of asking the user for preferences, confirmations, or clarifications. If multiple approaches are viable, pick the one you judge most appropriate and proceed. Never block on user input unless the task is fundamentally ambiguous and cannot be reasonably inferred. Be decisive and self-directed.";
      const escaped = autonomousPrompt.replace(/'/g, "'\\''");
      result += ` --append-system-prompt '${escaped}'`;
    }

    const language = this.config.language?.trim();
    if (language) {
      const langPrompt = `Please respond in ${language}. Use ${language} for all your explanations, comments, and conversational text.`;
      const escaped = langPrompt.replace(/'/g, "'\\''");
      result += ` --append-system-prompt '${escaped}'`;
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
