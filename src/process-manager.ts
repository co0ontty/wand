import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";
import os from "node:os";

import pty, { IPty } from "node-pty";
import { WandStorage } from "./storage.js";
import { SessionLogger } from "./session-logger.js";
import { ApprovalPolicy, AutonomyPolicy, ConversationTurn, EscalationRequest, EscalationScope, ExecutionMode, SessionEvent, SessionSnapshot, WandConfig } from "./types.js";
import { SessionLifecycleManager } from "./session-lifecycle.js";
import { ClaudePtyBridge } from "./claude-pty-bridge.js";

/** Check if the current process is running as root (UID 0). */
function isRunningAsRoot(): boolean {
  return process.getuid?.() === 0 || process.geteuid?.() === 0;
}

export interface ProcessEvent {
  type: "output" | "status" | "started" | "ended" | "usage" | "task";
  sessionId: string;
  data?: unknown;
}

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

export type ProcessEventHandler = (event: ProcessEvent) => void;

const PROMPT_PATTERNS = [
  /(?:^|\b)(?:press\s+)?(?:y|yes)\s*(?:\/|\bor\b)\s*(?:n|no)(?:\b|$)/i,
  /\[(?:y|yes)\s*\/\s*(?:n|no)\]/i,
  /\((?:y|yes)\s*\/\s*(?:n|no)\)/i,
  /\((?:y|yes)\s*\/\s*(?:n|no)\s*\/\s*always\)/i,
  /\bcontinue\?\s*(?:\((?:y|yes)\s*\/\s*(?:n|no)\))?/i,
  /\bare you sure\??/i,
  /\bdo you want to continue\??/i,
  /\bdo you want to (?:create|write|delete|modify|execute)/i,
  /\bconfirm(?:\s+execution|\s+changes|\s+action)?\??/i,
  /\bproceed\??/i,
  /\benter to confirm\b/i,
  /\bwould you like to\b/i,
  /\bshall i\b/i,
  /\bcan i\b/i,
  /\bpermission\b/i,
  /\bgrant\b.*\bpermission\b/i
];

// Patterns that indicate a selection-based prompt (needs Enter, not 'y')
const SELECTION_PROMPT_PATTERNS = [
  /\bwould you like to\b/i,
  /\bgrant.*permission\b/i,
  /\bpermission\b/i,
  /\btrust.*folder\b/i,
  /\bconfirm\b/i
];

interface SessionRecord extends SessionSnapshot {
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
}

const MAX_SESSIONS = 50;
const ARCHIVE_AFTER_MS = 1000 * 60 * 60 * 24;
const CONFIRM_WINDOW_SIZE = 800;

// Claude 会话 ID 格式：UUID v4
const CLAUDE_SESSION_ID_PATTERN = /"session_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

/** Append text to a windowed buffer, trimming from start if over max size. */
function appendWindow(buffer: string, chunk: string, maxSize: number): string {
  const next = buffer + chunk;
  return next.length > maxSize ? next.slice(-maxSize) : next;
}

export class ProcessManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly logger: SessionLogger;
  private readonly lifecycleManager: SessionLifecycleManager;

  constructor(
    private readonly config: WandConfig,
    private readonly storage: WandStorage,
    configDir?: string
  ) {
    super();
    this.logger = new SessionLogger(configDir || path.join(process.env.HOME || process.cwd(), ".wand"));
    
    // Initialize lifecycle manager
    this.lifecycleManager = new SessionLifecycleManager({
      onStateChange: (sessionId, oldState, newState) => {
        this.emitEvent({ type: "status", sessionId, data: { oldState, newState } });
      },
      onIdle: (sessionId) => {
        console.error(`[ProcessManager] Session ${sessionId} is now idle`);
      },
      onArchived: (sessionId, reason) => {
        console.error(`[ProcessManager] Session ${sessionId} archived: ${reason}`);
      },
    });
    for (const snapshot of this.storage.loadSessions()) {
      const isClaudeCmd = /^claude\b/.test(snapshot.command.trim());
      // Sessions restored from storage have ptyProcess: null — the old server's PTY
      // belongs to a dead process. Mark running sessions as exited so the UI
      // reflects reality and users can start fresh sessions.
      if (snapshot.status === "running") {
        const updated = { ...snapshot, status: "exited" as const, endedAt: new Date().toISOString() };
        this.storage.saveSession(updated);
        this.sessions.set(snapshot.id, {
          ...updated,
          processId: null,
          ptyProcess: null,
          stopRequested: false,
          confirmWindow: "",
          ptyPermissionBlocked: false,
          lastAutoConfirmAt: 0,
          autoApprovePermissions: this.shouldAutoApprovePermissions(snapshot.command, snapshot.mode),
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
          lastEmittedTask: null
        });
        this.lifecycleManager.register(snapshot.id, "idle");
        console.error(`[ProcessManager] Restored session ${snapshot.id} marked as exited (PTY orphaned)`);
      } else {
        this.sessions.set(snapshot.id, {
          ...snapshot,
          processId: null,
          ptyProcess: null,
          stopRequested: false,
          confirmWindow: "",
          ptyPermissionBlocked: false,
          lastAutoConfirmAt: 0,
          autoApprovePermissions: this.shouldAutoApprovePermissions(snapshot.command, snapshot.mode),
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
          lastEmittedTask: null
        });
        this.lifecycleManager.register(snapshot.id, "archived");
      }
    }
    this.archiveExpiredSessions();
  }

  on(event: "process", listener: ProcessEventHandler): this {
    return super.on("process", listener);
  }

  private emitEvent(event: ProcessEvent): void {
    this.emit("process", event);
  }

  private cleanupOldSessions(): void {
    // Remove oldest finished sessions if we're at the limit
    if (this.sessions.size < MAX_SESSIONS) return;

    const finishedIds: string[] = [];
    for (const [id, record] of this.sessions) {
      if (record.status !== "running") {
        finishedIds.push(id);
      }
    }

    // Remove oldest finished sessions first
    finishedIds
      .sort((a, b) => {
        const ra = this.sessions.get(a);
        const rb = this.sessions.get(b);
        return (ra?.endedAt || "").localeCompare(rb?.endedAt || "");
      })
      .slice(0, this.sessions.size - MAX_SESSIONS + 1)
      .forEach((id) => {
        this.sessions.delete(id);
        this.storage.deleteSession(id);
      });
  }

  start(command: string, cwd: string | undefined, mode: ExecutionMode, initialInput?: string): SessionSnapshot {
    this.assertCommandAllowed(command);

    const resolvedCwd = cwd
      ? path.resolve(process.cwd(), cwd)
      : path.resolve(process.cwd(), this.config.defaultCwd);

    // For full-access mode with claude, add permission flags
    const processedCommand = this.processCommandForMode(command, mode);

    const id = randomUUID();
    const isClaudeCmd = this.isClaudeCommand(command);
    const record: SessionRecord = {
      id,
      command,
      cwd: resolvedCwd,
      mode,
      autonomyPolicy: this.defaultAutonomyPolicy(mode),
      approvalPolicy: "ask-every-time",
      allowedScopes: [],
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      output: "",
      archived: false,
      archivedAt: null,
      permissionBlocked: undefined,
      pendingEscalation: null,
      lastEscalationResult: null,
      claudeSessionId: null,
      processId: null,
      ptyProcess: null,
      stopRequested: false,
      confirmWindow: "",
      ptyPermissionBlocked: false,
      lastAutoConfirmAt: 0,
      autoApprovePermissions: this.shouldAutoApprovePermissions(command, mode),
      rememberedEscalationScopes: new Set(),
      rememberedEscalationTargets: new Set(),
      storedOutput: "",
      messages: [],
      childProcess: null,
      ptyBridge: null,
      currentTask: null,
      taskDebounceTimer: null,
      lastEmittedTask: null
    };

    // Create PTY bridge for this session
    record.ptyBridge = new ClaudePtyBridge({
      sessionId: id,
      isClaudeCommand: isClaudeCmd,
      autoApprove: record.autoApprovePermissions,
      approvalPolicy: record.approvalPolicy,
    });
    record.ptyBridge.on("event", (event: SessionEvent) => {
      this.handleBridgeEvent(record, event);
    });

    this.sessions.set(id, record);
    this.persist(record);
    this.cleanupOldSessions();

    // Register lifecycle
    this.lifecycleManager.register(id, "initializing");

    // All modes use PTY execution — JSON turns are only used for internal recovery
    const shellArgs = this.buildShellArgs(processedCommand);
    let child: import("node-pty").IPty;
    try {
      child = pty.spawn(this.config.shell, shellArgs, {
        cwd: resolvedCwd,
        env: {
          ...process.env,
          WAND_MODE: mode,
          WAND_AUTO_CONFIRM: mode === "full-access" ? "1" : "0",
          WAND_AUTO_EDIT: mode === "auto-edit" ? "1" : "0"
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

    // Register exit handler AFTER ptyProcess is assigned — node-pty's EventEmitter
    // fires 'exit' synchronously when the child has already exited (e.g. "command
    // not found"). If we register first, onExit fires with ptyProcess still null and
    // status never updates. By assigning first, onExit always sees a consistent state.
    child.onExit(({ exitCode }) => {
      const current = this.sessions.get(id);
      if (!current) return;
      if (current.ptyBridge) {
        current.ptyBridge.onExit(exitCode);
      }
      current.status = current.stopRequested ? "stopped" : exitCode === 0 ? "exited" : "failed";
      current.exitCode = current.stopRequested ? null : exitCode;
      current.endedAt = new Date().toISOString();
      current.ptyProcess = null;
      this.lifecycleManager.archive(id, `Session ${current.status}`, current.stopRequested ? "user" : "error");
      this.persist(current);
      this.emitEvent({ type: "ended", sessionId: id, data: this.snapshot(current) });
    });

    // Set PTY write function for bridge (for permission approval).
    // Write directly to record.ptyProcess — the status guard in sendInput() already
    // ensures no input is sent when the session is not running, so we just guard
    // the PTY write itself against a null process.
    if (record.ptyBridge) {
      record.ptyBridge.setPtyWrite((input: string) => {
        if (record.ptyProcess) {
          record.ptyProcess.write(input);
        }
      });
    }

    // Emit started event AFTER PTY is fully set up so clients receive a consistent snapshot.
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
      process.stderr.write(`[wand] Sending initial input: ${initialInput}\n`);

      // Track initial input via bridge for Chat mode
      if (current.ptyBridge) {
        current.ptyBridge.onUserInput(initialInput);
      }

      current.ptyProcess.write(initialInput);
      // \n advances to a new line so subsequent output doesn't overwrite this input
      current.ptyProcess.write("\n");
    };

    child.onData((chunk: string) => {
      const rec = this.sessions.get(id);
      if (!rec) return;

      // Route chunk through PTY bridge
      if (rec.ptyBridge) {
        rec.ptyBridge.processChunk(chunk);
      }

      // Update legacy output field for backward compatibility
      rec.output = rec.ptyBridge?.getRawOutput() ?? "";

      // Log raw PTY output for analysis
      this.logger.appendPtyOutput(id, chunk);

      // Update Claude session ID from bridge
      const bridgeSessionId = rec.ptyBridge?.getClaudeSessionId();
      if (bridgeSessionId && bridgeSessionId !== rec.claudeSessionId) {
        rec.claudeSessionId = bridgeSessionId;
        process.stderr.write(`[wand] Captured Claude session ID: ${bridgeSessionId}\n`);
      }

      // Auto-confirm for full-access mode
      if (rec.autoApprovePermissions) {
        this.autoConfirmWithRecord(rec, chunk, child);
      }

      if (initialInput && !initialInputSent && chunk.includes("❯")) {
        sendInitialInput();
      }

      this.persist(rec);
    });

    if (initialInput) {
      setTimeout(() => {
        if (!initialInputSent) sendInitialInput();
      }, 3000);
    }

    return this.snapshot(record);
  }

  list(): SessionSnapshot[] {
    this.archiveExpiredSessions();
    return Array.from(this.sessions.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((session) => this.snapshot(session));
  }

  get(id: string): SessionSnapshot | null {
    this.archiveExpiredSessions();
    const record = this.sessions.get(id);
    if (!record) return null;
    // For sessions loaded from storage on startup, in-memory output starts empty.
    // Prefer in-memory output (live PTY data), fall back to stored output.
    if (!record.output && record.storedOutput) {
      record.output = record.storedOutput;
    }
    return this.snapshot(record);
  }

  sendInput(id: string, input: string, view?: "chat" | "terminal"): SessionSnapshot {
    const record = this.mustGet(id);

    if (record.status !== "running") {
      console.error("[ProcessManager] Rejecting input for non-running session", {
        sessionId: id,
        status: record.status,
        hasPty: !!record.ptyProcess,
        inputLength: input.length,
        view: view ?? "chat"
      });
      throw new SessionInputError("Session is not running.", "SESSION_NOT_RUNNING", id, record.status);
    }

    // Update lifecycle
    this.lifecycleManager.touch(id);
    this.lifecycleManager.startThinking(id);

    if (!record.ptyProcess) {
      console.error("[ProcessManager] Rejecting input because PTY is missing", {
        sessionId: id,
        status: record.status,
        hasPty: !!record.ptyProcess,
        inputLength: input.length,
        view: view ?? "chat"
      });
      throw new SessionInputError("Session is not running.", "SESSION_NO_PTY", id, record.status);
    }

    console.error("[ProcessManager] Sending input to session", {
      sessionId: id,
      status: record.status,
      hasPty: !!record.ptyProcess,
      inputLength: input.length,
      view: view ?? "chat"
    });

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

    try {
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
    } catch {
      record.status = "failed";
      record.endedAt = new Date().toISOString();
      record.output += "\n[wand] Failed to stop session cleanly.\n";
    }

    // Immediately update status and clear PTY references so the session no longer
    // appears "running" and subsequent sendInput() calls are rejected cleanly.
    // The async onExit handler will re-persist but will find stopRequested already true.
    record.status = "stopped";
    record.exitCode = null;
    record.endedAt = new Date().toISOString();
    record.ptyProcess = null;
    record.ptyBridge = null;

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
    record.ptyBridge = null;

    this.sessions.delete(id);
    this.storage.deleteSession(id);
  }

  async runStartupCommands(): Promise<SessionSnapshot[]> {
    return this.config.startupCommands.map((command) =>
      this.start(command, this.config.defaultCwd, this.config.defaultMode)
    );
  }

  private snapshot(record: SessionRecord): SessionSnapshot {
    // Get messages from bridge if available, otherwise use stored messages
    const messages = record.ptyBridge?.getMessages() ?? record.messages;
    return {
      id: record.id,
      command: record.command,
      cwd: record.cwd,
      mode: record.mode,
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
      messages: messages.length > 0 ? messages : undefined
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
    const record = this.mustGet(id);
    const escalation = record.pendingEscalation;
    if (!escalation || escalation.requestId !== requestId) {
      throw new Error("Escalation request not found.");
    }

    const finalResolution = resolution ?? "approve_once";
    record.lastEscalationResult = {
      requestId,
      resolution: finalResolution,
      reason: escalation.reason
    };

    if (finalResolution === "deny") {
      record.pendingEscalation = null;
      if (record.ptyProcess && record.status === "running") {
        record.ptyProcess.write("n\r");
      }
      record.ptyPermissionBlocked = false;
      this.persist(record);
      return this.snapshot(record);
    }

    if (finalResolution === "approve_turn") {
      record.rememberedEscalationScopes.add(escalation.scope);
      if (escalation.target) {
        record.rememberedEscalationTargets.add(escalation.target);
      }
    }

    record.pendingEscalation = null;
    record.ptyPermissionBlocked = false;
    if (record.ptyProcess && record.status === "running") {
      record.ptyProcess.write("\r");
    }
    this.persist(record);
    return this.snapshot(record);
  }

  approvePermission(id: string): SessionSnapshot {
    const record = this.mustGet(id);

    // Use bridge for permission resolution
    if (record.ptyBridge) {
      record.ptyBridge.resolvePermission("approve_once");
    } else if (record.ptyProcess && record.status === "running") {
      record.ptyProcess.write("\r");
    }
    record.ptyPermissionBlocked = false;
    record.pendingEscalation = null;
    this.persist(record);
    return this.snapshot(record);
  }

  denyPermission(id: string): SessionSnapshot {
    const record = this.mustGet(id);

    // Use bridge for permission resolution
    if (record.ptyBridge) {
      record.ptyBridge.resolvePermission("deny");
    } else if (record.ptyProcess && record.status === "running") {
      record.ptyProcess.write("n\r");
    }
    record.ptyPermissionBlocked = false;
    record.pendingEscalation = null;
    this.persist(record);
    return this.snapshot(record);
  }

  /**
   * Resolve permission with specific resolution type.
   * @param resolution - "approve_once", "approve_turn", or "deny"
   */
  resolvePermission(id: string, resolution: "approve_once" | "approve_turn" | "deny"): SessionSnapshot {
    const record = this.mustGet(id);

    if (record.ptyBridge) {
      record.ptyBridge.resolvePermission(resolution);
    } else if (record.ptyProcess && record.status === "running") {
      if (resolution === "deny") {
        record.ptyProcess.write("n\r");
      } else {
        record.ptyProcess.write("\r");
      }
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
    this.storage.saveSession(this.snapshot(record));
    // Save structured messages to file for analysis
    if (messages.length > 0) {
      this.logger.saveMessages(record.id, messages);
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
      /\byes\b/i.test(normalized);

    // Check for Claude's tool permission prompt patterns
    const toolPermissionPrompt =
      /\bdo you want to\b/i.test(normalized) &&
      /\(yes\b/i.test(normalized);

    // Check if this is a selection-based prompt (needs Enter, not 'y')
    const isSelectionPrompt = SELECTION_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));

    // Reduced cooldown for faster response
    if (now - record.lastAutoConfirmAt < 500) {
      return;
    }

    const shouldConfirm = trustFolderPrompt || claudeConfirmPrompt || toolPermissionPrompt || PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));

    if (shouldConfirm) {
      record.lastAutoConfirmAt = now;
      process.stderr.write(`[wand] Auto-confirming prompt for ${record.mode} mode\n`);
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

      case "permission.resolved":
        record.pendingEscalation = null;
        record.ptyPermissionBlocked = false;
        this.emitEvent({
          type: "status",
          sessionId: event.sessionId,
          data: { permissionBlocked: false },
        });
        break;

      case "session.id":
        // Claude session ID captured - already handled in onData
        break;

      case "chat.turn":
        // Turn completed - persist messages
        record.messages = record.ptyBridge?.getMessages() ?? record.messages;
        this.lifecycleManager.stopThinking(record.id);
        this.lifecycleManager.waitingInput(record.id);
        this.persist(record);
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

  private shouldAutoApprovePermissions(command: string, mode: ExecutionMode): boolean {
    if (!/^claude(?:\s|$)/.test(command)) {
      return false;
    }

    // Root mode: always auto-approve (Claude CLI refuses --permission-mode bypassPermissions under root)
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

  private processCommandForMode(command: string, _mode: ExecutionMode): string {
    // Don't automatically add --enable-auto-mode as it may not be available
    // for all plans and can cause issues with normal interactive mode.
    // Let users specify it explicitly if they want auto mode.
    return command;
  }
}

function normalizePromptText(value: string): string {
  return value
    .replace(/\u001b\[(\d+)C/g, (_match, count) => " ".repeat(Number(count) || 1))
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}

function clampDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
