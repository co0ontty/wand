import { createHash } from "node:crypto";
import { parseExecutionMode } from "./session-request.js";

import { ProcessManager,PtyInputDeliveryError,SessionInputError } from "./process-manager.js";
import { WandStorage } from "./storage.js";
import { StructuredSessionManager } from "./structured-session-manager.js";
import { ExecutionMode, SessionProvider, SessionSnapshot } from "./types.js";

import { getWorktreeMergeErrorCode, WorktreeMergeError } from "./git-worktree.js";
import { toSessionListItemDTO } from "./session-transport.js";

import { getErrorMessage } from "./error-utils.js";
import { buildIterationCommitContext, readCommitContextMode, resolveCommitContextInput, type IterationCommitContext } from "./iteration-log.js";
import { buildProviderResumeCommand } from "./resume-policy.js";
import { buildDirectoryTree, type SessionDirectoryNode } from "./session-directory-tree.js";
import { inferProviderFromCommand, isSessionProvider, providerCliCommand } from "./session-provider.js";
import { deleteOwnedSessionWithHistory, SessionRegistry, type ProviderHistoryDeleter } from "./session-registry.js";
import { projectCwdForSession, resolveWorkspaceIdForNewSession } from "./workspace-binding.js";
import { badRequest } from "./http-error.js";


// Session route business logic: list/tree builders, input error mapping, deletion,
// worktree merge/commit helpers and resume/archive restoration. Route modules only parse and reply.

/** 提交输入模式：query 覆盖 > 记住的偏好 > 默认（有提示词就优先用提示词）。 */
export function commitModeForRead(storage: WandStorage, override: unknown): string {
  return readCommitContextMode(storage, override);
}

/**
 * 生成 commit message 的输入：迭代模式下给「本轮提示词清单」，
 * 切到 diff 模式、或本轮没记录到任何提示词时给空 digest（调用方自动读完整 diff）。
 */
export async function iterationCommitInput(
  storage: WandStorage,
  snapshot: SessionSnapshot,
  body: { mode?: unknown; entryIds?: unknown },
): Promise<{ digest: string; entryIds: string[]; iteration: IterationCommitContext["iteration"] }> {
  const context = await buildIterationCommitContext(storage, { session: snapshot });
  const input = resolveCommitContextInput(storage, context, body);
  return { digest: input.digest, entryIds: input.entryIds, iteration: context.iteration };
}

/** 只有「让模型自己写 message」时才把迭代提示词交给它；用户手写的 message 不需要读任何输入。 */
export function commitMessageFromIteration(body: { autoMessage?: boolean; customMessage?: string }): boolean {
  return body.autoMessage !== false && !body.customMessage?.trim();
}

export function getInputErrorResponse(error: unknown, sessionId: string) {
  if (error instanceof PtyInputDeliveryError) {
    return {
      statusCode: 503,
      payload: {
        error: "PTY 输入结果未获确认；请先检查终端输出，不要直接重复提交。",
        errorCode: "INPUT_DELIVERY_UNCONFIRMED",
        sessionId,
        sessionStatus: null,
      },
    };
  }
  if (error instanceof SessionInputError) {
    const statusCode = error.code === "SESSION_NOT_FOUND" ? 404 : 409;
    return {
      statusCode,
      payload: {
        error: error.message,
        errorCode: error.code,
        sessionId,
        sessionStatus: error.sessionStatus ?? null,
      },
    };
  }

  const errorCode = (error as { code?: string } | null | undefined)?.code;
  if (errorCode === "duplicate_queued_message" || errorCode === "duplicate_idempotency_key" || errorCode === "idempotency_key_conflict") {
    return {
      statusCode: 409,
      payload: {
        error: getErrorMessage(error, "检测到重复发送，已拦截。"),
        errorCode,
        sessionId,
        sessionStatus: null,
      },
    };
  }

  return {
    statusCode: 400,
    payload: {
      error: getErrorMessage(error, "会话已结束，请启动新会话。"),
      errorCode: "INPUT_SEND_FAILED",
      sessionId,
      sessionStatus: null,
    },
  };
}


export function getInputDebugMeta(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { error };
}

export type SessionDeletionProcesses = Pick<
  ProcessManager,
  "get" | "delete"
> & ProviderHistoryDeleter;

export type SessionDeletionStructured = Pick<StructuredSessionManager, "get" | "delete">;

/**
 * A Wand-managed session and its provider-native history represent the same
 * conversation. Delete both in one operation so the native history cannot
 * immediately reappear as a "non-Wand" session after the Wand row is removed.
 */
export function deleteSessionWithProviderHistory(
  processes: SessionDeletionProcesses,
  structured: SessionDeletionStructured,
  storage: Pick<WandStorage, "getConfigValue" | "setConfigValue">,
  id: string,
): void {
  deleteOwnedSessionWithHistory(() => {
    const snapshot = structured.get(id) ?? processes.get(id);
    if (snapshot?.sessionKind === "structured") structured.delete(id);
    else processes.delete(id);
    return snapshot;
  }, processes, storage);
}

export type SessionListPageEntry = {
  type: "managed";
  key: string;
  sortTimestamp: number;
  session: ReturnType<typeof toSessionListItemDTO>;
};

export interface SessionListPage {
  entries: SessionListPageEntry[];
  offset: number;
  total: number;
  revision: string;
}

export interface SessionDirectoryTreeResponse {
  roots: SessionDirectoryNode<SessionListPageEntry>[];
  totalSessions: number;
  directoryCount: number;
  /** Session-entry revision, kept identical to /api/session-list for pagination compatibility. */
  revision: string;
  /** Full directory-tree revision, including custom workspace names. */
  treeRevision: string;
}

export function sessionSortTimestamp(snapshot: SessionSnapshot): number {
  const timestamp = Date.parse(snapshot.startedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function buildSessionListEntries(
  sessions: SessionSnapshot[],
): SessionListPageEntry[] {
  return sessions.filter(session => session.sessionSource !== "quick-terminal").map<SessionListPageEntry>((session) => ({
    type: "managed",
    key: `session-${session.id}`,
    sortTimestamp: sessionSortTimestamp(session),
    session: toSessionListItemDTO(session, { avatar: "compact" }),
  })).sort((left, right) => {
    const timestampOrder = right.sortTimestamp - left.sortTimestamp;
    return timestampOrder || left.key.localeCompare(right.key);
  });
}

export function sessionListRevision(
  entries: readonly SessionListPageEntry[],
  directoryNames: ReadonlyArray<readonly [path: string, name: string]> = [],
): string {
  const entryState = entries.map((entry) => [
    entry.key,
    entry.sortTimestamp,
    entry.session.title,
    entry.session.status,
    entry.session.completionRevision ?? 0,
    entry.session.viewedCompletionRevision ?? 0,
    entry.session.ptyBusy === true,
    entry.session.ptyCommandRunning === true,
    entry.session.structuredState?.inFlight === true,
  ]);
  const revisionState = directoryNames.length === 0
    ? entryState
    : {
      entries: entryState,
      directoryNames: directoryNames.slice().sort(([left], [right]) => left.localeCompare(right)),
    };
  return createHash("sha256")
    .update(JSON.stringify(revisionState))
    .digest("base64url");
}

export function buildSessionListPage(
  sessions: SessionSnapshot[],
  offset: number,
  limit: number,
): SessionListPage {
  const entries = buildSessionListEntries(sessions);
  const boundedOffset = Math.min(Math.max(offset, 0), entries.length);
  const revision = sessionListRevision(entries);
  return {
    entries: entries.slice(boundedOffset, boundedOffset + limit),
    offset: boundedOffset,
    total: entries.length,
    revision,
  };
}

export function buildSessionDirectoryTree(
  sessions: SessionSnapshot[],
  customNames: ReadonlyMap<string, string> = new Map(),
): SessionDirectoryTreeResponse {
  const entries = buildSessionListEntries(sessions);
  const tree = buildDirectoryTree(entries.map((entry) => ({
    entry,
    cwd: entry.session.cwd,
    sortTimestamp: entry.sortTimestamp,
  })), "未知目录", customNames);
  const appliedCustomNames: Array<readonly [string, string]> = [];
  const collectCustomNames = (nodes: readonly SessionDirectoryNode<SessionListPageEntry>[]): void => {
    for (const node of nodes) {
      if (node.customName) appliedCustomNames.push([node.path, node.customName]);
      collectCustomNames(node.children);
    }
  };
  collectCustomNames(tree.roots);
  return {
    ...tree,
    revision: sessionListRevision(entries),
    treeRevision: sessionListRevision(entries, appliedCustomNames),
  };
}

export function directoryTreeContainsPath(
  nodes: readonly SessionDirectoryNode<SessionListPageEntry>[],
  directoryPath: string,
): boolean {
  return nodes.some((node) => (
    (!node.synthetic && node.path === directoryPath)
    || directoryTreeContainsPath(node.children, directoryPath)
  ));
}

export function requireWorktreeSession(snapshot: SessionSnapshot | null): SessionSnapshot {
  if (!snapshot) {
    throw badRequest("未找到该会话。");
  }
  if (!snapshot.worktreeEnabled || !snapshot.worktree?.branch || !snapshot.worktree?.path) {
    throw badRequest("该会话未启用 worktree 模式。 ");
  }
  return snapshot;
}

export function buildWorktreeMergeInfo(
  current: SessionSnapshot,
  info: SessionSnapshot["worktreeMergeInfo"]
): SessionSnapshot["worktreeMergeInfo"] {
  return {
    ...(current.worktreeMergeInfo ?? null),
    ...(info ?? null),
    lastError: info?.lastError,
    conflict: info?.conflict,
  };
}

export function saveWorktreeMergeState(
  sessions: SessionRegistry,
  current: SessionSnapshot,
  status: SessionSnapshot["worktreeMergeStatus"],
  info: SessionSnapshot["worktreeMergeInfo"]
): SessionSnapshot {
  const mergedInfo = buildWorktreeMergeInfo(current, info);
  const updated: SessionSnapshot = {
    ...current,
    worktreeMergeStatus: status,
    worktreeMergeInfo: mergedInfo,
  };

  return sessions.updateWorktreeState(current.id, status, mergedInfo) ?? updated;
}

export function getWorktreeMergeResponseStatus(error: unknown): number {
  return getWorktreeMergeErrorCode(error) === "WORKTREE_MERGE_CONFLICT" ? 409 : 400;
}

export function getWorktreeMergePayload(error: unknown, fallback: string) {
  if (error instanceof WorktreeMergeError) {
    return {
      error: error.message,
      errorCode: error.code,
      result: error.result ?? null,
    };
  }
  return {
    error: getErrorMessage(error, fallback),
    errorCode: getWorktreeMergeErrorCode(error) ?? null,
    result: null,
  };
}

export function resolvePtyResumeProvider(snapshot: SessionSnapshot): SessionProvider {
  if (snapshot.provider) return snapshot.provider;
  return inferProviderFromCommand(snapshot.command) ?? "claude";
}

export function isPtyProviderCommand(provider: SessionProvider, command: string): boolean {
  return new RegExp(`^${providerCliCommand(provider)}\\b`, "i").test(command.trim());
}

export async function startResumedPtySession(
  processes: ProcessManager,
  storage: WandStorage,
  existingSession: SessionSnapshot,
  sessionId: string,
  defaultMode: ExecutionMode,
  body: { mode?: ExecutionMode; cols?: number; rows?: number },
  initialInput?: string
): Promise<SessionSnapshot> {
  if ((existingSession.sessionKind ?? "pty") !== "pty") {
    throw badRequest("结构化会话不支持 PTY resume。");
  }

  const command = existingSession.command.trim();
  const provider = resolvePtyResumeProvider(existingSession);
  const resumeSessionId = existingSession.claudeSessionId;
  if (!resumeSessionId) {
    throw badRequest(`此会话没有 ${provider} 会话 ID，无法恢复。`);
  }

  if (!isPtyProviderCommand(provider, command)) {
    throw badRequest(`当前命令不是 ${provider} CLI，无法恢复。`);
  }
  if (provider === "codex") {
    if (!processes.hasCodexSessionFile(resumeSessionId)) {
      throw badRequest("对应的 Codex 历史会话不存在，无法恢复。");
    }
  }

  const newMode = parseExecutionMode(body.mode, parseExecutionMode(existingSession.mode, defaultMode));
  const resumeCommand = buildProviderResumeCommand(provider, command, resumeSessionId);
  const reqCols = typeof body.cols === "number" && Number.isFinite(body.cols) ? body.cols : undefined;
  const reqRows = typeof body.rows === "number" && Number.isFinite(body.rows) ? body.rows : undefined;
  return processes.start(resumeCommand, existingSession.cwd, newMode, initialInput, {
    reuseId: sessionId,
    cols: reqCols,
    rows: reqRows,
    provider,
    model: existingSession.selectedModel ?? undefined,
    thinkingEffort: existingSession.thinkingEffort ?? undefined,
    // 恢复会话也要把角色与规则带回来（PTY 的指令是拼在启动命令上的）。
    systemPrompt: existingSession.systemPrompt ?? undefined,
    workspaceId: existingSession.workspaceId
      ?? resolveWorkspaceIdForNewSession(storage, projectCwdForSession(existingSession) || existingSession.cwd),
    workspaceTaskId: existingSession.workspaceTaskId,
  });
}

/** 取消归档后，用原来的 Wand 会话 ID 把终端拉起来；有 provider session id 就续接那次对话。 */
export async function restoreArchivedSession(
  sessions: SessionRegistry,
  processes: ProcessManager,
  storage: WandStorage,
  sessionId: string,
  defaultMode: ExecutionMode,
): Promise<SessionSnapshot | null> {
  const existing = sessions.get(sessionId) ?? storage.getSession(sessionId);
  if (!existing) return null;
  const cleared = sessions.setArchived(sessionId, false);
  if (!cleared) return null;
  if ((existing.sessionKind ?? "pty") !== "pty" || cleared.status === "running") return cleared;
  const command = existing.command.trim();
  if (!command) return cleared;
  const provider = existing.provider ?? inferProviderFromCommand(command) ?? undefined;
  if (existing.claudeSessionId && provider && isPtyProviderCommand(provider, command)) {
    return startResumedPtySession(processes, storage, { ...existing, ...cleared }, sessionId, defaultMode, {});
  }
  return processes.start(command, existing.cwd, parseExecutionMode(existing.mode, defaultMode), undefined, {
    reuseId: sessionId,
    provider,
    model: existing.selectedModel ?? undefined,
    thinkingEffort: existing.thinkingEffort ?? undefined,
    systemPrompt: existing.systemPrompt ?? undefined,
    workspaceId: existing.workspaceId,
    workspaceTaskId: existing.workspaceTaskId,
  });
}

export function getAutoResumeInitialInput(
  snapshot: SessionSnapshot | null,
  input: string,
  view?: "chat" | "terminal",
  shortcutKey?: string,
): string | null {
  if (view === "terminal") {
    const isCodexPty = Boolean(snapshot?.provider === "codex" || /^codex\b/.test(snapshot?.command.trim() ?? ""));
    if (!isCodexPty) return null;
    if (shortcutKey && shortcutKey !== "enter_text") return null;
    if (/[\x00-\x08\x0B-\x1F\x7F]/.test(input.replace(/[\r\n]+$/g, ""))) return null;
  }
  if (shortcutKey && shortcutKey !== "enter_text") return null;
  const trimmedRight = input.replace(/[\r\n]+$/g, "").trimEnd();
  return trimmedRight.trim().length > 0 ? trimmedRight : null;
}

export function canAutoResumePtyForInput(snapshot: SessionSnapshot | null, input: string | null): snapshot is SessionSnapshot {
  return Boolean(
    snapshot
    && (snapshot.sessionKind ?? "pty") === "pty"
    && snapshot.status !== "running"
    && (isSessionProvider(snapshot.provider) || Boolean(inferProviderFromCommand(snapshot.command)))
    && snapshot.claudeSessionId
    && input
  );
}

export function canMergeSession(snapshot: SessionSnapshot): boolean {
  return Boolean(snapshot.worktreeEnabled && snapshot.worktree?.branch && snapshot.worktree?.path);
}

export function isMergeActionAllowed(snapshot: SessionSnapshot): boolean {
  return snapshot.status !== "running";
}

