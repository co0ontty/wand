import type { ContentBlock, ConversationTurn, SessionSnapshot } from "./types.js";

export interface StructuredRunnerTurnState {
  blocks: ContentBlock[];
  result: string;
  sessionId: string | null;
  model?: string;
  usage?: ConversationTurn["usage"];
}

export interface StructuredRunnerContext {
  session: SessionSnapshot;
  prompt: string;
  env: NodeJS.ProcessEnv;
}

export interface StructuredRunnerObserver {
  isActive(): boolean;
  onStdout?(text: string): void;
  onStderr?(text: string): void;
  onEvent?(event: Record<string, unknown>): void;
  onUpdate(state: StructuredRunnerTurnState): void;
}

export interface StructuredRunnerResult {
  state: StructuredRunnerTurnState;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  primaryError: string | null;
  errors?: string[];
  stdoutTail?: string;
  stopReason?: "ask-user-question";
  spawnError?: NodeJS.ErrnoException;
}

export interface StructuredRunnerExecution {
  args: string[];
  spawnedAt: string;
  pid: number | null;
  completion: Promise<StructuredRunnerResult>;
  /** Idempotent, best-effort, and never throws. Completion must still settle. */
  interrupt(): void;
}

export interface StructuredRunnerAdapter {
  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution;
}
