import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import pty, { IPty } from "node-pty";
import { WandStorage } from "./storage.js";
import { ConversationTurn, ExecutionMode, SessionSnapshot, WandConfig } from "./types.js";

export interface ProcessEvent {
  type: "output" | "status" | "started" | "ended";
  sessionId: string;
  data?: unknown;
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
  lastAutoConfirmAt: number;
  /** 用于解析会话 ID 的输出窗口 */
  sessionIdWindow: string;
  /** 从存储加载的初始输出（用于重启后恢复） */
  storedOutput: string;
  /** Structured conversation messages (JSON chat mode) */
  messages: ConversationTurn[];
  /** Whether a JSON chat turn is currently in progress */
  jsonChatBusy: boolean;
  /** Child process reference for native mode (for cleanup) */
  childProcess: import("node:child_process").ChildProcess | null;
}

const MAX_SESSIONS = 50;
const ARCHIVE_AFTER_MS = 1000 * 60 * 60 * 24;
const OUTPUT_WINDOW_SIZE = 4096;
const CONFIRM_WINDOW_SIZE = 800;
const OUTPUT_MAX_SIZE = 120000;

// Claude 会话 ID 格式：UUID v4
const CLAUDE_SESSION_ID_PATTERN = /"session_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

/** Append text to a windowed buffer, trimming from start if over max size. */
function appendWindow(buffer: string, chunk: string, maxSize: number): string {
  const next = buffer + chunk;
  return next.length > maxSize ? next.slice(-maxSize) : next;
}

export class ProcessManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly config: WandConfig,
    private readonly storage: WandStorage
  ) {
    super();
    for (const snapshot of this.storage.loadSessions()) {
      this.sessions.set(snapshot.id, {
        ...snapshot,
        processId: null,
        ptyProcess: null,
        stopRequested: false,
        confirmWindow: "",
        lastAutoConfirmAt: 0,
        sessionIdWindow: "",
        storedOutput: snapshot.output,
        messages: snapshot.messages ?? [],
        jsonChatBusy: false,
        childProcess: null
      });
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
    const record: SessionRecord = {
      id,
      command,
      cwd: resolvedCwd,
      mode,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      output: "",
      archived: false,
      archivedAt: null,
      claudeSessionId: null,
      processId: null,
      ptyProcess: null,
      stopRequested: false,
      confirmWindow: "",
      lastAutoConfirmAt: 0,
      sessionIdWindow: "",
      storedOutput: "",
      messages: [],
      jsonChatBusy: false,
      childProcess: null
    };

    this.sessions.set(id, record);
    this.persist(record);
    this.cleanupOldSessions();

    // Emit started event
    this.emitEvent({ type: "started", sessionId: id, data: this.snapshot(record) });

    // For native mode, skip PTY creation — sendInput() will spawn child processes directly
    if (mode === "native") {
      // If there's an initial input, kick off the first JSON chat turn
      if (initialInput) {
        this.runJsonChatTurn(record, initialInput);
      }
      return this.snapshot(record);
    }

    const shellArgs = this.buildShellArgs(processedCommand);
    const child = pty.spawn(this.config.shell, shellArgs, {
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

    record.processId = child.pid;
    record.ptyProcess = child;

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
      current.ptyProcess.write(initialInput);
      // \n advances to a new line so subsequent output doesn't overwrite this input
      current.ptyProcess.write("\n");
    };

    // Debounce rapid PTY output events to reduce WebSocket flooding
    let outputDebounceTimer: NodeJS.Timeout | null = null;
    let pendingChunk = "";

    child.onData((chunk: string) => {
      const rec = this.sessions.get(id);
      if (!rec) return;

      rec.output = appendWindow(rec.output, normalizePtyOutput(chunk), OUTPUT_MAX_SIZE);

      // Capture Claude session ID from output
      if (!rec.claudeSessionId) {
        rec.sessionIdWindow = appendWindow(rec.sessionIdWindow, chunk, OUTPUT_WINDOW_SIZE);
        const match = CLAUDE_SESSION_ID_PATTERN.exec(rec.sessionIdWindow);
        if (match?.[1]) {
          rec.claudeSessionId = match[1];
          process.stderr.write(`[wand] Captured Claude session ID: ${match[1]}\n`);
          this.persist(rec);
        }
      }

      if (mode === "full-access") {
        this.autoConfirmWithRecord(rec, chunk, child);
      }

      if (initialInput && !initialInputSent && chunk.includes("❯")) {
        sendInitialInput();
      }

      // Batch rapid output chunks to reduce WebSocket messages
      pendingChunk += chunk;
      if (outputDebounceTimer) {
        clearTimeout(outputDebounceTimer);
      }
      outputDebounceTimer = setTimeout(() => {
        const finalChunk = pendingChunk;
        pendingChunk = "";
        outputDebounceTimer = null;
        this.persist(rec);
        this.emitEvent({ type: "output", sessionId: id, data: { chunk: finalChunk, output: rec.output } });
      }, 30); // 30ms debounce for PTY mode
    });

    child.onExit(({ exitCode }) => {
      const current = this.sessions.get(id);
      if (!current) return;
      current.status = current.stopRequested ? "stopped" : exitCode === 0 ? "exited" : "failed";
      current.exitCode = current.stopRequested ? null : exitCode;
      current.endedAt = new Date().toISOString();
      current.ptyProcess = null;
      this.persist(current);
      this.emitEvent({ type: "ended", sessionId: id, data: this.snapshot(current) });
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

  sendInput(id: string, input: string): SessionSnapshot {
    const record = this.mustGet(id);

    // Native mode: use JSON chat turn (claude -p --output-format stream-json)
    if (record.mode === "native") {
      return this.runJsonChatTurn(record, input);
    }

    if (!record.ptyProcess || record.status !== "running") {
      throw new Error("Session is not running.");
    }
    // Ensure input advances to a new line so subsequent PTY output doesn't overwrite it
    record.ptyProcess.write(input);
    if (!input.endsWith("\n")) {
      record.ptyProcess.write("\n");
    }
    this.persist(record);
    return this.snapshot(record);
  }

  private runJsonChatTurn(record: SessionRecord, message: string): SessionSnapshot {
    if (record.jsonChatBusy) {
      // Queue or reject — for now just ignore until previous turn finishes
      process.stderr.write(`[wand] JSON chat turn already in progress for ${record.id}, ignoring\n`);
      return this.snapshot(record);
    }
    record.jsonChatBusy = true;
    record.status = "running";

    const baseCommand = record.command.trim();
    const escapedMessage = message.replace(/'/g, "'\\''");

    // Build command: claude -p 'message' --output-format stream-json [--resume sessionId] [--permission-mode acceptEdits]
    const parts = [baseCommand, "-p", `'${escapedMessage}'`, "--output-format", "stream-json"];

    if (record.claudeSessionId) {
      parts.push("--resume", record.claudeSessionId);
    }

    // Add permission mode for full-access
    if (/^claude\s/.test(baseCommand) && !/--permission-mode\b/.test(baseCommand)) {
      parts.push("--permission-mode", "acceptEdits");
    }

    const nativeCommand = parts.join(" ");
    process.stderr.write(`[wand] Running JSON chat turn: ${nativeCommand}\n`);

    // Add user message to conversation
    record.messages.push({
      role: "user",
      content: [{ type: "text", text: message }]
    });

    // Also append to raw output for terminal view
    record.output = appendWindow(record.output, `\n❯ ${message}\n`, OUTPUT_MAX_SIZE);
    this.persist(record);
    this.emitEvent({ type: "output", sessionId: record.id, data: { chunk: `\n❯ ${message}\n`, output: record.output, messages: record.messages } });

    const child = spawn(nativeCommand, [], {
      cwd: record.cwd,
      env: {
        ...process.env,
        WAND_MODE: "native",
        TERM: process.env.TERM || "xterm-256color"
      },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    // Store child process reference for cleanup
    record.childProcess = child;

    // Collect NDJSON lines from stdout
    let stdoutBuffer = "";
    const assistantBlocks: Array<{ type: string; [key: string]: unknown }> = [];
    let turnSessionId: string | null = null;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBuffer += text;

      // Process complete NDJSON lines
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || ""; // Keep incomplete last line in buffer

      let hasNewContent = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const event = JSON.parse(trimmed);
          this.processJsonEvent(record, event, assistantBlocks);

          // Extract session_id from any event that has it
          if (event.session_id && !turnSessionId) {
            turnSessionId = event.session_id;
          }
          hasNewContent = true;
        } catch {
          // Not valid JSON — might be debug output, append to raw output
          record.output = appendWindow(record.output, trimmed + "\n", OUTPUT_MAX_SIZE);
          hasNewContent = true;
        }
      }

      this.persist(record);
      // Only emit output event if there's actual new content
      if (hasNewContent) {
        this.emitEvent({ type: "output", sessionId: record.id, data: { chunk: text, output: record.output, messages: record.messages } });
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      record.output = appendWindow(record.output, text, OUTPUT_MAX_SIZE);
      this.persist(record);
      this.emitEvent({ type: "output", sessionId: record.id, data: { chunk: text, output: record.output, messages: record.messages } });
    });

    child.on("close", (code: number | null) => {
      // Process any remaining buffer
      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer.trim());
          this.processJsonEvent(record, event, assistantBlocks);
          if (event.session_id && !turnSessionId) {
            turnSessionId = event.session_id;
          }
        } catch {
          record.output = appendWindow(record.output, stdoutBuffer, OUTPUT_MAX_SIZE);
        }
      }

      // Finalize assistant turn if we collected any blocks
      if (assistantBlocks.length > 0) {
        // Build the assistant turn from collected blocks
        const turn = this.buildAssistantTurn(assistantBlocks);
        record.messages.push(turn);
      }

      // Update session ID for multi-turn resume
      if (turnSessionId) {
        record.claudeSessionId = turnSessionId;
        process.stderr.write(`[wand] Captured Claude session ID: ${turnSessionId}\n`);
      }

      record.jsonChatBusy = false;
      // Native mode: session stays "running" to accept more turns, unless stop was requested
      if (record.stopRequested) {
        record.status = "stopped";
        record.endedAt = new Date().toISOString();
      } else if (code !== 0 && code !== null) {
        // Non-zero exit but don't end the session — just log it
        process.stderr.write(`[wand] JSON chat turn exited with code ${code}\n`);
      }
      // Session stays running for more turns

      this.persist(record);
      this.emitEvent({ type: "output", sessionId: record.id, data: { chunk: "", output: record.output, messages: record.messages } });
    });

    child.on("error", (err: Error) => {
      const errMsg = `\n[wand] Error: ${err.message}\n`;
      record.output = appendWindow(record.output, errMsg, OUTPUT_MAX_SIZE);
      record.jsonChatBusy = false;
      this.persist(record);
      this.emitEvent({ type: "output", sessionId: record.id, data: { chunk: errMsg, output: record.output, messages: record.messages } });
    });

    this.persist(record);
    return this.snapshot(record);
  }

  private processJsonEvent(
    record: SessionRecord,
    event: { type?: string; message?: { role?: string; content?: unknown[] }; content_block?: { type?: string; [key: string]: unknown }; delta?: { type?: string; text?: string; partial_json?: string; thinking?: string }; [key: string]: unknown },
    assistantBlocks: Array<{ type: string; [key: string]: unknown }>
  ): void {
    switch (event.type) {
      case "assistant": {
        // Full assistant message — only use if we haven't collected blocks from streaming
        const msg = event.message;
        if (msg?.content && Array.isArray(msg.content) && assistantBlocks.length === 0) {
          for (const block of msg.content) {
            if (block && typeof block === "object" && "type" in block) {
              assistantBlocks.push(block as { type: string; [key: string]: unknown });
              this.appendBlockToOutput(record, block as { type: string; [key: string]: unknown });
            }
          }
        }
        break;
      }
      case "content_block_start": {
        // Streaming: new content block starting
        if (event.content_block) {
          assistantBlocks.push({ ...event.content_block } as { type: string; [key: string]: unknown });
        }
        break;
      }
      case "content_block_delta": {
        // Streaming: delta for the current block
        if (event.delta) {
          const lastBlock = assistantBlocks[assistantBlocks.length - 1];
          if (lastBlock) {
            if (event.delta.text) {
              lastBlock.text = (lastBlock.text as string || "") + event.delta.text;
              record.output = appendWindow(record.output, event.delta.text, OUTPUT_MAX_SIZE);
            }
            if (event.delta.partial_json) {
              lastBlock._partialJson = (lastBlock._partialJson as string || "") + event.delta.partial_json;
            }
            if (event.delta.thinking) {
              lastBlock.thinking = (lastBlock.thinking as string || "") + event.delta.thinking;
            }
          }
        }
        break;
      }
      case "result": {
        // Final result event — may contain full message and session_id
        if (event.result && typeof event.result === "object") {
          const result = event.result as { content?: unknown[] };
          if (result.content && Array.isArray(result.content)) {
            // If we haven't collected blocks from streaming, use the result
            if (assistantBlocks.length === 0) {
              for (const block of result.content) {
                if (block && typeof block === "object" && "type" in block) {
                  assistantBlocks.push(block as { type: string; [key: string]: unknown });
                  this.appendBlockToOutput(record, block as { type: string; [key: string]: unknown });
                }
              }
            }
          }
        }
        break;
      }
      // system, error, etc. — just log
      default:
        break;
    }
  }

  private appendBlockToOutput(record: SessionRecord, block: { type: string; [key: string]: unknown }): void {
    switch (block.type) {
      case "text":
        record.output = appendWindow(record.output, (block.text as string) + "\n", OUTPUT_MAX_SIZE);
        break;
      case "thinking":
        record.output = appendWindow(record.output, "[thinking...]\n", OUTPUT_MAX_SIZE);
        break;
      case "tool_use":
        record.output = appendWindow(
          record.output,
          `[tool: ${block.name as string}]\n`,
          OUTPUT_MAX_SIZE
        );
        break;
      case "tool_result":
        record.output = appendWindow(
          record.output,
          `[tool result: ${(block.content as string || "").slice(0, 200)}]\n`,
          OUTPUT_MAX_SIZE
        );
        break;
    }
  }

  private buildAssistantTurn(blocks: Array<{ type: string; [key: string]: unknown }>): ConversationTurn {
    const contentBlocks = blocks.map((b) => {
      switch (b.type) {
        case "text":
          return { type: "text" as const, text: (b.text as string) || "" };
        case "thinking":
          return { type: "thinking" as const, thinking: (b.thinking as string) || "" };
        case "tool_use": {
          let input = b.input as Record<string, unknown> || {};
          // If we accumulated partial JSON, parse it
          if (b._partialJson && typeof b._partialJson === "string") {
            try { input = JSON.parse(b._partialJson); } catch { /* keep original */ }
          }
          return {
            type: "tool_use" as const,
            id: (b.id as string) || "",
            name: (b.name as string) || "",
            input
          };
        }
        case "tool_result":
          return {
            type: "tool_result" as const,
            tool_use_id: (b.tool_use_id as string) || "",
            content: (b.content as string) || "",
            is_error: (b.is_error as boolean) || false
          };
        default:
          return { type: "text" as const, text: JSON.stringify(b) };
      }
    });

    return { role: "assistant", content: contentBlocks };
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

    try {
      record.stopRequested = true;
      // For native mode, kill the child process
      if (record.mode === "native" && record.childProcess) {
        record.childProcess.kill();
        record.childProcess = null;
      }
      // For PTY mode, kill the pty process
      if (record.ptyProcess) {
        record.ptyProcess.kill();
      }
    } catch {
      record.status = "failed";
      record.endedAt = new Date().toISOString();
      record.output += "\n[wand] Failed to stop session cleanly.\n";
    }

    this.persist(record);
    return this.snapshot(record);
  }

  delete(id: string): void {
    const record = this.mustGet(id);
    if (record.status === "running") {
      try {
        record.stopRequested = true;
        // For native mode, kill the child process
        if (record.mode === "native" && record.childProcess) {
          record.childProcess.kill();
          record.childProcess = null;
        }
        // For PTY mode, kill the pty process
        if (record.ptyProcess) {
          record.ptyProcess.kill();
        }
      } catch {
        // Ignore and continue deleting persisted state.
      }
    }
    this.sessions.delete(id);
    this.storage.deleteSession(id);
  }

  async runStartupCommands(): Promise<SessionSnapshot[]> {
    return this.config.startupCommands.map((command) =>
      this.start(command, this.config.defaultCwd, this.config.defaultMode)
    );
  }

  private snapshot(record: SessionRecord): SessionSnapshot {
    return {
      id: record.id,
      command: record.command,
      cwd: record.cwd,
      mode: record.mode,
      status: record.status,
      exitCode: record.exitCode,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      output: record.output,
      archived: record.archived,
      archivedAt: record.archivedAt,
      claudeSessionId: record.claudeSessionId,
      messages: record.messages.length > 0 ? record.messages : undefined
    };
  }

  private persist(record: SessionRecord): void {
    this.storage.saveSession(this.snapshot(record));
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
      process.stderr.write(`[wand] Auto-confirming prompt in full-access mode\n`);
      // For Claude Code's selection UI, Enter confirms the selected option
      // For other prompts, "y" + Enter confirms
      if (trustFolderPrompt || claudeConfirmPrompt || toolPermissionPrompt || isSelectionPrompt) {
        ptyProcess.write("\r");
      } else {
        ptyProcess.write("y\r");
      }
    }
  }

  private mustGet(id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) {
      throw new Error("Session not found.");
    }
    return record;
  }

  private buildShellArgs(command: string): string[] {
    if (os.platform() === "win32") {
      return ["/d", "/s", "/c", command];
    }
    return ["-ic", command];
  }

  private processCommandForMode(command: string, mode: ExecutionMode): string {
    // For full-access mode with claude commands, add permission flags
    if (mode === "full-access" && /^claude\s/.test(command)) {
      // Check if permission-mode is already specified
      if (!/--permission-mode\b/.test(command)) {
        // Add --permission-mode acceptEdits for full-access mode
        return command.replace(/^claude\s/, "claude --permission-mode acceptEdits ");
      }
    }
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

function normalizePtyOutput(value: string): string {
  return value.replace(/\r\r\n/g, "\r\n");
}

function clampDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
