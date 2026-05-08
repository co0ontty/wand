export type SessionKind = "pty" | "structured";
export type SessionCreateKind = "pty" | "structured";
export type SessionProvider = "claude" | "codex";
export type SessionRunner = "claude-cli" | "claude-cli-print" | "codex-cli-exec" | "pty";

export type ExecutionMode = "assist" | "agent" | "agent-max" | "default" | "auto-edit" | "full-access" | "native" | "managed";

export type AutonomyPolicy = "assist" | "agent" | "agent-max";
export type ApprovalPolicy = "ask-every-time" | "approve-once" | "remember-this-turn";
export type EscalationScope = "write_file" | "run_command" | "network" | "outside_workspace" | "dangerous_shell" | "unknown";
export type EscalationRunner = "json" | "pty";
export type EscalationResolution = "approve_once" | "approve_turn" | "deny" | "fallback_manual";
export type EscalationSource = "tool_permission_request" | "sandbox_hard_block" | "workspace_policy_limit" | "cli_capability_limit" | "unknown";

/** WebSocket / ProcessManager event envelope used throughout the app. */
export interface ProcessEvent {
  type: "output" | "status" | "started" | "ended" | "usage" | "task" | "notification";
  sessionId: string;
  data?: unknown;
  /** Monotonic per-session sequence stamped by the WS broadcast layer for
   *  output events. Lets clients spot gaps caused by backpressure drops. */
  seq?: number;
}

export type ProcessEventHandler = (event: ProcessEvent) => void;

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

export interface StructuredChatPersonaRoleConfig {
  name?: string;
  avatar?: string;
}

export interface StructuredChatPersonaConfig {
  user?: StructuredChatPersonaRoleConfig;
  assistant?: StructuredChatPersonaRoleConfig;
}

export interface CardExpandDefaults {
  /** Edit/Write/MultiEdit diff cards (default: false) */
  editCards?: boolean;
  /** Read/Glob/Grep/WebFetch/WebSearch inline tools (default: false) */
  inlineTools?: boolean;
  /** Bash terminal output (default: false) */
  terminal?: boolean;
  /** Thinking blocks (default: false) */
  thinking?: boolean;
  /** Tool groups (default: false) */
  toolGroup?: boolean;
}

export interface AndroidApkConfig {
  enabled?: boolean;
  apkDir?: string;
  currentApkFile?: string;
}

export interface WandConfig {
  host: string;
  port: number;
  /** Enable HTTPS with self-signed certificate (default: false) */
  https?: boolean;
  password: string;
  defaultMode: ExecutionMode;
  shell: string;
  defaultCwd: string;
  startupCommands: string[];
  allowedCommandPrefixes: string[];
  commandPresets: CommandPreset[];
  structuredChatPersona?: StructuredChatPersonaConfig;
  /** Max total size (bytes) for shortcut interaction logs per session (default: 10 MB). Set 0 to disable logging. */
  shortcutLogMaxBytes?: number;
  /** Preferred response language for Claude (e.g. "中文", "English"). Empty string means no override. */
  language?: string;
  /** Per-instance secret for app connection code encryption. Auto-generated on first run. */
  appSecret?: string;
  android?: AndroidApkConfig;
  /** Default expand/collapse state for card types in structured chat view */
  cardDefaults?: CardExpandDefaults;
  /** 新建会话时默认使用的 Claude 模型（别名或完整 ID）。留空则不传 --model，由 claude 自行决定。 */
  defaultModel?: string;
}

export interface ClaudeModelInfo {
  /** 传给 --model 的值（别名或完整模型 ID） */
  id: string;
  /** UI 显示的友好标签 */
  label: string;
  /** 可选备注：例如 "当前默认"、"最新" */
  note?: string;
  /** 是否为别名（opus/sonnet 等）；完整 ID 为 false */
  alias?: boolean;
}

interface WorktreeInfo {
  branch: string;
  path: string;
}

export interface WorktreeMergeInfo {
  targetBranch?: string;
  mergedAt?: string;
  mergeCommit?: string;
  cleanupDone?: boolean;
  lastError?: string;
  conflict?: boolean;
}

export interface WorktreeMergeCheckResult {
  ok: boolean;
  sourceBranch: string;
  targetBranch: string;
  worktreePath: string;
  repoRoot: string;
  hasUncommittedChanges: boolean;
  aheadCount: number;
  hasConflicts: boolean;
  recommendedAction: "merge" | "noop" | "resolve-conflict";
  reason?: string;
}

export interface WorktreeMergeResult {
  ok: boolean;
  sourceBranch: string;
  targetBranch: string;
  repoRoot: string;
  mergeCommit?: string;
  mergedAt?: string;
  cleanupDone: boolean;
  conflict: boolean;
  errorCode?: string;
  reason?: string;
}

export interface GitStatusFileEntry {
  path: string;
  /** Two-char porcelain status (e.g. " M", "MM", "??", "A ") */
  status: string;
  /** True 当条目是 submodule（来源于 porcelain v2 的 sub 字段第一位为 S）。 */
  isSubmodule?: boolean;
  /** submodule 子状态：指针是否变化 / 内部是否 dirty / 是否有未跟踪文件。 */
  submoduleState?: {
    commitChanged: boolean;
    hasTrackedChanges: boolean;
    hasUntracked: boolean;
  };
}

export interface GitStatusResult {
  isGit: boolean;
  branch?: string;
  /** Number of files with any change (modified / added / deleted / untracked). */
  modifiedCount?: number;
  files?: GitStatusFileEntry[];
  head?: string;
  repoRoot?: string;
  /** Truthy when the repo has no commits yet (initial state). */
  initialCommit?: boolean;
  /** Most recent reachable tag (e.g. "v1.2.3"). */
  latestTag?: string;
  /** Auto-suggested next tag derived by bumping the patch segment. */
  suggestedNextTag?: string;
  error?: string;
}

export interface QuickCommitResult {
  ok: boolean;
  commit?: { hash: string; message: string };
  tag?: { name: string };
  pushed?: boolean;
  /** commit 已成功但 push 失败时填入；前端用它显示"已提交但 push 失败"。 */
  pushError?: string;
}

export interface CommandRequest {
  command: string;
  provider?: SessionProvider;
  cwd?: string;
  mode?: ExecutionMode;
  initialInput?: string;
  worktreeEnabled?: boolean;
  /** Claude 模型（别名或完整 ID）。仅对 claude provider 生效。留空则回落到 config.defaultModel。 */
  model?: string;
  /** 创建会话时由前端测得的真实列数。后端用它直接 spawn PTY，避免"先 120 列再 resize"的早期错位。 */
  cols?: number;
  /** 创建会话时由前端测得的真实行数。 */
  rows?: number;
}

export interface InputRequest {
  input?: string;
  /** Current UI view: "chat" or "terminal". Chat view uses PTY-derived structured messages. */
  view?: "chat" | "terminal";
  autonomyPolicy?: AutonomyPolicy;
  approvalPolicy?: ApprovalPolicy;
  allowedScopes?: EscalationScope[];
  turn?: TurnRequest;
  /** Shortcut key name that triggered this input (e.g. "enter", "yes", "ctrl_c"). Used for interaction logging in managed/full-access modes. */
  shortcutKey?: string;
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
  /** When true, content has been truncated for transport. Client should fetch full content via API. */
  _truncated?: boolean;
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

export interface StructuredSessionState {
  provider?: SessionProvider;
  runner: SessionRunner;
  model?: string;
  lastError: string | null;
  inFlight: boolean;
  activeRequestId: string | null;
}

export interface SessionSnapshot {
  id: string;
  sessionKind?: SessionKind;
  provider?: SessionProvider;
  runner?: SessionRunner;
  command: string;
  cwd: string;
  mode: ExecutionMode;
  worktreeEnabled?: boolean;
  worktree?: WorktreeInfo | null;
  worktreeMergeStatus?: "ready" | "checking" | "merging" | "merged" | "failed";
  worktreeMergeInfo?: WorktreeMergeInfo | null;
  autonomyPolicy?: AutonomyPolicy;
  approvalPolicy?: ApprovalPolicy;
  allowedScopes?: EscalationScope[];
  status: "idle" | "running" | "exited" | "failed" | "stopped";
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
  /** Pending structured user inputs queued while an assistant response is in flight. */
  queuedMessages?: string[];
  structuredState?: StructuredSessionState;
  /** 此会话是从哪个 Wand 会话恢复而来 */
  resumedFromSessionId?: string | null;
  /** 服务器重启时是否自动恢复 */
  autoRecovered?: boolean;
  /** 是否启用自动批准权限 */
  autoApprovePermissions?: boolean;
  /** 自动批准统计（按类别分） */
  approvalStats?: { tool: number; command: number; file: number; total: number };
  /** 会话摘要：从首条用户消息或当前任务提取 */
  summary?: string;
  /** 当前正在执行的任务标题（用于会话列表展示） */
  currentTaskTitle?: string;
  /** 用户为此会话选定的 Claude 模型（别名或完整 ID）。结构化会话下次 spawn 时使用；PTY 会话仅用于展示。 */
  selectedModel?: string | null;
  /** 当前 PTY 列宽，由最近一次 resize 决定。前端用它来判断本端 fit 是否需要校准。 */
  ptyCols?: number;
  /** 当前 PTY 行数，由最近一次 resize 决定。 */
  ptyRows?: number;
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
