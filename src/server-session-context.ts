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

import { commitModeForRead, iterationCommitInput, commitMessageFromIteration, getInputErrorResponse, getInputDebugMeta, SessionDeletionProcesses, SessionDeletionStructured, deleteSessionWithProviderHistory, SessionListPageEntry, SessionListPage, SessionDirectoryTreeResponse, sessionSortTimestamp, buildSessionListEntries, sessionListRevision, buildSessionListPage, buildSessionDirectoryTree, directoryTreeContainsPath, requireWorktreeSession, buildWorktreeMergeInfo, saveWorktreeMergeState, getWorktreeMergeResponseStatus, getWorktreeMergePayload, resolvePtyResumeProvider, isPtyProviderCommand, startResumedPtySession, restoreArchivedSession, getAutoResumeInitialInput, canAutoResumePtyForInput, canMergeSession, isMergeActionAllowed } from "./session-service.js";

/** Dependencies shared by every session route module (one typed object, no positional args). */
export interface SessionRouteDeps {
  processes: ProcessManager;
  structured: StructuredSessionManager;
  storage: WandStorage;
  defaultMode: ExecutionMode;
  config: WandConfig;
  sessions: SessionRegistry;
  onSessionCreated?: (cwd: string | undefined | null) => void;
  onCompletionViewed?: (event: ProcessEvent) => void;
  decisions?: PiRecommendationRuntime;
  free?: Pick<OpenRouterFreeModelsService, "resolveForCall">;
}

export interface SessionRouteContext extends SessionRouteDeps {
  wantsCompactTools: (req: Request) => boolean;
  sessionResponseDTO: (snapshot: SessionSnapshot, req: Request) => ReturnType<typeof toSessionDetailDTO>;
  currentDirectoryTree: () => SessionDirectoryTreeResponse;
  piSettingsResponse: (id: string) => Promise<PiSettingsResponse>;
  requirePiSession: (id: string) => void;
}

export function createSessionRouteContext(deps: SessionRouteDeps): SessionRouteContext {
  const { processes, structured, storage, sessions, config, decisions, free } = deps;
  const wantsCompactTools = (req: Request): boolean =>
    req.get("X-Wand-Tool-Projection") === "compact" || req.query.compactTools === "1";

  const sessionResponseDTO = (snapshot: SessionSnapshot, req: Request) => {
    const enriched = enrichStructuredMessages(snapshot.messages ?? [], snapshot.id);
    const windowed = windowMessagesForTransport(
      wantsCompactTools(req) ? compactToolMessagesForTransport(enriched) : enriched,
      config.cardDefaults ?? {},
    );
    return toSessionDetailDTO(snapshot, {
      messages: windowed.messages,
      messageOffset: windowed.messageOffset,
      messageTotal: windowed.messageTotal,
    });
  };

  const currentDirectoryTree = (): SessionDirectoryTreeResponse => buildSessionDirectoryTree(
    sessions.listSlim(),
    storage.listSessionDirectoryNames(),
  );

  const piSettingsResponse = async (id: string): Promise<PiSettingsResponse> => {
    const { settings, resolution } = structured.getPiSettings(id);
    const snapshot = structured.get(id)!;
    const installed = await installedPiExtensions(config, snapshot.cwd);
    const sdk = resolution.engine === "core";
    const archived = snapshot.archived;
    const modifiable = !archived;
    const goalAvailable = installed.some((item) => item.goal);
    const localDecisionAvailable = config.localDecision?.enabled === true || decisions?.status().enabled === true;
    const inventory = await discoverPiResources(config, snapshot.cwd);
    const resourceCatalog = { ...inventory.catalog, supported: modifiable && !sdk && inventory.catalog.supported,
      reason: archived ? "请先恢复已归档的会话。" : sdk ? "Wand Agent 尚不支持 Skills / MCP 会话选择。" : inventory.catalog.reason };
    const controls: PiSettingsControls = {
      // 基础工具与 CodeMode 在两种引擎下都能表达（CLI 通过 --tools 白名单）。
      tools: modifiable,
      codemode: modifiable,
      codemodeOnly: modifiable && sdk,
      codemodeOverride: modifiable && !sdk,
      globalTools: modifiable,
      goalMode: modifiable && goalAvailable,
      localDecision: modifiable && localDecisionAvailable,
      autoCompaction: modifiable && sdk,
    };
    const status = decisions?.status();
    const recommendationAvailable = resourceCatalog.supported && settings.localDecision !== false
      && status?.enabled === true && status.supported && status.configured;
    const recommendationReason = !resourceCatalog.supported ? resourceCatalog.reason
      : settings.localDecision === false ? "本会话已关闭本地决策。"
      : !recommendationAvailable ? status && "notice" in status && typeof status.notice === "string" ? status.notice : `本地决策未启用或运行环境不可用；请配置「${DECISION_EXPERT_NAME}」调用链。` : "";
    return { recommendationAvailable, recommendationReason,
      autoResourcesAvailable: recommendationAvailable, autoResourcesReason: recommendationReason,
      autoCodemodeAvailable: recommendationAvailable, skillLocksAvailable: resourceCatalog.supported,
      ...(status?.hardware && typeof status.employeeId === "string" ? { decisionAdvisor: {
        notice: status.notice ?? null, employeeId: status.employeeId, hardware: status.hardware } } : {}),
      settings: effectivePiSessionSettings(settings, resolution.engine), engine: resolution.engine,
      available: sdk && modifiable, toolsAvailable: !sdk && modifiable,
      reason: archived ? "请先恢复已归档的会话。" : resolution.reason,
      goalAvailable, globalExtensions: [...new Set(installed.filter((item) => !item.goal).map((item) => item.name))],
      localDecisionAvailable, controls, resourceCatalog };
  };
  const requirePiSession = (id: string): void => {
    const owner = sessions.ownerOf(id);
    if (!owner) throw Object.assign(new Error("未找到该会话。"), { status: 404 });
    if (owner !== "structured" || structured.get(id)?.provider !== "pi") {
      throw badRequest("这些设置仅适用于 Pi 结构化会话，不会改变 PTY 或其他工具。");
    }
  };
  return {
    ...deps,
    wantsCompactTools,
    sessionResponseDTO,
    currentDirectoryTree,
    piSettingsResponse,
    requirePiSession,
  };
}
