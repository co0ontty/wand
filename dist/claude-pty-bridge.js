/**
 * ClaudePtyBridge - PTY output parsing and event bridge
 *
 * Transforms raw PTY output into structured events for WebSocket broadcast.
 * Maintains two parallel output streams:
 * 1. Raw output for terminal view (passthrough)
 * 2. Structured messages for chat view (parsed)
 */
import { EventEmitter } from "node:events";
import { stripAnsi, isNoiseLine, appendWindow, normalizePromptText, hasExplicitConfirmSyntax, hasPermissionActionContext, scorePermissionLikelihood, FALLBACK_SCORE_THRESHOLD, isSlashCommandMenu, stripForEchoMatch, skipAnsiSequence, PTY_OUTPUT_MAX_SIZE } from "./pty-text-utils.js";
// ── Constants ──
const OUTPUT_MAX_SIZE = PTY_OUTPUT_MAX_SIZE;
const SESSION_ID_WINDOW_SIZE = 16384;
const PERMISSION_WINDOW_SIZE = 2000;
const AUTO_APPROVE_DELAY_MS = 350;
/** How long to monitor output after fallback auto-approve for false-positive detection */
const FALLBACK_VERIFY_WINDOW_MS = 600;
/** How long a session must be idle (no user input, no new output) before sending a probe */
const IDLE_PROBE_DELAY_MS = 3000;
/** Minimum time between idle probes */
const IDLE_PROBE_COOLDOWN_MS = 5000;
const UUID_PATTERN = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const CLAUDE_SESSION_ID_PATTERNS = [
    new RegExp(`"session_id"\\s*:\\s*"${UUID_PATTERN}"`, "i"),
    new RegExp(`(?:^|\\s)--resume\\s+${UUID_PATTERN}(?:\\s|$)`, "i"),
    new RegExp(`(?:claude\\s+session\\s+id|session\\s+id)\\s*[:#]?\\s*${UUID_PATTERN}`, "i")
];
// ── Helper Functions ──
/** Normalize PTY output (fix line endings) */
function normalizePtyOutput(value) {
    return value.replace(/\r\r\n/g, "\r\n");
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
    sessionId;
    // Output state
    rawOutput;
    messages;
    // Chat parsing state
    chatState;
    // Permission detection state
    permissionState;
    // Session ID capture
    sessionIdWindow;
    claudeSessionId = null;
    // Task tracking
    currentTask = null;
    taskDebounceTimer = null;
    lastEmittedTask = null;
    // Options
    isClaudeCommand;
    autoApprove;
    approvalPolicy;
    ptyWrite;
    /** Set to true once onExit() has been called; guards against post-exit method calls */
    _exited = false;
    // Permission memory for "approve_turn" policy
    rememberedScopes = new Set();
    rememberedTargets = new Set();
    // Chat event throttle
    lastChatEmitAt = 0;
    chatEmitTimer = null;
    // Idle probe state (last-resort robustness)
    lastOutputAt;
    lastUserInputAt;
    idleProbeTimer;
    lastIdleProbeAt;
    constructor(options) {
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
            pendingAutoApproveTimer: null,
            fallbackVerifyUntil: 0,
            fallbackContext: null,
            fallbackOutputLenAtApprove: 0,
            retryCount: 0,
        };
        this.sessionIdWindow = "";
        this.lastOutputAt = 0;
        this.lastUserInputAt = 0;
        this.idleProbeTimer = null;
        this.lastIdleProbeAt = 0;
    }
    // ── Core API ──
    /**
     * Process a raw PTY chunk.
     * Emits events via EventEmitter.
     */
    processChunk(chunk) {
        // Guard against post-exit calls (e.g., late PTY drain data after onExit)
        if (this._exited)
            return;
        // 1. Append to raw output
        this.rawOutput = appendWindow(this.rawOutput, normalizePtyOutput(chunk), OUTPUT_MAX_SIZE);
        this.lastOutputAt = Date.now();
        // 2. Emit raw output event (for terminal view)
        this.emitEvent({
            type: "output.raw",
            sessionId: this.sessionId,
            timestamp: Date.now(),
            data: { chunk, output: this.rawOutput },
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
        // 6. Reset idle probe timer on new output
        if (this.autoApprove && this.isClaudeCommand) {
            this.resetIdleProbeTimer();
        }
    }
    /**
     * Called when user sends input.
     * Starts tracking a new assistant response.
     */
    onUserInput(input) {
        // Guard against post-exit calls
        if (this._exited)
            return;
        this.lastUserInputAt = Date.now();
        // Filter out non-chat input (control chars, etc.)
        if (!this.isRealChatInput(input)) {
            return;
        }
        const cleanInput = input.replace(/[\r\n]+$/, "").trim();
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
            },
        });
    }
    /**
     * Called when PTY process exits.
     * Finalizes any pending response.
     */
    onExit(exitCode) {
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
        // Flush pending chat emit
        if (this.chatEmitTimer) {
            clearTimeout(this.chatEmitTimer);
            this.chatEmitTimer = null;
        }
        // Clear permission state — prevents stale blocked state after exit
        this.cancelPendingAutoApprove();
        this.clearIdleProbeTimer();
        this.permissionState.isBlocked = false;
        this.permissionState.lastPrompt = null;
        this.permissionState.lastScope = null;
        this.permissionState.lastTarget = null;
        this.emitEvent({
            type: "ended",
            sessionId: this.sessionId,
            timestamp: Date.now(),
            data: { exitCode },
        });
    }
    // ── State Accessors ──
    getMessages() {
        return this.messages;
    }
    getRawOutput() {
        return this.rawOutput;
    }
    getClaudeSessionId() {
        return this.claudeSessionId;
    }
    isPermissionBlocked() {
        return this.permissionState.isBlocked;
    }
    getPermissionState() {
        return this.permissionState;
    }
    getCurrentTask() {
        return this.currentTask;
    }
    /**
     * Set the PTY write function for sending approval input.
     */
    setPtyWrite(fn) {
        this.ptyWrite = fn;
    }
    /**
     * Toggle auto-approve at runtime.
     */
    setAutoApprove(enabled) {
        this.autoApprove = enabled;
        if (!enabled) {
            // Cancel any pending auto-approve timer
            if (this.permissionState.pendingAutoApproveTimer) {
                clearTimeout(this.permissionState.pendingAutoApproveTimer);
                this.permissionState.pendingAutoApproveTimer = null;
            }
            // Cancel idle probe
            if (this.idleProbeTimer) {
                clearTimeout(this.idleProbeTimer);
                this.idleProbeTimer = null;
            }
        }
    }
    // ── Permission Resolution ──
    /**
     * Resolve the current permission prompt.
     * @param resolution - How to resolve the permission
     */
    resolvePermission(resolution) {
        // Guard against post-exit calls — ptyWrite may be stale after exit
        if (this._exited)
            return;
        if (!this.permissionState.isBlocked)
            return;
        // Handle "approve_turn" - remember this scope/target for the rest of the turn
        if (resolution === "approve_turn") {
            if (this.permissionState.lastScope) {
                this.rememberedScopes.add(this.permissionState.lastScope);
            }
            if (this.permissionState.lastTarget) {
                this.rememberedTargets.add(this.permissionState.lastTarget);
            }
        }
        // Cancel any pending auto-approve timer (user resolved manually)
        this.cancelPendingAutoApprove();
        // Send approval/denial to PTY
        if (this.ptyWrite) {
            if (resolution === "deny") {
                this.ptyWrite("n\r");
            }
            else {
                this.ptyWrite("\r");
            }
        }
        // Clear state
        this.permissionState.isBlocked = false;
        this.permissionState.window = "";
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
    shouldAutoApprove(scope, target) {
        if (this.rememberedScopes.has(scope))
            return true;
        if (target && this.rememberedTargets.has(target))
            return true;
        return false;
    }
    /**
     * Clear remembered permissions (call at the start of a new turn).
     */
    clearRememberedPermissions() {
        this.rememberedScopes.clear();
        this.rememberedTargets.clear();
    }
    /**
     * Clear permission blocked state (called when permission is resolved externally).
     */
    clearPermissionBlocked() {
        this.cancelPendingAutoApprove();
        this.permissionState.isBlocked = false;
        this.permissionState.window = "";
        this.permissionState.lastPrompt = null;
        this.permissionState.lastScope = null;
        this.permissionState.lastTarget = null;
    }
    // ── Private Implementation ──
    emitEvent(event) {
        this.emit("event", event);
    }
    isRealChatInput(input) {
        const trimmed = input.replace(/[\r\n]+$/, "").trim();
        // Empty or whitespace-only
        if (!trimmed)
            return false;
        // Single control character (Ctrl+C, Ctrl+D, etc.)
        if (trimmed.length === 1 && trimmed.charCodeAt(0) < 32)
            return false;
        // ANSI escape sequences (arrow keys, etc.)
        if (trimmed.startsWith("\x1b"))
            return false;
        // Single "y" or "n" — likely auto-confirm response (Claude only)
        if (this.isClaudeCommand && /^[yn]$/i.test(trimmed))
            return false;
        // Just Enter/CR
        if (trimmed === "\r" || trimmed === "\n")
            return false;
        return true;
    }
    captureSessionId(chunk) {
        if (this.claudeSessionId)
            return;
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
                data: { claudeSessionId: match[1] },
            });
        }
    }
    detectPermission(chunk) {
        if (!this.isClaudeCommand)
            return;
        this.permissionState.window = appendWindow(this.permissionState.window, chunk, PERMISSION_WINDOW_SIZE);
        const normalized = normalizePromptText(this.permissionState.window);
        // ── Fallback false-positive detection ──
        // After a fallback auto-approve, monitor output for signs it was wrong
        if (this.permissionState.fallbackContext) {
            const now = Date.now();
            if (now < this.permissionState.fallbackVerifyUntil) {
                // Check if the output grew with a prompt echo (false positive: \r was consumed as input)
                const outputGrew = this.rawOutput.length > this.permissionState.fallbackOutputLenAtApprove;
                if (outputGrew) {
                    // Check if the new output looks like Claude echoed our empty input (prompt re-appeared)
                    const newOutput = this.rawOutput.slice(this.permissionState.fallbackOutputLenAtApprove);
                    const stripped = stripAnsi(newOutput).trim();
                    // If we see a bare prompt symbol and no permission keywords → likely false positive
                    const looksLikeFalsePositive = /^❯\s*$/.test(stripped)
                        || (stripped.includes("❯") && !this.isPermissionPromptDetected(normalized));
                    if (looksLikeFalsePositive) {
                        const ctx = this.permissionState.fallbackContext;
                        this.emitEvent({
                            type: "permission.resolved",
                            sessionId: this.sessionId,
                            timestamp: now,
                            data: {
                                resolution: "approve_once",
                                autoApproved: true,
                                approveType: "fallback",
                                falsePositive: true,
                                score: ctx.score,
                                matched: ctx.matched,
                                tail: ctx.text,
                            },
                        });
                        this.permissionState.fallbackContext = null;
                        return;
                    }
                }
            }
            else {
                // Verification window expired — assume it was correct
                const ctx = this.permissionState.fallbackContext;
                this.emitEvent({
                    type: "permission.resolved",
                    sessionId: this.sessionId,
                    timestamp: now,
                    data: {
                        resolution: "approve_once",
                        autoApproved: true,
                        approveType: "fallback",
                        falsePositive: false,
                        score: ctx.score,
                        matched: ctx.matched,
                        tail: ctx.text,
                    },
                });
                this.permissionState.fallbackContext = null;
            }
        }
        const blocked = this.isPermissionPromptDetected(normalized);
        // ── Fallback: weighted keyword scoring ──
        // If strict detection missed but auto-approve is on, try scoring
        if (!blocked && !this.permissionState.isBlocked && this.autoApprove) {
            const { score, matched } = scorePermissionLikelihood(normalized);
            if (score >= FALLBACK_SCORE_THRESHOLD) {
                const target = this.extractPermissionTarget(normalized);
                const scope = this.inferScope(normalized, target);
                const lines = normalized.split("\n");
                const tailText = lines.slice(-8).join("\n");
                this.scheduleFallbackAutoApprove(scope, target, { score, matched, text: tailText });
                return;
            }
        }
        // If state hasn't changed, check if a new distinct prompt appeared while already blocked
        if (this.permissionState.isBlocked === blocked) {
            if (blocked) {
                const prompt = this.extractPromptText(normalized);
                if (prompt !== this.permissionState.lastPrompt) {
                    // New permission prompt while already blocked — update and re-process
                    const target = this.extractPermissionTarget(normalized);
                    const scope = this.inferScope(normalized, target);
                    this.permissionState.lastPrompt = prompt;
                    this.permissionState.lastScope = scope;
                    this.permissionState.lastTarget = target ?? null;
                    const shouldAutoApprove = this.autoApprove || this.shouldAutoApprove(scope, target);
                    if (shouldAutoApprove) {
                        this.scheduleAutoApprove(scope, target);
                    }
                    else {
                        this.emitEvent({
                            type: "permission.prompt",
                            sessionId: this.sessionId,
                            timestamp: Date.now(),
                            data: { prompt, scope, target },
                        });
                    }
                }
            }
            return;
        }
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
                this.scheduleAutoApprove(scope, target);
            }
            else {
                // Emit permission prompt event for UI to handle
                this.emitEvent({
                    type: "permission.prompt",
                    sessionId: this.sessionId,
                    timestamp: Date.now(),
                    data: { prompt, scope, target },
                });
            }
        }
        else {
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
    /**
     * Schedule a delayed auto-approve. The delay gives the Claude CLI's interactive
     * selection prompt time to fully render and enter its input loop before we send \r.
     */
    scheduleAutoApprove(scope, target) {
        // Debounce: skip if another auto-approve was recently sent or is pending
        const now = Date.now();
        if (now - this.permissionState.lastAutoConfirmAt < 500)
            return;
        if (this.permissionState.pendingAutoApproveTimer)
            return;
        this.permissionState.lastAutoConfirmAt = now;
        this.permissionState.pendingAutoApproveTimer = setTimeout(() => {
            this.permissionState.pendingAutoApproveTimer = null;
            if (this._exited)
                return;
            if (this.ptyWrite) {
                this.ptyWrite("\r");
            }
            this.permissionState.isBlocked = false;
            this.permissionState.window = "";
            this.permissionState.lastPrompt = null;
            this.permissionState.lastScope = null;
            this.permissionState.lastTarget = null;
            this.emitEvent({
                type: "permission.resolved",
                sessionId: this.sessionId,
                timestamp: Date.now(),
                data: { resolution: "approve_once", autoApproved: true, approveType: "strict" },
            });
            // Schedule a retry check: if the prompt re-appears shortly after,
            // the \r may have arrived before the CLI was ready. Retry with a
            // longer delay to handle slow-rendering selection menus.
            if (this.permissionState.retryCount < 3) {
                const retryDelay = 800 + this.permissionState.retryCount * 400;
                setTimeout(() => {
                    if (this._exited)
                        return;
                    if (this.permissionState.isBlocked && this.autoApprove) {
                        this.permissionState.retryCount++;
                        this.permissionState.lastAutoConfirmAt = 0; // allow immediate retry
                        this.scheduleAutoApprove(scope, target);
                    }
                    else {
                        this.permissionState.retryCount = 0;
                    }
                }, retryDelay);
            }
        }, AUTO_APPROVE_DELAY_MS);
    }
    /**
     * Schedule a fallback auto-approve with false-positive verification.
     * Similar to scheduleAutoApprove but sets up post-approve monitoring.
     */
    scheduleFallbackAutoApprove(scope, target, context) {
        const now = Date.now();
        if (now - this.permissionState.lastAutoConfirmAt < 500)
            return;
        if (this.permissionState.pendingAutoApproveTimer)
            return;
        this.permissionState.lastAutoConfirmAt = now;
        this.permissionState.pendingAutoApproveTimer = setTimeout(() => {
            this.permissionState.pendingAutoApproveTimer = null;
            if (this._exited)
                return;
            // Snapshot output length before sending \r for false-positive detection
            this.permissionState.fallbackOutputLenAtApprove = this.rawOutput.length;
            this.permissionState.fallbackVerifyUntil = Date.now() + FALLBACK_VERIFY_WINDOW_MS;
            this.permissionState.fallbackContext = context;
            if (this.ptyWrite) {
                this.ptyWrite("\r");
            }
            // Don't clear isBlocked/window here — let the verification logic in detectPermission handle it
            this.permissionState.isBlocked = false;
            this.permissionState.window = "";
            this.permissionState.lastPrompt = null;
            this.permissionState.lastScope = null;
            this.permissionState.lastTarget = null;
        }, AUTO_APPROVE_DELAY_MS);
    }
    cancelPendingAutoApprove() {
        if (this.permissionState.pendingAutoApproveTimer) {
            clearTimeout(this.permissionState.pendingAutoApproveTimer);
            this.permissionState.pendingAutoApproveTimer = null;
        }
    }
    // ── Idle Probe (last-resort robustness) ──
    /**
     * Reset the idle probe timer. Called on every new output chunk.
     * If the terminal goes idle (no output for IDLE_PROBE_DELAY_MS) while
     * auto-approve is enabled and no permission is currently detected,
     * we send a speculative \r to catch prompts that all detection layers missed.
     */
    resetIdleProbeTimer() {
        this.clearIdleProbeTimer();
        this.idleProbeTimer = setTimeout(() => {
            this.idleProbeTimer = null;
            this.maybeIdleProbe();
        }, IDLE_PROBE_DELAY_MS);
    }
    clearIdleProbeTimer() {
        if (this.idleProbeTimer) {
            clearTimeout(this.idleProbeTimer);
            this.idleProbeTimer = null;
        }
    }
    /**
     * Idle probe: the terminal has been quiet for a while. If conditions suggest
     * a stuck permission prompt, send a speculative \r and monitor the result.
     */
    maybeIdleProbe() {
        if (this._exited || !this.autoApprove || !this.ptyWrite)
            return;
        // Don't probe if permission is already detected or fallback is pending verification
        if (this.permissionState.isBlocked)
            return;
        if (this.permissionState.fallbackContext)
            return;
        if (this.permissionState.pendingAutoApproveTimer)
            return;
        const now = Date.now();
        // Cooldown between probes
        if (now - this.lastIdleProbeAt < IDLE_PROBE_COOLDOWN_MS)
            return;
        // Don't probe if user recently sent input (they're actively interacting)
        if (now - this.lastUserInputAt < IDLE_PROBE_DELAY_MS)
            return;
        // Only probe if output stopped recently (not ancient idle sessions)
        if (now - this.lastOutputAt > 15000)
            return;
        // Quick heuristic: check if recent output has ANY permission-like keywords
        const normalized = normalizePromptText(this.permissionState.window);
        const { score, matched } = scorePermissionLikelihood(normalized);
        // Lower threshold than fallback — we're being speculative
        if (score < 4)
            return;
        this.lastIdleProbeAt = now;
        // Snapshot output before probe
        this.permissionState.fallbackOutputLenAtApprove = this.rawOutput.length;
        this.permissionState.fallbackVerifyUntil = now + FALLBACK_VERIFY_WINDOW_MS;
        this.permissionState.fallbackContext = {
            score,
            matched,
            text: normalized.split("\n").slice(-8).join("\n"),
        };
        this.ptyWrite("\r");
    }
    isPermissionPromptDetected(normalized) {
        // Slash-command selection menus (/model, /effort, /output-style …) share
        // "Enter to confirm" with permission prompts but must be left alone.
        if (isSlashCommandMenu(normalized))
            return false;
        const hasIntent = /\bdo you want to\b/i.test(normalized)
            || /\bwould you like to\b/i.test(normalized)
            || /\benter to confirm\b/i.test(normalized)
            || /\bgrant\b.*\bpermission\b/i.test(normalized)
            || /\bhaven't granted\b/i.test(normalized);
        const hasConfirmSyntax = hasExplicitConfirmSyntax(normalized);
        const hasActionCtx = hasPermissionActionContext(normalized);
        // For numbered selection prompts (Claude CLI v2+), require the readiness marker
        // "Esc to cancel" / "Tab to amend" which appears only after the full menu is rendered
        // and the input handler is active
        const hasReadyMarker = /\besc\b.*\bcancel\b/i.test(normalized)
            || /\btab\b.*\bamend\b/i.test(normalized);
        // Intent phrase + explicit confirm syntax (e.g. "Do you want to proceed? (yes/no)")
        if (hasIntent && hasConfirmSyntax)
            return true;
        // Intent phrase + action keyword + readiness marker (numbered selection prompts)
        if (hasIntent && hasActionCtx && hasReadyMarker)
            return true;
        // Standalone confirm syntax + action keyword (e.g. "[y/n] Allow bash command")
        if (hasConfirmSyntax && hasActionCtx)
            return true;
        return false;
    }
    extractPromptText(normalized) {
        // Return a snippet around the permission prompt
        const match = normalized.match(/.{0,100}(?:do you want to|permission|grant|enter to confirm|would you like to proceed).{0,100}/i);
        return match?.[0] ?? normalized.slice(-100);
    }
    extractPermissionTarget(normalized) {
        const match = normalized.match(/write to\s+([^,.\n]+)/i)
            || normalized.match(/modify\s+([^,.\n]+)/i)
            || normalized.match(/delete\s+([^,.\n]+)/i)
            || normalized.match(/execute\s+([^,.\n]+)/i);
        return match?.[1]?.trim();
    }
    inferScope(normalized, target) {
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
    parseChatResponse() {
        const clean = stripAnsi(this.chatState.buffer);
        if (!this.chatState.echoSkipped) {
            const echoEndIndex = this.findEchoEndIndex(clean, this.chatState.lastUserInput);
            if (echoEndIndex <= 0) {
                return;
            }
            this.chatState.echoSkipped = true;
            this.chatState.buffer = clean.slice(echoEndIndex);
        }
        if (this.detectCompletion(this.chatState.buffer)) {
            this.finalizeResponse();
            return;
        }
        this.updateAssistantContent();
    }
    detectCompletion(clean) {
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
    static CHAT_THROTTLE_MS = 80;
    updateAssistantContent() {
        const idx = this.chatState.assistantIndex;
        if (idx === null)
            return;
        const text = this.cleanForChat(this.chatState.buffer);
        if (text) {
            this.messages[idx].content = [{ type: "text", text }];
        }
        const now = Date.now();
        if (now - this.lastChatEmitAt < ClaudePtyBridge.CHAT_THROTTLE_MS) {
            if (!this.chatEmitTimer) {
                this.chatEmitTimer = setTimeout(() => {
                    this.chatEmitTimer = null;
                    this.lastChatEmitAt = Date.now();
                    this.emitEvent({
                        type: "output.chat",
                        sessionId: this.sessionId,
                        timestamp: Date.now(),
                        data: {
                            messages: this.messages,
                            streamingIndex: this.chatState.assistantIndex,
                            isResponding: true,
                        },
                    });
                }, ClaudePtyBridge.CHAT_THROTTLE_MS);
            }
            return;
        }
        this.lastChatEmitAt = now;
        this.emitEvent({
            type: "output.chat",
            sessionId: this.sessionId,
            timestamp: Date.now(),
            data: {
                messages: this.messages,
                streamingIndex: idx,
                isResponding: true,
            },
        });
    }
    finalizeResponse() {
        const idx = this.chatState.assistantIndex;
        if (idx !== null) {
            const text = this.cleanForChat(this.chatState.buffer);
            if (text) {
                this.messages[idx].content = [{ type: "text", text }];
            }
            else if (this.messages[idx].content.length === 0) {
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
                data: { turn: lastTurn, messages: this.messages },
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
            data: { messages: this.messages, isResponding: false },
        });
    }
    // ── Text Processing Utilities ──
    /**
     * Find the end index of the echoed user input in the PTY buffer.
     * Returns 0 if the echo cannot be fully matched.
     *
     * Why: ANSI escapes and whitespace can interleave the echoed characters
     * (line wrapping, padding, color codes), so matching skips them while
     * comparing every printable codepoint of `userInput` in order.
     */
    findEchoEndIndex(buffer, userInput) {
        const inputChars = stripForEchoMatch(userInput);
        if (inputChars.length === 0)
            return 0;
        let matchedChars = 0;
        let endIndex = 0;
        let i = 0;
        while (i < buffer.length && matchedChars < inputChars.length) {
            const ch = buffer[i];
            const code = ch.charCodeAt(0);
            // Skip a complete ANSI escape sequence (CSI/OSC/etc.).
            if (code === 0x1b) {
                i = skipAnsiSequence(buffer, i);
                continue;
            }
            // Skip control chars and whitespace — they do not appear in `inputChars`.
            if (code < 0x20 || code === 0x7f || code === 0x20) {
                i++;
                continue;
            }
            if (ch.toLowerCase() === inputChars[matchedChars].toLowerCase()) {
                matchedChars++;
                endIndex = i + 1;
            }
            i++;
        }
        // Look for a newline or prompt marker after the echo
        for (let j = endIndex; j < buffer.length && j < endIndex + 50; j++) {
            if (buffer[j] === "\n" || buffer[j] === "\r") {
                endIndex = j + 1;
                break;
            }
        }
        return matchedChars === inputChars.length ? endIndex : 0;
    }
    cleanForChat(raw) {
        const text = stripAnsi(raw);
        const lines = text.split("\n");
        const cleanLines = [];
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
