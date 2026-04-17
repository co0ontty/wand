import express, { Express } from "express";

import { parseMessages } from "./message-parser.js";
import { ProcessManager, SessionInputError } from "./process-manager.js";
import { StructuredSessionManager } from "./structured-session-manager.js";
import { WandStorage } from "./storage.js";
import { ExecutionMode, InputRequest, ResizeRequest, SessionRunner, SessionSnapshot } from "./types.js";
import { checkSessionWorktreeMergeability, cleanupSessionWorktree, getWorktreeMergeErrorCode, mergeSessionWorktree, WorktreeMergeError } from "./git-worktree.js";

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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

function normalizeMode(mode: ExecutionMode | undefined, defaultMode: ExecutionMode): ExecutionMode {
  return mode ?? defaultMode;
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
  defaultMode: ExecutionMode
): void {
  app.get("/api/sessions", (_req, res) => {
    const all = listAllSessionsSlim(processes, structured);
    console.log("[WAND] GET /api/sessions count:", all.length, "sessions:", all.map(s => ({ id: s.id.substring(0, 8), kind: s.sessionKind, runner: s.runner, status: s.status })));
    res.json(all);
  });

  app.post("/api/structured-sessions", express.json(), async (req, res) => {
    const body = req.body as { cwd?: string; mode?: ExecutionMode; prompt?: string; runner?: SessionRunner; provider?: string; worktreeEnabled?: boolean; model?: string };
    console.log("[WAND] POST /api/structured-sessions body:", JSON.stringify({ cwd: body.cwd, mode: body.mode, runner: body.runner, provider: body.provider, worktreeEnabled: body.worktreeEnabled === true, hasPrompt: !!body.prompt, model: body.model }));
    try {
      if (body.provider && body.provider !== "claude") {
        res.status(400).json({ error: "结构化会话当前仅支持 Claude provider。" });
        return;
      }
      const snapshot = structured.createSession({
        cwd: body.cwd?.trim() || process.cwd(),
        mode: normalizeMode(body.mode, defaultMode),
        prompt: body.prompt,
        runner: body.runner ?? "claude-cli-print",
        worktreeEnabled: body.worktreeEnabled === true,
        model: typeof body.model === "string" ? body.model.trim() : undefined,
      });
      console.log("[WAND] structured session created:", JSON.stringify({ id: snapshot.id, sessionKind: snapshot.sessionKind, runner: snapshot.runner, status: snapshot.status }));
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
    console.log("[WAND] POST /api/structured-sessions/:id/messages id:", req.params.id, "input:", input.substring(0, 50));
    try {
      const snapshot = await structured.sendMessage(req.params.id, input);
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法发送结构化消息。") });
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
      const allowFallback = (snapshot.sessionKind ?? "pty") === "pty";
      const fallbackOutput = allowFallback ? transcriptOutput : "";
      const messages = snapshot.messages && snapshot.messages.length > 0
        ? snapshot.messages
        : allowFallback
          ? parseMessages(fallbackOutput, snapshot.command)
          : [];
      res.json({ ...snapshot, output: transcriptOutput, messages });
    } else {
      res.json({ ...snapshot, output: transcriptOutput });
    }
  });

  app.post("/api/sessions/:id/resume", (req, res) => {
    const sessionId = req.params.id;
    const body = req.body as { mode?: ExecutionMode; view?: "chat" | "terminal" };
    console.log("[WAND] POST /api/sessions/:id/resume sessionId:", sessionId);
    try {
      const existingSession = processes.get(sessionId) || storage.getSession(sessionId);
      console.log("[WAND] resume lookup: found:", !!existingSession, "sessionKind:", existingSession?.sessionKind, "claudeSessionId:", existingSession?.claudeSessionId);
      if (!existingSession) {
        res.status(404).json({ error: "会话不存在。" });
        return;
      }
      if ((existingSession.sessionKind ?? "pty") !== "pty") {
        res.status(400).json({ error: "结构化会话不支持 Claude CLI resume。" });
        return;
      }
      if (existingSession.provider && existingSession.provider !== "claude") {
        res.status(400).json({ error: "只有 Claude provider 支持恢复功能。" });
        return;
      }
      const claudeSessionId = existingSession.claudeSessionId;
      if (!claudeSessionId) {
        res.status(400).json({ error: "此会话没有 Claude 会话 ID，无法恢复。" });
        return;
      }
      const command = existingSession.command.trim();
      if (!/^claude\b/.test(command)) {
        res.status(400).json({ error: "只有 Claude 命令支持恢复功能。" });
        return;
      }
      const newMode = body.mode ? normalizeMode(body.mode, defaultMode) : normalizeMode(existingSession.mode, defaultMode);
      const resumeCommand = `${command} --resume ${claudeSessionId}`;
      const newSnapshot = processes.start(resumeCommand, existingSession.cwd, newMode, undefined, { resumedFromSessionId: sessionId });
      storage.saveSession({ ...existingSession, resumedToSessionId: newSnapshot.id, archived: true });
      res.status(201).json({ resumedFromSessionId: sessionId, ...newSnapshot });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法恢复会话。") });
    }
  });

  app.post("/api/claude-sessions/:claudeSessionId/resume", (req, res) => {
    const claudeSessionId = String(req.params.claudeSessionId || "").trim();
    const body = req.body as { mode?: ExecutionMode; cwd?: string };
    console.log("[WAND] POST /api/claude-sessions/:claudeSessionId/resume claudeSessionId:", claudeSessionId, "cwd:", body.cwd);
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
        const newSnapshot = processes.start(resumeCommand, existingSession.cwd, newMode, undefined, { resumedFromSessionId: existingSession.id });
        storage.saveSession({ ...existingSession, resumedToSessionId: newSnapshot.id, archived: true });
        res.status(201).json({ resumedFromSessionId: existingSession.id, resumedClaudeSessionId: claudeSessionId, ...newSnapshot });
      } else {
        const cwd = body.cwd?.trim();
        if (!cwd) {
          res.status(400).json({ error: "未找到对应的会话记录，请提供工作目录 (cwd)。" });
          return;
        }
        const newMode = normalizeMode(body.mode, defaultMode);
        const resumeCommand = `claude --resume ${claudeSessionId}`;
        const newSnapshot = processes.start(resumeCommand, cwd, newMode);
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
}
