export type ExecutionMode = "auto-edit" | "default" | "full-access";

export interface CommandPreset {
  label: string;
  command: string;
  mode?: ExecutionMode;
}

export interface WandConfig {
  host: string;
  port: number;
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
