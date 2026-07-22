import { createHash } from "node:crypto";
import type { Express } from "express";

import { ProcessManager, SessionInputError } from "./process-manager.js";
import { StructuredSessionManager } from "./structured-session-manager.js";
import { WandStorage } from "./storage.js";
import { ExecutionMode, InputRequest, ResizeRequest, SessionProvider, SessionRunner, SessionSnapshot, SessionSource, WandConfig } from "./types.js";
import { getDefaultModelForProvider, isExecutionMode } from "./config.js";
import { blockWindowMessagesForTransport, sliceTurnBlocksForTransport, truncateMessagesForTransport, windowMessagesForTransport } from "./message-truncator.js";
import { toSessionDetailDTO, toSessionListItemDTO } from "./session-transport.js";
import {
  checkSessionWorktreeMergeabilityAsync,
  cleanupSessionWorktreeAsync,
  getWorktreeMergeErrorCode,
  mergeSessionWorktreeAsync,
  WorktreeMergeError,
} from "./git-worktree.js";
import { resolveSessionCwd } from "./session-cwd.js";
import { resolveCommitAiContext } from "./session-ai-context.js";
import {
  getGitStatusAsync,
  QuickCommitError,
  runQuickCommitWithFallback,
  runTagHead,
  runPush,
  generateCommitMessageOnly,
} from "./git-quick-commit.js";

import { getErrorMessage } from "./error-utils.js";
import { buildProviderResumeCommand, isProviderSessionId, isSafeProviderSessionId } from "./resume-policy.js";
import { parseBoundedInteger } from "./request-limits.js";
import { asyncRoute } from "./express-async.js";
import { SessionRegistry } from "./session-registry.js";
import { enrichStructuredMessages, WAND_PROTOCOL_VERSION } from "./structured-client-protocol.js";

export function parseExecutionMode(value: unknown, fallback: ExecutionMode): ExecutionMode {
  if (value === undefined) return fallback;
  if (!isExecutionMode(value)) {
    throw new Error(`无效执行模式: ${String(value)}`);
  }
  return value;
}

export function parseSessionCreationOrigin(
  body: { sessionSource?: unknown; automationId?: unknown } | null | undefined,
): { sessionSource: SessionSource; automationId?: string } {
  const rawSource = body?.sessionSource;
  if (rawSource !== undefined && rawSource !== "interactive" && rawSource !== "automation" && rawSource !== "startup") {
    throw new Error("sessionSource 必须是 interactive、automation 或 startup。");
  }

  const rawAutomationId = body?.automationId;
  if (rawAutomationId !== undefined && typeof rawAutomationId !== "string") {
    throw new Error("automationId 必须是非空字符串。");
  }
  const automationId = rawAutomationId?.trim();
  if (rawAutomationId !== undefined && !automationId) {
    throw new Error("automationId 必须是非空字符串。");
  }

  return {
    sessionSource: rawSource ?? "interactive",
    ...(automationId ? { automationId } : {}),
  };
}

function getInputErrorResponse(error: unknown, sessionId: string) {
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
  if (errorCode === "duplicate_queued_message" || errorCode === "duplicate_idempotency_key") {
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

function parseClaudeSdkSkills(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("skills 必须是数组。");
  }
  if (value.length > 50) {
    throw new Error("最多选择 50 个 skills。");
  }

  const names = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new Error("skills 只能包含字符串。");
    const name = item.trim();
    if (!name || name.length > 128) throw new Error("skill 名称无效。");
    names.add(name);
  }
  return Array.from(names);
}

function getInputDebugMeta(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { error };
}

function getHiddenClaudeSessionIds(storage: WandStorage): Set<string> {
  const raw = storage.getConfigValue("hidden_claude_session_ids");
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function saveHiddenClaudeSessionIds(storage: WandStorage, ids: Set<string>): void {
  storage.setConfigValue("hidden_claude_session_ids", JSON.stringify(Array.from(ids)));
}

function addToHiddenClaudeSessionIds(storage: Pick<WandStorage, "getConfigValue" | "setConfigValue">, ids: string[]): void {
  if (ids.length === 0) return;
  const raw = storage.getConfigValue("hidden_claude_session_ids");
  let hidden: Set<string>;
  try {
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    hidden = new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    hidden = new Set();
  }
  let changed = false;
  for (const id of ids) {
    if (!hidden.has(id)) {
      hidden.add(id);
      changed = true;
    }
  }
  if (changed) {
    storage.setConfigValue("hidden_claude_session_ids", JSON.stringify(Array.from(hidden)));
  }
}

function removeFromHiddenClaudeSessionIds(storage: WandStorage, ids: string[]): void {
  if (ids.length === 0) return;
  const hidden = getHiddenClaudeSessionIds(storage);
  let changed = false;
  for (const id of ids) {
    changed = hidden.delete(id) || changed;
  }
  if (changed) {
    saveHiddenClaudeSessionIds(storage, hidden);
  }
}

type SessionDeletionProcesses = Pick<
  ProcessManager,
  "get" | "delete"
  | "deleteClaudeHistoryFiles" | "deleteCodexHistoryFiles"
  | "deleteOpenCodeHistorySessions" | "deleteQoderHistoryFiles"
>;

type SessionDeletionStructured = Pick<StructuredSessionManager, "get" | "delete">;

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
  const snapshot = structured.get(id) ?? processes.get(id);

  if (snapshot && (snapshot.sessionKind ?? "pty") === "structured") {
    structured.delete(id);
  } else {
    processes.delete(id);
  }

  const providerSessionId = snapshot?.claudeSessionId?.trim();
  if (!snapshot || !providerSessionId) return;

  const provider = snapshot.provider
    ?? snapshot.structuredState?.provider
    ?? (/^codex\b/i.test(snapshot.command.trim())
      ? "codex"
      : /^opencode\b/i.test(snapshot.command.trim())
        ? "opencode"
        : "claude");

  if (provider === "claude") {
    processes.deleteClaudeHistoryFiles([{
      claudeSessionId: providerSessionId,
      cwd: snapshot.cwd,
    }]);
  } else if (provider === "codex") {
    processes.deleteCodexHistoryFiles([providerSessionId]);
  } else if (provider === "opencode") {
    processes.deleteOpenCodeHistorySessions([providerSessionId]);
  } else if (provider === "qoder") {
    processes.deleteQoderHistoryFiles([providerSessionId]);
  } else {
    return;
  }

  // History deletion is intentionally best-effort at the filesystem layer.
  // Keep a tombstone as a fallback for permission errors or process tail writes.
  addToHiddenClaudeSessionIds(storage, [providerSessionId]);
}

type ProviderHistorySession = {
  claudeSessionId: string;
  cwd: string;
  firstUserMessage: string;
  timestamp: string;
  mtimeMs: number;
  hasConversation: boolean;
  managedByWand: boolean;
  provider?: "claude" | "codex" | "opencode" | "qoder";
};

export type SessionListPageEntry =
  | {
    type: "managed";
    key: string;
    sortTimestamp: number;
    session: ReturnType<typeof toSessionListItemDTO>;
  }
  | {
    type: "recoverable";
    key: string;
    sortTimestamp: number;
    history: ProviderHistorySession & { provider: "claude" | "codex" | "opencode" | "qoder" };
  };

export interface SessionListPage {
  entries: SessionListPageEntry[];
  offset: number;
  total: number;
  revision: string;
}

function sessionSortTimestamp(snapshot: SessionSnapshot): number {
  const timestamp = Date.parse(snapshot.startedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function buildSessionListPage(
  sessions: SessionSnapshot[],
  claudeHistory: ProviderHistorySession[],
  codexHistory: ProviderHistorySession[],
  hiddenHistoryIds: Set<string>,
  offset: number,
  limit: number,
  openCodeHistory: ProviderHistorySession[] = [],
  qoderHistory: ProviderHistorySession[] = [],
): SessionListPage {
  const managed = sessions.map<SessionListPageEntry>((session) => ({
    type: "managed",
    key: `session-${session.id}`,
    sortTimestamp: sessionSortTimestamp(session),
    session: toSessionListItemDTO(session),
  }));
  const recoverable = [
    ...markManagedProviderHistory(claudeHistory, sessions, "claude"),
    ...markManagedProviderHistory(codexHistory, sessions, "codex"),
    ...markManagedProviderHistory(openCodeHistory, sessions, "opencode"),
    ...markManagedProviderHistory(qoderHistory, sessions, "qoder"),
  ].flatMap<SessionListPageEntry>((history) => {
    const provider = history.provider === "codex" || history.provider === "opencode" || history.provider === "qoder"
      ? history.provider
      : "claude";
    if (!history.hasConversation || history.managedByWand || hiddenHistoryIds.has(history.claudeSessionId)) {
      return [];
    }
    return [{
      type: "recoverable",
      key: `recoverable-${provider}-${history.claudeSessionId}`,
      sortTimestamp: history.mtimeMs,
      history: { ...history, provider },
    }];
  });
  const entries = [...managed, ...recoverable].sort((left, right) => {
    const timestampOrder = right.sortTimestamp - left.sortTimestamp;
    return timestampOrder || left.key.localeCompare(right.key);
  });
  const boundedOffset = Math.min(Math.max(offset, 0), entries.length);
  const revision = createHash("sha256")
    .update(JSON.stringify(entries.map((entry) => [entry.key, entry.sortTimestamp])))
    .digest("base64url");
  return {
    entries: entries.slice(boundedOffset, boundedOffset + limit),
    offset: boundedOffset,
    total: entries.length,
    revision,
  };
}

/**
 * Provider history is scanned by ProcessManager, but structured sessions live
 * in StructuredSessionManager. Annotate against the combined session list so a
 * structured conversation is not also exposed as a recoverable native history
 * entry. Return copies for matches because ProcessManager caches scan results.
 */
export function markManagedProviderHistory<T extends ProviderHistorySession>(
  history: T[],
  sessions: SessionSnapshot[],
  provider: "claude" | "codex" | "opencode" | "qoder",
): T[] {
  const managedIds = new Set<string>();
  for (const session of sessions) {
    const sessionProvider = session.provider
      ?? session.structuredState?.provider
      ?? (/^codex\b/i.test(session.command.trim())
        ? "codex"
        : /^opencode\b/i.test(session.command.trim())
          ? "opencode"
          : /^qodercli\b/i.test(session.command.trim())
            ? "qoder"
            : "claude");
    const providerSessionId = session.claudeSessionId?.trim();
    if (sessionProvider === provider && providerSessionId) {
      managedIds.add(providerSessionId);
    }
  }

  return history.map((entry) => (
    entry.managedByWand || !managedIds.has(entry.claudeSessionId)
      ? entry
      : { ...entry, managedByWand: true }
  ));
}

function requireWorktreeSession(snapshot: SessionSnapshot | null): SessionSnapshot {
  if (!snapshot) {
    throw new Error("未找到该会话。");
  }
  if (!snapshot.worktreeEnabled || !snapshot.worktree?.branch || !snapshot.worktree?.path) {
    throw new Error("该会话未启用 worktree 模式。 ");
  }
  return snapshot;
}

function buildWorktreeMergeInfo(
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

function saveWorktreeMergeState(
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

function getWorktreeMergeResponseStatus(error: unknown): number {
  return getWorktreeMergeErrorCode(error) === "WORKTREE_MERGE_CONFLICT" ? 409 : 400;
}

function getWorktreeMergePayload(error: unknown, fallback: string) {
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

function resolvePtyResumeProvider(snapshot: SessionSnapshot): SessionProvider {
  if (snapshot.provider) return snapshot.provider;
  const command = snapshot.command.trim();
  if (/^codex\b/.test(command)) return "codex";
  if (/^opencode\b/.test(command)) return "opencode";
  if (/^grok\b/.test(command)) return "grok";
  if (/^qodercli\b/.test(command)) return "qoder";
  return "claude";
}

function isPtyProviderCommand(provider: SessionProvider, command: string): boolean {
  const executable = provider === "qoder" ? "qodercli" : provider;
  return new RegExp(`^${executable}\\b`, "i").test(command.trim());
}

function startResumedPtySession(
  processes: ProcessManager,
  existingSession: SessionSnapshot,
  sessionId: string,
  defaultMode: ExecutionMode,
  body: { mode?: ExecutionMode; cols?: number; rows?: number },
  initialInput?: string
): SessionSnapshot {
  if ((existingSession.sessionKind ?? "pty") !== "pty") {
    throw new Error("结构化会话不支持 PTY resume。");
  }

  const command = existingSession.command.trim();
  const provider = resolvePtyResumeProvider(existingSession);
  const resumeSessionId = existingSession.claudeSessionId;
  if (!resumeSessionId) {
    throw new Error(`此会话没有 ${provider} 会话 ID，无法恢复。`);
  }

  if (!isPtyProviderCommand(provider, command)) {
    throw new Error(`当前命令不是 ${provider} CLI，无法恢复。`);
  }
  if (provider === "codex") {
    if (!processes.hasCodexSessionFile(resumeSessionId)) {
      throw new Error("对应的 Codex 历史会话不存在，无法恢复。");
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
  });
}

function getAutoResumeInitialInput(
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

function canAutoResumePtyForInput(snapshot: SessionSnapshot | null, input: string | null): snapshot is SessionSnapshot {
  return Boolean(
    snapshot
    && (snapshot.sessionKind ?? "pty") === "pty"
    && snapshot.status !== "running"
    && (snapshot.provider === "claude" || snapshot.provider === "codex" || snapshot.provider === "opencode" || snapshot.provider === "grok" || snapshot.provider === "qoder"
      || /^(?:claude|codex|opencode|grok|qodercli)\b/.test(snapshot.command.trim()))
    && snapshot.claudeSessionId
    && input
  );
}

function canMergeSession(snapshot: SessionSnapshot): boolean {
  return Boolean(snapshot.worktreeEnabled && snapshot.worktree?.branch && snapshot.worktree?.path);
}

function isMergeActionAllowed(snapshot: SessionSnapshot): boolean {
  return snapshot.status !== "running";
}

export function registerSessionRoutes(
  app: Express,
  processes: ProcessManager,
  structured: StructuredSessionManager,
  storage: WandStorage,
  defaultMode: ExecutionMode,
  config: WandConfig,
  sessions: SessionRegistry,
  onSessionCreated?: (cwd: string | undefined | null) => void
): void {
  const sessionResponseDTO = (snapshot: SessionSnapshot) => {
    const windowed = windowMessagesForTransport(
      enrichStructuredMessages(snapshot.messages ?? []),
      config.cardDefaults ?? {},
    );
    return toSessionDetailDTO(snapshot, {
      messages: windowed.messages,
      messageOffset: windowed.messageOffset,
      messageTotal: windowed.messageTotal,
    });
  };

  app.get("/api/session-list", (req, res) => {
    try {
      const offset = parseBoundedInteger(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = parseBoundedInteger(req.query.limit, 40, 1, 200);
      const requestedRevision = typeof req.query.revision === "string" ? req.query.revision : "";
      const currentSessions = sessions.listSlim();
      const page = buildSessionListPage(
        currentSessions,
        processes.listClaudeHistorySessions(),
        processes.listCodexHistorySessions(),
        getHiddenClaudeSessionIds(storage),
        offset,
        limit,
        processes.listOpenCodeHistorySessions(),
        processes.listQoderHistorySessions(),
      );
      if (offset > 0 && requestedRevision !== page.revision) {
        res.status(409).json({ error: "会话列表已更新，请重新加载。", revision: page.revision });
        return;
      }
      res.json(page);
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "无法加载会话列表。") });
    }
  });

  app.get("/api/sessions", (_req, res) => {
    res.json(sessions.listSlim().map(toSessionListItemDTO));
  });

  app.post("/api/structured-sessions", asyncRoute(async (req, res) => {
    const body = req.body as { cwd?: string; mode?: ExecutionMode; prompt?: string; runner?: SessionRunner; provider?: string; worktreeEnabled?: boolean; model?: string; thinkingEffort?: string; sessionSource?: unknown; automationId?: unknown };
    try {
      if (body.provider && body.provider !== "claude" && body.provider !== "codex" && body.provider !== "opencode" && body.provider !== "grok" && body.provider !== "qoder") {
        res.status(400).json({ error: "结构化会话当前仅支持 Claude、Codex、OpenCode、Grok 或 Qoder provider。" });
        return;
      }
      const provider: SessionProvider = body.provider === "codex" || body.provider === "opencode" || body.provider === "grok" || body.provider === "qoder" ? body.provider : "claude";
      const rawModel = typeof body.model === "string" ? body.model.trim() : "";
      const origin = parseSessionCreationOrigin(body);
      const snapshot = structured.createSession({
        cwd: resolveSessionCwd(body.cwd, config.defaultCwd),
        mode: parseExecutionMode(body.mode, defaultMode),
        provider,
        // Omit runner to let StructuredSessionManager apply the configured
        // Claude default; explicit values are validated against the provider.
        runner: body.runner,
        worktreeEnabled: body.worktreeEnabled === true,
        model: rawModel || getDefaultModelForProvider(config, provider) || undefined,
        thinkingEffort: typeof body.thinkingEffort === "string"
          ? (body.thinkingEffort as SessionSnapshot["thinkingEffort"])
          : config.defaultThinkingEffort,
        ...origin,
      });
      onSessionCreated?.(snapshot.cwd);
      const prompt = body.prompt?.trim();
      if (prompt) {
        const finished = await structured.sendMessage(snapshot.id, prompt);
        res.status(201).json(finished);
        return;
      }
      res.status(201).json(sessionResponseDTO(snapshot));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法启动结构化会话。") });
    }
  }));

  app.post("/api/sessions/:id/model", (req, res) => {
    const body = req.body as { model?: string | null };
    const rawModel = typeof body?.model === "string" ? body.model.trim() : null;
    const id = req.params.id;
    try {
      const updated = sessions.setSessionModel(id, rawModel);
      if (!updated) {
        res.status(404).json({ error: "未找到该会话。" });
        return;
      }
      res.json(updated);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "切换模型失败。") });
    }
  });

  // 思考深度切换：与 /model 路由对称。结构化会话立即影响下一条 prompt（CLI/SDK 各自接入
  // --effort / thinking budget），PTY 会话通过 /effort 更新当前 Claude 进程。
  app.post("/api/sessions/:id/thinking-effort", (req, res) => {
    const body = req.body as { thinkingEffort?: string | null };
    const raw = typeof body?.thinkingEffort === "string" ? body.thinkingEffort : null;
    const id = req.params.id;
    try {
      const updated = sessions.setSessionThinkingEffort(id, raw as SessionSnapshot["thinkingEffort"]);
      if (!updated) {
        res.status(404).json({ error: "未找到该会话。" });
        return;
      }
      res.json(updated);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "切换思考深度失败。") });
    }
  });

  // 执行模式切换：与 /model、/thinking-effort 路由对称。结构化会话立即影响下一条
  // prompt（权限策略 / 系统提示 / CLI flag 都按 session.mode 逐轮重新派生）；PTY 会话
  // 仅更新 wand 自身的权限自动放行判定，已启动的 claude 进程命令行 flag 不变。codex 锁 full-access。
  app.post("/api/sessions/:id/mode", (req, res) => {
    const body = req.body as { mode?: string };
    const raw = typeof body?.mode === "string" ? body.mode.trim() : "";
    if (!raw) {
      res.status(400).json({ error: "缺少 mode。" });
      return;
    }
    if (!isExecutionMode(raw)) {
      res.status(400).json({ error: `无效执行模式: ${raw}` });
      return;
    }
    const mode = raw;
    const id = req.params.id;
    try {
      const snapshot = sessions.get(id);
      if (!snapshot) {
        res.status(404).json({ error: "未找到该会话。" });
        return;
      }
      const effective = (snapshot.provider ?? "claude") === "codex" ? "full-access" : mode;
      res.json(sessions.setSessionMode(id, effective));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "切换模式失败。") });
    }
  });

  app.get("/api/structured-sessions/:id/messages", (req, res) => {
    const snapshot = structured.get(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该结构化会话。" });
      return;
    }
    res.json({ id: snapshot.id, messages: snapshot.messages ?? [] });
  });

  app.post("/api/structured-sessions/:id/messages", asyncRoute(async (req, res) => {
    const input = String(req.body?.input ?? "");
    const interrupt = !!req.body?.interrupt;
    // preserveQueue: 仅在 interrupt 路径有意义。排队条「立即」会带这个 flag，
    // 让退出 handler 不要把剩余 queuedMessages 清空（默认行为是清空）。
    const preserveQueue = !!req.body?.preserveQueue;
    const idempotencyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined;
    try {
      const session = structured.get(req.params.id);
      if (!session) {
        res.status(404).json({ error: "未找到该结构化会话。" });
        return;
      }
      const hasSkills = Object.prototype.hasOwnProperty.call(req.body ?? {}, "skills");
      if (hasSkills && (session.provider !== "claude" || session.runner !== "claude-sdk")) {
        res.status(400).json({ error: "skills 仅支持 Claude SDK 结构化会话。" });
        return;
      }
      const skills = hasSkills ? parseClaudeSdkSkills(req.body.skills) : [];
      const snapshot = await structured.sendMessage(req.params.id, input, {
        interrupt,
        preserveQueue,
        idempotencyKey,
        skills,
      });
      res.json(sessionResponseDTO(snapshot));
    } catch (error) {
      const errorCode = (error as { code?: string } | null | undefined)?.code;
      const status = errorCode === "duplicate_idempotency_key" || errorCode === "duplicate_queued_message" ? 409 : 400;
      res.status(status).json({
        error: getErrorMessage(error, "无法发送结构化消息。"),
        errorCode,
      });
    }
  }));

  // ── Structured queued-messages management ──
  // 这些端点构成"排队消息条"的后端操作面：reorder、立即发送、单条删除、全部清空。
  // 全部走乐观更新模型，失败时前端会回滚到上一次 WS 推送的 queuedMessages。
  app.patch("/api/structured-sessions/:id/queued", (req, res) => {
    const rawOrder = req.body?.order;
    if (!Array.isArray(rawOrder)) {
      res.status(400).json({ error: "缺少 order 数组。" });
      return;
    }
    try {
      const snapshot = structured.reorderQueuedMessages(req.params.id, rawOrder.map((v: unknown) => Number(v)));
      res.json(sessionResponseDTO(snapshot));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法调整排队顺序。") });
    }
  });

  app.delete("/api/structured-sessions/:id/queued/:index", (req, res) => {
    const index = Number(req.params.index);
    if (!Number.isFinite(index)) {
      res.status(400).json({ error: "下标无效。" });
      return;
    }
    try {
      const snapshot = structured.deleteQueuedMessage(req.params.id, index);
      res.json(sessionResponseDTO(snapshot));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法删除排队消息。") });
    }
  });

  app.post("/api/structured-sessions/:id/queued/:index/promote", asyncRoute(async (req, res) => {
    const index = Number(req.params.index);
    if (!Number.isInteger(index)) {
      res.status(400).json({ error: "下标无效。" });
      return;
    }
    const expectedText = typeof req.body?.expectedText === "string" ? req.body.expectedText : undefined;
    const idempotencyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined;
    try {
      const snapshot = await structured.promoteQueuedMessage(req.params.id, index, expectedText, idempotencyKey);
      res.json(sessionResponseDTO(snapshot));
    } catch (error) {
      const errorCode = (error as { code?: string } | null | undefined)?.code;
      const status = errorCode === "duplicate_idempotency_key" ? 409 : 400;
      res.status(status).json({
        error: getErrorMessage(error, "无法立即发送排队消息。"),
        errorCode,
      });
    }
  }));

  app.delete("/api/structured-sessions/:id/queued", (req, res) => {
    try {
      const snapshot = structured.clearQueuedMessages(req.params.id);
      res.json(sessionResponseDTO(snapshot));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法清空排队消息。") });
    }
  });

  // ── Tool content lazy-load endpoint ──

  app.get("/api/sessions/:id/tool-content/:toolUseId", (req, res) => {
    const snapshot = sessions.get(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    const toolUseId = req.params.toolUseId;
    const messages = snapshot.messages ?? [];
    for (const turn of messages) {
      for (const block of turn.content) {
        if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
          res.json({
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error || false,
          });
          return;
        }
      }
    }
    res.status(404).json({ error: "未找到该工具结果。" });
  });

  app.post("/api/sessions/:id/worktree/merge/check", asyncRoute(async (req, res) => {
    try {
      const current = requireWorktreeSession(sessions.getLatest(req.params.id));
      if (!isMergeActionAllowed(current)) {
        res.status(409).json({ error: "会话仍在运行，请结束后再合并。", errorCode: "SESSION_STILL_RUNNING" });
        return;
      }
      const checking = saveWorktreeMergeState(sessions, current, "checking", {
        ...(current.worktreeMergeInfo ?? null),
        targetBranch: current.worktreeMergeInfo?.targetBranch,
        lastError: undefined,
        conflict: false,
      });
      const result = await checkSessionWorktreeMergeabilityAsync({
        worktree: checking.worktree as NonNullable<SessionSnapshot["worktree"]>,
        targetBranch: current.worktreeMergeInfo?.targetBranch,
      });
      const nextStatus: SessionSnapshot["worktreeMergeStatus"] = result.ok ? "ready" : "failed";
      const updated = saveWorktreeMergeState(sessions, checking, nextStatus, {
        targetBranch: result.targetBranch,
        conflict: result.hasConflicts,
        lastError: result.ok ? undefined : result.reason,
      });
      res.json({ session: updated, result });
    } catch (error) {
      res.status(getWorktreeMergeResponseStatus(error)).json(getWorktreeMergePayload(error, "无法检查 worktree 合并状态。"));
    }
  }));

  app.post("/api/sessions/:id/worktree/merge", asyncRoute(async (req, res) => {
    try {
      const current = requireWorktreeSession(sessions.getLatest(req.params.id));
      if (!isMergeActionAllowed(current)) {
        res.status(409).json({ error: "会话仍在运行，请结束后再合并。", errorCode: "SESSION_STILL_RUNNING" });
        return;
      }
      const merging = saveWorktreeMergeState(sessions, current, "merging", {
        ...(current.worktreeMergeInfo ?? null),
        lastError: undefined,
        conflict: false,
      });
      const result = await mergeSessionWorktreeAsync({
        worktree: merging.worktree as NonNullable<SessionSnapshot["worktree"]>,
        targetBranch: current.worktreeMergeInfo?.targetBranch,
      });
      const updated = saveWorktreeMergeState(sessions, merging, "merged", {
        targetBranch: result.targetBranch,
        mergedAt: result.mergedAt,
        mergeCommit: result.mergeCommit,
        cleanupDone: result.cleanupDone,
        lastError: undefined,
        conflict: false,
      });
      res.json({ session: updated, result });
    } catch (error) {
      const current = sessions.getLatest(req.params.id);
      if (current && canMergeSession(current)) {
        const payload = getWorktreeMergePayload(error, "无法合并 worktree。") as { error: string; errorCode: string | null; result: Partial<import("./types.js").WorktreeMergeResult> | null };
        saveWorktreeMergeState(sessions, current, "failed", {
          ...(current.worktreeMergeInfo ?? null),
          targetBranch: payload.result?.targetBranch ?? current.worktreeMergeInfo?.targetBranch,
          mergedAt: payload.result?.mergedAt,
          mergeCommit: payload.result?.mergeCommit,
          cleanupDone: payload.result?.cleanupDone,
          lastError: payload.error,
          conflict: payload.result?.conflict === true,
        });
      }
      res.status(getWorktreeMergeResponseStatus(error)).json(getWorktreeMergePayload(error, "无法合并 worktree。"));
    }
  }));

  app.get("/api/sessions/:id/git-status", asyncRoute(async (req, res) => {
    const snapshot = sessions.getLatest(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (!snapshot.cwd) {
      res.json({ isGit: false });
      return;
    }
    try {
      res.json(await getGitStatusAsync(snapshot.cwd));
    } catch (error) {
      res.json({ isGit: false, error: getErrorMessage(error, "无法读取 git 状态。") });
    }
  }));

  app.post("/api/sessions/:id/quick-commit", asyncRoute(async (req, res) => {
    const snapshot = sessions.getLatest(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (!snapshot.cwd) {
      res.status(400).json({ error: "会话没有工作目录。", errorCode: "NO_CWD" });
      return;
    }
    const body = (req.body ?? {}) as { autoMessage?: boolean; customMessage?: string; tag?: string; autoTag?: boolean; push?: boolean; submodule?: boolean };
    try {
      const ai = resolveCommitAiContext(snapshot, config);
      const result = await runQuickCommitWithFallback({
        cwd: snapshot.cwd,
        language: config.language ?? "",
        ...ai,
        autoMessage: body.autoMessage !== false,
        customMessage: typeof body.customMessage === "string" ? body.customMessage : undefined,
        tag: typeof body.tag === "string" ? body.tag : undefined,
        autoTag: !!body.autoTag,
        push: !!body.push,
        submodule: !!body.submodule,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof QuickCommitError) {
        const status = error.code === "NOTHING_TO_COMMIT" || error.code === "TAG_EXISTS" ? 409 : 400;
        res.status(status).json({ error: error.message, errorCode: error.code });
        return;
      }
      res.status(400).json({ error: getErrorMessage(error, "快捷提交失败。") });
    }
  }));

  app.post("/api/sessions/:id/generate-commit-message", asyncRoute(async (req, res) => {
    const snapshot = sessions.getLatest(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (!snapshot.cwd) {
      res.status(400).json({ error: "会话没有工作目录。" });
      return;
    }
    try {
      const ai = resolveCommitAiContext(snapshot, config);
      const result = await generateCommitMessageOnly(snapshot.cwd, config.language ?? "", {
        ...ai,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof QuickCommitError) {
        res.status(400).json({ error: error.message, errorCode: error.code });
        return;
      }
      res.status(400).json({ error: getErrorMessage(error, "生成 commit message 失败。") });
    }
  }));

  app.post("/api/sessions/:id/git/tag-head", asyncRoute(async (req, res) => {
    const snapshot = sessions.getLatest(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (!snapshot.cwd) {
      res.status(400).json({ error: "会话没有工作目录。", errorCode: "NO_CWD" });
      return;
    }
    const body = (req.body ?? {}) as { tag?: string; autoTag?: boolean; push?: boolean };
    try {
      const ai = resolveCommitAiContext(snapshot, config);
      const result = await runTagHead({
        cwd: snapshot.cwd,
        language: config.language ?? "",
        ...ai,
        tag: typeof body.tag === "string" ? body.tag : undefined,
        autoTag: !!body.autoTag,
        push: !!body.push,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof QuickCommitError) {
        const status = error.code === "TAG_EXISTS" ? 409 : 400;
        res.status(status).json({ error: error.message, errorCode: error.code });
        return;
      }
      res.status(400).json({ error: getErrorMessage(error, "打 tag 失败。") });
    }
  }));

  app.post("/api/sessions/:id/git/push", asyncRoute(async (req, res) => {
    const snapshot = sessions.getLatest(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (!snapshot.cwd) {
      res.status(400).json({ error: "会话没有工作目录。", errorCode: "NO_CWD" });
      return;
    }
    const body = (req.body ?? {}) as { pushCommits?: boolean; pushTags?: boolean; submodule?: boolean; tag?: string };
    try {
      const result = await runPush({
        cwd: snapshot.cwd,
        pushCommits: body.pushCommits !== false,
        pushTags: !!body.pushTags,
        submodule: !!body.submodule,
        tagName: typeof body.tag === "string" ? body.tag : undefined,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof QuickCommitError) {
        res.status(400).json({ error: error.message, errorCode: error.code });
        return;
      }
      res.status(400).json({ error: getErrorMessage(error, "推送失败。") });
    }
  }));

  app.post("/api/sessions/:id/worktree/cleanup", asyncRoute(async (req, res) => {
    try {
      const current = requireWorktreeSession(sessions.getLatest(req.params.id));
      if (current.worktreeMergeStatus !== "merged" || current.worktreeMergeInfo?.cleanupDone !== false) {
        res.status(400).json({ error: "当前 worktree 无需补偿清理。", errorCode: "WORKTREE_CLEANUP_NOT_NEEDED" });
        return;
      }
      await cleanupSessionWorktreeAsync({ worktree: current.worktree as NonNullable<SessionSnapshot["worktree"]> });
      const updated = saveWorktreeMergeState(sessions, current, "merged", {
        ...(current.worktreeMergeInfo ?? null),
        cleanupDone: true,
        lastError: undefined,
        conflict: false,
      });
      res.json({ session: updated, ok: true });
    } catch (error) {
      res.status(getWorktreeMergeResponseStatus(error)).json(getWorktreeMergePayload(error, "无法清理 worktree。"));
    }
  }));

  app.post("/api/sessions/batch-delete", (req, res) => {
    const sessionIds = Array.isArray(req.body?.sessionIds)
      ? req.body.sessionIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      : [];

    if (sessionIds.length === 0) {
      res.status(400).json({ error: "至少提供一个会话 ID。" });
      return;
    }

    let deleted = 0;
    const failed: string[] = [];

    for (const sessionId of sessionIds) {
      try {
        sessions.deleteWithProviderHistory(sessionId);
        deleted += 1;
      } catch {
        failed.push(sessionId);
      }
    }

    if (deleted === 0 && failed.length > 0) {
      res.status(400).json({ error: "无法批量删除会话。", failed });
      return;
    }

    res.json({ ok: true, deleted, failed });
  });

  app.get("/api/sessions/:id", (req, res) => {
    const snapshot = sessions.get(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话，可能已被删除。" });
      return;
    }
    const transcriptOutput = (snapshot.sessionKind ?? "pty") === "pty"
      ? processes.getPtyTranscript(snapshot.id) ?? snapshot.output
      : snapshot.output;
    if (req.query.format === "chat") {
      // 客户端带 blockBudget（iOS）走块级窗口：只回最近 N 个块（必要时切掉最旧 turn 的头部），
      // 根治「单条 turn 上百块/1MB」的长任务打开慢。Web/Android 不带该参数，走原 turn 级窗口。
      const rawBudget = req.query.blockBudget;
      if (typeof rawBudget === "string" && /^\d+$/.test(rawBudget) && Number(rawBudget) > 0) {
        const blockBudget = parseBoundedInteger(rawBudget, 1, 1, 2_000);
        const windowed = blockWindowMessagesForTransport(
          enrichStructuredMessages(snapshot.messages ?? []),
          config.cardDefaults ?? {},
          blockBudget,
        );
        res.json(toSessionDetailDTO(snapshot, {
          output: transcriptOutput,
          messages: windowed.messages,
          messageOffset: windowed.messageOffset,
          messageTotal: windowed.messageTotal,
          leadingBlockOffset: windowed.leadingBlockOffset,
          leadingBlockTotal: windowed.leadingBlockTotal,
        }));
        return;
      }
      // 与 WS init 对齐：只回最近一窗 turn + offset/total，更早的走 /messages 翻页。
      const windowed = windowMessagesForTransport(
        enrichStructuredMessages(snapshot.messages ?? []),
        config.cardDefaults ?? {},
      );
      res.json(toSessionDetailDTO(snapshot, {
        output: transcriptOutput,
        messages: windowed.messages,
        messageOffset: windowed.messageOffset,
        messageTotal: windowed.messageTotal,
      }));
    } else {
      res.json(toSessionDetailDTO(snapshot, { output: transcriptOutput }));
    }
  });

  // 历史消息分页拉取：客户端滚动到顶时按绝对下标往前翻。
  // 返回 messages = 完整历史的 [offset, offset+limit)（已做 transport 截断）+ total。
  app.get("/api/sessions/:id/messages", (req, res) => {
    const snapshot = sessions.get(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话，可能已被删除。" });
      return;
    }
    const all = enrichStructuredMessages(snapshot.messages ?? []);
    const total = all.length;

    // 块级翻页（iOS）：?turn=<i>&blockOffset=<当前 leading 偏移>&blockLimit=<N>
    // 取该 turn 的 [start, blockOffset) 段（start = max(0, blockOffset - blockLimit)）。
    const rawTurn = parseInt(String(req.query.turn ?? ""), 10);
    if (Number.isFinite(rawTurn)) {
      const turnIndex = Math.min(Math.max(rawTurn, 0), Math.max(total - 1, 0));
      const turn = all[turnIndex];
      if (!turn) {
        res.json({ turnIndex, blocks: [], blockOffset: 0, blockTotal: 0 });
        return;
      }
      const blockTotal = turn.content.length;
      const rawBlockLimit = parseInt(String(req.query.blockLimit ?? ""), 10);
      const rawBlockOffset = parseInt(String(req.query.blockOffset ?? ""), 10);
      const blockLimit = Math.min(Math.max(Number.isFinite(rawBlockLimit) ? rawBlockLimit : 40, 1), 200);
      const blockEnd = Math.min(Math.max(Number.isFinite(rawBlockOffset) ? rawBlockOffset : blockTotal, 0), blockTotal);
      const blockStart = Math.max(0, blockEnd - blockLimit);
      const blocks = enrichStructuredMessages([{
        ...turn,
        content: sliceTurnBlocksForTransport(turn, blockStart, blockEnd, config.cardDefaults ?? {}),
      }])[0].content;
      res.json({ wandProtocolVersion: WAND_PROTOCOL_VERSION, turnIndex, blocks, blockOffset: blockStart, blockTotal });
      return;
    }

    const rawLimit = parseInt(String(req.query.limit ?? ""), 10);
    const rawOffset = parseInt(String(req.query.offset ?? ""), 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 40, 1), 200);
    const offset = Math.min(Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0), total);
    const end = Math.min(offset + limit, total);
    const slice = enrichStructuredMessages(truncateMessagesForTransport(all.slice(offset, end), config.cardDefaults ?? {}));
    res.json({ wandProtocolVersion: WAND_PROTOCOL_VERSION, messages: slice, offset, total });
  });

  app.post("/api/sessions/:id/resume", (req, res) => {
    const sessionId = req.params.id;
    const body = req.body as { mode?: ExecutionMode; view?: "chat" | "terminal"; cols?: number; rows?: number };
    try {
      const existingSession = processes.get(sessionId) || storage.getSession(sessionId);
      if (!existingSession) {
        res.status(404).json({ error: "会话不存在。" });
        return;
      }
      if ((existingSession.sessionKind ?? "pty") !== "pty") {
        res.status(400).json({ error: "结构化会话不支持 PTY resume。" });
        return;
      }
      const newSnapshot = startResumedPtySession(processes, existingSession, sessionId, defaultMode, body);
      res.status(201).json(newSnapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法恢复会话。") });
    }
  });

  app.post("/api/claude-sessions/:claudeSessionId/resume", (req, res) => {
    const claudeSessionId = String(req.params.claudeSessionId || "").trim();
    const body = req.body as { mode?: ExecutionMode; cwd?: string; cols?: number; rows?: number; sessionSource?: unknown; automationId?: unknown };
    try {
      const requestedOrigin = body.sessionSource !== undefined || body.automationId !== undefined
        ? parseSessionCreationOrigin(body)
        : null;
      if (!isProviderSessionId(claudeSessionId)) {
        res.status(400).json({ error: "Claude 会话 ID 必须是有效的 UUID。" });
        return;
      }
      const existingSession = storage.getLatestSessionByClaudeSessionId(claudeSessionId);
      if (existingSession) {
        if (existingSession.provider && existingSession.provider !== "claude") {
          res.status(400).json({ error: "只有 Claude provider 支持按 Claude Session ID 恢复。" });
          return;
        }
        const command = existingSession.command.trim();
        if ((existingSession.sessionKind ?? "pty") !== "pty") {
          res.status(400).json({ error: "结构化会话不支持按 Claude Session ID 恢复。" });
          return;
        }
        if (!/^claude\b/.test(command)) {
          res.status(400).json({ error: "只有 Claude 命令支持按 Claude Session ID 恢复。" });
          return;
        }
        if (!existingSession.cwd || !processes.hasClaudeSessionFile(existingSession.cwd, claudeSessionId)) {
          res.status(400).json({ error: "对应的 Claude 历史会话文件不存在，无法恢复。" });
          return;
        }
        const newMode = parseExecutionMode(body.mode, parseExecutionMode(existingSession.mode, defaultMode));
        // Do not reuse the persisted shell command here. It may contain flags or
        // shell operators and must never become part of a resume command.
        const resumeCommand = `claude --resume ${claudeSessionId}`;
        const reqCols = typeof body.cols === "number" && Number.isFinite(body.cols) ? body.cols : undefined;
        const reqRows = typeof body.rows === "number" && Number.isFinite(body.rows) ? body.rows : undefined;
        const newSnapshot = processes.start(resumeCommand, existingSession.cwd, newMode, undefined, {
          reuseId: existingSession.id,
          cols: reqCols,
          rows: reqRows,
          ...(requestedOrigin ?? {}),
        });
        res.status(201).json({ resumedClaudeSessionId: claudeSessionId, ...sessionResponseDTO(newSnapshot) });
      } else {
        const cwd = body.cwd?.trim();
        if (!cwd) {
          res.status(400).json({ error: "未找到对应的会话记录，请提供工作目录 (cwd)。" });
          return;
        }
        const newMode = parseExecutionMode(body.mode, defaultMode);
        const resumeCommand = `claude --resume ${claudeSessionId}`;
        const reqCols = typeof body.cols === "number" && Number.isFinite(body.cols) ? body.cols : undefined;
        const reqRows = typeof body.rows === "number" && Number.isFinite(body.rows) ? body.rows : undefined;
        const newSnapshot = processes.start(resumeCommand, cwd, newMode, undefined, {
          cols: reqCols,
          rows: reqRows,
          ...(requestedOrigin ?? {}),
        });
        res.status(201).json({ resumedClaudeSessionId: claudeSessionId, ...sessionResponseDTO(newSnapshot) });
      }
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法按 Claude 会话 ID 恢复会话。") });
    }
  });

  app.post("/api/sessions/:id/input", asyncRoute(async (req, res) => {
    const body = req.body as InputRequest;
    const sessionId = req.params.id;
    const input = body.input ?? "";
    const view = body.view;
    const shortcutKey = body.shortcutKey;
    try {
      if (structured.get(sessionId)) {
        const completion = structured.sendMessage(sessionId, input);
        if (body.respondImmediately === true) {
          // sendMessage updates the canonical snapshot synchronously before it
          // starts awaiting the runner. Native clients should not hold this
          // request open for an entire model turn (which can exceed their HTTP
          // timeout, especially while the first-turn title job is also active).
          // The normal structured events continue to carry progress/failure.
          completion.catch((error) => {
            console.error("[wand] Accepted structured input later failed", {
              sessionId,
              error: getInputDebugMeta(error),
            });
          });
          const accepted = structured.get(sessionId);
          if (!accepted) {
            throw new Error("未找到该结构化会话。");
          }
          res.status(202).json(sessionResponseDTO(accepted));
          return;
        }
        const snapshot = await completion;
        res.json(sessionResponseDTO(snapshot));
        return;
      }
      const existingSession = processes.get(sessionId) || storage.getSession(sessionId);
      const autoResumeInput = getAutoResumeInitialInput(existingSession, input, view, shortcutKey);
      if (autoResumeInput !== null && canAutoResumePtyForInput(existingSession, autoResumeInput)) {
        const snapshot = startResumedPtySession(processes, existingSession, sessionId, defaultMode, {}, autoResumeInput);
        res.json(sessionResponseDTO(snapshot));
        return;
      }
      const snapshot = processes.sendInput(sessionId, input, view, shortcutKey);
      res.json(sessionResponseDTO(snapshot));
    } catch (error) {
      const response = getInputErrorResponse(error, sessionId);
      console.error("[wand] Input request failed", {
        sessionId, inputLength: input.length, view: view ?? "chat",
        responseStatus: response.statusCode, responsePayload: response.payload,
        error: getInputDebugMeta(error),
      });
      res.status(response.statusCode).json(response.payload);
    }
  }));

  app.post("/api/codex-sessions/:threadId/resume", asyncRoute(async (req, res) => {
    const threadId = String(req.params.threadId || "").trim();
    const body = req.body as { mode?: ExecutionMode; cwd?: string; worktreeEnabled?: boolean; sessionSource?: unknown; automationId?: unknown };
    try {
      if (!isProviderSessionId(threadId)) {
        res.status(400).json({ error: "Codex 会话 ID 必须是有效的 UUID。" });
        return;
      }
      const history = processes.listCodexHistorySessions().find((s) => s.claudeSessionId === threadId);
      if (!history) {
        res.status(400).json({ error: "对应的 Codex 历史会话不存在，无法恢复。" });
        return;
      }
      const cwd = body.cwd?.trim() || history.cwd;
      if (!cwd) {
        res.status(400).json({ error: "无法确定工作目录 (cwd)，无法恢复。" });
        return;
      }
      const newMode = parseExecutionMode(body.mode, defaultMode);
      const origin = parseSessionCreationOrigin(body);
      const snapshot = structured.createSession({
        cwd,
        mode: newMode,
        provider: "codex",
        runner: "codex-cli-exec",
        worktreeEnabled: body.worktreeEnabled === true,
        claudeSessionId: threadId,
        ...origin,
      });
      onSessionCreated?.(cwd);
      res.status(201).json({ resumedClaudeSessionId: threadId, ...sessionResponseDTO(snapshot) });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法按 Codex 会话 ID 恢复会话。") });
    }
  }));

  /**
   * OpenCode and Qoder own their native transcript storage. Restoring an
   * external transcript creates a Wand structured shell carrying the native
   * ID; each provider runner adds its own resume flag when the next input is
   * sent, preserving the original context without importing the full history.
   */
  app.post("/api/opencode-sessions/:sessionId/resume", (req, res) => {
    const sessionId = String(req.params.sessionId || "").trim();
    const body = req.body as { mode?: ExecutionMode; cwd?: string; worktreeEnabled?: boolean; sessionSource?: unknown; automationId?: unknown };
    try {
      if (!isSafeProviderSessionId(sessionId)) {
        res.status(400).json({ error: "OpenCode 会话 ID 格式无效。" });
        return;
      }
      const history = processes.listOpenCodeHistorySessions().find((session) => session.claudeSessionId === sessionId);
      if (!history) {
        res.status(400).json({ error: "对应的 OpenCode 历史会话不存在，无法恢复。" });
        return;
      }
      const cwd = body.cwd?.trim() || history.cwd;
      if (!cwd) {
        res.status(400).json({ error: "无法确定工作目录 (cwd)，无法恢复。" });
        return;
      }
      const snapshot = structured.createSession({
        cwd,
        mode: parseExecutionMode(body.mode, defaultMode),
        provider: "opencode",
        runner: "opencode-cli-run",
        worktreeEnabled: body.worktreeEnabled === true,
        claudeSessionId: sessionId,
        ...parseSessionCreationOrigin(body),
      });
      onSessionCreated?.(cwd);
      res.status(201).json({ resumedClaudeSessionId: sessionId, ...sessionResponseDTO(snapshot) });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法按 OpenCode 会话 ID 恢复会话。") });
    }
  });

  app.post("/api/qoder-sessions/:sessionId/resume", (req, res) => {
    const sessionId = String(req.params.sessionId || "").trim();
    const body = req.body as { mode?: ExecutionMode; cwd?: string; worktreeEnabled?: boolean; sessionSource?: unknown; automationId?: unknown };
    try {
      if (!isSafeProviderSessionId(sessionId)) {
        res.status(400).json({ error: "Qoder 会话 ID 格式无效。" });
        return;
      }
      const history = processes.listQoderHistorySessions().find((session) => session.claudeSessionId === sessionId);
      if (!history) {
        res.status(400).json({ error: "对应的 Qoder 历史会话不存在，无法恢复。" });
        return;
      }
      const cwd = body.cwd?.trim() || history.cwd;
      if (!cwd) {
        res.status(400).json({ error: "无法确定工作目录 (cwd)，无法恢复。" });
        return;
      }
      const snapshot = structured.createSession({
        cwd,
        mode: parseExecutionMode(body.mode, defaultMode),
        provider: "qoder",
        runner: "qoder-cli-print",
        worktreeEnabled: body.worktreeEnabled === true,
        claudeSessionId: sessionId,
        ...parseSessionCreationOrigin(body),
      });
      onSessionCreated?.(cwd);
      res.status(201).json({ resumedClaudeSessionId: sessionId, ...sessionResponseDTO(snapshot) });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法按 Qoder 会话 ID 恢复会话。") });
    }
  });
  app.post("/api/sessions/:id/resize", (req, res) => {
    const body = req.body as ResizeRequest;
    try {
      if (sessions.ownerOf(req.params.id) === "structured") {
        res.status(400).json({ error: "结构化会话不支持调整终端大小。" });
        return;
      }
      const snapshot = processes.resize(req.params.id, body.cols ?? 0, body.rows ?? 0);
      res.json(sessionResponseDTO(snapshot));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法调整终端大小。") });
    }
  });

  app.post("/api/sessions/:id/approve-permission", (req, res) => {
    try {
      if (sessions.ownerOf(req.params.id) === "structured") {
        res.status(400).json({ error: "结构化会话不需要终端权限操作。" });
        return;
      }
      const snapshot = sessions.get(req.params.id);
      if (snapshot?.provider === "codex") {
        res.status(400).json({ error: "Codex provider 不支持权限批准操作。" });
        return;
      }
      res.json(processes.approvePermission(req.params.id));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法批准该授权请求。") });
    }
  });

  app.post("/api/sessions/:id/deny-permission", (req, res) => {
    try {
      if (sessions.ownerOf(req.params.id) === "structured") {
        res.status(400).json({ error: "结构化会话不需要终端权限操作。" });
        return;
      }
      const snapshot = sessions.get(req.params.id);
      if (snapshot?.provider === "codex") {
        res.status(400).json({ error: "Codex provider 不支持权限拒绝操作。" });
        return;
      }
      res.json(processes.denyPermission(req.params.id));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法拒绝该授权请求。") });
    }
  });

  app.post("/api/sessions/:id/toggle-auto-approve", (req, res) => {
    try {
      if (sessions.ownerOf(req.params.id) === "structured") {
        res.status(400).json({ error: "结构化会话不需要切换终端自动批准。" });
        return;
      }
      const snapshot = sessions.get(req.params.id);
      if (snapshot?.provider === "codex") {
        res.status(400).json({ error: "Codex provider 不支持自动批准切换。" });
        return;
      }
      res.json(processes.toggleAutoApprove(req.params.id));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法切换自动批准状态。") });
    }
  });

  app.post("/api/sessions/:id/escalations/:requestId/resolve", (req, res) => {
    try {
      const { requestId } = req.params;
      const body = req.body as { resolution?: unknown };
      const resolution = body?.resolution;
      if (resolution !== "approve_once" && resolution !== "approve_turn" && resolution !== "deny") {
        res.status(400).json({ error: "resolution 必须是 approve_once、approve_turn 或 deny。" });
        return;
      }
      if (sessions.ownerOf(req.params.id) === "structured") {
        res.json(structured.resolveEscalation(req.params.id, requestId, resolution));
        return;
      }
      res.json(processes.resolveEscalation(req.params.id, requestId, resolution));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法处理该授权请求。") });
    }
  });

  app.post("/api/sessions/:id/stop", (req, res) => {
    try {
      if (sessions.ownerOf(req.params.id) === "structured") {
        res.json(structured.stop(req.params.id));
        return;
      }
      res.json(processes.stop(req.params.id));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法停止会话。") });
    }
  });

  app.delete("/api/sessions/:id", (req, res) => {
    try {
      sessions.deleteWithProviderHistory(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法删除会话。") });
    }
  });
}

export function registerClaudeHistoryRoutes(
  app: Express,
  processes: ProcessManager,
  structured: StructuredSessionManager,
  storage: WandStorage,
  sessionRegistry: SessionRegistry,
): void {
  app.get("/api/claude-history", (_req, res) => {
    try {
      const history = markManagedProviderHistory(
        processes.listClaudeHistorySessions(),
        sessionRegistry.listSlim(),
        "claude",
      );
      const hidden = getHiddenClaudeSessionIds(storage);
      const filtered = hidden.size > 0
        ? history.filter((s: { claudeSessionId?: string }) => !s.claudeSessionId || !hidden.has(s.claudeSessionId))
        : history;
      res.json(filtered);
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "无法扫描 Claude 历史会话。") });
    }
  });

  app.delete("/api/claude-history/:claudeSessionId", (req, res) => {
    const claudeSessionId = req.params.claudeSessionId?.trim();
    if (!claudeSessionId) {
      res.status(400).json({ error: "会话 ID 不能为空。" });
      return;
    }
    const session = processes.listClaudeHistorySessions().find((s) => s.claudeSessionId === claudeSessionId);
    if (session) {
      processes.deleteClaudeHistoryFiles([{ claudeSessionId, cwd: session.cwd }]);
      removeFromHiddenClaudeSessionIds(storage, [claudeSessionId]);
    } else {
      const hidden = getHiddenClaudeSessionIds(storage);
      if (!hidden.has(claudeSessionId)) {
        hidden.add(claudeSessionId);
        saveHiddenClaudeSessionIds(storage, hidden);
      }
    }
    res.json({ ok: true });
  });

  app.delete("/api/claude-history", (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd.trim() : "";
    if (!cwd) {
      res.status(400).json({ error: "目录不能为空。" });
      return;
    }

    try {
      const sessions = processes.listClaudeHistorySessions();
      const toDelete: { claudeSessionId: string; cwd: string }[] = [];

      for (const session of sessions) {
        if (session.claudeSessionId && session.cwd === cwd) {
          toDelete.push({ claudeSessionId: session.claudeSessionId, cwd: session.cwd });
        }
      }

      const deleted = processes.deleteClaudeHistoryFiles(toDelete);
      removeFromHiddenClaudeSessionIds(storage, toDelete.map((s) => s.claudeSessionId));

      res.json({ ok: true, deleted });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "无法删除该目录下的历史会话。") });
    }
  });

  app.post("/api/claude-history/batch-delete", (req, res) => {
    const claudeSessionIds = Array.isArray(req.body?.claudeSessionIds)
      ? req.body.claudeSessionIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      : [];

    if (claudeSessionIds.length === 0) {
      res.status(400).json({ error: "至少提供一个历史会话 ID。" });
      return;
    }

    try {
      const allSessions = processes.listClaudeHistorySessions();
      const sessionMap = new Map<string, string>();
      for (const s of allSessions) {
        if (s.claudeSessionId) sessionMap.set(s.claudeSessionId, s.cwd);
      }

      const toDelete: { claudeSessionId: string; cwd: string }[] = [];
      const toHide: string[] = [];

      for (const id of claudeSessionIds) {
        const cwd = sessionMap.get(id);
        if (cwd) {
          toDelete.push({ claudeSessionId: id, cwd });
        } else {
          toHide.push(id);
        }
      }

      const deleted = processes.deleteClaudeHistoryFiles(toDelete);
      removeFromHiddenClaudeSessionIds(storage, toDelete.map((s) => s.claudeSessionId));

      if (toHide.length > 0) {
        const hidden = getHiddenClaudeSessionIds(storage);
        let added = 0;
        for (const id of toHide) {
          if (!hidden.has(id)) {
            hidden.add(id);
            added++;
          }
        }
        if (added > 0) saveHiddenClaudeSessionIds(storage, hidden);
      }

      res.json({ ok: true, deleted: deleted + toHide.length });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "无法批量删除历史会话。") });
    }
  });

  // ── Codex history（~/.codex/sessions/ 扫描，对齐 Claude 历史区） ──
  // codex 历史的"恢复"是新建一个结构化 codex 会话并预填 thread id（存进 claudeSessionId
  // 字段），用户发第一条消息时 buildCodexArgs 自动拼 `codex exec ... resume <thread_id>`。
  // hidden 集合与 claude 共用（id 全局唯一，不会冲突）。

  app.get("/api/codex-history", (_req, res) => {
    try {
      const history = markManagedProviderHistory(
        processes.listCodexHistorySessions(),
        sessionRegistry.listSlim(),
        "codex",
      );
      const hidden = getHiddenClaudeSessionIds(storage);
      const filtered = hidden.size > 0
        ? history.filter((s) => !hidden.has(s.claudeSessionId))
        : history;
      res.json(filtered);
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "无法扫描 Codex 历史会话。") });
    }
  });

  app.delete("/api/codex-history/:threadId", (req, res) => {
    const threadId = req.params.threadId?.trim();
    if (!threadId) {
      res.status(400).json({ error: "会话 ID 不能为空。" });
      return;
    }
    const exists = processes.listCodexHistorySessions().some((s) => s.claudeSessionId === threadId);
    if (exists) {
      processes.deleteCodexHistoryFiles([threadId]);
      removeFromHiddenClaudeSessionIds(storage, [threadId]);
    } else {
      const hidden = getHiddenClaudeSessionIds(storage);
      if (!hidden.has(threadId)) {
        hidden.add(threadId);
        saveHiddenClaudeSessionIds(storage, hidden);
      }
    }
    res.json({ ok: true });
  });

  app.post("/api/codex-history/batch-delete", (req, res) => {
    const threadIds = Array.isArray(req.body?.claudeSessionIds)
      ? req.body.claudeSessionIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (threadIds.length === 0) {
      res.status(400).json({ error: "至少提供一个历史会话 ID。" });
      return;
    }
    try {
      const existing = new Set(processes.listCodexHistorySessions().map((s) => s.claudeSessionId));
      const toDelete: string[] = [];
      const toHide: string[] = [];
      for (const id of threadIds) {
        if (existing.has(id)) toDelete.push(id);
        else toHide.push(id);
      }

      const deleted = processes.deleteCodexHistoryFiles(toDelete);
      removeFromHiddenClaudeSessionIds(storage, toDelete);

      if (toHide.length > 0) {
        const hidden = getHiddenClaudeSessionIds(storage);
        let added = 0;
        for (const id of toHide) {
          if (!hidden.has(id)) {
            hidden.add(id);
            added++;
          }
        }
        if (added > 0) saveHiddenClaudeSessionIds(storage, hidden);
      }

      res.json({ ok: true, deleted: deleted + toHide.length });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "无法批量删除历史会话。") });
    }
  });

  const externalHistoryProviders: Array<{
    provider: "opencode" | "qoder";
    label: string;
    list: () => ProviderHistorySession[];
    remove: (ids: string[]) => number;
  }> = [
    {
      provider: "opencode" as const,
      label: "OpenCode",
      list: () => processes.listOpenCodeHistorySessions(),
      remove: (ids: string[]) => processes.deleteOpenCodeHistorySessions(ids),
    },
    {
      provider: "qoder" as const,
      label: "Qoder",
      list: () => processes.listQoderHistorySessions(),
      remove: (ids: string[]) => processes.deleteQoderHistoryFiles(ids),
    },
  ];

  for (const config of externalHistoryProviders) {
    app.get(`/api/${config.provider}-history`, (_req, res) => {
      try {
        const history = markManagedProviderHistory(
          config.list(),
          sessionRegistry.listSlim(),
          config.provider,
        );
        const hidden = getHiddenClaudeSessionIds(storage);
        res.json(hidden.size > 0 ? history.filter((session) => !hidden.has(session.claudeSessionId)) : history);
      } catch (error) {
        res.status(500).json({ error: getErrorMessage(error, `无法扫描 ${config.label} 历史会话。`) });
      }
    });

    app.delete(`/api/${config.provider}-history/:sessionId`, (req, res) => {
      const sessionId = req.params.sessionId?.trim();
      if (!sessionId) {
        res.status(400).json({ error: "会话 ID 不能为空。" });
        return;
      }
      try {
        const exists = config.list().some((session) => session.claudeSessionId === sessionId);
        if (exists) {
          config.remove([sessionId]);
          removeFromHiddenClaudeSessionIds(storage, [sessionId]);
        } else {
          addToHiddenClaudeSessionIds(storage, [sessionId]);
        }
        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: getErrorMessage(error, `无法删除 ${config.label} 历史会话。`) });
      }
    });

    app.post(`/api/${config.provider}-history/batch-delete`, (req, res) => {
      const sessionIds: string[] = Array.isArray(req.body?.claudeSessionIds)
        ? req.body.claudeSessionIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      if (sessionIds.length === 0) {
        res.status(400).json({ error: "至少提供一个历史会话 ID。" });
        return;
      }
      try {
        const existing = new Set(config.list().map((session) => session.claudeSessionId));
        const toDelete = sessionIds.filter((id) => existing.has(id));
        const toHide = sessionIds.filter((id) => !existing.has(id));
        const deleted = config.remove(toDelete);
        removeFromHiddenClaudeSessionIds(storage, toDelete);
        addToHiddenClaudeSessionIds(storage, toHide);
        res.json({ ok: true, deleted: deleted + toHide.length });
      } catch (error) {
        res.status(500).json({ error: getErrorMessage(error, `无法批量删除 ${config.label} 历史会话。`) });
      }
    });
  }
}
