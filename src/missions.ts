import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { buildMissionDiff } from "./mission-diff.js";
import type {
  AgentActivityItem,
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

const ACTIVITY_NOISE = /(?:⏵⏵|⎿|bypasspermissions|shift\+tab|esc to interrupt|tip:|worked for|total messages:|ran playwright code)/i;

function cleanActivityText(value: string, maxLength: number): string | null {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || ACTIVITY_NOISE.test(normalized)) return null;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1).trimEnd()}…` : normalized;
}

function cleanActivityTitle(value: string): { title: string; summary: string | null } {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(.*?)\s+(执行中|已完成|失败|等待答复|等待授权)\s*[·:]?\s*(.*)$/);
  if (!match) return { title: cleanActivityText(normalized, 72) || "Agent 会话", summary: null };
  return {
    title: cleanActivityText(match[1], 72) || "Agent 会话",
    summary: cleanActivityText(match[3], 160),
  };
}

function sessionSummary(snapshot: SessionSnapshot): string | null {
  const direct = cleanActivityText(snapshot.description?.trim() || "", 160);
  if (direct) return direct;
  const taskTitle = cleanActivityText(snapshot.currentTaskTitle?.trim() || "", 160);
  if (taskTitle) return taskTitle;
  const messages = snapshot.messages ?? [];
  for (let turnIndex = messages.length - 1; turnIndex >= 0; turnIndex--) {
    const text = messages[turnIndex].content
      .filter((block) => block.type === "text")
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join(" ");
    const cleaned = cleanActivityText(text, 160);
    if (cleaned) return cleaned;
  }
  return cleanActivityText(snapshot.summary?.trim() || "", 160);
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
      taskId: input.taskId?.trim() || null,
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
    const mission = this.storage.getMission(attempt.missionId);
    this.storage.upsertAgentActivity({
      sessionId: event.sessionId,
      missionId: attempt.missionId,
      attemptId: attempt.id,
      state,
      // The session title can contain provider TUI status chrome. Inbox items
      // belong to the mission, so keep their title stable and human-readable.
      title: mission?.title || firstPromptLine(mission?.prompt ?? ""),
      summary: sessionSummary(snapshot),
      provider: snapshot.provider ?? attempt.provider,
      cwd: snapshot.cwd,
      updatedAt,
      readAt: null,
    });
    this.refreshMissionStatus(attempt.missionId);
  }

  inbox(): AgentActivityItem[] {
    return this.storage.listAgentActivity().map((item) => {
      const mission = item.missionId ? this.storage.getMission(item.missionId) : null;
      const legacyTitle = cleanActivityTitle(item.title);
      return {
        ...item,
        // Older rows may have been populated from a provider TUI title. Prefer
        // the mission title at read time so existing inbox data is repaired too.
        title: mission?.title || legacyTitle.title,
        summary: cleanActivityText(item.summary ?? "", 160) || legacyTitle.summary,
      };
    });
  }

  markInboxRead(sessionId?: string): void {
    this.storage.markAgentActivityRead(sessionId);
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

  async sendReview(missionId: string, attemptId: string, commentIds?: string[]): Promise<MissionReviewComment[]> {
    const attempt = this.requireAttempt(missionId, attemptId);
    if (!attempt.sessionId) throw new Error("这个 attempt 没有关联会话。");
    const selected = this.storage.listMissionReviewComments(missionId, attemptId)
      .filter((comment) => comment.status === "pending" && (!commentIds?.length || commentIds.includes(comment.id)));
    if (selected.length === 0) throw new Error("没有待发送的 review 意见。");
    const session = this.structured.get(attempt.sessionId);
    if (!session) throw new Error("任务会话当前不可用。");
    const commentIdsToSend = selected.map((comment) => comment.id);
    const accepted = this.structured.sendMessage(attempt.sessionId, reviewPrompt(selected));
    // sendMessage settles after the whole turn. Treat microtask acceptance as
    // "queued or started"; a synchronous/microtask rejection stays pending.
    try {
      await Promise.race([
        accepted,
        new Promise<void>((resolve) => setImmediate(resolve)),
      ]);
    } catch (error) {
      console.error(`[Missions] Review dispatch failed for ${attempt.id}:`, error);
      throw error;
    }
    accepted.catch((error) => {
      console.error(`[Missions] Review execution failed for ${attempt.id}:`, error);
    });
    this.storage.updateMissionReviewStatus(commentIdsToSend, "sent");
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
        // 关联任务的派发直接落在任务目录（不再叠加一层隔离），
        // 会话绑定 workspaceTaskId，出现在该任务下。
        worktreeEnabled: mission.taskId ? false : true,
        ...(mission.taskId ? { workspaceTaskId: mission.taskId } : {}),
        ...(!mission.taskId
          ? {
              worktreeSpec: {
                baseRef: mission.worktree.baseRef,
                taskName: `${mission.title}-${provider}`,
                sharedDirectories: mission.worktree.sharedDirectories,
                copyPaths: mission.worktree.copyPaths,
              },
            }
          : {}),
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
