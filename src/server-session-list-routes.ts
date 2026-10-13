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

/** Session list, detail, transcript and tool-content read routes. */
export function registerSessionListRoutes(app: Express, ctx: SessionRouteContext): void {
  const {
    processes, structured, storage, defaultMode, config, sessions, onSessionCreated, onCompletionViewed, decisions, free,
    wantsCompactTools, sessionResponseDTO, currentDirectoryTree, piSettingsResponse, requirePiSession,
  } = ctx;

  app.get("/api/session-list", (req, res) => {
    try {
      const offset = parseBoundedInteger(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = parseBoundedInteger(req.query.limit, 40, 1, 200);
      const requestedRevision = typeof req.query.revision === "string" ? req.query.revision : "";
      const currentSessions = sessions.listSlim();
      const page = buildSessionListPage(currentSessions, offset, limit);
      if (offset > 0 && requestedRevision !== page.revision) {
        res.status(409).json({ error: "会话列表已更新，请重新加载。", revision: page.revision });
        return;
      }
      if (offset === 0 && requestedRevision && requestedRevision === page.revision) {
        res.json({
          unchanged: true,
          entries: [],
          offset: 0,
          total: page.total,
          revision: page.revision,
        });
        return;
      }
      res.json(page);
    } catch (error) {
      sendRouteError(res, error, "无法加载会话列表。", 500);
    }
  });

  app.get("/api/session-directories", (_req, res) => {
    try {
      res.json(currentDirectoryTree());
    } catch (error) {
      sendRouteError(res, error, "无法加载会话目录。", 500);
    }
  });

  app.put("/api/session-directories/name", (req, res) => {
    const body = req.body as { path?: unknown; name?: unknown } | null | undefined;
    if (typeof body?.path !== "string") {
      res.status(400).json({ error: "path 必须是当前工作区的目录路径。" });
      return;
    }
    const directoryPath = normalizeSessionDirectory(body.path);
    if (!directoryPath) {
      res.status(400).json({ error: "不能重命名未知目录。" });
      return;
    }
    if (body.name !== null && typeof body.name !== "string") {
      res.status(400).json({ error: "name 必须是字符串或 null。" });
      return;
    }
    const customName = typeof body.name === "string" ? body.name.trim() : "";
    if (Array.from(customName).length > 80) {
      res.status(400).json({ error: "工作区名称不能超过 80 个字符。" });
      return;
    }
    if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(customName)) {
      res.status(400).json({ error: "工作区名称不能包含换行或控制字符。" });
      return;
    }

    try {
      const tree = currentDirectoryTree();
      const hasWorkspace = storage.listWorkspaces().some((workspace) =>
        workspace.kind !== "global" && normalizeSessionDirectory(workspace.cwd) === directoryPath);
      if (!directoryTreeContainsPath(tree.roots, directoryPath) && !hasWorkspace) {
        res.status(404).json({ error: "未找到该会话目录。" });
        return;
      }
      storage.setSessionDirectoryName(directoryPath, customName || null);
      // 同一步把项目名改成同一个名字，避免「工作区」改名后只有会话目录视图生效。
      renameWorkspaceDirectory(storage, directoryPath, customName);
      res.json({ ok: true, path: directoryPath, name: customName || null });
    } catch (error) {
      sendRouteError(res, error, "无法保存工作区名称。", 500);
    }
  });

  app.get("/api/sessions", (_req, res) => {
    res.json(sessions.listSlim().map((session) => toSessionListItemDTO(session)));
  });

  app.get("/api/sessions/provider-usage", (_req, res) => {
    res.json(storage.countInteractiveSessionsByProvider());
  });

  app.get("/api/sessions/:id/pi-execution/:toolUseId", asyncRoute(async (req, res) => {
    const snapshot = sessions.get(req.params.id);
    if (!snapshot) { res.status(404).json({ error: "未找到该会话。" }); return; }
    const execution = await inspectPiExecution(snapshot.messages ?? [], req.params.toolUseId);
    if (!execution) { res.status(404).json({ error: "未找到该 Pi 执行调用。" }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.json(execution);
  }));

  app.get("/api/sessions/:id/tool-content/:toolUseId", (req, res) => {
    const snapshot = sessions.get(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    const toolUseId = req.params.toolUseId;
    const messages = snapshot.messages ?? [];
    let toolUse: ToolUseBlock | undefined;
    let toolResult: ToolResultBlock | undefined;
    for (const turn of messages) {
      for (const block of turn.content) {
        if (block.type === "tool_use" && block.id === toolUseId) toolUse = block;
        if (block.type === "tool_result" && block.tool_use_id === toolUseId) toolResult = block;
      }
    }
    if (!toolUse && !toolResult) {
      res.status(404).json({ error: "未找到该工具调用。" });
      return;
    }
    res.json({
      tool_use_id: toolUseId,
      input: toolUse?.input ?? {},
      content: toolResult?.content ?? "",
      is_error: toolResult?.is_error ?? false,
      pending: !toolResult,
      resultAvailable: !!toolResult,
    });
  });

  // ── Inline tool image endpoint ──
  // tool_result 里内联的 base64 图片在传输层被改写为这个 URL（避免把整张图的 base64
  // 塞进每次快照 / WS 帧）。各端用同一套带鉴权的取图通道按需加载。

  app.get("/api/sessions/:id/tool-images/:toolUseId/:index", (req, res) => {
    const snapshot = sessions.get(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    const toolUseId = req.params.toolUseId;
    const index = Number.parseInt(req.params.index, 10);
    if (!Number.isFinite(index) || index < 0) {
      res.status(400).json({ error: "无效的图片序号。" });
      return;
    }
    for (const turn of snapshot.messages ?? []) {
      for (const block of turn.content) {
        if (block.type !== "tool_result" || block.tool_use_id !== toolUseId || !Array.isArray(block.content)) continue;
        const part = block.content.filter(isStructuredImagePart)[index];
        const source = asRecord((part as { source?: unknown } | undefined)?.source);
        const data = typeof source?.data === "string" ? source.data : undefined;
        if (source?.type !== "base64" || !data) {
          res.status(404).json({ error: "未找到该图片。" });
          return;
        }
        res.setHeader("Content-Type", typeof source.media_type === "string" ? source.media_type : "image/png");
        res.setHeader("Cache-Control", "private, max-age=3600");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.send(Buffer.from(data, "base64"));
        return;
      }
    }
    res.status(404).json({ error: "未找到该工具结果。" });
  });

  app.get("/api/sessions/:id/pty-history", asyncRoute(async (req, res) => {
    const snapshot = sessions.get(req.params.id);
    if (!snapshot || (snapshot.sessionKind ?? "pty") !== "pty") {
      res.status(404).json({ error: "未找到 PTY 会话。" });
      return;
    }
    const before = Number(req.query.before);
    const revision = Number(req.query.revision);
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(revision) || before < 1 || revision < 0) {
      res.status(400).json({ error: "无效的终端历史游标。" });
      return;
    }
    const page = await processes.getTerminalHistoryPage(snapshot.id, before, revision);
    if (!page) {
      res.status(409).json({ error: "终端历史已变化，请重新同步。" });
      return;
    }
    res.json(page);
  }));

  // Explicit display acknowledgement: reads/prefetch/resync never consume completion state.

  app.post("/api/sessions/:id/completion/view", (req, res) => {
    const snapshot = sessions.get(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话。" });
      return;
    }
    const revision = req.body?.completionRevision;
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      res.status(400).json({ error: "完成代次无效。" });
      return;
    }
    const changed = storage.markSessionCompletionViewed(snapshot.id, revision);
    const completion = storage.getSessionCompletion(snapshot.id)!;
    if (changed) onCompletionViewed?.({ type: "status", sessionId: snapshot.id, data: completion });
    res.json({ ok: true, ...completion });
  });

  app.get("/api/sessions/:id", (req, res) => {
    const snapshot = sessions.get(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话，可能已被删除。" });
      return;
    }
    const transcriptOutput = (snapshot.sessionKind ?? "pty") === "pty"
      ? processes.getPtyTranscript(snapshot.id) ?? snapshot.output
      : req.query.format === "chat" && req.query.output === "omit" ? "" : snapshot.output;
    const enriched = enrichStructuredMessages(snapshot.messages ?? [], snapshot.id);
    const messages = wantsCompactTools(req) ? compactToolMessagesForTransport(enriched) : enriched;
    if (req.query.format === "chat") {
      // 客户端带 blockBudget（Web/iOS）走块级窗口：只回最近 N 个块（必要时切掉最旧 turn 的头部），
      // 根治「单条 turn 上百块/1MB」的长任务打开慢；未启用的客户端保持 turn 级窗口。
      const rawBudget = req.query.blockBudget;
      if (typeof rawBudget === "string" && /^\d+$/.test(rawBudget) && Number(rawBudget) > 0) {
        const blockBudget = parseBoundedInteger(rawBudget, 1, 1, 2_000);
        const windowed = blockWindowMessagesForTransport(
          messages,
          config.cardDefaults ?? {},
          blockBudget,
          messageWindowByteBudget(req.query.byteBudget),
          typeof req.query.byteBudget === "string",
        );
        res.json(toSessionDetailDTO(snapshot, {
          output: transcriptOutput,
          messages: windowed.messages,
          messageOffset: windowed.messageOffset,
          messageTotal: windowed.messageTotal,
          leadingBlockOffset: windowed.leadingBlockOffset,
          leadingBlockTotal: windowed.leadingBlockTotal,
          leadingVisibleCount: windowed.leadingVisibleCount,
        }));
        return;
      }
      // 与 WS init 对齐：只回最近一窗 turn + offset/total，更早的走 /messages 翻页。
      const windowed = windowMessagesForTransport(
        messages,
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
    const enriched = enrichStructuredMessages(snapshot.messages ?? [], snapshot.id);
    const all = wantsCompactTools(req) ? compactToolMessagesForTransport(enriched) : enriched;
    const total = all.length;

    // Web history: fetch at most one block window *before* the currently
    // displayed turn. A 40-turn page can contain a single multi-MB assistant
    // turn, defeating the initial block budget entirely.
    if (typeof req.query.before === "string" && /^\d+$/.test(req.query.before)
      && typeof req.query.blockBudget === "string" && /^\d+$/.test(req.query.blockBudget)) {
      const before = parseBoundedInteger(req.query.before, total, 0, total);
      const budget = parseBoundedInteger(req.query.blockBudget, 60, 1, 200);
      const windowed = blockWindowMessagesForTransport(all.slice(0, before), config.cardDefaults ?? {}, budget,
        messageWindowByteBudget(req.query.byteBudget), typeof req.query.byteBudget === "string");
      res.json({ wandProtocolVersion: WAND_PROTOCOL_VERSION, ...windowed,
        offset: windowed.messageOffset, total });
      return;
    }

    // 块级翻页（iOS / Android）：?turn=<i>&blockOffset=<当前 leading 偏移>&blockLimit=<N>
    // 取该 turn 的 [start, blockOffset) 段（start = max(0, blockOffset - blockLimit)）。
    // 起点同样吸附到干净边界（不切开折叠的工具段、不留下无头 tool_result），并回一份
    // blockVisible：被切掉的头部里还剩多少条用户可感知的块（默认收起的工具块不计入）。
    const rawTurn = parseInt(String(req.query.turn ?? ""), 10);
    if (Number.isFinite(rawTurn)) {
      const turnIndex = Math.min(Math.max(rawTurn, 0), Math.max(total - 1, 0));
      const turn = all[turnIndex];
      if (!turn) {
        res.json({ turnIndex, blocks: [], blockOffset: 0, blockTotal: 0, blockVisible: 0 });
        return;
      }
      const blockTotal = turn.content.length;
      const rawBlockLimit = parseInt(String(req.query.blockLimit ?? ""), 10);
      const rawBlockOffset = parseInt(String(req.query.blockOffset ?? ""), 10);
      const blockLimit = Math.min(Math.max(Number.isFinite(rawBlockLimit) ? rawBlockLimit : 40, 1), 200);
      const blockEnd = Math.min(Math.max(Number.isFinite(rawBlockOffset) ? rawBlockOffset : blockTotal, 0), blockTotal);
      const blockStart = Math.max(0, blockEnd - blockLimit);
      const cardDefaults = config.cardDefaults ?? {};
      const startOffset = alignedBlockStart(turn.content, cardDefaults, blockStart, blockEnd,
        Math.min(128 * 1024, messageWindowByteBudget(req.query.byteBudget)));
      const blocks = enrichStructuredMessages([{
        ...turn,
        content: sliceTurnBlocksForTransport(turn, startOffset, blockEnd, cardDefaults),
      }], snapshot.id)[0].content;
      res.json({
        wandProtocolVersion: WAND_PROTOCOL_VERSION,
        turnIndex,
        blocks,
        blockOffset: startOffset,
        blockTotal,
        blockVisible: visibleBlockCount(turn.content, cardDefaults, startOffset),
      });
      return;
    }

    const rawLimit = parseInt(String(req.query.limit ?? ""), 10);
    const rawOffset = parseInt(String(req.query.offset ?? ""), 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 40, 1), 200);
    const offset = Math.min(Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0), total);
    const end = Math.min(offset + limit, total);
    const slice = enrichStructuredMessages(truncateMessagesForTransport(all.slice(offset, end), config.cardDefaults ?? {}), snapshot.id);
    res.json({ wandProtocolVersion: WAND_PROTOCOL_VERSION, messages: slice, offset, total });
  });
}
