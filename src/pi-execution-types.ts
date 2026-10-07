export type PiExecutionState = "pending" | "running" | "background" | "completed" | "failed" | "paused" | "stopped" | "detached" | "rejected" | "skipped" | "partial" | "unknown";

export interface PiExecutionNode {
  id: string;
  parentId?: string;
  label: string;
  kind: string;
  state: PiExecutionState;
  phase?: string;
  agent?: string;
  model?: string;
  runId?: string;
  task?: string;
  currentTool?: string;
  durationMs?: number;
  tokens?: number;
  toolCount?: number;
  error?: string;
  output?: string;
}

export interface PiExecutionSnapshot {
  version: 1;
  source: "tool-progress" | "tool-result" | "status-file";
  mode: string;
  name?: string;
  runId?: string;
  state: PiExecutionState;
  inventoryComplete: boolean;
  updatedAt?: number;
  nodes: PiExecutionNode[];
  trace: Array<{ key: string; operation: string; state: string; phase?: string; durationMs?: number; error?: string }>;
  omittedNodes: number;
  omittedTrace: number;
}

export interface PiExecutionResponse {
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
  script?: string;
  snapshot: PiExecutionSnapshot | null;
  notice?: string;
}
