export type MissionProvider = "claude" | "codex" | "opencode" | "grok" | "qoder" | "pi";
type AttemptState = "working" | "needs_input" | "needs_permission" | "done" | "failed" | "queued";

export interface MissionAttempt {
  id: string;
  missionId: string;
  sessionId: string | null;
  provider: MissionProvider;
  state: AttemptState;
  branch: string | null;
  worktreePath: string | null;
  baseRef: string | null;
  summary: string | null;
  error: string | null;
  updatedAt: string;
}

export interface ReviewComment {
  id: string;
  missionId: string;
  attemptId: string;
  filePath: string;
  line: number | null;
  side: "old" | "new";
  body: string;
  status: "pending" | "sent" | "resolved";
  createdAt: string;
}

export interface MissionDetails {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  status: "dispatching" | "running" | "needs_input" | "completed" | "failed" | "archived";
  worktree: { baseRef?: string; sharedDirectories?: string[]; copyPaths?: string[] };
  createdAt: string;
  updatedAt: string;
  attempts: MissionAttempt[];
  comments: ReviewComment[];
}

export interface MissionDiff {
  missionId: string;
  attemptId: string;
  baseRef: string;
  files: Array<{ path: string; status: string }>;
  patch: string;
  truncated: boolean;
}

export interface CreateMissionRequest {
  title?: string;
  prompt: string;
  cwd: string;
  providers: MissionProvider[];
  /** 关联到当前任务（workspace task）：派发的会话绑定该任务。 */
  taskId?: string;
  baseRef?: string;
  sharedDirectories?: string[];
  copyPaths?: string[];
}

export interface InboxItem {
  sessionId: string;
  missionId: string | null;
  attemptId: string | null;
  state: string;
  title: string;
  summary: string | null;
  provider: string | null;
  cwd: string | null;
  updatedAt: string;
  readAt: string | null;
}

export interface MissionsRepository {
  list(): Promise<MissionDetails[]>;
  listInbox(): Promise<InboxItem[]>;
  markInboxRead(sessionId?: string): Promise<void>;
  create(request: CreateMissionRequest): Promise<MissionDetails>;
  diff(missionId: string, attemptId: string): Promise<MissionDiff>;
  addComment(missionId: string, attemptId: string, input: { filePath: string; line: number | null; side: "old" | "new"; body: string }): Promise<ReviewComment>;
  sendReview(missionId: string, attemptId: string): Promise<ReviewComment[]>;
}

export interface MissionsRuntimeAdapter {
  onOpen(): void;
  onClose(): void;
  openSession(sessionId: string): Promise<void>;
  effectiveCwd(): string;
}
