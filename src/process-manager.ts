import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import pty, { IPty } from "node-pty";
import { WandStorage } from "./storage.js";
import { SessionLogger } from "./session-logger.js";
import { ContentBlock, ConversationTurn, ExecutionMode, SessionSnapshot, WandConfig } from "./types.js";

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
  /** PTY chat tracking state: idle = waiting for input, responding = assistant is generating */
  ptyChatState: "idle" | "responding";
  /** Accumulated raw PTY output for current assistant response */
  ptyAssistantBuffer: string;
  /** The user input text that was last sent (for skipping echo) */
  ptyLastUserInput: string;
  /** Whether the user input echo has been detected and skipped */
  ptyEchoSkipped: boolean;
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
  private readonly logger: SessionLogger;

  constructor(
    private readonly config: WandConfig,
    private readonly storage: WandStorage,
    configDir?: string
  ) {
    super();
    this.logger = new SessionLogger(configDir || path.join(process.env.HOME || process.cwd(), ".wand"));
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
        childProcess: null,
        ptyChatState: "idle",
        ptyAssistantBuffer: "",
        ptyLastUserInput: "",
        ptyEchoSkipped: false
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
      childProcess: null,
      ptyChatState: "idle",
      ptyAssistantBuffer: "",
      ptyLastUserInput: "",
      ptyEchoSkipped: false
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

      // Track initial input as a user message for Chat mode
      if (this.isRealChatInput(initialInput)) {
        const cleanInput = initialInput.replace(/[\r\n]+$/, "").trim();
        current.messages.push({
          role: "user",
          content: [{ type: "text", text: cleanInput }]
        });
        current.messages.push({
          role: "assistant",
          content: []
        });
        current.ptyChatState = "responding";
        current.ptyAssistantBuffer = "";
        current.ptyLastUserInput = cleanInput;
        current.ptyEchoSkipped = false;
      }

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

      // Log raw PTY output for analysis
      this.logger.appendPtyOutput(id, chunk);

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

      // Track assistant response for Chat mode (PTY sessions)
      if (rec.ptyChatState === "responding") {
        rec.ptyAssistantBuffer += chunk;
        this.trackPtyAssistantResponse(rec);
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
        this.emitEvent({
          type: "output",
          sessionId: id,
          data: {
            chunk: finalChunk,
            output: rec.output,
            messages: rec.messages.length > 0 ? rec.messages : undefined
          }
        });
      }, 30); // 30ms debounce for PTY mode
    });

    child.onExit(({ exitCode }) => {
      const current = this.sessions.get(id);
      if (!current) return;
      // Finalize any pending assistant response before ending
      if (current.ptyChatState === "responding") {
        current.ptyEchoSkipped = true; // Force skip echo on exit
        this.finalizePtyAssistantMessage(current);
      }
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

  sendInput(id: string, input: string, view?: "chat" | "terminal"): SessionSnapshot {
    const record = this.mustGet(id);

    // Native mode: always use JSON chat turn
    // Strip trailing newlines — input from chat UI includes Enter key as "\n"
    if (record.mode === "native") {
      const cleanInput = input.replace(/[\r\n]+$/, "").trim();
      if (cleanInput) {
        return this.runJsonChatTurn(record, cleanInput);
      }
      return this.snapshot(record);
    }

    // Chat view + Claude command → route through native pipeline for structured output
    // This gives Chat mode the same structured messages as native mode, regardless of session mode
    if (view === "chat" && this.isClaudeCommand(record.command) && this.isRealChatInput(input)) {
      return this.runJsonChatTurn(record, input.replace(/[\r\n]+$/, "").trim());
    }

    if (!record.ptyProcess || record.status !== "running") {
      throw new Error("Session is not running.");
    }

    // Track user input as a structured message for Chat mode display (PTY fallback)
    if (this.isRealChatInput(input)) {
      const cleanInput = input.replace(/[\r\n]+$/, "").trim();
      record.messages.push({
        role: "user",
        content: [{ type: "text", text: cleanInput }]
      });
      // Add assistant placeholder for streaming updates
      record.messages.push({
        role: "assistant",
        content: []
      });
      record.ptyChatState = "responding";
      record.ptyAssistantBuffer = "";
      record.ptyLastUserInput = cleanInput;
      record.ptyEchoSkipped = false;
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

    // Build command: claude -p 'message' --output-format stream-json --verbose [--resume sessionId] [--permission-mode acceptEdits]
    // Note: --verbose is required when using --output-format stream-json with --print (Claude CLI only)
    const isClaude = /^claude\b/.test(baseCommand);
    const parts = [baseCommand, "-p", `'${escapedMessage}'`, "--output-format", "stream-json"];
    if (isClaude) parts.push("--verbose");

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
    // Store usage data from result event (attached as a property on the blocks array)
    (assistantBlocks as unknown as Record<string, unknown>)._lastUsage = null;

    // Add assistant placeholder immediately so frontend has both messages during streaming
    const assistantIndex = record.messages.length;
    record.messages.push({
      role: "assistant",
      content: []
    });

    // Debounce rapid output to reduce flicker during streaming
    let outputDebounceTimer: NodeJS.Timeout | null = null;
    let pendingOutput = false;

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

          // Log native mode event for analysis
          this.logger.appendStreamEvent(record.id, event);

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

      if (hasNewContent) {
        // Update assistant message content from collected blocks during streaming
        if (assistantBlocks.length > 0) {
          record.messages[assistantIndex].content = this.buildContentBlocks(assistantBlocks);
        }
        this.persist(record);
        pendingOutput = true;

        // Debounce output events to reduce WebSocket flooding
        if (outputDebounceTimer) {
          clearTimeout(outputDebounceTimer);
        }
        outputDebounceTimer = setTimeout(() => {
          outputDebounceTimer = null;
          if (pendingOutput) {
            pendingOutput = false;
            this.emitEvent({ type: "output", sessionId: record.id, data: { chunk: "", output: record.output, messages: record.messages } });
          }
        }, 50); // 50ms debounce for native mode
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

      // Finalize assistant message - update the placeholder we created
      if (assistantBlocks.length > 0) {
        record.messages[assistantIndex].content = this.buildContentBlocks(assistantBlocks);
      }

      // Extract and apply token usage from result event
      const blocksMeta = assistantBlocks as unknown as Record<string, unknown>;
      const lastUsage = blocksMeta._lastUsage as Record<string, unknown> | null;
      if (lastUsage) {
        record.messages[assistantIndex].usage = {
          inputTokens: lastUsage.input_tokens as number | undefined,
          outputTokens: lastUsage.output_tokens as number | undefined,
          cacheReadInputTokens: lastUsage.cache_read_input_tokens as number | undefined,
          cacheCreationInputTokens: lastUsage.cache_creation_input_tokens as number | undefined,
          totalCostUsd: lastUsage._totalCostUsd as number | undefined,
        };
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
    event: { type?: string; message?: { role?: string; content?: unknown[] }; content_block?: { type?: string; [key: string]: unknown }; delta?: { type?: string; text?: string; partial_json?: string; thinking?: string }; result?: unknown; usage?: Record<string, unknown>; total_cost_usd?: number; modelUsage?: Record<string, Record<string, unknown>>; [key: string]: unknown },
    assistantBlocks: Array<{ type: string; [key: string]: unknown }>
  ): void {
    switch (event.type) {
      case "assistant": {
        // Assistant message — may arrive as multiple separate events (e.g. thinking block first, text block second)
        // Merge new blocks that aren't yet in assistantBlocks
        const msg = event.message;
        if (msg?.content && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block && typeof block === "object" && "type" in block) {
              const blockType = (block as { type: string }).type;
              // Check if this block type already exists in assistantBlocks
              const existing = assistantBlocks.findIndex((b) => b.type === blockType);
              if (existing >= 0) {
                // Update existing block — merge fields (e.g. thinking → text transition)
                Object.assign(assistantBlocks[existing], block);
              } else {
                // New block type — add it
                assistantBlocks.push(block as { type: string; [key: string]: unknown });
                this.appendBlockToOutput(record, block as { type: string; [key: string]: unknown });
              }
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
        // Final result event — `event.result` can be a string or an object with `result` + `content`
        const resultStr = typeof event.result === "string" ? event.result : (event.result as Record<string, unknown>)?.result as string | undefined;

        if (typeof event.result === "object" && event.result !== null) {
          const result = event.result as { content?: unknown[] };
          if (result.content && Array.isArray(result.content)) {
            for (const block of result.content) {
              if (block && typeof block === "object" && "type" in block) {
                const blockType = (block as { type: string }).type;
                const existing = assistantBlocks.findIndex((b) => b.type === blockType);
                if (existing >= 0) {
                  Object.assign(assistantBlocks[existing], block);
                } else {
                  assistantBlocks.push(block as { type: string; [key: string]: unknown });
                  this.appendBlockToOutput(record, block as { type: string; [key: string]: unknown });
                }
              }
            }
          }
        }

        // Use the result string as text if no text block exists yet
        if (resultStr) {
          const hasTextBlock = assistantBlocks.some((b) => b.type === "text");
          if (!hasTextBlock) {
            const textBlock = { type: "text", text: resultStr };
            assistantBlocks.push(textBlock);
            this.appendBlockToOutput(record, textBlock);
          } else {
            // Update existing text block with final result
            const textBlock = assistantBlocks.find((b) => b.type === "text");
            if (textBlock) {
              textBlock.text = resultStr;
            }
          }
        }

        // Capture token usage from result event (store in assistantBlocks metadata)
        if (event.usage || event.total_cost_usd) {
          const usage: Record<string, unknown> = {};
          if (event.usage) Object.assign(usage, event.usage);
          if (event.total_cost_usd !== undefined) {
            usage._totalCostUsd = event.total_cost_usd;
          }
          (assistantBlocks as unknown as Record<string, unknown>)._lastUsage = usage;
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

  private buildContentBlocks(blocks: Array<{ type: string; [key: string]: unknown }>): ContentBlock[] {
    return blocks.map((b) => {
      switch (b.type) {
        case "text":
          return { type: "text" as const, text: (b.text as string) || "" };
        case "thinking":
          return { type: "thinking" as const, thinking: (b.thinking as string) || "" };
        case "tool_use": {
          let input = b.input as Record<string, unknown> || {};
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
  }

  private buildAssistantTurn(blocks: Array<{ type: string; [key: string]: unknown }>): ConversationTurn {
    return { role: "assistant", content: this.buildContentBlocks(blocks) };
  }

  // ── PTY Chat Tracking helpers ──

  /** Determine if input looks like a real chat message (not control characters) */
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

  /** Check if a command is a Claude CLI command */
  private isClaudeCommand(command: string): boolean {
    const trimmed = command.trim();
    return /^claude\b/.test(trimmed);
  }

  /** Strip ANSI escape sequences from raw PTY output */
  private stripAnsiSequences(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")   // CSI sequences
      .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "") // OSC sequences
      .replace(/\x1b[><=ePX^_]/g, "")              // Single-char escapes
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "") // Control chars (keep \t \n \r)
      .replace(/\r\n?/g, "\n");
  }

  /** Track and update assistant response from PTY output */
  private trackPtyAssistantResponse(record: SessionRecord): void {
    const clean = this.stripAnsiSequences(record.ptyAssistantBuffer);

    // Phase 1: Skip user input echo
    if (!record.ptyEchoSkipped) {
      // Look for the user's input text in the cleaned output (it's the PTY echo)
      const echoIdx = clean.indexOf(record.ptyLastUserInput);
      if (echoIdx !== -1) {
        record.ptyEchoSkipped = true;
        // Don't try to trim the raw buffer — cleanPtyOutputForChat will filter the echo line.
        // The echo line starts with ❯ which is already filtered by cleanPtyOutputForChat.
      }
      // Don't update assistant content until echo is skipped
      return;
    }

    // Phase 2: Check if assistant is done (❯ prompt reappeared)
    const lines = clean.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("❯")) {
        const afterPrompt = trimmed.slice(1).trim();
        // Standalone ❯ or ❯ with prompt suggestions = assistant done
        if (!afterPrompt || afterPrompt.startsWith("Try")) {
          this.finalizePtyAssistantMessage(record);
          return;
        }
        break;
      }
    }

    // Phase 3: Update assistant content progressively during streaming
    this.updatePtyAssistantContent(record);
  }

  /** Update the assistant placeholder message with cleaned PTY content */
  private updatePtyAssistantContent(record: SessionRecord): void {
    const lastMsg = record.messages[record.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;

    const text = this.cleanPtyOutputForChat(record.ptyAssistantBuffer);
    if (text) {
      lastMsg.content = [{ type: "text", text }];
    }
  }

  /** Finalize the assistant message when ❯ prompt is detected */
  private finalizePtyAssistantMessage(record: SessionRecord): void {
    const lastMsg = record.messages[record.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;

    const text = this.cleanPtyOutputForChat(record.ptyAssistantBuffer);
    if (text) {
      lastMsg.content = [{ type: "text", text }];
    } else if (lastMsg.content.length === 0) {
      // Remove empty assistant placeholder if no content was captured
      record.messages.pop();
    }

    record.ptyChatState = "idle";
    record.ptyAssistantBuffer = "";
    record.ptyLastUserInput = "";
    record.ptyEchoSkipped = false;
    process.stderr.write(`[wand] PTY assistant response finalized (${record.messages.length} messages)\n`);
  }

  /** Clean raw PTY output into readable chat content */
  private cleanPtyOutputForChat(raw: string): string {
    const text = this.stripAnsiSequences(raw);
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

    const cleanLines = lines.filter(line => {
      // Noise filters (same as frontend parseMessages but server-side)
      if (line.startsWith("────")) return false;
      if (line === "❯") return false;
      if (line.startsWith("❯")) return false;
      if (line.includes("esc to interrupt")) return false;
      if (line.includes("Claude Code v")) return false;
      if (/^Sonnet\b/.test(line)) return false;
      if (line.startsWith("~/")) return false;
      if (line.includes("● high")) return false;
      if (line.includes("Failed to install Anthropic")) return false;
      if (line.includes("Claude Code has switched")) return false;
      if (line.includes("Fluttering")) return false;
      if (line.includes("? for shortcuts")) return false;
      if (line.startsWith("0;") || line.startsWith("9;")) return false;
      if (line.includes("Claude is waiting")) return false;
      if (/[✢✳✶✻✽]/.test(line)) return false;
      if (/^[▐▝▘]/.test(line)) return false;
      if (["lu", "ue", "tr", "ti", "g", "n", "i…", "…", "uts", "lt", "rg", "·"].includes(line) && line.length < 4) return false;
      if (line.startsWith("✽F") || line.startsWith("✻F")) return false;
      if (line.includes("[wand]")) return false;
      if (line.includes("Captured Claude session ID")) return false;
      if (line.includes("⏵")) return false;
      if (line.includes("acceptedit")) return false;
      if (line.includes("shift+tab")) return false;
      if (line.includes("tabtocycle")) return false;
      if (line.includes("ctrl+g")) return false;
      if (line.includes("/effort")) return false;
      if (line.includes("Opus") && line.includes("model")) return false;
      if (line.includes("Haiku")) return false;
      if (line.includes("to cycle")) return false;
      if (/\bhigh\s*·/.test(line) || /\bmedium\s*·/.test(line) || /\blow\s*·/.test(line)) return false;
      if (line.includes("thinking with")) return false;
      if (/^thought for \d+/.test(line)) return false;
      if (line.includes("Germinating") || line.includes("Doodling") || line.includes("Brewing")) return false;
      if (line.includes("npm WARN") || line.includes("npm notice")) return false;
      if (/^Using .* for .* session/.test(line)) return false;
      if (line.includes("Permissions") && line.includes("mode")) return false;
      if (line.includes("You can use")) return false;
      if (line.startsWith("Press ") && line.includes(" for")) return false;
      if (line.startsWith("type ") && line.includes(" to ")) return false;
      if (line.length < 3 && !/^[a-zA-Z]{3}$/.test(line)) return false;
      // Strip bullet prefix and keep content
      if (line.startsWith("●")) {
        return line.slice(1).trim().length > 0;
      }
      return true;
    }).map(line => {
      // Clean bullet prefix
      if (line.startsWith("●")) return line.slice(1).trim();
      // Clean ⏺ prefix (Claude TUI response marker)
      if (line.startsWith("⏺")) return line.slice(1).trim();
      return line;
    });

    return cleanLines.join("\n").trim();
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
    // Save structured messages to file for analysis
    if (record.messages.length > 0) {
      this.logger.saveMessages(record.id, record.messages);
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
