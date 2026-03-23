export type ExecutionMode = "auto-edit" | "default" | "full-access" | "native";

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

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// ── Structured JSON chat types (from Claude --output-format stream-json) ──

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
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface ConversationTurn {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface SessionSnapshot {
  id: string;
  command: string;
  cwd: string;
  mode: ExecutionMode;
  status: "running" | "exited" | "failed" | "stopped";
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  output: string;
  archived: boolean;
  archivedAt: string | null;
  /** Claude Code 会话 ID，用于 --resume 恢复会话 */
  claudeSessionId: string | null;
  /** Structured conversation messages (from JSON chat mode) */
  messages?: ConversationTurn[];
}
