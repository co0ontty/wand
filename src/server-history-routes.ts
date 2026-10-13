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


export function registerClaudeHistoryRoutes(
  app: Express,
  deps: { processes: ProcessManager; storage: WandStorage },
): void {
  const { processes, storage } = deps;
  // Older clients still GET these endpoints. Wand no longer imports provider-native
  // history into its session list, so the supported list response stays empty.
  for (const provider of SESSION_PROVIDERS) {
    app.get(`/api/${provider}-history`, (_req, res) => {
      res.json([]);
    });
  }

  const historyFiles = {
    claude: {
      list: () => processes.listClaudeHistorySessions(),
      remove: (ids: string[]) => {
        const cwdById = new Map(
          processes.listClaudeHistorySessions().map((session) => [session.claudeSessionId, session.cwd]),
        );
        return processes.deleteClaudeHistoryFiles(ids.flatMap((id) => {
          const cwd = cwdById.get(id);
          return cwd ? [{ claudeSessionId: id, cwd }] : [];
        }));
      },
    },
    codex: {
      list: () => processes.listCodexHistorySessions(),
      remove: (ids: string[]) => processes.deleteCodexHistoryFiles(ids),
    },
    opencode: {
      list: () => processes.listOpenCodeHistorySessions(),
      remove: (ids: string[]) => processes.deleteOpenCodeHistorySessions(ids),
    },
    qoder: {
      list: () => processes.listQoderHistorySessions(),
      remove: (ids: string[]) => processes.deleteQoderHistoryFiles(ids),
    },
  } as const;

  const deleteHistory = (provider: keyof typeof historyFiles, ids: string[]): number => {
    const existing = new Set(
      historyFiles[provider].list()
        .map((session) => session.claudeSessionId)
        .filter((id): id is string => Boolean(id)),
    );
    const toDelete = ids.filter((id) => existing.has(id));
    const toHide = ids.filter((id) => !existing.has(id));
    const deleted = historyFiles[provider].remove(toDelete);
    removeHiddenSessionIds(storage, toDelete);
    addHiddenSessionIds(storage, toHide);
    return deleted + toHide.length;
  };

  const registerHistoryMutations = (
    provider: keyof typeof historyFiles,
    param: string,
    label: string,
  ): void => {
    app.delete(`/api/${provider}-history/:${param}`, (req, res) => {
      const id = req.params[param]?.trim();
      if (!id) {
        res.status(400).json({ error: "会话 ID 不能为空。" });
        return;
      }
      try {
        deleteHistory(provider, [id]);
        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: getErrorMessage(error, `无法删除 ${label} 历史会话。`) });
      }
    });

    app.post(`/api/${provider}-history/batch-delete`, (req, res) => {
      const ids: string[] = Array.isArray(req.body?.claudeSessionIds)
        ? req.body.claudeSessionIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      if (ids.length === 0) {
        res.status(400).json({ error: "至少提供一个历史会话 ID。" });
        return;
      }
      try {
        res.json({ ok: true, deleted: deleteHistory(provider, ids) });
      } catch (error) {
        res.status(500).json({ error: getErrorMessage(error, `无法批量删除 ${label} 历史会话。`) });
      }
    });
  };

  registerHistoryMutations("claude", "claudeSessionId", "Claude");

  app.delete("/api/claude-history", (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd.trim() : "";
    if (!cwd) {
      res.status(400).json({ error: "目录不能为空。" });
      return;
    }

    try {
      const toDelete = processes.listClaudeHistorySessions()
        .filter((session) => session.claudeSessionId && session.cwd === cwd)
        .map((session) => ({ claudeSessionId: session.claudeSessionId, cwd: session.cwd }));
      const deleted = processes.deleteClaudeHistoryFiles(toDelete);
      removeHiddenSessionIds(storage, toDelete.map((session) => session.claudeSessionId));
      res.json({ ok: true, deleted });
    } catch (error) {
      sendRouteError(res, error, "无法删除该目录下的历史会话。", 500);
    }
  });

  registerHistoryMutations("codex", "threadId", "Codex");
  registerHistoryMutations("opencode", "sessionId", "OpenCode");
  registerHistoryMutations("qoder", "sessionId", "Qoder");
}

