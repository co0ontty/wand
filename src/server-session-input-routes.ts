import type { Express,Request } from "express";
import { createHash } from "node:crypto";
import { parseExecutionMode,parseSessionCreationOrigin } from "./session-request.js";

import { isExecutionMode } from "./config.js";
import { DECISION_EXPERT_NAME } from "./decision-expert-identity.js";
import { defaultRoleForCli } from "./default-employee.js";
import { fallbackProviderModel, resolveExplicitOrFallbackModel, sessionEmployeeFields } from "./session-model.js";
import type { OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import { ProcessManager,PtyInputDeliveryError,SessionInputError } from "./process-manager.js";
import { WandStorage } from "./storage.js";
import { StructuredSessionManager } from "./structured-session-manager.js";
import { ExecutionMode,InputRequest,ProcessEvent,ResizeRequest,SessionProvider,SessionRunner,SessionSnapshot,ToolResultBlock,ToolUseBlock,WandConfig } from "./types.js";

import {
  generateCommitMessageOnly,
  getGitStatusAsync,
  QuickCommitError,
  runPush,
  runQuickCommitWithFallback,
  runTagHead,
} from "./git-quick-commit.js";
import {
  checkSessionWorktreeMergeabilityAsync,
  cleanupSessionWorktreeAsync,
  getWorktreeMergeErrorCode,
  mergeSessionWorktreeAsync,
  WorktreeMergeError,
} from "./git-worktree.js";
import { alignedBlockStart,blockWindowMessagesForTransport,compactToolMessagesForTransport,messageWindowByteBudget,sliceTurnBlocksForTransport,truncateMessagesForTransport,visibleBlockCount,windowMessagesForTransport } from "./message-truncator.js";
import { inspectPiExecution } from "./pi-execution.js";
import { resolveSystemAiContext } from "./session-ai-context.js";
import { resolveSessionCwd } from "./session-cwd.js";
import { toSessionDetailDTO,toSessionListItemDTO } from "./session-transport.js";

import { getErrorMessage } from "./error-utils.js";
import { asyncRoute } from "./express-async.js";
import {
  buildIterationCommitContext,
  COMMIT_CONTEXT_MODE_PREF_KEY,
  isCommitContextMode,
  readCommitContextMode,
  resolveCommitContextInput,
  type IterationCommitContext,
} from "./iteration-log.js";
import { installedPiExtensions } from "./pi-extension-resources.js";
import { discoverPiResources,resolvePiResourceSelection } from "./pi-resource-catalog.js";
import { effectivePiSessionSettings,patchPiSessionSettings,type PiSettingsControls,type PiSettingsResponse } from "./pi-session-settings.js";
import { parseBoundedInteger } from "./request-limits.js";
import { buildProviderResumeCommand,isProviderSessionId } from "./resume-policy.js";
import { registerPiRecommendationRoute,type PiRecommendationRuntime } from "./server-pi-recommendation-routes.js";
import { sendRouteError } from "./server-request.js";
import { registerStructuredResumeRoutes } from "./server-resume-routes.js";
import {
  buildDirectoryTree,
  normalizeSessionDirectory,
  type SessionDirectoryNode,
} from "./session-directory-tree.js";
import { inferProviderFromCommand,isSessionProvider,providerCliCommand,SESSION_PROVIDERS } from "./session-provider.js";
import { addHiddenSessionIds,deleteOwnedSessionWithHistory,removeHiddenSessionIds,SessionRegistry,type ProviderHistoryDeleter } from "./session-registry.js";
import { selectEmployeeCandidate } from "./silicon-employee-dispatch.js";
import { enrichStructuredMessages,WAND_PROTOCOL_VERSION } from "./structured-client-protocol.js";
import { asRecord,isStructuredImagePart } from "./structured-content.js";
import {
  projectCwdForSession,
  renameWorkspaceDirectory,
  resolveWorkspaceIdForNewSession,
} from "./workspace-binding.js";
import { badRequest, surfaceDomainError } from "./http-error.js";

import type { SessionRouteContext } from "./server-session-context.js";
import { commitModeForRead, iterationCommitInput, commitMessageFromIteration, getInputErrorResponse, getInputDebugMeta, SessionDeletionProcesses, SessionDeletionStructured, deleteSessionWithProviderHistory, SessionListPageEntry, SessionListPage, SessionDirectoryTreeResponse, sessionSortTimestamp, buildSessionListEntries, sessionListRevision, buildSessionListPage, buildSessionDirectoryTree, directoryTreeContainsPath, requireWorktreeSession, buildWorktreeMergeInfo, saveWorktreeMergeState, getWorktreeMergeResponseStatus, getWorktreeMergePayload, resolvePtyResumeProvider, isPtyProviderCommand, startResumedPtySession, restoreArchivedSession, getAutoResumeInitialInput, canAutoResumePtyForInput, canMergeSession, isMergeActionAllowed } from "./session-service.js";

/** Structured message/queue, PTY input and permission/escalation control routes. */
export function registerSessionInputRoutes(app: Express, ctx: SessionRouteContext): void {
  const {
    processes, structured, storage, defaultMode, config, sessions, onSessionCreated, onCompletionViewed, decisions, free,
    wantsCompactTools, sessionResponseDTO, currentDirectoryTree, piSettingsResponse, requirePiSession,
  } = ctx;

  app.get("/api/structured-sessions/:id/messages", (req, res) => {
    const snapshot = structured.get(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该结构化会话。" });
      return;
    }
    const raw = snapshot.messages ?? [];
    const all = wantsCompactTools(req)
      ? compactToolMessagesForTransport(enrichStructuredMessages(raw, snapshot.id))
      : raw;
    const offset = parseBoundedInteger(req.query.offset, Math.max(0, all.length - 40), 0, all.length);
    const limit = parseBoundedInteger(req.query.limit, 40, 1, 200);
    res.json({
      id: snapshot.id,
      messages: truncateMessagesForTransport(all.slice(offset, offset + limit), config.cardDefaults ?? {}),
      offset,
      total: all.length,
    });
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
      const snapshot = await structured.sendMessage(req.params.id, input, {
        interrupt,
        preserveQueue,
        idempotencyKey,
      });
      res.json(sessionResponseDTO(snapshot, req));
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
      res.json(sessionResponseDTO(snapshot, req));
    } catch (error) {
      sendRouteError(res, surfaceDomainError(error, /^(排序长度与当前队列不一致，请刷新后重试。|排序参数无效。)$/) ?? error, "无法调整排队顺序。");
    }
  });

  app.patch("/api/structured-sessions/:id/queued/:index", (req, res) => {
    const { expectedText, text } = req.body ?? {};
    if (typeof expectedText !== "string" || typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "排队消息不能为空，且必须提供原文。" });
      return;
    }
    try {
      res.json(sessionResponseDTO(structured.editQueuedMessage(
        req.params.id, Number(req.params.index), expectedText, text,
      ), req));
    } catch (error) {
      sendRouteError(res, surfaceDomainError(error, /^(排队消息已变化，请刷新后重试。|排队消息不能为空。)$/) ?? error, "无法编辑排队消息。");
    }
  });

  app.delete("/api/structured-sessions/:id/queued/:index", (req, res) => {
    const index = Number(req.params.index);
    if (!Number.isFinite(index)) {
      res.status(400).json({ error: "下标无效。" });
      return;
    }
    const expectedText = typeof req.body?.expectedText === "string" ? req.body.expectedText : undefined;
    try {
      const snapshot = structured.deleteQueuedMessage(req.params.id, index, expectedText);
      res.json(sessionResponseDTO(snapshot, req));
    } catch (error) {
      sendRouteError(res, surfaceDomainError(error, /^(队列中没有该条消息（可能已被处理）。|排队消息已变化，请按最新顺序重试。)$/) ?? error, "无法删除排队消息。");
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
      res.json(sessionResponseDTO(snapshot, req));
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
      res.json(sessionResponseDTO(snapshot, req));
    } catch (error) {
      sendRouteError(res, error, "无法清空排队消息。");
    }
  });

  // ── Tool content lazy-load endpoint ──

  app.post("/api/sessions/:id/input", asyncRoute(async (req, res) => {
    const body = req.body as InputRequest;
    const sessionId = req.params.id;
    const input = body.input ?? "";
    const view = body.view;
    const shortcutKey = body.shortcutKey;
    try {
      if (structured.get(sessionId)) {
        const completion = structured.sendMessage(sessionId, input);
        if (body.respondImmediately === true || (structured.get(sessionId)?.provider === "pi"
          && structured.get(sessionId)?.piSettings?.autoResources === true)) {
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
            throw badRequest("未找到该结构化会话。");
          }
          res.status(202).json(sessionResponseDTO(accepted, req));
          return;
        }
        const snapshot = await completion;
        res.json(sessionResponseDTO(snapshot, req));
        return;
      }
      const existingSession = processes.get(sessionId) || storage.getSession(sessionId);
      const autoResumeInput = getAutoResumeInitialInput(existingSession, input, view, shortcutKey);
      if (autoResumeInput !== null && canAutoResumePtyForInput(existingSession, autoResumeInput)) {
        const snapshot = await startResumedPtySession(processes, storage, existingSession, sessionId, defaultMode, {}, autoResumeInput);
        // Resume input waits for the provider prompt and is deliberately queued after start.
        // This branch reports a pending delivery, unlike an already-running PTY write.
        res.setHeader("X-Wand-Input-Delivery", "pending");
        if (body.responseMode === "accepted") {
          res.status(202).json({ accepted: true, deliveryConfirmed: false });
          return;
        }
        res.json(sessionResponseDTO(snapshot, req));
        return;
      }
      const snapshot = await processes.sendInputConfirmed(sessionId, input, view, shortcutKey);
      if (body.responseMode === "accepted") {
        res.status(202).json({ accepted: true });
        return;
      }
      res.json(sessionResponseDTO(snapshot, req));
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

  registerStructuredResumeRoutes(app, {
    processes,
    structured,
    storage,
    defaultMode,
    onSessionCreated,
    toDetailDTO: sessionResponseDTO,
  });

  app.post("/api/sessions/:id/resize", (req, res) => {
    const body = req.body as ResizeRequest;
    try {
      if (sessions.ownerOf(req.params.id) === "structured") {
        res.status(400).json({ error: "结构化会话不支持调整终端大小。" });
        return;
      }
      const snapshot = processes.resize(req.params.id, body.cols ?? 0, body.rows ?? 0);
      res.json(sessionResponseDTO(snapshot, req));
    } catch (error) {
      sendRouteError(res, error, "无法调整终端大小。");
    }
  });

  app.post("/api/sessions/:id/approve-permission", (req, res) => {
    try {
      if (sessions.ownerOf(req.params.id) === "structured") {
        res.json(sessionResponseDTO(structured.approvePermission(req.params.id), req));
        return;
      }
      const snapshot = sessions.get(req.params.id);
      if (snapshot?.provider === "codex") {
        res.status(400).json({ error: "Codex provider 不支持权限批准操作。" });
        return;
      }
      res.json(sessionResponseDTO(processes.approvePermission(req.params.id), req));
    } catch (error) {
      sendRouteError(res, surfaceDomainError(error, /^当前会话没有待处理的授权请求。$/) ?? error, "无法批准该授权请求。");
    }
  });

  app.post("/api/sessions/:id/deny-permission", (req, res) => {
    try {
      if (sessions.ownerOf(req.params.id) === "structured") {
        res.json(sessionResponseDTO(structured.denyPermission(req.params.id), req));
        return;
      }
      const snapshot = sessions.get(req.params.id);
      if (snapshot?.provider === "codex") {
        res.status(400).json({ error: "Codex provider 不支持权限拒绝操作。" });
        return;
      }
      res.json(sessionResponseDTO(processes.denyPermission(req.params.id), req));
    } catch (error) {
      sendRouteError(res, surfaceDomainError(error, /^当前会话没有待处理的授权请求。$/) ?? error, "无法拒绝该授权请求。");
    }
  });

  app.post("/api/sessions/:id/toggle-auto-approve", (req, res) => {
    try {
      if (sessions.ownerOf(req.params.id) === "structured") {
        res.json(sessionResponseDTO(structured.toggleAutoApprove(req.params.id), req));
        return;
      }
      const snapshot = sessions.get(req.params.id);
      if (snapshot?.provider === "codex") {
        res.status(400).json({ error: "Codex provider 不支持自动批准切换。" });
        return;
      }
      res.json(sessionResponseDTO(processes.toggleAutoApprove(req.params.id), req));
    } catch (error) {
      sendRouteError(res, error, "无法切换自动批准状态。");
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
        res.json(sessionResponseDTO(structured.resolveEscalation(req.params.id, requestId, resolution), req));
        return;
      }
      res.json(sessionResponseDTO(processes.resolveEscalation(req.params.id, requestId, resolution), req));
    } catch (error) {
      sendRouteError(res, surfaceDomainError(error, /^(当前会话没有待处理的授权请求。|授权请求已失效，请刷新后重试。)$/) ?? error, "无法处理该授权请求。");
    }
  });

  app.post("/api/sessions/:id/stop", (req, res) => {
    try {
      if (sessions.ownerOf(req.params.id) === "structured") {
        res.json(sessionResponseDTO(structured.stop(req.params.id), req));
        return;
      }
      res.json(sessionResponseDTO(processes.stop(req.params.id), req));
    } catch (error) {
      sendRouteError(res, error, "无法停止会话。");
    }
  });

  // 归档只隐藏会话，保留运行进程、Wand 会话 ID 与 provider session id。
}
