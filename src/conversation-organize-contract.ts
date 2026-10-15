import type { TaskOrganizeMode, TaskOrganizeTarget } from "./task-organize-contract.js";

export interface ConversationOrganizationScope {
  target?: TaskOrganizeTarget;
  taskIds?: readonly string[];
  sessionIds?: readonly string[];
  mode: TaskOrganizeMode;
}
export interface ConversationOrganizationPreview {
  token: string;
  sessionCount: number;
  manualSessionCount: number;
  skippedSessionCount: number;
  existingTaskCount: number;
  contentCharacters: number;
  estimatedModelRequests: number;
  unchanged: boolean;
  activeJobId?: string;
}
export interface ConversationOrganizationResult {
  ok: true;
  foundSessions: number;
  eligibleSessions: number;
  skippedManualSessions: number;
  skippedSessions: number;
  analyzedSessions: number;
  createdTasks: Array<{ taskId: string; cardId: string; title: string; sessionCount: number }>;
  reusedTasks: Array<{ taskId: string; title: string; sessionCount: number }>;
  updatedTasks: Array<{ taskId: string; previousTitle: string; title: string }>;
  movedSessions: Array<{ sessionId: string; taskId: string; taskName: string }>;
  unassignedSessions: Array<{ sessionId: string; reason: string }>;
  refused: Array<{ id: string; kind: "session" | "task"; reason: string }>;
  unchanged?: boolean;
  cancelled?: boolean;
  error?: string;
}
export interface ConversationOrganizationJob {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  stage: string;
  processedSessions: number;
  totalSessions: number;
  modelRequests: number;
  result: ConversationOrganizationResult;
  logSessionId?: string;
  error?: string;
}
