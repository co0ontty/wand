/**
 * ClaudePtyBridge - PTY output parsing and event bridge
 *
 * Transforms raw PTY output into structured events for WebSocket broadcast.
 * Maintains two parallel output streams:
 * 1. Raw output for terminal view (passthrough)
 * 2. Structured messages for chat view (parsed)
 */

import { EventEmitter } from "node:events";
import type {
  ApprovalPolicy,
  ConversationTurn,
  EscalationScope,
  SessionEvent,
  ChatOutputData,
  ChatTurnData,
  PermissionPromptData,
  SessionIdData,
  TaskData,
  SessionEndData,
  RawOutputData,
} from "./types.js";
import { stripAnsi, isNoiseLine } from "./pty-text-utils.js";

// ── Constants ──

const OUTPUT_MAX_SIZE = 120000;
const SESSION_ID_WINDOW_SIZE = 16384;
const PERMISSION_WINDOW_SIZE = 800;

const UUID_PATTERN = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const CLAUDE_SESSION_ID_PATTERNS = [
  new RegExp(`"session_id"\\s*:\\s*"${UUID_PATTERN}"`, "i"),
  new RegExp(`(?:^|\\s)--resume\\s+${UUID_PATTERN}(?:\\s|$)`, "i"),
  new RegExp(`(?:claude\\s+session\\s+id|session\\s+id)\\s*[:#]?\\s*${UUID_PATTERN}`, "i")
];

// ── Internal State Types ──

interface PtyChatState {
  phase: "idle" | "responding";
  /** Accumulated raw PTY output for current response */
  buffer: string;
  /** User input that triggered current response */
  lastUserInput: string;
  /** Whether the PTY echo of user input has been skipped */
  echoSkipped: boolean;
  /** Index of current assistant message in messages array */
  assistantIndex: number | null;
}

interface PermissionState {
  /** Rolling window for prompt detection */
  window: string;
  /** Currently blocked */
  isBlocked: boolean;
  /** Last detected prompt text */
  lastPrompt: string | null;
  /** Last detected scope */
  lastScope: EscalationScope | null;
  /** Last detected target */
  lastTarget: string | null;
  /** Timestamp of last auto-confirm to prevent rapid repeats */
  lastAutoConfirmAt: number;
}

/** Permission resolution result */
export type PermissionResolution = "approve_once" | "approve_turn" | "deny";

// ── Helper Functions ──

/** Append text to a windowed buffer, trimming from start if over max size. */
function appendWindow(buffer: string, chunk: string, maxSize: number): string {
  const next = buffer + chunk;
  return next.length > maxSize ? next.slice(-maxSize) : next;
}

/** Normalize prompt text for permission detection */
function normalizePromptText(value: string): string {
  return value
    .replace(/\u001b\[(\d+)C/g, (_match, count) => " ".repeat(Number(count) || 1))
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}

/** Normalize PTY output (fix line endings) */
function normalizePtyOutput(value: string): string {
  return value.replace(/\r\r\n/g, "\r\n");
}

// ── ClaudePtyBridge Class ──

export interface ClaudePtyBridgeOptions {
  sessionId: string;
  /** Initial messages from storage (for restart recovery) */
  initialMessages?: ConversationTurn[];
  /** Initial raw output from storage */
  initialOutput?: string;
  /** Whether this is a Claude CLI command (enables permission detection) */
  isClaudeCommand?: boolean;
  /** Whether to auto-approve permission prompts */
  autoApprove?: boolean;
  /** Approval policy for permission handling */
  approvalPolicy?: ApprovalPolicy;
  /** PTY write function for sending approval input */
  ptyWrite?: (input: string) => void;
}

/**
 * ClaudePtyBridge transforms raw PTY output into structured events.
 *
 * Events emitted:
 * - "output.raw" - Raw PTY output for terminal view
 * - "output.chat" - Structured chat content update
 * - "chat.turn" - Conversation turn completed
 * - "permission.prompt" - Permission request detected
 * - "permission.resolved" - Permission resolved
 * - "session.id" - Claude session ID captured
 * - "task" - Task info update
 * - "ended" - Session ended
 */
export class ClaudePtyBridge extends EventEmitter {
  readonly sessionId: string;

  // Output state
  private rawOutput: string;
  private messages: ConversationTurn[];

  // Chat parsing state
  private chatState: PtyChatState;

  // Permission detection state
  private permissionState: PermissionState;

  // Session ID capture
  private sessionIdWindow: string;
  private claudeSessionId: string | null = null;

  // Task tracking
  private currentTask: TaskData | null = null;
  private taskDebounceTimer: NodeJS.Timeout | null = null;
  private lastEmittedTask: string | null = null;

  // Options
  private isClaudeCommand: boolean;
  private autoApprove: boolean;
  private approvalPolicy: ApprovalPolicy;
  private ptyWrite: ((input: string) => void) | null;

  /** Set to true once onExit() has been called; guards against post-exit method calls */
  private _exited: boolean = false;

  // Permission memory for "approve_turn" policy
  private rememberedScopes: Set<EscalationScope> = new Set();
  private rememberedTargets: Set<string> = new Set();

  constructor(options: ClaudePtyBridgeOptions) {
    super();
    this.sessionId = options.sessionId;
    this.messages = options.initialMessages ?? [];
    this.rawOutput = options.initialOutput ?? "";
    this.isClaudeCommand = options.isClaudeCommand ?? false;
    this.autoApprove = options.autoApprove ?? false;
    this.approvalPolicy = options.approvalPolicy ?? "ask-every-time";
    this.ptyWrite = options.ptyWrite ?? null;

    this.chatState = {
      phase: "idle",
      buffer: "",
      lastUserInput: "",
      echoSkipped: false,
      assistantIndex: null,
    };

    this.permissionState = {
      window: "",
      isBlocked: false,
      lastPrompt: null,
      lastScope: null,
      lastTarget: null,
      lastAutoConfirmAt: 0,
    };

    this.sessionIdWindow = "";
  }

  // ── Core API ──

  /**
   * Process a raw PTY chunk.
   * Emits events via EventEmitter.
   */
  processChunk(chunk: string): void {
    // Guard against post-exit calls (e.g., late PTY drain data after onExit)
    if (this._exited) return;

    // 1. Append to raw output
    this.rawOutput = appendWindow(this.rawOutput, normalizePtyOutput(chunk), OUTPUT_MAX_SIZE);

    // 2. Emit raw output event (for terminal view)
    this.emitEvent({
      type: "output.raw",
      sessionId: this.sessionId,
      timestamp: Date.now(),
      data: { chunk, output: this.rawOutput } as RawOutputData,
    });

    // 3. Session ID capture
    this.captureSessionId(chunk);

    // 4. Permission detection
    this.detectPermission(chunk);

    // 5. Chat parsing (if responding)
    if (this.chatState.phase === "responding") {
      this.chatState.buffer += chunk;
      this.parseChatResponse();
    }
  }

  /**
   * Called when user sends input.
   * Starts tracking a new assistant response.
   */
  onUserInput(input: string): void {
    // Guard against post-exit calls
    if (this._exited) return;

    // Filter out non-chat input (control chars, etc.)
    if (!this.isRealChatInput(input)) {
      process.stderr.write(`[Bridge] Input filtered as non-chat: ${input.substring(0, 50)}\n`);
      return;
    }

    const cleanInput = input.replace(/[\r\n]+$/, "").trim();
    process.stderr.write(`[Bridge] Starting chat tracking for: ${cleanInput.substring(0, 50)}\n`);

    // Add user message
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: cleanInput }],
    });

    // Add assistant placeholder for streaming
    this.messages.push({
      role: "assistant",
      content: [],
    });

    // Initialize chat state
    this.chatState = {
      phase: "responding",
      buffer: "",
      lastUserInput: cleanInput,
      echoSkipped: false,
      assistantIndex: this.messages.length - 1,
    };

    // Emit chat state update
    this.emitEvent({
      type: "output.chat",
      sessionId: this.sessionId,
      timestamp: Date.now(),
      data: {
        messages: this.messages,
        streamingIndex: this.chatState.assistantIndex,
        isResponding: true,
      } as ChatOutputData,
    });
  }

  /**
   * Called when PTY process exits.
   * Finalizes any pending response.
   */
  onExit(exitCode: number | null): void {
    // Mark as exited FIRST — prevents any concurrent or subsequent method calls
    this._exited = true;

    if (this.chatState.phase === "responding") {
      this.chatState.echoSkipped = true; // Force skip echo on exit
      this.finalizeResponse();
    }

    // Clear task debounce timer
    if (this.taskDebounceTimer) {
      clearTimeout(this.taskDebounceTimer);
      this.taskDebounceTimer = null;
    }

    // Clear permission state — prevents stale blocked state after exit
    this.permissionState.isBlocked = false;
    this.permissionState.lastPrompt = null;
    this.permissionState.lastScope = null;
    this.permissionState.lastTarget = null;

    this.emitEvent({
      type: "ended",
      sessionId: this.sessionId,
      timestamp: Date.now(),
      data: { exitCode } as SessionEndData,
    });
  }

  // ── State Accessors ──

  getMessages(): ConversationTurn[] {
    return this.messages;
  }

  getRawOutput(): string {
    return this.rawOutput;
  }

  getClaudeSessionId(): string | null {
    return this.claudeSessionId;
  }

  isPermissionBlocked(): boolean {
    return this.permissionState.isBlocked;
  }

  getPermissionState(): PermissionState {
    return this.permissionState;
  }

  getCurrentTask(): TaskData | null {
    return this.currentTask;
  }

  /**
   * Set the PTY write function for sending approval input.
   */
  setPtyWrite(fn: (input: string) => void): void {
    this.ptyWrite = fn;
  }

  // ── Permission Resolution ──

  /**
   * Resolve the current permission prompt.
   * @param resolution - How to resolve the permission
   */
  resolvePermission(resolution: PermissionResolution): void {
    // Guard against post-exit calls — ptyWrite may be stale after exit
    if (this._exited) return;
    if (!this.permissionState.isBlocked) return;

    // Handle "approve_turn" - remember this scope/target for the rest of the turn
    if (resolution === "approve_turn") {
      if (this.permissionState.lastScope) {
        this.rememberedScopes.add(this.permissionState.lastScope);
      }
      if (this.permissionState.lastTarget) {
        this.rememberedTargets.add(this.permissionState.lastTarget);
      }
    }

    // Send approval/denial to PTY
    if (this.ptyWrite) {
      if (resolution === "deny") {
        this.ptyWrite("n\r");
      } else {
        this.ptyWrite("\r");
      }
    }

    // Clear state
    this.permissionState.isBlocked = false;
    this.permissionState.lastPrompt = null;
    this.permissionState.lastScope = null;
    this.permissionState.lastTarget = null;

    this.emitEvent({
      type: "permission.resolved",
      sessionId: this.sessionId,
      timestamp: Date.now(),
      data: { resolution },
    });
  }

  /**
   * Check if a permission scope/target should be auto-approved based on remembered decisions.
   */
  shouldAutoApprove(scope: EscalationScope, target?: string): boolean {
    if (this.rememberedScopes.has(scope)) return true;
    if (target && this.rememberedTargets.has(target)) return true;
    return false;
  }

  /**
   * Clear remembered permissions (call at the start of a new turn).
   */
  clearRememberedPermissions(): void {
    this.rememberedScopes.clear();
    this.rememberedTargets.clear();
  }

  /**
   * Clear permission blocked state (called when permission is resolved externally).
   */
  clearPermissionBlocked(): void {
    this.permissionState.isBlocked = false;
    this.permissionState.lastPrompt = null;
    this.permissionState.lastScope = null;
    this.permissionState.lastTarget = null;
  }

  // ── Private Implementation ──

  private emitEvent(event: SessionEvent): void {
    this.emit("event", event);
  }

  private isRealChatInput(input: string): boolean {
    const trimmed = input.replace(/[\r\n]+$/, "").trim();
    // Empty or whitespace-only
    if (!trimmed) return false;
    // Single control character (Ctrl+C, Ctrl+D, etc.)
    if (trimmed.length === 1 && trimmed.charCodeAt(0) < 32) return false;
    // ANSI escape sequences (arrow keys, etc.)
    if (trimmed.startsWith("\x1b")) return false;
    // Single "y" or "n" — likely auto-confirm response
    if (/^[yn]$/i.test(trimmed)) return false;
    // Just Enter/CR
    if (trimmed === "\r" || trimmed === "\n") return false;
    return true;
  }

  private captureSessionId(chunk: string): void {
    if (this.claudeSessionId) return;
    this.sessionIdWindow = appendWindow(this.sessionIdWindow, chunk, SESSION_ID_WINDOW_SIZE);
    const match = CLAUDE_SESSION_ID_PATTERNS
      .map((pattern) => pattern.exec(this.sessionIdWindow))
      .find((result) => Boolean(result?.[1]));

    if (match?.[1]) {
      this.claudeSessionId = match[1];
      this.emitEvent({
        type: "session.id",
        sessionId: this.sessionId,
        timestamp: Date.now(),
        data: { claudeSessionId: match[1] } as SessionIdData,
      });
    }
  }

  private detectPermission(chunk: string): void {
    if (!this.isClaudeCommand) return;

    this.permissionState.window = appendWindow(
      this.permissionState.window,
      chunk,
      PERMISSION_WINDOW_SIZE
    );

    const normalized = normalizePromptText(this.permissionState.window);
    const blocked = this.isPermissionPromptDetected(normalized);

    if (this.permissionState.isBlocked === blocked) return;

    this.permissionState.isBlocked = blocked;

    if (blocked) {
      const prompt = this.extractPromptText(normalized);
      const target = this.extractPermissionTarget(normalized);
      const scope = this.inferScope(normalized, target);

      this.permissionState.lastPrompt = prompt;
      this.permissionState.lastScope = scope;
      this.permissionState.lastTarget = target ?? null;

      // Check if we should auto-approve
      const shouldAutoApprove = this.autoApprove || this.shouldAutoApprove(scope, target);

      if (shouldAutoApprove) {
        // Debounce auto-confirm to avoid rapid repeats
        const now = Date.now();
        if (now - this.permissionState.lastAutoConfirmAt < 500) return;

        this.permissionState.lastAutoConfirmAt = now;
        process.stderr.write(`[wand] Auto-confirming permission for ${scope}${target ? `: ${target}` : ""}\n`);

        // Send approval to PTY
        if (this.ptyWrite) {
          this.ptyWrite("\r");
        }

        // Clear blocked state immediately
        this.permissionState.isBlocked = false;
        this.permissionState.lastPrompt = null;
        this.permissionState.lastScope = null;
        this.permissionState.lastTarget = null;

        this.emitEvent({
          type: "permission.resolved",
          sessionId: this.sessionId,
          timestamp: Date.now(),
          data: { resolution: "approve_once", autoApproved: true },
        });
      } else {
        // Emit permission prompt event for UI to handle
        this.emitEvent({
          type: "permission.prompt",
          sessionId: this.sessionId,
          timestamp: Date.now(),
          data: { prompt, scope, target } as PermissionPromptData,
        });
      }
    } else {
      this.permissionState.lastPrompt = null;
      this.permissionState.lastScope = null;
      this.permissionState.lastTarget = null;

      this.emitEvent({
        type: "permission.resolved",
        sessionId: this.sessionId,
        timestamp: Date.now(),
        data: {},
      });
    }
  }

  private isPermissionPromptDetected(normalized: string): boolean {
    return (
      /\bdo you want to\b/i.test(normalized) ||
      /\bgrant\b.*\bpermission\b/i.test(normalized) ||
      /\bhaven't granted\b/i.test(normalized) ||
      /\bpermission\b/i.test(normalized) ||
      /\benter to confirm\b/i.test(normalized)
    );
  }

  private extractPromptText(normalized: string): string {
    // Return a snippet around the permission prompt
    const match = normalized.match(/.{0,100}(?:do you want to|permission|grant|enter to confirm).{0,100}/i);
    return match?.[0] ?? normalized.slice(-100);
  }

  private extractPermissionTarget(normalized: string): string | undefined {
    const match = normalized.match(/write to\s+([^,.\n]+)/i)
      || normalized.match(/modify\s+([^,.\n]+)/i)
      || normalized.match(/delete\s+([^,.\n]+)/i)
      || normalized.match(/execute\s+([^,.\n]+)/i);
    return match?.[1]?.trim();
  }

  private inferScope(normalized: string, target?: string): EscalationScope {
    const lower = normalized.toLowerCase();
    if (lower.includes("write") || lower.includes("redirection") || lower.includes("output redirection")) {
      return "write_file";
    }
    if (lower.includes("network") || lower.includes("web") || lower.includes("fetch") || lower.includes("url")) {
      return "network";
    }
    if (lower.includes("command") || lower.includes("bash") || lower.includes("execute")) {
      return "run_command";
    }
    return "unknown";
  }

  private parseChatResponse(): void {
    const clean = stripAnsi(this.chatState.buffer);

    if (!this.chatState.echoSkipped) {
      const echoEndIndex = this.findEchoEndIndex(clean, this.chatState.lastUserInput);
      if (echoEndIndex <= 0) {
        return;
      }

      this.chatState.echoSkipped = true;
      this.chatState.buffer = clean.slice(echoEndIndex);
      process.stderr.write(`[Bridge] Echo skipped, remaining length: ${this.chatState.buffer.length}\n`);
    }

    if (this.detectCompletion(this.chatState.buffer)) {
      process.stderr.write("[Bridge] Completion detected, finalizing\n");
      this.finalizeResponse();
      return;
    }

    this.updateAssistantContent();
  }

  private detectCompletion(clean: string): boolean {
    const lines = clean.split("\n").map((line) => line.trimEnd());
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) {
        continue;
      }
      if (isNoiseLine(trimmed)) {
        continue;
      }
      if (trimmed.startsWith("❯")) {
        const afterPrompt = trimmed.slice(1).trim();
        return afterPrompt.length === 0 || afterPrompt.startsWith("Try");
      }
      return false;
    }
    return false;
  }

  private updateAssistantContent(): void {
    const idx = this.chatState.assistantIndex;
    if (idx === null) return;

    const text = this.cleanForChat(this.chatState.buffer);
    if (text) {
      this.messages[idx].content = [{ type: "text", text }];
    }

    this.emitEvent({
      type: "output.chat",
      sessionId: this.sessionId,
      timestamp: Date.now(),
      data: {
        messages: this.messages,
        streamingIndex: idx,
        isResponding: true,
      } as ChatOutputData,
    });
  }

  private finalizeResponse(): void {
    const idx = this.chatState.assistantIndex;

    if (idx !== null) {
      const text = this.cleanForChat(this.chatState.buffer);
      if (text) {
        this.messages[idx].content = [{ type: "text", text }];
      } else if (this.messages[idx].content.length === 0) {
        this.messages.splice(idx, 1);
      }
    }

    // Emit turn completed
    const lastTurn = this.messages[this.messages.length - 1];
    if (lastTurn?.role === "assistant" && lastTurn.content.length > 0) {
      this.emitEvent({
        type: "chat.turn",
        sessionId: this.sessionId,
        timestamp: Date.now(),
        data: { turn: lastTurn, messages: this.messages } as ChatTurnData,
      });
    }

    // Reset state
    this.chatState = {
      phase: "idle",
      buffer: "",
      lastUserInput: "",
      echoSkipped: false,
      assistantIndex: null,
    };

    // Emit idle state
    this.emitEvent({
      type: "output.chat",
      sessionId: this.sessionId,
      timestamp: Date.now(),
      data: { messages: this.messages, isResponding: false } as ChatOutputData,
    });
  }

  // ── Text Processing Utilities ──

  /**
   * Find the end index of the echoed user input in the PTY buffer.
   * The echo may contain ANSI codes between characters.
   * Returns the index after the last character of the echo.
   */
  private findEchoEndIndex(buffer: string, userInput: string): number {
    // Keep alphanumeric and common symbols for matching
    const inputChars = userInput.replace(/[^a-zA-Z0-9+=?!\-]/g, "");
    if (inputChars.length === 0) return 0;

    let matchedChars = 0;
    let endIndex = 0;

    for (let i = 0; i < buffer.length && matchedChars < inputChars.length; i++) {
      const ch = buffer[i];
      // Check if this printable char matches the next expected char
      if (/[a-zA-Z0-9+=?!\-]/.test(ch) && ch.toLowerCase() === inputChars[matchedChars].toLowerCase()) {
        matchedChars++;
        endIndex = i + 1;
      }
      // Skip ANSI codes and other non-matching characters
    }

    // Look for a newline or prompt marker after the echo
    for (let i = endIndex; i < buffer.length && i < endIndex + 50; i++) {
      if (buffer[i] === "\n" || buffer[i] === "\r") {
        endIndex = i + 1;
        break;
      }
    }

    return matchedChars === inputChars.length ? endIndex : 0;
  }

  private cleanForChat(raw: string): string {
    const text = stripAnsi(raw);
    const lines = text.split("\n");
    const cleanLines: string[] = [];

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        if (cleanLines.length > 0 && cleanLines[cleanLines.length - 1] !== "") {
          cleanLines.push("");
        }
        continue;
      }

      if (trimmed === this.chatState.lastUserInput.trim()) {
        continue;
      }

      if (isNoiseLine(trimmed)) {
        continue;
      }

      if (trimmed.startsWith("❯")) {
        continue;
      }

      let normalized = trimmed;
      if (normalized.startsWith("●") || normalized.startsWith("⏺")) {
        normalized = normalized.slice(1).trimStart();
      }

      cleanLines.push(normalized);
    }

    while (cleanLines.length > 0 && cleanLines[cleanLines.length - 1] === "") {
      cleanLines.pop();
    }

    return cleanLines.join("\n");
  }
}
