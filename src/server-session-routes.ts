import express, { Express } from "express";

import { ProcessManager, SessionInputError } from "./process-manager.js";
import { StructuredSessionManager } from "./structured-session-manager.js";
import { WandStorage } from "./storage.js";
import { ExecutionMode, InputRequest, ResizeRequest, SessionRunner, SessionSnapshot, WandConfig } from "./types.js";
import { normalizeMode } from "./config.js";
import { blockWindowMessagesForTransport, sliceTurnBlocksForTransport, truncateMessagesForTransport, windowMessagesForTransport } from "./message-truncator.js";
import { checkSessionWorktreeMergeability, cleanupSessionWorktree, getWorktreeMergeErrorCode, mergeSessionWorktree, WorktreeMergeError } from "./git-worktree.js";
import { resolveSessionCwd } from "./session-cwd.js";
import {
  getGitStatus,
  QuickCommitError,
  runQuickCommit,
  runTagHead,
  runPush,
  generateCommitMessageOnly,
} from "./git-quick-commit.js";

import { getErrorMessage } from "./error-utils.js";
export { getErrorMessage };

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

function getSessionById(processes: ProcessManager, structured: StructuredSessionManager, id: string) {
  return structured.get(id) ?? processes.get(id);
}

function listAllSessions(processes: ProcessManager, structured: StructuredSessionManager) {
  return [...structured.list(), ...processes.list()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Lightweight session list — omits output and messages to reduce payload. */
function listAllSessionsSlim(processes: ProcessManager, structured: StructuredSessionManager) {
  return [...structured.listSlim(), ...processes.listSlim()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
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
  status: SessionSnapshot["worktreeMergeStatus"],
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
  storage: WandStorage,
  current: SessionSnapshot,
  status: SessionSnapshot["worktreeMergeStatus"],
  info: SessionSnapshot["worktreeMergeInfo"]
): SessionSnapshot {
  const mergedInfo = buildWorktreeMergeInfo(current, status, info);
  const updated: SessionSnapshot = {
    ...current,
    worktreeMergeStatus: status,
    worktreeMergeInfo: mergedInfo,
  };
  storage.saveSessionMetadata(updated);
  return updated;
}

function getWorktreeMergeResponseStatus(error: unknown): number {
  const code = getWorktreeMergeErrorCode(error);
  if (!code) {
    return 400;
  }
  if (code === "WORKTREE_MERGE_CONFLICT") {
    return 409;
  }
  return 400;
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

function getLatestSessionSnapshot(processes: ProcessManager, structured: StructuredSessionManager, storage: WandStorage, id: string): SessionSnapshot | null {
  return getSessionById(processes, structured, id) ?? storage.getSession(id);
}

function buildCodexResumeCommand(command: string, threadId: string): string {
  const trimmed = command.trim();
  const withoutExistingResume = trimmed
    .replace(/\s+resume\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\s|$)/i, " ")
    .trim();
  return `${withoutExistingResume || "codex"} resume ${threadId}`;
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
  onSessionCreated?: (cwd: string | undefined | null) => void
): void {
  app.get("/api/sessions", (_req, res) => {
    const all = listAllSessionsSlim(processes, structured);
    res.json(all);
  });

  app.post("/api/structured-sessions", express.json(), async (req, res) => {
    const body = req.body as { cwd?: string; mode?: ExecutionMode; prompt?: string; runner?: SessionRunner; provider?: string; worktreeEnabled?: boolean; model?: string; thinkingEffort?: string };
    try {
      if (body.provider && body.provider !== "claude" && body.provider !== "codex") {
        res.status(400).json({ error: "结构化会话当前仅支持 Claude 或 Codex provider。" });
        return;
      }
      const provider = body.provider === "codex" ? "codex" : "claude";
      const snapshot = structured.createSession({
        cwd: resolveSessionCwd(body.cwd, config.defaultCwd),
        mode: normalizeMode(body.mode, defaultMode),
        provider,
        runner: body.runner ?? (provider === "codex" ? "codex-cli-exec" : "claude-cli-print"),
        worktreeEnabled: body.worktreeEnabled === true,
        model: typeof body.model === "string" ? body.model.trim() : (config.defaultModel ?? "").trim() || undefined,
        thinkingEffort: typeof body.thinkingEffort === "string"
          ? (body.thinkingEffort as SessionSnapshot["thinkingEffort"])
          : config.defaultThinkingEffort,
      });
      onSessionCreated?.(snapshot.cwd);
      const prompt = body.prompt?.trim();
      if (prompt) {
        const finished = await structured.sendMessage(snapshot.id, prompt);
        res.status(201).json(finished);
        return;
      }
      res.status(201).json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法启动结构化会话。") });
    }
  });

  app.post("/api/sessions/:id/model", express.json(), (req, res) => {
    const body = req.body as { model?: string | null };
    const rawModel = typeof body?.model === "string" ? body.model.trim() : null;
    const id = req.params.id;
    try {
      const structuredSnapshot = structured.get(id);
      if (structuredSnapshot) {
        const updated = structured.setSessionModel(id, rawModel);
        res.json(updated);
        return;
      }
      const ptySnapshot = processes.get(id);
      if (!ptySnapshot) {
        res.status(404).json({ error: "未找到该会话。" });
        return;
      }
      const updated = processes.setSessionModel(id, rawModel);
      res.json(updated);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "切换模型失败。") });
    }
  });

  // 思考深度切换：与 /model 路由对称。结构化会话立即影响下一条 prompt（CLI/SDK 各自接入
  // applyThinkingEffortToPrompt / thinking budget），PTY 会话仅影响通过 chat 视图发送的输入。
  app.post("/api/sessions/:id/thinking-effort", express.json(), (req, res) => {
    const body = req.body as { thinkingEffort?: string | null };
    const raw = typeof body?.thinkingEffort === "string" ? body.thinkingEffort : null;
    const id = req.params.id;
    try {
      if (structured.get(id)) {
        const updated = structured.setSessionThinkingEffort(id, raw as SessionSnapshot["thinkingEffort"]);
        res.json(updated);
        return;
      }
      if (!processes.get(id)) {
        res.status(404).json({ error: "未找到该会话。" });
        return;
      }
      const updated = processes.setSessionThinkingEffort(id, raw as SessionSnapshot["thinkingEffort"]);
      res.json(updated);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "切换思考深度失败。") });
    }
  });

  // 执行模式切换：与 /model、/thinking-effort 路由对称。结构化会话立即影响下一条
  // prompt（权限策略 / 系统提示 / CLI flag 都按 session.mode 逐轮重新派生）；PTY 会话
  // 仅更新 wand 自身的权限自动放行判定，已启动的 claude 进程命令行 flag 不变。codex 锁 full-access。
  app.post("/api/sessions/:id/mode", express.json(), (req, res) => {
    const body = req.body as { mode?: string };
    const raw = typeof body?.mode === "string" ? body.mode.trim() : "";
    if (!raw) {
      res.status(400).json({ error: "缺少 mode。" });
      return;
    }
    const mode = normalizeMode(raw, "managed");
    const id = req.params.id;
    try {
      const structuredSnapshot = structured.get(id);
      if (structuredSnapshot) {
        const provider = structuredSnapshot.provider ?? "claude";
        const effective = provider === "codex" ? "full-access" : mode;
        res.json(structured.setSessionMode(id, effective));
        return;
      }
      const ptySnapshot = processes.get(id);
      if (!ptySnapshot) {
        res.status(404).json({ error: "未找到该会话。" });
        return;
      }
      const effective = (ptySnapshot.provider ?? "claude") === "codex" ? "full-access" : mode;
      res.json(processes.setSessionMode(id, effective));
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

  app.post("/api/structured-sessions/:id/messages", express.json(), async (req, res) => {
    const input = String(req.body?.input ?? "");
    const interrupt = !!req.body?.interrupt;
    // preserveQueue: 仅在 interrupt 路径有意义。排队条「立即」会带这个 flag，
    // 让退出 handler 不要把剩余 queuedMessages 清空（默认行为是清空）。
    const preserveQueue = !!req.body?.preserveQueue;
    const idempotencyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined;
    try {
      const snapshot = await structured.sendMessage(req.params.id, input, { interrupt, preserveQueue, idempotencyKey });
      res.json(snapshot);
    } catch (error) {
      const errorCode = (error as { code?: string } | null | undefined)?.code;
      const status = errorCode === "duplicate_idempotency_key" ? 409 : 400;
      res.status(status).json({
        error: getErrorMessage(error, "无法发送结构化消息。"),
        errorCode,
      });
    }
  });

  // ── Structured queued-messages management ──
  // 这些端点构成"排队消息条"的后端操作面：reorder、立即发送、单条删除、全部清空。
  // 全部走乐观更新模型，失败时前端会回滚到上一次 WS 推送的 queuedMessages。
  app.patch("/api/structured-sessions/:id/queued", express.json(), (req, res) => {
    const rawOrder = req.body?.order;
    if (!Array.isArray(rawOrder)) {
      res.status(400).json({ error: "缺少 order 数组。" });
      return;
    }
    try {
      const snapshot = structured.reorderQueuedMessages(req.params.id, rawOrder.map((v: unknown) => Number(v)));
      res.json(snapshot);
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
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法删除排队消息。") });
    }
  });

  app.post("/api/structured-sessions/:id/queued/:index/promote", express.json(), async (req, res) => {
    const index = Number(req.params.index);
    if (!Number.isInteger(index)) {
      res.status(400).json({ error: "下标无效。" });
      return;
    }
    const expectedText = typeof req.body?.expectedText === "string" ? req.body.expectedText : undefined;
    const idempotencyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined;
    try {
      const snapshot = await structured.promoteQueuedMessage(req.params.id, index, expectedText, idempotencyKey);
      res.json(snapshot);
    } catch (error) {
      const errorCode = (error as { code?: string } | null | undefined)?.code;
      const status = errorCode === "duplicate_idempotency_key" ? 409 : 400;
      res.status(status).json({
        error: getErrorMessage(error, "无法立即发送排队消息。"),
        errorCode,
      });
    }
  });

  app.delete("/api/structured-sessions/:id/queued", (req, res) => {
    try {
      const snapshot = structured.clearQueuedMessages(req.params.id);
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法清空排队消息。") });
    }
  });

  // ── Tool content lazy-load endpoint ──

  app.get("/api/sessions/:id/tool-content/:toolUseId", (req, res) => {
    const snapshot = getSessionById(processes, structured, req.params.id);
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

  app.post("/api/sessions/:id/worktree/merge/check", (req, res) => {
    try {
      const current = requireWorktreeSession(getLatestSessionSnapshot(processes, structured, storage, req.params.id));
      if (!isMergeActionAllowed(current)) {
        res.status(409).json({ error: "会话仍在运行，请结束后再合并。", errorCode: "SESSION_STILL_RUNNING" });
        return;
      }
      const checking = saveWorktreeMergeState(storage, current, "checking", {
        ...(current.worktreeMergeInfo ?? null),
        targetBranch: current.worktreeMergeInfo?.targetBranch,
        lastError: undefined,
        conflict: false,
      });
      const result = checkSessionWorktreeMergeability({
        worktree: checking.worktree as NonNullable<SessionSnapshot["worktree"]>,
        targetBranch: current.worktreeMergeInfo?.targetBranch,
      });
      const nextStatus: SessionSnapshot["worktreeMergeStatus"] = result.ok ? "ready" : "failed";
      const updated = saveWorktreeMergeState(storage, checking, nextStatus, {
        targetBranch: result.targetBranch,
        conflict: result.hasConflicts,
        lastError: result.ok ? undefined : result.reason,
      });
      res.json({ session: updated, result });
    } catch (error) {
      res.status(getWorktreeMergeResponseStatus(error)).json(getWorktreeMergePayload(error, "无法检查 worktree 合并状态。"));
    }
  });

  app.post("/api/sessions/:id/worktree/merge", express.json(), (req, res) => {
    try {
      const current = requireWorktreeSession(getLatestSessionSnapshot(processes, structured, storage, req.params.id));
      if (!isMergeActionAllowed(current)) {
        res.status(409).json({ error: "会话仍在运行，请结束后再合并。", errorCode: "SESSION_STILL_RUNNING" });
        return;
      }
      const merging = saveWorktreeMergeState(storage, current, "merging", {
        ...(current.worktreeMergeInfo ?? null),
        lastError: undefined,
        conflict: false,
      });
      const result = mergeSessionWorktree({
        worktree: merging.worktree as NonNullable<SessionSnapshot["worktree"]>,
        targetBranch: current.worktreeMergeInfo?.targetBranch,
      });
      const updated = saveWorktreeMergeState(storage, merging, "merged", {
        targetBranch: result.targetBranch,
        mergedAt: result.mergedAt,
        mergeCommit: result.mergeCommit,
        cleanupDone: result.cleanupDone,
        lastError: undefined,
        conflict: false,
      });
      res.json({ session: updated, result });
    } catch (error) {
      const current = getLatestSessionSnapshot(processes, structured, storage, req.params.id);
      if (current && canMergeSession(current)) {
        const payload = getWorktreeMergePayload(error, "无法合并 worktree。") as { error: string; errorCode: string | null; result: Partial<import("./types.js").WorktreeMergeResult> | null };
        saveWorktreeMergeState(storage, current, "failed", {
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
  });

  app.get("/api/sessions/:id/git-status", (req, res) => {
    const snapshot = getLatestSessionSnapshot(processes, structured, storage, req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (!snapshot.cwd) {
      res.json({ isGit: false });
      return;
    }
    try {
      res.json(getGitStatus(snapshot.cwd));
    } catch (error) {
      res.json({ isGit: false, error: getErrorMessage(error, "无法读取 git 状态。") });
    }
  });

  app.post("/api/sessions/:id/quick-commit", express.json(), async (req, res) => {
    const snapshot = getLatestSessionSnapshot(processes, structured, storage, req.params.id);
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
      const result = await runQuickCommit({
        cwd: snapshot.cwd,
        language: config.language ?? "",
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
  });

  app.post("/api/sessions/:id/generate-commit-message", express.json(), async (req, res) => {
    const snapshot = getLatestSessionSnapshot(processes, structured, storage, req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    if (!snapshot.cwd) {
      res.status(400).json({ error: "会话没有工作目录。" });
      return;
    }
    try {
      const result = await generateCommitMessageOnly(snapshot.cwd, config.language ?? "");
      res.json(result);
    } catch (error) {
      if (error instanceof QuickCommitError) {
        res.status(400).json({ error: error.message, errorCode: error.code });
        return;
      }
      res.status(400).json({ error: getErrorMessage(error, "生成 commit message 失败。") });
    }
  });

  app.post("/api/sessions/:id/git/tag-head", express.json(), async (req, res) => {
    const snapshot = getLatestSessionSnapshot(processes, structured, storage, req.params.id);
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
      const result = await runTagHead({
        cwd: snapshot.cwd,
        language: config.language ?? "",
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
  });

  app.post("/api/sessions/:id/git/push", express.json(), async (req, res) => {
    const snapshot = getLatestSessionSnapshot(processes, structured, storage, req.params.id);
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
  });

  app.post("/api/sessions/:id/worktree/cleanup", (req, res) => {
    try {
      const current = requireWorktreeSession(getLatestSessionSnapshot(processes, structured, storage, req.params.id));
      if (current.worktreeMergeStatus !== "merged" || current.worktreeMergeInfo?.cleanupDone !== false) {
        res.status(400).json({ error: "当前 worktree 无需补偿清理。", errorCode: "WORKTREE_CLEANUP_NOT_NEEDED" });
        return;
      }
      cleanupSessionWorktree({ worktree: current.worktree as NonNullable<SessionSnapshot["worktree"]> });
      const updated = saveWorktreeMergeState(storage, current, "merged", {
        ...(current.worktreeMergeInfo ?? null),
        cleanupDone: true,
        lastError: undefined,
        conflict: false,
      });
      res.json({ session: updated, ok: true });
    } catch (error) {
      res.status(getWorktreeMergeResponseStatus(error)).json(getWorktreeMergePayload(error, "无法清理 worktree。"));
    }
  });

  app.post("/api/sessions/batch-delete", express.json(), (req, res) => {
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
        if (structured.get(sessionId)) {
          structured.delete(sessionId);
        } else {
          processes.delete(sessionId);
        }
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
    const snapshot = getSessionById(processes, structured, req.params.id);
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
      const rawBudget = parseInt(String(req.query.blockBudget ?? ""), 10);
      if (Number.isFinite(rawBudget) && rawBudget > 0) {
        const windowed = blockWindowMessagesForTransport(snapshot.messages ?? [], config.cardDefaults ?? {}, rawBudget);
        res.json({
          ...snapshot,
          output: transcriptOutput,
          messages: windowed.messages,
          messageOffset: windowed.messageOffset,
          messageTotal: windowed.messageTotal,
          leadingBlockOffset: windowed.leadingBlockOffset,
          leadingBlockTotal: windowed.leadingBlockTotal,
        });
        return;
      }
      // 与 WS init 对齐：只回最近一窗 turn + offset/total，更早的走 /messages 翻页。
      const windowed = windowMessagesForTransport(snapshot.messages ?? [], config.cardDefaults ?? {});
      res.json({
        ...snapshot,
        output: transcriptOutput,
        messages: windowed.messages,
        messageOffset: windowed.messageOffset,
        messageTotal: windowed.messageTotal,
      });
    } else {
      res.json({ ...snapshot, output: transcriptOutput });
    }
  });

  // 历史消息分页拉取：客户端滚动到顶时按绝对下标往前翻。
  // 返回 messages = 完整历史的 [offset, offset+limit)（已做 transport 截断）+ total。
  app.get("/api/sessions/:id/messages", (req, res) => {
    const snapshot = getSessionById(processes, structured, req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话，可能已被删除。" });
      return;
    }
    const all = snapshot.messages ?? [];
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
      const blocks = sliceTurnBlocksForTransport(turn, blockStart, blockEnd, config.cardDefaults ?? {});
      res.json({ turnIndex, blocks, blockOffset: blockStart, blockTotal });
      return;
    }

    const rawLimit = parseInt(String(req.query.limit ?? ""), 10);
    const rawOffset = parseInt(String(req.query.offset ?? ""), 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 40, 1), 200);
    const offset = Math.min(Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0), total);
    const end = Math.min(offset + limit, total);
    const slice = truncateMessagesForTransport(all.slice(offset, end), config.cardDefaults ?? {});
    res.json({ messages: slice, offset, total });
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
      const command = existingSession.command.trim();
      const provider = existingSession.provider ?? (/^codex\b/.test(command) ? "codex" : "claude");
      if (provider !== "claude" && provider !== "codex") {
        res.status(400).json({ error: "只有 Claude 或 Codex provider 支持恢复功能。" });
        return;
      }
      const resumeSessionId = existingSession.claudeSessionId;
      if (!resumeSessionId) {
        res.status(400).json({ error: provider === "codex" ? "此会话没有 Codex thread ID，无法恢复。" : "此会话没有 Claude 会话 ID，无法恢复。" });
        return;
      }
      if (provider === "claude" && !/^claude\b/.test(command)) {
        res.status(400).json({ error: "只有 Claude 命令支持恢复功能。" });
        return;
      }
      if (provider === "codex") {
        if (!/^codex\b/.test(command)) {
          res.status(400).json({ error: "只有 Codex 命令支持恢复功能。" });
          return;
        }
        if (!processes.hasCodexSessionFile(resumeSessionId)) {
          res.status(400).json({ error: "对应的 Codex 历史会话不存在，无法恢复。" });
          return;
        }
      }
      const newMode = body.mode ? normalizeMode(body.mode, defaultMode) : normalizeMode(existingSession.mode, defaultMode);
      const resumeCommand = provider === "codex"
        ? buildCodexResumeCommand(command, resumeSessionId)
        : `${command} --resume ${resumeSessionId}`;
      const reqCols = typeof body.cols === "number" && Number.isFinite(body.cols) ? body.cols : undefined;
      const reqRows = typeof body.rows === "number" && Number.isFinite(body.rows) ? body.rows : undefined;
      const newSnapshot = processes.start(resumeCommand, existingSession.cwd, newMode, undefined, { reuseId: sessionId, cols: reqCols, rows: reqRows, provider });
      res.status(201).json(newSnapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法恢复会话。") });
    }
  });

  app.post("/api/claude-sessions/:claudeSessionId/resume", (req, res) => {
    const claudeSessionId = String(req.params.claudeSessionId || "").trim();
    const body = req.body as { mode?: ExecutionMode; cwd?: string; cols?: number; rows?: number };
    try {
      if (!claudeSessionId) {
        res.status(400).json({ error: "Claude 会话 ID 不能为空。" });
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
        const newMode = body.mode ? normalizeMode(body.mode, defaultMode) : normalizeMode(existingSession.mode, defaultMode);
        const resumeCommand = `${command} --resume ${claudeSessionId}`;
        const reqCols = typeof body.cols === "number" && Number.isFinite(body.cols) ? body.cols : undefined;
        const reqRows = typeof body.rows === "number" && Number.isFinite(body.rows) ? body.rows : undefined;
        const newSnapshot = processes.start(resumeCommand, existingSession.cwd, newMode, undefined, { reuseId: existingSession.id, cols: reqCols, rows: reqRows });
        res.status(201).json({ resumedClaudeSessionId: claudeSessionId, ...newSnapshot });
      } else {
        const cwd = body.cwd?.trim();
        if (!cwd) {
          res.status(400).json({ error: "未找到对应的会话记录，请提供工作目录 (cwd)。" });
          return;
        }
        const newMode = normalizeMode(body.mode, defaultMode);
        const resumeCommand = `claude --resume ${claudeSessionId}`;
        const reqCols = typeof body.cols === "number" && Number.isFinite(body.cols) ? body.cols : undefined;
        const reqRows = typeof body.rows === "number" && Number.isFinite(body.rows) ? body.rows : undefined;
        const newSnapshot = processes.start(resumeCommand, cwd, newMode, undefined, { cols: reqCols, rows: reqRows });
        res.status(201).json({ resumedClaudeSessionId: claudeSessionId, ...newSnapshot });
      }
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法按 Claude 会话 ID 恢复会话。") });
    }
  });

  app.post("/api/sessions/:id/input", async (req, res) => {
    const body = req.body as InputRequest;
    const sessionId = req.params.id;
    const input = body.input ?? "";
    const view = body.view;
    const shortcutKey = body.shortcutKey;
    try {
      if (structured.get(sessionId)) {
        const snapshot = await structured.sendMessage(sessionId, input);
        res.json(snapshot);
        return;
      }
      const snapshot = processes.sendInput(sessionId, input, view, shortcutKey);
      res.json(snapshot);
    } catch (error) {
      const response = getInputErrorResponse(error, sessionId);
      console.error("[wand] Input request failed", {
        sessionId, inputLength: input.length, view: view ?? "chat",
        responseStatus: response.statusCode, responsePayload: response.payload,
        error: getInputDebugMeta(error),
      });
      res.status(response.statusCode).json(response.payload);
    }
  });

  app.post("/api/codex-sessions/:threadId/resume", express.json(), async (req, res) => {
    const threadId = String(req.params.threadId || "").trim();
    const body = req.body as { mode?: ExecutionMode; cwd?: string; worktreeEnabled?: boolean };
    try {
      if (!threadId) {
        res.status(400).json({ error: "Codex 会话 ID 不能为空。" });
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
      const newMode = normalizeMode(body.mode, defaultMode);
      const snapshot = structured.createSession({
        cwd,
        mode: newMode,
        provider: "codex",
        runner: "codex-cli-exec",
        worktreeEnabled: body.worktreeEnabled === true,
        claudeSessionId: threadId,
      });
      onSessionCreated?.(cwd);
      res.status(201).json({ resumedClaudeSessionId: threadId, ...snapshot });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法按 Codex 会话 ID 恢复会话。") });
    }
  });
  app.post("/api/sessions/:id/resize", (req, res) => {
    const body = req.body as ResizeRequest;
    try {
      if (structured.get(req.params.id)) {
        res.status(400).json({ error: "结构化会话不支持调整终端大小。" });
        return;
      }
      const snapshot = processes.resize(req.params.id, body.cols ?? 0, body.rows ?? 0);
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法调整终端大小。") });
    }
  });

  app.post("/api/sessions/:id/approve-permission", (req, res) => {
    try {
      if (structured.get(req.params.id)) {
        res.status(400).json({ error: "结构化会话不需要终端权限操作。" });
        return;
      }
      const snapshot = processes.get(req.params.id);
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
      if (structured.get(req.params.id)) {
        res.status(400).json({ error: "结构化会话不需要终端权限操作。" });
        return;
      }
      const snapshot = processes.get(req.params.id);
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
      if (structured.get(req.params.id)) {
        res.status(400).json({ error: "结构化会话不需要切换终端自动批准。" });
        return;
      }
      const snapshot = processes.get(req.params.id);
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
      const body = req.body as { resolution?: "approve_once" | "approve_turn" | "deny" };
      if (structured.get(req.params.id)) {
        res.json(structured.resolveEscalation(req.params.id, requestId, body.resolution));
        return;
      }
      res.json(processes.resolveEscalation(req.params.id, requestId, body.resolution));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法处理该授权请求。") });
    }
  });

  app.post("/api/sessions/:id/stop", (req, res) => {
    try {
      if (structured.get(req.params.id)) {
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
      if (structured.get(req.params.id)) {
        structured.delete(req.params.id);
      } else {
        processes.delete(req.params.id);
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法删除会话。") });
    }
  });
}

export function registerClaudeHistoryRoutes(app: Express, processes: ProcessManager, storage: WandStorage): void {
  app.get("/api/claude-history", (_req, res) => {
    try {
      const sessions = processes.listClaudeHistorySessions();
      const hidden = getHiddenClaudeSessionIds(storage);
      const filtered = hidden.size > 0
        ? sessions.filter((s: { claudeSessionId?: string }) => !s.claudeSessionId || !hidden.has(s.claudeSessionId))
        : sessions;
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

  app.post("/api/claude-history/batch-delete", express.json(), (req, res) => {
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
      const sessions = processes.listCodexHistorySessions();
      const hidden = getHiddenClaudeSessionIds(storage);
      const filtered = hidden.size > 0
        ? sessions.filter((s) => !hidden.has(s.claudeSessionId))
        : sessions;
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

  app.post("/api/codex-history/batch-delete", express.json(), (req, res) => {
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
}
