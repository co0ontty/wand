import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { buildMissionDiff } from "./mission-diff.js";
import type {
  AgentActivityState,
  CreateMissionInput,
  CreateReviewCommentInput,
  Mission,
  MissionAttempt,
  MissionAttemptState,
  MissionDetails,
  MissionDiff,
  MissionReviewComment,
  MissionStatus,
} from "./mission-types.js";
import type { SessionRegistry } from "./session-registry.js";
import type { StructuredSessionManager } from "./structured-session-manager.js";
import type { WandStorage } from "./storage.js";
import type { ConversationTurn, ProcessEvent, SessionProvider, SessionSnapshot } from "./types.js";

const PROVIDERS = new Set<SessionProvider>(["claude", "codex", "opencode", "grok", "qoder", "pi"]);
const MAX_ATTEMPTS = 6;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeStringList(value: string[] | undefined, field: string): string[] {
  const result = [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))];
  if (result.length > 20) throw new Error(`${field} 最多允许 20 个路径。`);
  for (const item of result) {
    if (item.length > 500) throw new Error(`${field} 中的路径过长。`);
  }
  return result;
}

function firstPromptLine(prompt: string): string {
  const line = prompt.split("\n").map((part) => part.trim()).find(Boolean) || "新任务";
  return line.length > 72 ? `${line.slice(0, 69)}…` : line;
}

function sessionSummary(snapshot: SessionSnapshot): string | null {
  if (snapshot.description?.trim()) return snapshot.description.trim();
  if (snapshot.currentTaskTitle?.trim()) return snapshot.currentTaskTitle.trim();
  const messages = snapshot.messages ?? [];
  for (let turnIndex = messages.length - 1; turnIndex >= 0; turnIndex--) {
    const text = messages[turnIndex].content
      .filter((block) => block.type === "text")
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join(" ");
    if (text) return text.length > 240 ? `${text.slice(0, 237)}…` : text;
  }
  return snapshot.summary?.trim() || null;
}

function hasUnansweredQuestion(messages: ConversationTurn[] | undefined): boolean {
  if (!messages?.length || messages[messages.length - 1]?.role === "user") return false;
  const answered = new Set<string>();
  for (const turn of messages) {
    for (const block of turn.content) {
      if (block.type === "tool_result") answered.add(block.tool_use_id);
    }
  }
  for (let turnIndex = messages.length - 1; turnIndex >= 0; turnIndex--) {
    const turn = messages[turnIndex];
    if (turn.role === "user" && turn.content.some((block) => block.type === "text")) break;
    if (turn.content.some((block) => block.type === "tool_use"
      && (block.name === "AskUserQuestion" || block.semantic?.kind === "question_request")
      && !answered.has(block.id))) return true;
  }
  return false;
}

function activityState(snapshot: SessionSnapshot, event?: ProcessEvent): AgentActivityState {
  if (snapshot.pendingEscalation || snapshot.permissionBlocked) return "needs_permission";
  if (hasUnansweredQuestion(snapshot.messages)) return "needs_input";
  if (snapshot.status === "failed" || (event?.type === "ended" && snapshot.exitCode !== null && snapshot.exitCode !== 0)) return "failed";
  if (snapshot.status === "running" || snapshot.structuredState?.inFlight) return "working";
  return "done";
}

function missionStatus(attempts: MissionAttempt[]): MissionStatus {
  if (attempts.length === 0) return "dispatching";
  if (attempts.some((attempt) => attempt.state === "needs_input" || attempt.state === "needs_permission")) return "needs_input";
  if (attempts.some((attempt) => attempt.state === "working" || attempt.state === "queued")) return "running";
  if (attempts.some((attempt) => attempt.state === "done")) return "completed";
  return "failed";
}

function reviewPrompt(comments: MissionReviewComment[]): string {
  const lines = comments.map((comment, index) => {
    const location = comment.line === null ? comment.filePath : `${comment.filePath}:${comment.line}`;
    return `${index + 1}. ${location} [${comment.side}] — ${comment.body}`;
  });
  return [
    "Please address the following review feedback for this task.",
    "Apply all requested changes in the current worktree, preserve unrelated work, and run focused verification before replying.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * Deep task-orchestration module. Callers create missions and review diffs
 * without coordinating session/worktree/storage details.
 */
export class Missions {
  constructor(
    private readonly storage: WandStorage,
    private readonly structured: StructuredSessionManager,
    private readonly sessions: SessionRegistry,
  ) {}

  list(): MissionDetails[] {
    return this.storage.listMissions().map((mission) => this.details(mission));
  }

  get(id: string): MissionDetails | null {
    const mission = this.storage.getMission(id);
    return mission ? this.details(mission) : null;
  }

  create(input: CreateMissionInput): MissionDetails {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new Error("任务提示词不能为空。");
    if (prompt.length > 200_000) throw new Error("任务提示词不能超过 200000 个字符。");
    const cwd = path.resolve(input.cwd || "");
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error("任务工作目录不存在。");
    const providers = [...new Set(input.providers ?? [])];
    if (providers.length === 0 || providers.length > MAX_ATTEMPTS || providers.some((provider) => !PROVIDERS.has(provider))) {
      throw new Error(`请选择 1-${MAX_ATTEMPTS} 个有效 provider。`);
    }

    const createdAt = nowIso();
    const mission: Mission = {
      id: randomUUID(),
      title: input.title?.trim().slice(0, 120) || firstPromptLine(prompt),
      prompt,
      cwd,
      status: "dispatching",
      worktree: {
        baseRef: input.baseRef?.trim() || undefined,
        sharedDirectories: normalizeStringList(input.sharedDirectories, "sharedDirectories"),
        copyPaths: normalizeStringList(input.copyPaths, "copyPaths"),
      },
      createdAt,
      updatedAt: createdAt,
    };
    this.storage.saveMission(mission);

    for (const provider of providers) this.dispatchAttempt(mission, provider);
    this.refreshMissionStatus(mission.id);
    return this.get(mission.id)!;
  }

  ingest(event: ProcessEvent): void {
    if (!event.sessionId || event.sessionId === "__system__") return;
    const snapshot = this.sessions.getLatest(event.sessionId);
    if (!snapshot) return;
    const attempt = this.storage.getMissionAttemptBySession(event.sessionId);
    if (!attempt) return;
    const state = activityState(snapshot, event);
    const updatedAt = nowIso();
    this.storage.saveMissionAttempt({
      ...attempt,
      state: state as MissionAttemptState,
      summary: sessionSummary(snapshot),
      error: state === "failed" ? snapshot.structuredState?.lastError ?? "任务执行失败" : null,
      updatedAt,
    });
    this.refreshMissionStatus(attempt.missionId);
  }

  diff(missionId: string, attemptId: string): MissionDiff {
    const attempt = this.requireAttempt(missionId, attemptId);
    if (!attempt.worktreePath || !attempt.baseRef) throw new Error("这个 attempt 没有可审查的 worktree。");
    return buildMissionDiff({ missionId, attemptId, cwd: attempt.worktreePath, baseRef: attempt.baseRef });
  }

  addReviewComment(missionId: string, attemptId: string, input: CreateReviewCommentInput): MissionReviewComment {
    this.requireAttempt(missionId, attemptId);
    const body = input.body?.trim();
    const filePath = input.filePath?.trim();
    if (!body || !filePath) throw new Error("文件和 review 内容不能为空。");
    const createdAt = nowIso();
    const comment: MissionReviewComment = {
      id: randomUUID(), missionId, attemptId, filePath,
      line: typeof input.line === "number" && Number.isFinite(input.line) ? Math.max(1, Math.floor(input.line)) : null,
      side: input.side === "old" ? "old" : "new",
      body, status: "pending", createdAt, sentAt: null, resolvedAt: null,
    };
    this.storage.saveMissionReviewComment(comment);
    return comment;
  }

  sendReview(missionId: string, attemptId: string, commentIds?: string[]): MissionReviewComment[] {
    const attempt = this.requireAttempt(missionId, attemptId);
    if (!attempt.sessionId) throw new Error("这个 attempt 没有关联会话。");
    const selected = this.storage.listMissionReviewComments(missionId, attemptId)
      .filter((comment) => comment.status === "pending" && (!commentIds?.length || commentIds.includes(comment.id)));
    if (selected.length === 0) throw new Error("没有待发送的 review 意见。");
    const session = this.structured.get(attempt.sessionId);
    if (!session) throw new Error("任务会话当前不可用。");
    const completion = this.structured.sendMessage(attempt.sessionId, reviewPrompt(selected));
    completion.catch((error) => {
      console.error(`[Missions] Review dispatch failed for ${attempt.id}:`, error);
    });
    this.storage.updateMissionReviewStatus(selected.map((comment) => comment.id), "sent");
    this.storage.saveMissionAttempt({ ...attempt, state: "working", updatedAt: nowIso() });
    this.refreshMissionStatus(missionId);
    return this.storage.listMissionReviewComments(missionId, attemptId);
  }

  resolveReview(missionId: string, attemptId: string, commentIds: string[]): MissionReviewComment[] {
    this.requireAttempt(missionId, attemptId);
    this.storage.updateMissionReviewStatus(commentIds, "resolved");
    return this.storage.listMissionReviewComments(missionId, attemptId);
  }

  archive(id: string): MissionDetails {
    const mission = this.storage.getMission(id);
    if (!mission) throw new Error("任务不存在。");
    this.storage.updateMissionStatus(id, "archived");
    return this.getIncludingArchived(id)!;
  }

  private dispatchAttempt(mission: Mission, provider: SessionProvider): void {
    const attemptId = randomUUID();
    const createdAt = nowIso();
    let attempt: MissionAttempt = {
      id: attemptId, missionId: mission.id, sessionId: null, provider, state: "queued",
      branch: null, worktreePath: null, baseRef: mission.worktree.baseRef ?? null,
      summary: null, error: null, createdAt, updatedAt: createdAt,
    };
    this.storage.saveMissionAttempt(attempt);
    try {
      const session = this.structured.createSession({
        cwd: mission.cwd,
        mode: "agent",
        provider,
        worktreeEnabled: true,
        worktreeSpec: {
          baseRef: mission.worktree.baseRef,
          taskName: `${mission.title}-${provider}`,
          sharedDirectories: mission.worktree.sharedDirectories,
          copyPaths: mission.worktree.copyPaths,
        },
        sessionSource: "automation",
        automationId: mission.id,
      });
      attempt = {
        ...attempt,
        sessionId: session.id,
        state: "working",
        branch: session.worktree?.branch ?? null,
        worktreePath: session.worktree?.path ?? null,
        baseRef: session.worktree?.baseRef ?? mission.worktree.baseRef ?? null,
        updatedAt: nowIso(),
      };
      this.storage.saveMissionAttempt(attempt);
      const completion = this.structured.sendMessage(session.id, mission.prompt);
      completion.catch((error) => {
        console.error(`[Missions] Attempt ${attemptId} failed after dispatch:`, error);
      });
    } catch (error) {
      this.storage.saveMissionAttempt({
        ...attempt,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: nowIso(),
      });
    }
  }

  private details(mission: Mission): MissionDetails {
    return {
      ...mission,
      attempts: this.storage.listMissionAttempts(mission.id),
      comments: this.storage.listMissionReviewComments(mission.id),
    };
  }

  private getIncludingArchived(id: string): MissionDetails | null {
    const mission = this.storage.getMission(id);
    return mission ? this.details(mission) : null;
  }

  private requireAttempt(missionId: string, attemptId: string): MissionAttempt {
    const attempt = this.storage.getMissionAttempt(attemptId);
    if (!attempt || attempt.missionId !== missionId) throw new Error("任务 attempt 不存在。");
    return attempt;
  }

  private refreshMissionStatus(missionId: string): void {
    const mission = this.storage.getMission(missionId);
    if (!mission || mission.status === "archived") return;
    this.storage.updateMissionStatus(missionId, missionStatus(this.storage.listMissionAttempts(missionId)));
  }
}
