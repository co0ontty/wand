export type ExecutionMode = "assist" | "agent" | "agent-max" | "default" | "auto-edit" | "full-access" | "native" | "managed";

export type AutonomyPolicy = "assist" | "agent" | "agent-max";
export type ApprovalPolicy = "ask-every-time" | "approve-once" | "remember-this-turn";
export type EscalationScope = "write_file" | "run_command" | "network" | "outside_workspace" | "dangerous_shell" | "unknown";
export type EscalationRunner = "json" | "pty";
export type EscalationResolution = "approve_once" | "approve_turn" | "deny" | "fallback_manual";
export type EscalationSource = "tool_permission_request" | "sandbox_hard_block" | "workspace_policy_limit" | "cli_capability_limit" | "unknown";

export interface EscalationRequest {
  requestId: string;
  scope: EscalationScope;
  runner: EscalationRunner;
  source: EscalationSource;
  resolution?: EscalationResolution;
  target?: string;
  reason: string;
}

export interface TurnRequest {
  message: string;
  autonomyPolicy?: AutonomyPolicy;
  approvalPolicy?: ApprovalPolicy;
  allowedScopes?: EscalationScope[];
}

export interface EscalationDecisionRequest {
  resolution?: Extract<EscalationResolution, "approve_once" | "approve_turn" | "deny">;
}

export interface CommandPreset {
  label: string;
  command: string;
  mode?: ExecutionMode;
}

export interface WandConfig {
  host: string;
  port: number;
  /** Enable HTTPS with self-signed certificate (default: true) */
  https?: boolean;
  password: string;
  defaultMode: ExecutionMode;
  shell: string;
  defaultCwd: string;
  startupCommands: string[];
  allowedCommandPrefixes: string[];
  commandPresets: CommandPreset[];
}

export interface CommandRequest {
  command: string;
  cwd?: string;
  mode?: ExecutionMode;
  initialInput?: string;
}

export interface InputRequest {
  input?: string;
  /** Current UI view: "chat" or "terminal". Chat view uses PTY-derived structured messages. */
  view?: "chat" | "terminal";
  autonomyPolicy?: AutonomyPolicy;
  approvalPolicy?: ApprovalPolicy;
  allowedScopes?: EscalationScope[];
  turn?: TurnRequest;
}

export interface ResizeRequest {
  cols?: number;
  rows?: number;
}

export interface PathSuggestion {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface GitFileStatus {
  staged?: 'modified' | 'added' | 'deleted' | 'renamed';
  unstaged?: 'modified' | 'deleted';
  untracked?: boolean;
}

export interface FileEntry {
  path: string;
  name: string;
  type: 'dir' | 'file';
  gitStatus?: GitFileStatus;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// ── Structured chat message types derived from PTY output ──

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  description?: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface ConversationTurn {
  role: "user" | "assistant";
  content: ContentBlock[];
  /** Optional usage metadata when available from the underlying tool. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    totalCostUsd?: number;
  };
}

export interface SessionSnapshot {
  id: string;
  command: string;
  cwd: string;
  mode: ExecutionMode;
  autonomyPolicy?: AutonomyPolicy;
  approvalPolicy?: ApprovalPolicy;
  allowedScopes?: EscalationScope[];
  status: "running" | "exited" | "failed" | "stopped";
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  output: string;
  archived: boolean;
  archivedAt: string | null;
  /** Backward-compatible derived flag from pendingEscalation */
  permissionBlocked?: boolean;
  pendingEscalation?: EscalationRequest | null;
  lastEscalationResult?: {
    requestId: string;
    resolution: EscalationResolution;
    reason: string;
  } | null;
  /** Claude Code 会话 ID，用于 --resume 恢复会话 */
  claudeSessionId: string | null;
  /** Structured conversation messages derived from PTY output. */
  messages?: ConversationTurn[];
  /** Session lifecycle state */
  lifecycleState?: "running" | "idle" | "archived";
  /** Last activity timestamp */
  lastActivityAt?: string | null;
  /** 此会话是从哪个 Wand 会话恢复而来 */
  resumedFromSessionId?: string | null;
  /** 此会话被哪个恢复后的会话替代 */
  resumedToSessionId?: string | null;
  /** 服务器重启时是否自动恢复 */
  autoRecovered?: boolean;
}

// ── Session Lifecycle ──

export type SessionLifecycleState = "initializing" | "running" | "idle" | "thinking" | "waiting-input" | "archived";

export interface SessionLifecycle {
  state: SessionLifecycleState;
  stateSince: number;
  lastActivityAt: number;
  archivedBy?: "user" | "timeout" | "error";
  archiveReason?: string;
}

// ── Session Event (PTY Bridge Output) ──

/** Unified event type emitted by ClaudePtyBridge for WebSocket broadcast */
export type SessionEventType =
  | "output.raw"          // Raw PTY output for terminal view
  | "output.chat"         // Structured chat content update
  | "chat.turn"           // Conversation turn completed
  | "permission.prompt"   // Permission request detected
  | "permission.resolved" // Permission resolved
  | "session.id"          // Claude session ID captured
  | "task"                // Task info update
  | "ended";              // Session ended

export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  timestamp: number;
  data?: unknown;
}

// Event-specific data payloads

export interface RawOutputData {
  chunk: string;
  /** Full accumulated output for terminal view */
  output: string;
}

export interface ChatOutputData {
  /** Current messages array */
  messages: ConversationTurn[];
  /** Index of the message being streamed */
  streamingIndex?: number;
  /** Whether assistant is currently responding */
  isResponding: boolean;
}

export interface ChatTurnData {
  /** The completed turn */
  turn: ConversationTurn;
  /** Full messages array */
  messages: ConversationTurn[];
}

export interface PermissionPromptData {
  /** Detected prompt text */
  prompt: string;
  /** Inferred scope */
  scope: EscalationScope;
  /** Target if detected */
  target?: string;
}

export interface SessionIdData {
  /** Claude CLI session UUID */
  claudeSessionId: string;
}

export interface TaskData {
  title: string;
  tool?: string;
}

export interface SessionEndData {
  exitCode: number | null;
}
