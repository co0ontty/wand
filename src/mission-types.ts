import type { SessionProvider } from "./types.js";

export type AgentActivityState = "working" | "needs_input" | "needs_permission" | "done" | "failed";
export type MissionStatus = "dispatching" | "running" | "needs_input" | "completed" | "failed" | "archived";
export type MissionAttemptState = AgentActivityState | "queued";
export type MissionReviewStatus = "pending" | "sent" | "resolved";

export interface MissionWorktreeOptions {
  baseRef?: string;
  sharedDirectories?: string[];
  copyPaths?: string[];
}

export interface Mission {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  status: MissionStatus;
  worktree: MissionWorktreeOptions;
  createdAt: string;
  updatedAt: string;
}

export interface MissionAttempt {
  id: string;
  missionId: string;
  sessionId: string | null;
  provider: SessionProvider;
  state: MissionAttemptState;
  branch: string | null;
  worktreePath: string | null;
  baseRef: string | null;
  summary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MissionReviewComment {
  id: string;
  missionId: string;
  attemptId: string;
  filePath: string;
  line: number | null;
  side: "old" | "new";
  body: string;
  status: MissionReviewStatus;
  createdAt: string;
  sentAt: string | null;
  resolvedAt: string | null;
}

export interface AgentActivityItem {
  sessionId: string;
  missionId: string | null;
  attemptId: string | null;
  state: AgentActivityState;
  title: string;
  summary: string | null;
  provider: SessionProvider | null;
  cwd: string | null;
  updatedAt: string;
  readAt: string | null;
}

export interface MissionDetails extends Mission {
  attempts: MissionAttempt[];
  comments: MissionReviewComment[];
}

export interface MissionDiffFile {
  path: string;
  status: string;
}

export interface MissionDiff {
  missionId: string;
  attemptId: string;
  baseRef: string;
  files: MissionDiffFile[];
  patch: string;
  truncated: boolean;
}

export interface CreateMissionInput {
  prompt: string;
  title?: string;
  cwd: string;
  providers: SessionProvider[];
  baseRef?: string;
  sharedDirectories?: string[];
  copyPaths?: string[];
}

export interface CreateReviewCommentInput {
  filePath: string;
  line?: number | null;
  side?: "old" | "new";
  body: string;
}
