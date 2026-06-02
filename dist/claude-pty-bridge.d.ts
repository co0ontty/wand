/**
 * ClaudePtyBridge - PTY output parsing and event bridge
 *
 * Transforms raw PTY output into structured events for WebSocket broadcast.
 * Maintains two parallel output streams:
 * 1. Raw output for terminal view (passthrough)
 * 2. Structured messages for chat view (parsed)
 */
import { EventEmitter } from "node:events";
import type { ApprovalPolicy, ConversationTurn, EscalationScope, TaskData } from "./types.js";
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
    /** Timer for delayed auto-approve (gives CLI time to be ready) */
    pendingAutoApproveTimer: ReturnType<typeof setTimeout> | null;
    /** Fallback auto-approve: verification deadline timestamp */
    fallbackVerifyUntil: number;
    /** Fallback auto-approve: context for logging */
    fallbackContext: {
        score: number;
        matched: string[];
        text: string;
    } | null;
    /** Output length snapshot taken right before fallback auto-approve fires */
    fallbackOutputLenAtApprove: number;
    /** Consecutive auto-approve attempts for the same prompt without resolution */
    retryCount: number;
}
/** Permission resolution result */
export type PermissionResolution = "approve_once" | "approve_turn" | "deny";
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
export declare class ClaudePtyBridge extends EventEmitter {
    readonly sessionId: string;
    private rawOutput;
    private messages;
    private chatState;
    private permissionState;
    private sessionIdWindow;
    private claudeSessionId;
    private currentTask;
    private taskDebounceTimer;
    private lastEmittedTask;
    private isClaudeCommand;
    private autoApprove;
    private approvalPolicy;
    private ptyWrite;
    /** Set to true once onExit() has been called; guards against post-exit method calls */
    private _exited;
    private rememberedScopes;
    private rememberedTargets;
    private lastChatEmitAt;
    private chatEmitTimer;
    private lastOutputAt;
    private lastUserInputAt;
    private idleProbeTimer;
    private lastIdleProbeAt;
    constructor(options: ClaudePtyBridgeOptions);
    /**
     * Process a raw PTY chunk.
     * Emits events via EventEmitter.
     */
    processChunk(chunk: string): void;
    /**
     * Called when user sends input.
     * Starts tracking a new assistant response.
     */
    onUserInput(input: string): void;
    /**
     * Called when PTY process exits.
     * Finalizes any pending response.
     */
    onExit(exitCode: number | null): void;
    getMessages(): ConversationTurn[];
    getRawOutput(): string;
    getClaudeSessionId(): string | null;
    isPermissionBlocked(): boolean;
    getPermissionState(): PermissionState;
    getCurrentTask(): TaskData | null;
    /**
     * Set the PTY write function for sending approval input.
     */
    setPtyWrite(fn: (input: string) => void): void;
    /**
     * Toggle auto-approve at runtime.
     */
    setAutoApprove(enabled: boolean): void;
    /**
     * Resolve the current permission prompt.
     * @param resolution - How to resolve the permission
     */
    resolvePermission(resolution: PermissionResolution): void;
    /**
     * Check if a permission scope/target should be auto-approved based on remembered decisions.
     */
    shouldAutoApprove(scope: EscalationScope, target?: string): boolean;
    /**
     * Clear remembered permissions (call at the start of a new turn).
     */
    clearRememberedPermissions(): void;
    /**
     * Clear permission blocked state (called when permission is resolved externally).
     */
    clearPermissionBlocked(): void;
    private emitEvent;
    private isRealChatInput;
    private captureSessionId;
    private detectPermission;
    /**
     * Schedule a delayed auto-approve. The delay gives the Claude CLI's interactive
     * selection prompt time to fully render and enter its input loop before we send \r.
     */
    private scheduleAutoApprove;
    /**
     * Schedule a fallback auto-approve with false-positive verification.
     * Similar to scheduleAutoApprove but sets up post-approve monitoring.
     */
    private scheduleFallbackAutoApprove;
    private cancelPendingAutoApprove;
    /**
     * Reset the idle probe timer. Called on every new output chunk.
     * If the terminal goes idle (no output for IDLE_PROBE_DELAY_MS) while
     * auto-approve is enabled and no permission is currently detected,
     * we send a speculative \r to catch prompts that all detection layers missed.
     */
    private resetIdleProbeTimer;
    private clearIdleProbeTimer;
    /**
     * Idle probe: the terminal has been quiet for a while. If conditions suggest
     * a stuck permission prompt, send a speculative \r and monitor the result.
     */
    private maybeIdleProbe;
    private isPermissionPromptDetected;
    private extractPromptText;
    private extractPermissionTarget;
    private inferScope;
    private parseChatResponse;
    private detectCompletion;
    private static readonly CHAT_THROTTLE_MS;
    private updateAssistantContent;
    private finalizeResponse;
    /**
     * Find the end index of the echoed user input in the PTY buffer.
     * Returns 0 if the echo cannot be fully matched.
     *
     * Why: ANSI escapes and whitespace can interleave the echoed characters
     * (line wrapping, padding, color codes), so matching skips them while
     * comparing every printable codepoint of `userInput` in order.
     */
    private findEchoEndIndex;
    private cleanForChat;
}
export {};
