import { registerKnowledgeRoutes } from "./server-knowledge-routes.js";
import { OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import { OpenCodeFreeModelsService, registerOpenCodeFreePool, adoptSystemOpenCodeFreeDefault } from "./opencode-system-fallback.js";
import { OPENCODE_FREE_GROUP_ID, OPENCODE_FREE_GROUP_NAME } from "./opencode-free-selection.js";
import crypto from "node:crypto";
import compression from "compression";
import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { WebSocketServer } from "ws";
import {
  AuthService,
  principalHasScope,
} from "./auth.js";
import {
  authenticateBearerAppToken,
  createRequireAuth,
  getEffectivePassword,
  requireAdmin as requireAdminScope,
  requireAdminOrSessionPreferences,
  requireScope,
} from "./middleware/auth.js";
import { createApiScopeMiddleware } from "./middleware/api-scope.js";
import { createExtensionCors } from "./middleware/cors.js";
import { RUNNING_BUILD_INFO as BUILD_INFO } from "./build-info.js";
import { ensureCertificates } from "./cert.js";
import {
  getDefaultModelForProvider,
  getProviderDefaultModels,
  resolveConfigDir,
  writePreferenceToStorage,
} from "./config.js";
import { ModelCatalogService, type ModelRefreshOptions } from "./models.js";
import { readProviderModelPreferences } from "./session-model.js";

import { ProcessManager, ProcessEvent } from "./process-manager.js";
import { SessionLogger } from "./session-logger.js";
import { coreHarnessAgentDir } from "./harness-engine.js";
import { SessionRegistry } from "./session-registry.js";
import { SessionCompletionTracker } from "./session-completion.js";
import { ApnsClient, loadApnsConfiguration } from "./apns-client.js";
import { ApnsService } from "./apns-service.js";
import { LiveActivityService } from "./live-activity-service.js";
import { apnsDigest } from "./storage/apns-repository.js";
import { registerApnsRoutes } from "./server-apns-routes.js";
import { resolveSystemAiContext } from "./session-ai-context.js";
import { systemAiSessions } from "./system-ai-session-recorder.js";
import { StructuredSessionManager } from "./structured-session-manager.js";
import { SettingsWebAccess, registerSettingsWebAccessRoute } from "./settings-web-access.js";
import { DecisionService } from "./decision-service.js";
import type { DecisionRuntimeAccess } from "./decision-runner.js";
import { registerDecisionRoutes } from "./server-decision-routes.js";
import { registerFileRoutes } from "./server-file-routes.js";
import { recordRecentPath } from "./recent-paths.js";
import { registerLocalPreviewRoutes } from "./server-local-preview-routes.js";
import { registerSettingsRoutes } from "./server-settings-routes.js";
import { registerLocalModelRoutes } from "./server-local-model-routes.js";
import { createStorageCleanup, STORAGE_CLEANUP_RETENTION_DAYS } from "./storage-cleanup.js";
import { pruneMigrationBackups } from "./migration-backup-retention.js";
import { registerStorageCleanupRoutes } from "./server-storage-cleanup-routes.js";
import { LocalModelSetupService } from "./local-model-setup.js";
import { DecisionExpertService } from "./decision-expert-service.js";
import { DECISION_EXPERT_KEY } from "./decision-expert-identity.js";
import {
  buildStructuredChatPersonaPayload,
  generateAppToken,
  resolveAppConnectCode,
} from "./server-app-connect.js";
import { resolveTrustProxy, sendRouteError } from "./server-request.js";
import { registerAuthRoutes } from "./server-auth-routes.js";
import { WebLoginTickets } from "./web-login-tickets.js";
import { isSessionProvider } from "./session-provider.js";
import { registerVaultRoutes } from "./server-vault-routes.js";
import { registerGithubRoutes } from "./server-github-routes.js";
import { registerTaskRoutes } from "./server-task-routes.js";
import { TaskExecutionQueue } from "./task-execution-queue.js";
import { taskTitleService } from "./task-title-service.js";
import { getGithubConnectorStatus } from "./github-connector.js";
import { registerMissionRoutes } from "./server-mission-routes.js";
import { Missions } from "./missions.js";
import { AI_TEAM_CHAT_PREFIX, createAiTeamRunner } from "./ai-team-runner.js";
import { ServerNotifier } from "./server-notifier.js";
import { ConversationService } from "./conversation-service.js";
import { ScheduledTaskService } from "./scheduled-task-service.js";
import { registerScheduledTaskRoutes } from "./server-scheduled-task-routes.js";
import { CONVERSATION_RELAY_PREFIX } from "./conversation-types.js";
import { forwardConversationRelay, registerConversationRoutes } from "./server-conversation-routes.js";
import { registerAiTeamRoutes } from "./server-ai-team-routes.js";
import { registerTeamDispatchRoutes } from "./server-team-dispatch-routes.js";
import { registerSiliconEmployeeRoutes } from "./server-employee-routes.js";
import { EmployeeImService } from "./employee-im.js";
import { EmployeeImLifecycle } from "./employee-im-lifecycle.js";
import { registerEmployeeImRoutes } from "./server-employee-im-routes.js";
import { DwsClient } from "./dingtalk-dws.js";
import { DingTalkService } from "./dingtalk-service.js";
import { registerDingTalkRoutes } from "./server-dingtalk-routes.js";
import { UserMemoryService } from "./user-memory.js";
import { registerUserMemoryRoutes, userMemoryOperationLog } from "./server-user-memory.js";
import { registerAttentionRoutes } from "./server-attention-routes.js";
import {
  refreshProviderCliUpdateState,
  registerAdminUpdateRoutes,
  launchServerUpdate,
  type AdminUpdateRoutesDependencies,
  registerPublicUpdateRoutes,
  ServerUpdateState,
} from "./server-update-routes.js";
import { registerClaudeHistoryRoutes, registerSessionRoutes } from "./server-session-routes.js";
import { registerWorkspaceRoutes } from "./server-workspace-routes.js";
import { backfillSessionWorkspaces } from "./workspace-binding.js";
import { getErrorMessage } from "./error-utils.js";
import { stopIterationPrompts, whenIterationPromptsSettled } from "./iteration-log.js";
import { asyncRoute, jsonErrorHandler } from "./express-async.js";
import { FeedbackReceiver, FeedbackReporter } from "./feedback.js";
import { feedbackFeatureForApiPath } from "./feedback-feature-map.js";
import { feedbackRequestSecrets, registerFeedbackAdminRoutes, registerFeedbackClientRoutes, registerFeedbackIngress } from "./server-feedback-routes.js";
import type { ErrorRequestHandler } from "express";
import {
  checkPackageUpdateAsync,
  normalizeUpdateChannel,
  resolveGlobalWandCli,
  type PackageUpdateInfo,
  type UpdateChannel,
} from "./npm-update-utils.js";
import { computeRelaunch } from "./relaunch.js";
import { createRetentionSweep, startRetentionTimer, type RetentionResult } from "./retention.js";
import { RuntimeConfigState } from "./runtime-config.js";
import { safeServiceInstalled } from "./tui/runtime-utils.js";
import { registerUploadRoutes, invalidateUploadUsage } from "./upload-routes.js";
import { uploadReferenceGuard } from "./upload-reference-guard.js";
import { configTemporaryRoot } from "./managed-temp.js";
import { ensureManagedSkills, formatManagedSkillsEnsureLog, isDefaultConfigPath } from "./managed-skills-ensure.js";
import { optimizePrompt, PromptOptimizeError } from "./prompt-optimizer.js";
import { resolveDatabasePath, WandStorage } from "./storage.js";
import { deepRepairRuntimePath, formatPathRepairSummary, repairRuntimePath, type PathRepairResult } from "./path-repair.js";
import { DistributionManager } from "./distribution-manager.js";
import { isLogBusActive, wandTuiLog } from "./tui/log-bus.js";
import { registerAssetRoutes } from "./server-asset-routes.js";
import { WsBroadcastManager } from "./ws-broadcast.js";
import { TerminalDaemonClient } from "./terminal-daemon-client.js";
import { createUpgradeAwareTerminalHost } from "./render-host.js";
import { DaemonAdmission, DaemonMaintenance } from "./daemon-maintenance.js";
import { createDaemonMaintenanceTargets } from "./daemon-maintenance-targets.js";
import { registerDaemonMaintenanceRoutes } from "./server-daemon-maintenance-routes.js";
import { terminalDaemonBuildIsCurrent } from "./terminal-daemon-build.js";
import { createUpgradeAwareStructuredHost } from "./render-structured-host.js";
import { PiTmuxHost, type PiNativeGcReport } from "./pi-tmux-host.js";
import { PtyTmuxBackend, type PtyTmuxGcReport } from "./pty-tmux-backend.js";
import type { StructuredExecHost } from "./structured-exec-host.js";
import { StructuredTmuxHost } from "./structured-tmux-host.js";
import { logInfo } from "./runtime-log.js";
import { probeTmuxSupport, tmuxEnabled } from "./tmux-policy.js";
import { structuredHostMaintenance } from "./structured-host-maintenance.js";
import { createTmuxTerminalHost } from "./tmux-terminal-host.js";
import type { TerminalHost } from "./terminal-host.js";
import {
  updateProviderClis,
  verifyProviderCliUpdateResults,
  type ProviderCliUpdateStatus,
} from "./provider-cli-updater.js";
import { SessionProvider, WandConfig } from "./types.js";
import { userAuthor, userDisplayName } from "./user-profile.js";

const SERVER_MODULE_DIR = path.dirname(new URL(import.meta.url).pathname);
const RUNTIME_ROOT_DIR = path.resolve(SERVER_MODULE_DIR, "..");

// ── Package info ──

const PKG_JSON = JSON.parse(readFileSync(path.join(RUNTIME_ROOT_DIR, "package.json"), "utf8")) as {
  name: string;
  version: string;
  engines?: { node?: string };
  repository?: { url?: string };
};
const PKG_NAME = PKG_JSON.name;
const PKG_VERSION = PKG_JSON.version;
const PKG_NODE_REQ = PKG_JSON.engines?.node ?? ">=22.19.0";
const PKG_REPO_URL = "https://github.com/co0ontty/wand";

// ── Update check cache ──

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
/** CLI 模型目录和思考档位的探测间隔。页面另有更密的快照拉取。 */
const MODEL_CATALOG_AUTO_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/** Cached update result broadcast to new clients on connect. */
let cachedUpdateInfo: Pick<PackageUpdateInfo, "channel" | "current" | "latest" | "updateAvailable"> | null = null;

const packageUpdateCache = new Map<UpdateChannel, { info: PackageUpdateInfo; timestamp: number }>();

async function checkLatestPackageVersion(channel: UpdateChannel, forceRefresh = false): Promise<PackageUpdateInfo> {
  const now = Date.now();
  const cached = packageUpdateCache.get(channel);
  if (!forceRefresh && cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.info;
  }
  // The immutable running build is also what the UI reports. Shared package metadata may
  // belong to a different installer; it must not make a local Beta look like an older stable.
  const info = await checkPackageUpdateAsync(DISPLAY_VERSION, channel, undefined, BUILD_INFO);
  if (info.latest) {
    packageUpdateCache.set(channel, { info, timestamp: now });
  }
  return info;
}

// ── Build info (构建时打入的 commit SHA) + Beta 通道 ──

const DISPLAY_VERSION = BUILD_INFO.version || PKG_VERSION;
const SERVER_INSTANCE_ID = crypto.randomUUID();

// ── Startup error handling ──

let activeFeedback: FeedbackReporter | null = null;
process.on("uncaughtException", (err) => {
  activeFeedback?.capture("uncaught_exception", err);
  wandError("服务器异常", err.message, "请检查配置是否正确，或尝试重启服务。");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  activeFeedback?.capture("unhandled_rejection", reason);
  const msg = getErrorMessage(reason);
  wandError("未处理的异步错误", msg);
});

function wandError(label: string, message: string, suggestion?: string): void {
  if (isLogBusActive()) {
    wandTuiLog("error", `✗ [wand] ${label}：${message}`);
    if (suggestion) wandTuiLog("error", `  解决方法：${suggestion}`);
    return;
  }
  process.stderr.write(`\n✗ [wand] ${label}：${message}\n`);
  if (suggestion) process.stderr.write(`  解决方法：${suggestion}\n`);
  process.stderr.write("\n");
}

function wandWarn(message: string, hint?: string): void {
  if (isLogBusActive()) {
    wandTuiLog("warn", `⚠️  [wand] 警告：${message}`);
    if (hint) wandTuiLog("warn", `  提示：${hint}`);
    return;
  }
  process.stderr.write(`⚠️  [wand] 警告：${message}\n`);
  if (hint) process.stderr.write(`  提示：${hint}\n`);
}

// ── Main server ──

interface ServerUrl {
  url: string;
  scheme: "HTTP" | "HTTPS";
}

export interface ServerHandle {
  processManager: ProcessManager;
  structuredSessions: StructuredSessionManager;
  authService: AuthService;
  configPath: string;
  dbPath: string;
  urls: ServerUrl[];
  bindAddr: string;
  httpsEnabled: boolean;
  version: string;
  orphanRecoveredCount: number;
  pathRepair: PathRepairResult;
  close(): Promise<void>;
}

export class PortInUseError extends Error {
  readonly code = "EADDRINUSE";

  constructor(
    readonly port: number,
    readonly host: string,
  ) {
    super(`Port ${port} is already in use`);
    this.name = "PortInUseError";
  }
}

export function isPortInUseError(error: unknown): error is PortInUseError {
  return error instanceof PortInUseError
    || (
      !!error
      && typeof error === "object"
      && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    );
}

export async function startServer(
  config: WandConfig,
  configPath: string,
  options: { modelRefreshOptions?: () => Partial<ModelRefreshOptions>; terminalHost?: TerminalHost; openRouterFetch?: typeof fetch } = {},
): Promise<ServerHandle> {
  if (config.shell?.trim()) process.env.SHELL = config.shell.trim();
  // 关键：在创建 ProcessManager / 任何 spawn 之前先修 PATH。
  // 服务被注册为 systemd / launchd 时，unit 文件里的 PATH 是安装那一刻烧死的，
  // 之后用户切 node 版本 / 重装 wand / 把 claude 装到新位置都不会更新 unit，
  // 服务进程的 process.env.PATH 就长期 stale。这里追加常见工具链 bin 目录，
  // 让 spawn 出的 PTY 子进程能找到 claude / codex。详见 src/path-repair.ts。
  const pathRepair = repairRuntimePath();
  // 同步追加完后还有一层兜底：起 login shell 拉用户实际 $PATH，把 nvm / fnm /
  // volta 这类动态注入的目录也合并进来。失败会静默走 sync 结果，不阻塞启动。
  try {
    await deepRepairRuntimePath(pathRepair, { shell: config.shell });
  } catch {
    // deepRepairRuntimePath 内部已经 catch 了所有异常并写到 result.warnings；
    // 这里只是兜底，避免任何意外 throw 阻断启动。
  }
  if (
    pathRepair.added.length > 0
    || Object.values(pathRepair.resolved).some((v) => v === null)
    || pathRepair.warnings.length > 0
  ) {
    // 有改动 / 有命令没解析到 / 有告警时才打 log，避免正常启动刷屏。
    process.stdout.write(`[wand] ${formatPathRepairSummary(pathRepair)}\n`);
  }

  const feedbackReceiver = process.env.WAND_FEEDBACK_PRIVATE_KEY_FILE
    ? new FeedbackReceiver(resolveConfigDir(configPath), process.env.WAND_FEEDBACK_PRIVATE_KEY_FILE, {
      accept: (report, envelope) => storage.ingestFeedback(report, envelope),
      latest: taskId => storage.latestFeedbackEnvelopes(taskId),
    }) : null;
  const feedback = new FeedbackReporter({ configDir: resolveConfigDir(configPath), version: DISPLAY_VERSION,
    username: () => userDisplayName(config.userProfile),
    secrets: () => [config.password, config.appSecret ?? "", getEffectivePassword(storage, config), ...Object.entries(process.env)
      .filter(([key]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)/i.test(key))
      .map(([, value]) => value ?? "")] });
  const app = express();
  let shuttingDown = false;
  const testMode = process.env.WAND_TEST_MODE === "1";
  // Explicit and bounded: login/bearer limits key on req.ip, so forwarded headers are only
  // honoured for the configured proxy hops (see resolveTrustProxy).
  app.set("trust proxy", resolveTrustProxy(config.trustProxy));
  const databasePath = resolveDatabasePath(configPath);
  const storage = new WandStorage(databasePath);
  const systemCalls = systemAiSessions(storage);
  systemCalls.recoverInterrupted();
  if (!storage.getConfigValue("migration:session-workspaces:v1")) {
    backfillSessionWorkspaces(storage);
    storage.setConfigValue("migration:session-workspaces:v1", "done");
  }
  const taskTitles = taskTitleService(storage, { config });
  const runtimeConfig = new RuntimeConfigState(config);
  const openRouter = new OpenRouterFreeModelsService(storage, options.openRouterFetch);
  const authService = new AuthService(storage);
  const webLoginTickets = new WebLoginTickets();
  const settingsAccess = new SettingsWebAccess();
  const decisions = new DecisionService(config.localDecision);
  const decisionExpert = new DecisionExpertService({ local: decisions, free: openRouter, config,
    employee: () => storage.getSystemSiliconEmployee(DECISION_EXPERT_KEY),
    trace: employee => systemCalls.forEmployee(employee) });
  const getModelRefreshOptions = (): ModelRefreshOptions => {
    const injected = options.modelRefreshOptions?.() ?? {};
    const currentDefaults = readProviderModelPreferences(config, storage);
    return {
      storage,
      managedPiModels: () => openRouter.catalog(),
      managedPiModelMembers: () => openRouter.members(),
      modelGroups: () => config.modelGroups ?? [],
      inheritEnv: config.inheritEnv !== false,
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      ...injected,
      piEndpointDiscovery: injected.piEndpointDiscovery ?? { enabled: !testMode, agentDir: coreHarnessAgentDir(config.harness) },
      configuredClaudeModels: [
        currentDefaults.claude,
        config.commitCli === "claude" ? (storage.getPreference("pref:commitModel", config.commitModel) ?? "") : undefined,
        ...(injected.configuredClaudeModels ?? []),
      ],
    };
  };
  // This service is the only owner of CLI model discovery for this server.
  // Clients receive its persisted snapshot via GET /api/models.
  const modelCatalog = new ModelCatalogService(getModelRefreshOptions);
  const configDir = resolveConfigDir(configPath);
  // 托管技能（wand-system / wand-decision）是员工发现本机 Wand 命令的入口，但过去只有手动命令
  // 才同步，升级安装包后安装态副本会长期漂移（2026-10-17 登录 helper 过期复盘）。默认安装在这里
  // 幂等兜底：内容相同零写入，用户改过的技能保留并告警，失败不阻断启动；隔离配置不接管机器级链接。
  if (!testMode && isDefaultConfigPath(configPath)) {
    const ensured = formatManagedSkillsEnsureLog(await ensureManagedSkills(configPath));
    if (ensured) process.stdout.write(ensured);
    storage.syncGlobalKnowledge();
  }
  let notifyFreeDefaultChanged = (_employeeId: string): void => {};
  let collectNativeRunArtifacts: (() => PiNativeGcReport | null) | null = null;
  let collectPtyTmuxArtifacts: (() => PtyTmuxGcReport | null) | null = null;
  const systemFallback = testMode || process.env.WAND_DISABLE_OPENCODE_FALLBACK === "1" ? undefined : new OpenCodeFreeModelsService({ configDir,
    storage, inheritEnv: config.inheritEnv, onLog: line => process.stdout.write(`[wand] ${line}\n`),
    onModelsChanged(models) {
      const candidate = runtimeConfig.createCandidate();
      // Refresh reads the latest preference at commit time; never clobber unrelated groups/edits.
      const groups = candidate.modelGroups ?? [];
      const next = [...groups.filter(group => !(group.provider === "opencode"
        && (group.id === OPENCODE_FREE_GROUP_ID || group.name === OPENCODE_FREE_GROUP_NAME))),
        { id: OPENCODE_FREE_GROUP_ID, provider: "opencode" as const, name: OPENCODE_FREE_GROUP_NAME, models }];
      if (JSON.stringify(groups) !== JSON.stringify(next)) {
        writePreferenceToStorage(candidate, storage, "modelGroups", next);
        runtimeConfig.commit(candidate, ["modelGroups"]);
        modelCatalog.publishModelGroups();
      }
      if (models.length) {
        const adopted = adoptSystemOpenCodeFreeDefault(storage);
        if (adopted === "adopted") notifyFreeDefaultChanged(storage.getSystemSiliconEmployee()!.id);
        if (adopted === "full") process.stdout.write("[wand] 系统员工已有4个明确候选，未覆盖；请腾出一格后采用 OpenCode 免费分组。\n");
      }
    } });
  if (systemFallback) {
    const unregister = registerOpenCodeFreePool(storage, systemFallback);
    storage.onClose(() => { unregister(); systemFallback.dispose(); });
    systemFallback.restoreSavedGroup();
  }
  const storageCleanup = createStorageCleanup(configDir, { uploads: storage.uploads,
    uploadsActive: () => sessionRegistry.listSlim().some(session => (session.sessionKind === "structured" && session.status === "running") || (session.queuedMessages?.length ?? 0) > 0),
    onUploadRemoved: invalidateUploadUsage,
    // 历史构建包也会持续堆积（每次 debug 构建一个新版本号），跟着同一轮定时回收走。
    pruneDistributionArtifacts: async () => {
      const results = await Promise.all([
        distributionManager.pruneAndroidApkDirectory(),
        distributionManager.pruneMacosBetaDirectory(),
        distributionManager.pruneIosIpaDirectory(),
      ]);
      return {
        deleted: results.flatMap((result) => result.deleted),
        freedBytes: results.reduce((total, result) => total + result.freedBytes, 0),
      };
    },
    // Pi 原生回合目录（pi-native/）和 structured-tmux 按回合数增长，交给同一轮定时回收。
    // 只保护未归档会话。已删除或已归档的 slot 在 ack 完成、进程退出后整槽删除。
    // 宿主在下面才包好，这里先留空，避免清理闭包引用尚未赋值的变量。
    collectNativeArtifacts: () => collectNativeRunArtifacts?.() ?? null,
    collectPtyTmuxArtifacts: () => collectPtyTmuxArtifacts?.() ?? null,
    // 旧版本遗留的迁移前快照：无上限堆积。迁移成功路径已在 storage-schema 修剪。
    pruneMigrationSnapshots: () => pruneMigrationBackups(databasePath, { dryRun: false }) });
  const localModels = new LocalModelSetupService({ configDir, decisions,
    decisionConfig: () => config.localDecision ?? { enabled: false, pythonPath: "", modelPath: "" },
    configureDecision(next) {
      decisions.assertConfigurable();
      const candidate = runtimeConfig.createCandidate();
      writePreferenceToStorage(candidate, storage, "localDecision", next);
      decisions.configure(next);
      runtimeConfig.commit(candidate, ["localDecision"]);
      refreshDecisionRuntime();
    },
  });
  const distributionManager = new DistributionManager({
    configDir,
    configPath,
    config,
    repositoryUrl: PKG_REPO_URL,
  });
  const knownPtySessionIds = storage.loadSessions()
    .filter((session) => (session.sessionKind ?? "pty") === "pty" && session.status === "running")
    .map((session) => session.id);
  // PTY 所有者可以是 legacy terminald 或常驻的 Rust Render：升级期由复合 host 按所有权
  // 路由（旧会话留在 legacy，新会话进 Render），对客户端契约没有任何改变。
  const ptyHosts = options.terminalHost
    ? { host: options.terminalHost, renderHost: null, legacyHost: null }
    : await createUpgradeAwareTerminalHost(configPath, {
        engine: config.render?.engine,
        binaryPath: config.render?.binaryPath,
        knownSessionIds: knownPtySessionIds,
      });
  const tmuxTerminals = options.terminalHost
    ? { host: ptyHosts.host, client: null, configPath, maintenanceTarget: undefined }
    : await createTmuxTerminalHost(configPath, ptyHosts.host);
  if (tmuxEnabled()) {
    const probe = probeTmuxSupport();
    if (probe.ok) {
      logInfo(`tmux runtime active (${probe.version}, ${probe.path}); terminal and structured CLI runs hosted.`);
    } else {
      wandWarn(`tmux 执行底座检查未通过: ${probe.error}`);
    }
  }
  const daemonAdmission = new DaemonAdmission();
  const terminalHost = daemonAdmission.terminal(tmuxTerminals.host);
  let decisionRuntime: DecisionRuntimeAccess | null = null;
  let autoAssignEvaluate: DecisionRuntimeAccess["evaluate"];
  const processes = new ProcessManager(config, storage, configDir, terminalHost,
    { resolveDecisionEvaluate: () => autoAssignEvaluate, free: openRouter });
  const structuredLogger = new SessionLogger(configDir, config.shortcutLogMaxBytes);
  systemCalls.attach({ logger: structuredLogger });
  // Production startup provides a daemon-backed host for structured CLI runs
  // even when Render owns every PTY. In-process hosts are for test injection.
  const legacyStructuredHost = ptyHosts.legacyHost
    ?? (ptyHosts.host instanceof TerminalDaemonClient ? ptyHosts.host : null);
  const structuredHosts = await createUpgradeAwareStructuredHost(
    configPath, legacyStructuredHost, config.structured?.processHost,
  );
  let structuredHost = structuredHosts.host;
  let structuredTmuxHost: StructuredTmuxHost | null = null;
  if (structuredHost?.persistent) {
    const enabled = tmuxEnabled();
    structuredTmuxHost = new StructuredTmuxHost(configDir, structuredHost, enabled);
    // Keep both routes available after disabling new tmux launches: existing
    // native and generic runs still belong to their original persistent owner.
    structuredHost = new PiTmuxHost(configDir, structuredTmuxHost, enabled && process.env.WAND_PI_NATIVE_TMUX !== "0");
  }
  const structuredSessions = new StructuredSessionManager(
    storage, config, structuredLogger, {},
    structuredHost ? daemonAdmission.structured(structuredHost) : undefined, () => decisionRuntime, openRouter,
    () => autoAssignEvaluate, webLoginTickets,
  );
  // No SDK prewarm: Pi defaults to CLI. Only an explicit Wand Agent selection
  // probes the in-process harness; CLI startup/settings must not depend on it.
  const sessionRegistry = new SessionRegistry(processes, structuredSessions, storage);
  collectNativeRunArtifacts = () => {
    const activeSessionIds = new Set(sessionRegistry.listSlim().filter((session) => !session.archived).map((session) => session.id));
    const retentionMs = STORAGE_CLEANUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const hosts = [structuredHost, structuredTmuxHost].filter((host): host is StructuredExecHost => Boolean(host?.collectGarbage));
    let removedSlots = 0;
    let removedTurns = 0;
    let freedBytes = 0;
    let ran = false;
    for (const host of hosts) {
      const part = host.collectGarbage?.({ liveSessionIds: activeSessionIds, activeSessionIds, retentionMs });
      if (!part) continue;
      ran = true;
      removedSlots += part.removedSlots;
      removedTurns += part.removedTurns;
      freedBytes += part.freedBytes;
    }
    const report: PiNativeGcReport | null = ran ? { removedSlots, removedTurns, freedBytes } : null;
    return report;
  };
  collectPtyTmuxArtifacts = () => {
    const activeSessionIds = new Set(sessionRegistry.listSlim().filter((session) => !session.archived).map((session) => session.id));
    const retentionMs = STORAGE_CLEANUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    return PtyTmuxBackend.collectGarbage(configDir, { activeSessionIds, retentionMs });
  };
  // 员工任务并发闸门：所有员工派发共用同一实例，排队状态随存储持久化。
  const taskExecutionQueue = new TaskExecutionQueue({
    storage, config, structured: structuredSessions, processes, sessions: sessionRegistry,
  });
  structuredSessions.setEmployeeInputAdmission({
    canStart: (session, scheduling, immediate) => taskExecutionQueue.canStartSession(session, scheduling, immediate),
    schedule: employeeId => taskExecutionQueue.scheduleDrain(employeeId),
  });
  let apnsConfiguration: ReturnType<typeof loadApnsConfiguration> = null;
  try { apnsConfiguration = loadApnsConfiguration(process.env, configDir); }
  catch (error) { wandWarn(error instanceof Error ? error.message : "APNs 配置不可用。"); }
  const apns = new ApnsService(storage, apnsConfiguration, apnsConfiguration ? new ApnsClient(apnsConfiguration) : null,
    () => apnsDigest(generateAppToken(getEffectivePassword(storage, config), config.appSecret ?? "")),
    id => sessionRegistry.ownerOf(id) === "storage" ? null : sessionRegistry.getSlim(id),
    message => wandWarn(message));
  let liveActivityFactsReady = false;
  const liveActivities = new LiveActivityService(storage, apnsConfiguration, apnsConfiguration ? new ApnsClient(apnsConfiguration) : null,
    () => apnsDigest(generateAppToken(getEffectivePassword(storage, config), config.appSecret ?? "")),
    () => liveActivityFactsReady ? sessionRegistry.listSlim({ runtimeOnly: true }) : null,
    message => wandWarn(message));
  const sessionCompletions = new SessionCompletionTracker(storage, (id) => sessionRegistry.get(id),
    (id, revision) => apns.completed(id, revision));
  let nextEmployeeImWarningAt = 0;
  const employeeIm = new EmployeeImService(storage, { onFailure: () => {
    if (Date.now() < nextEmployeeImWarningAt) return;
    nextEmployeeImWarningAt = Date.now() + 60_000;
    wandWarn("员工 IM 通知发送未确认或队列已满；不会自动重发。");
  } });
  const employeeImLifecycle = new EmployeeImLifecycle({ im: employeeIm, getSession: id => sessionRegistry.get(id),
    getRunSteps: id => storage.listAiTeamSteps(id) });
  employeeImLifecycle.seed(sessionRegistry.listSlim(), storage.listAiTeamRuns());
  const missions = new Missions(storage, structuredSessions, sessionRegistry);
  // 任务保留的立即扫描也晚绑定：设置路由先注册，WebSocket 和会话表稍后才就绪。
  let runTaskRetentionSweep = (): RetentionResult => ({
    archivedSessions: 0, purgedSessions: 0, archivedTasks: 0, purgedTasks: 0, purgedTeamRuns: 0,
  });
  // WebSocket 在后面才建：所有系统通知经同一个 Notifier，接好之前静默丢弃。
  const notifier = new ServerNotifier();
  const notifyAiTeamRun = notifier.aiTeamChanged;
  notifyFreeDefaultChanged = employeeId => notifyAiTeamRun({ kind: "silicon-employee-definition", employeeId });
  // 团队降级的 model-unknown 事前比对只看这份已发现的清单；没刷新过就是空，判定方向是放行。
  const aiTeamModelIds = (provider: SessionProvider): string[] => {
    const cache = modelCatalog.snapshot();
    const key = ({
      claude: "models",
      codex: "codexModels",
      opencode: "opencodeModels",
      grok: "grokModels",
      qoder: "qoderModels",
      pi: "piModels",
    } as const)[provider];
    return cache[key].map((entry) => entry.id);
  };
  let conversations: ConversationService | null = null;
  const aiTeams = createAiTeamRunner({
    storage, config, structured: structuredSessions, processes, sessions: sessionRegistry,
    selfAuthor: () => userAuthor(config.userProfile),
    notify: (run) => {
      conversations?.importRun(run);
      employeeImLifecycle.ingestRun(run);
      notifyAiTeamRun({ kind: "ai-team-run", runId: run.id, taskId: run.taskId });
    },
    notifyLive: notifier.aiTeamLive,
    models: aiTeamModelIds,
    chatHistoryTurns: id => conversations?.history(id) ?? [],
    // 成员名单里的模型名：`default` 哨兵换成服务端为该 CLI 配置的默认模型。
    defaultModelOf: (provider) => getDefaultModelForProvider(config, provider),
  });
  const conversationService = new ConversationService({ storage, config, structured: structuredSessions, runner: aiTeams,
    notifySession: notifier.conversationSession, notifyChanged: () => notifier.system({ kind: "conversations-changed" }), deleteSession: id => { sessionRegistry.deleteWithProviderHistory(id); } });
  conversations = conversationService;
  conversationService.migrateExistingChats();
  const dingtalkDws = new DwsClient(storage.directory());
  const dingtalk = new DingTalkService({ storage, dws: dingtalkDws, config, structured: structuredSessions,
    changed: () => notifier.system({ kind: "conversations-changed" }) });
  conversationService.attachExternal(dingtalk);
  storage.onClose(() => { dingtalk.dispose(); dingtalkDws.dispose(); });
  // Restore only explicitly persisted subscriptions; startup never creates or publishes remote resources.
  if (!testMode) void dingtalk.restore().catch(() => wandWarn("钉钉连接恢复未完成，请在连接器检查授权。"));
  const scheduledTasks = new ScheduledTaskService({ storage, conversations: conversationService,
    getSession: id => sessionRegistry.get(id), defaultCwd: () => config.defaultCwd });
  for (const prefix of [CONVERSATION_RELAY_PREFIX, AI_TEAM_CHAT_PREFIX]) {
    structuredSessions.registerRelay(prefix, (sessionId, input) => forwardConversationRelay(conversationService, sessionId, input));
  }
  const updateState = new ServerUpdateState();
  const daemonMaintenance = new DaemonMaintenance({
    targets: testMode ? [] : [
      ...await createDaemonMaintenanceTargets(configPath, ptyHosts, structuredHosts.rustClient, config.render?.binaryPath),
      ...(tmuxTerminals.client ? (await createDaemonMaintenanceTargets(tmuxTerminals.configPath,
        { host: tmuxTerminals.host, renderHost: null, legacyHost: tmuxTerminals.client }, null))
        .map(target => ({ ...target, name: "tmux-terminald" })) : []),
      ...(tmuxTerminals.maintenanceTarget ? [tmuxTerminals.maintenanceTarget] : []),
      ...(structuredHost ? [structuredHostMaintenance(structuredHost)] : []),
    ],
    admission: daemonAdmission,
    busy: () => structuredSessions.getCoreTurnStatus().hasActiveTurns
      || [...processes.list(), ...structuredSessions.list()].some((session) =>
        session.status === "running" || session.structuredState?.inFlight === true || (session.queuedMessages?.length ?? 0) > 0),
    beginCoreDrain: () => structuredSessions.beginCoreRestartDrain(),
    coreBusy: () => structuredSessions.getCoreTurnStatus().hasActiveTurns,
    stopExecutions: () => {
      for (const session of structuredSessions.list()) {
        if (session.status === "running" || session.structuredState?.inFlight) structuredSessions.stop(session.id);
      }
      for (const session of processes.list()) {
        if (session.status === "running") processes.stop(session.id);
      }
    },
    available: () => !shuttingDown && !updateState.updateInFlight && !updateState.providerCliUpdateInFlight
      && terminalDaemonBuildIsCurrent(),
    log: (error) => {
      feedback.capture("daemon_update_failed", error);
      wandError("底层组件自动更新暂缓，将稍后重试", getErrorMessage(error));
    },
  });
  const getUpdateChannel = (): "stable" | "beta" =>
    normalizeUpdateChannel(storage.getConfigValue("updateChannel"));
  let disconnectAuthenticatedSockets = (): void => {};
  const refreshProviderCliUpdates = async (): Promise<{ items: ProviderCliUpdateStatus[]; checkedAt: string }> => {
    return refreshProviderCliUpdateState(updateState, config);
  };
  const useHttps = config.https === true;
  const protocol = useHttps ? "https" : "http";
  const requireAuth = createRequireAuth({ useHttps, storage, config, authService, settingsAccess });
  const requireAdmin = requireAdminScope;
  const requireSessions = requireScope("sessions");
  const requireFiles = requireScope("files");
  // Local preview traffic may contain arbitrary POST bodies. Mounting it before
  // Express body parsers keeps uploads, SSE and non-JSON requests streamable.
  registerLocalPreviewRoutes(app, { requireAuth, requireFiles });

  // Route-specific parsers must run before the global parser. Once body-parser
  // has consumed a request, a later express.json() cannot tighten or widen it.
  registerFeedbackIngress(app, feedbackReceiver);
  registerApnsRoutes(app, { storage, config, service: apns, liveActivity: liveActivities });
  app.use("/api/feedback/client", express.json({ limit: "32kb", inflate: false }));
  app.use("/api/decisions", express.json({ limit: "32kb" }));
  app.use("/api/optimize-prompt", express.json({ limit: "256kb" }));
  app.use("/api/file-write", express.json({ limit: "2mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(compression({ threshold: 1024 }));
  app.use((_req, res, next) => {
    if (!shuttingDown) {
      next();
      return;
    }
    res.setHeader("Connection", "close");
    res.status(503).json({ error: "Server is shutting down." });
  });
  app.use(createExtensionCors(config.browserExtensionIds));

  registerAssetRoutes(app, { configPath, config, requireAuth, requireSessions, authService, useHttps });


  registerAuthRoutes(app, {
    storage, config, authService, useHttps, requireAuth, tickets: webLoginTickets,
    getSession: id => sessionRegistry.get(id),
    disconnectAuthenticatedSockets: () => disconnectAuthenticatedSockets(),
  });

  // ── Android APK update & download (no auth required) ──

  registerPublicUpdateRoutes(app, distributionManager, config.publicOrigin);

  registerSettingsWebAccessRoute(app, {
    requireAuth, useHttps, access: settingsAccess,
    authenticateSession: (token) => authService.authenticateSession(token),
  });

  // Count-only compatibility probe. Local control (including session IDs and
  // admission barriers) uses the owner-only Unix IPC socket.
  app.get("/api/core-status", (_req, res) => {
    const { hasActiveTurns, activeTurnCount } = structuredSessions.getCoreTurnStatus();
    res.set("Cache-Control", "no-store").json({ hasActiveTurns, activeTurnCount });
  });

  registerDecisionRoutes(app, { storage, decisions: decisionExpert, requireAuth, requireSessions });
  app.use("/api", requireAuth);
  registerDaemonMaintenanceRoutes(app, { requireAdmin, maintenance: daemonMaintenance,
    canForceUpdate: req => {
      return !!req.principal && principalHasScope(req.principal, "admin");
    },
    log: error => {
      feedback.capture("daemon_update_failed", error);
      wandError("底层组件强制更新未完成", getErrorMessage(error));
    } });

  // Every /api family declares its scope in src/middleware/api-scope.ts; unlisted
  // paths are admin-only for connected apps (default-deny).
  app.use("/api", createApiScopeMiddleware());
  registerFeedbackClientRoutes(app, feedback);
  registerFeedbackAdminRoutes(app, feedbackReceiver, requireAdmin);
  app.use("/api", uploadReferenceGuard(storage.uploads));
  app.use(userMemoryOperationLog(storage));
  const userMemory = new UserMemoryService({
    storage, config, free: openRouter,
    notifyChanged: (employeeId) => notifyAiTeamRun({ kind: "silicon-employee-definition", employeeId }),
  });
  registerUserMemoryRoutes(app, {
    storage, service: userMemory,
    notifyChanged: (employeeId) => notifyAiTeamRun({ kind: "silicon-employee-definition", employeeId }),
  });

  // ── Config & Session info ──

  app.get("/api/config", asyncRoute(async (req, res) => {
    const structuredChatPersona = await buildStructuredChatPersonaPayload(configPath, config);
    const defaultModels = getProviderDefaultModels(config);
    res.json({
      host: config.host,
      port: config.port,
      defaultProvider: config.defaultProvider ?? "claude",
      defaultSessionKind: config.defaultSessionKind ?? "structured",
      defaultEngine: config.defaultEngine ?? "cli",
      defaultTaskWorktree: config.defaultTaskWorktree !== false,
      defaultMode: config.defaultMode,
      defaultCwd: config.defaultCwd,
      defaultModel: defaultModels.claude,
      defaultCodexModel: defaultModels.codex,
      defaultOpenCodeModel: defaultModels.opencode,
      defaultGrokModel: defaultModels.grok,
      defaultQoderModel: defaultModels.qoder,
      defaultModels,
      defaultThinkingEffort: config.defaultThinkingEffort ?? "off",
      commandPresets: config.commandPresets,
      structuredRunners: [
        { label: "Claude Structured", runner: "claude-cli-print" },
        { label: "Codex Structured", runner: "codex-cli-exec" },
        { label: "OpenCode Structured", runner: "opencode-cli-run" },
        { label: "Grok Structured", runner: "grok-cli-headless" },
        { label: "Qoder Structured", runner: "qoder-cli-print" },
      ],
      structuredChatPersona,
      cardDefaults: config.cardDefaults,
      // 会话署名与头像：客户端只做展示投影，不解释成任何执行身份。
      userProfile: config.userProfile ?? {},
      // 把语言偏好暴露给前端做 UI 文案 i18n。后端原本只用它给 Claude 拼 system prompt，
      // 前端没收到 → "SUBAGENT" / "Read" 这些 UI label 一直是英文，跟用户设的中文不匹配。
      language: config.language ?? "",
      updateAvailable: cachedUpdateInfo?.channel === getUpdateChannel() ? cachedUpdateInfo.updateAvailable : false,
      latestVersion: cachedUpdateInfo?.channel === getUpdateChannel() ? cachedUpdateInfo.latest : null,
      updateChannel: getUpdateChannel(),
      currentVersion: DISPLAY_VERSION,
      packageVersion: PKG_VERSION,
      canManageSettings: !!req.principal && principalHasScope(req.principal, "admin"),
      serverInstanceId: SERVER_INSTANCE_ID,
    });
  }));

  // ── Claude skills & browser extension vault ──

  registerVaultRoutes(app, { storage, config, useHttps });

  // ── Settings endpoints ──

  const getDistributionSettings = () => distributionManager.getSettings();

  registerSettingsRoutes(app, {
    storage,
    config,
    runtimeConfig,
    configPath,
    configDir,
    requireAdmin,
    requireAdminOrSessionPreferences,
    packageInfo: { version: DISPLAY_VERSION, name: PKG_NAME, nodeVersion: PKG_NODE_REQ, repoUrl: PKG_REPO_URL },
    buildInfo: BUILD_INFO,
    getCachedUpdateInfo: () => cachedUpdateInfo?.channel === getUpdateChannel() ? cachedUpdateInfo : null,
    getUpdateChannel,
    getDistributionSettings,
    getGithubConnector: () => getGithubConnectorStatus(storage),
    modelCatalog,
    openRouter,
    resolveAppConnectCode: (req) =>
      resolveAppConnectCode(req, config, useHttps, getEffectivePassword(storage, config)),
    sweepTaskRetention: () => runTaskRetentionSweep(),
  });

  registerGithubRoutes(app, { storage, requireAdmin, sessions: sessionRegistry });
  // 任务管理与 Missions 一样只需登录：原生 connected-app 也要能列/建/派发。
  registerTaskRoutes(app, { storage, sessions: sessionRegistry, structured: structuredSessions, processes, config, aiTeams, free: openRouter, executionQueue: taskExecutionQueue });
  registerAiTeamRoutes(app, {
    storage,
    runner: aiTeams,
    notifyTeamChanged: (teamId) => notifyAiTeamRun({ kind: "ai-team-definition", teamId }),
  });
  // 无指派派工：本地决策模型建议名单 → 确认开工（不自动派工，见 AGENTS）。
  registerTeamDispatchRoutes(app, { storage, runner: aiTeams, decisions: decisionExpert });
  registerSiliconEmployeeRoutes(app, {
    storage,
    config,
    free: openRouter,
    executionQueue: taskExecutionQueue,
    notifyEmployeeChanged: (employeeId) => notifyAiTeamRun({ kind: "silicon-employee-definition", employeeId }),
  });
  registerKnowledgeRoutes(app, storage);
  registerEmployeeImRoutes(app, { storage, im: employeeIm, requireAdmin });
  registerDingTalkRoutes(app, { service: dingtalk, requireAdmin, install: () => dingtalkDws.install() });
  registerAttentionRoutes(app, { sessions: sessionRegistry, runner: aiTeams });
  registerConversationRoutes(app, conversationService);
  registerScheduledTaskRoutes(app, scheduledTasks);

  const adminUpdateDeps: AdminUpdateRoutesDependencies = {
    storage,
    config,
    configPath,
    requireAdmin,
    state: updateState,
    getDistributionSettings,
    modelCatalog,
    getUpdateChannel,
    checkLatestPackageVersion,
    buildInfo: BUILD_INFO,
    serverInstanceId: SERVER_INSTANCE_ID,
    currentVersion: DISPLAY_VERSION,
    feedbackUsername: () => userDisplayName(config.userProfile),
    reportFailure: (event, error) => feedback.capture(event, error),
    emitSystemNotification: (data) => {
      wsManager.emitEvent({ type: "notification", sessionId: "__system__", data });
    },
    requestUpdateCheck: () => {
      if (updateChecksEnabled) void performAutoUpdate({ manual: true }).catch(() => {});
    },
  };
  registerAdminUpdateRoutes(app, adminUpdateDeps);

  registerSessionRoutes(app, {
    processes,
    structured: structuredSessions,
    storage,
    defaultMode: config.defaultMode,
    config,
    sessions: sessionRegistry,
    onSessionCreated: (cwd) => recordRecentPath(storage, cwd),
    onCompletionViewed: (event) => wsManager.emitEvent(event),
    decisions: decisionExpert,
    free: openRouter,
  });
  registerClaudeHistoryRoutes(app, { processes, storage });
  registerWorkspaceRoutes(app, storage, sessionRegistry, { config, free: openRouter });
  registerMissionRoutes(app, missions);
  registerUploadRoutes(app, sessionRegistry, { uploads: storage.uploads, temporaryRoot: configTemporaryRoot(configDir) });
  registerLocalModelRoutes(app, { models: localModels, requireSessions, requireAdmin });
  registerStorageCleanupRoutes(app, storageCleanup, requireAdmin);

  app.post("/api/optimize-prompt", asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as { text?: string; sessionId?: string };
    const text = typeof body.text === "string" ? body.text : "";
    let cwd: string | undefined;
    let ai: ReturnType<typeof resolveSystemAiContext> | undefined;
    if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
      const snapshot = sessionRegistry.getLatest(body.sessionId);
      if (snapshot?.cwd) cwd = snapshot.cwd;
      if (snapshot) ai = resolveSystemAiContext(snapshot, config, storage.getSystemSiliconEmployee(), openRouter, { storage });
    }
    if (!ai) {
      const defaultSession = {
        provider: config.defaultProvider,
        structuredState: undefined,
        runner: undefined,
        command: config.defaultProvider === "qoder" ? "qodercli" : config.defaultProvider ?? "claude",
        selectedModel: null,
        thinkingEffort: config.defaultThinkingEffort,
      };
      ai = resolveSystemAiContext(defaultSession, config, storage.getSystemSiliconEmployee(), openRouter, { storage });
    }
    const callSessionIds: string[] = [];
    ai.onCallSessionCreated = id => callSessionIds.push(id);
    try {
      const optimized = await optimizePrompt(text, config.language ?? "", cwd, ai);
      res.setHeader("X-Wand-System-Call-Ids", callSessionIds.slice(0, 64).join(","));
      res.setHeader("X-Wand-System-Call-Count", String(callSessionIds.length));
      res.json({ optimized });
    } catch (error) {
      res.setHeader("X-Wand-System-Call-Ids", callSessionIds.slice(0, 64).join(","));
      res.setHeader("X-Wand-System-Call-Count", String(callSessionIds.length));
      if (error instanceof PromptOptimizeError) {
        const status = error.code === "EMPTY_INPUT" || error.code === "INPUT_TOO_LONG" ? 400 : 500;
        res.status(status).json({ error: error.message, errorCode: error.code });
        return;
      }
      sendRouteError(res, error, "提示词优化失败。", 500);
    }
  }));

  registerFileRoutes(app, { storage, defaultCwd: config.defaultCwd });

  // ── Session control ──

  // ── WebSocket broadcast layer ──

  let activeSslCertPath: string | null = null;
  const server = useHttps
    ? (() => {
        const ssl = ensureCertificates(resolveConfigDir(configPath), {
          userCertPath: config.tls?.certPath,
          userKeyPath: config.tls?.keyPath,
        });
        activeSslCertPath = ssl.certPath;
        return createHttpsServer({ key: ssl.key, cert: ssl.cert }, app);
      })()
    : createHttpServer(app);
  // Node's 5s default can close an idle socket just before iOS URLSession reuses
  // it for a later POST, surfacing as "network connection lost" on the client.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;

  // 公开下载当前证书 —— 方便从手机/其他终端拉证书并导入信任链。
  // 不鉴权：证书本身是公开材料（不含私钥），泄露不影响安全。
  if (useHttps && activeSslCertPath) {
    const certPath = activeSslCertPath;
    app.get("/cert/server.crt", (_req, res) => {
      try {
        if (!existsSync(certPath)) {
          res.status(404).type("text/plain").send("证书文件不存在");
          return;
        }
        res.setHeader("Content-Type", "application/x-x509-ca-cert");
        res.setHeader("Content-Disposition", 'attachment; filename="wand-server.crt"');
        res.send(readFileSync(certPath));
      } catch (err) {
        res.status(500).type("text/plain").send(`读取证书失败: ${getErrorMessage(err, "未知错误")}`);
      }
    });
  }

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    // Incoming frames are control messages (subscribe/resync/pong), never
    // transcripts. Bound them so a single client cannot allocate arbitrarily
    // large buffers before JSON parsing.
    maxPayload: 256 * 1024,
    perMessageDeflate: {
      zlibDeflateOptions: { level: 1 },
      threshold: 512,
      concurrencyLimit: 10,
    },
  });
  const wsManager = new WsBroadcastManager(
    wss,
    () => config.cardDefaults ?? {},
    useHttps,
    authService,
    (req) => authenticateBearerAppToken(req, storage, config) !== null,
  );
  wsManager.setup({
    getSession: (id) => sessionRegistry.get(id),
    projectMessages: (id, messages) => sessionRegistry.transportMessages(id, messages),
    getTerminalState: (id) => processes.getTerminalState(id),
    sendPtyInput: (id, input, shortcutKey, userInput) =>
      processes.sendInputConfirmed(id, input, "terminal", shortcutKey, userInput).then(() => {}),
    resizePty: (id, cols, rows) => {
      processes.resize(id, cols, rows);
    },
  });
  disconnectAuthenticatedSockets = () => wsManager.disconnectAll();
  wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") return;
    feedback.capture("websocket_error", err);
    wandError("WebSocket 异常", err.message);
  });

  // Wire process events to WebSocket broadcast
  processes.on("process", (event: ProcessEvent) => {
    sessionRegistry.invalidateMessageProjection(event.sessionId);
    taskTitles.ingest(event);
    sessionCompletions.ingest(event);
    apns.ingest(event);
    liveActivities.ingest(event);
    missions.ingest(event);
    aiTeams.ingest(event);
    employeeImLifecycle.ingest(event);
    wsManager.emitEvent(event);
  });
  structuredSessions.setEventEmitter((event) => {
    sessionRegistry.invalidateMessageProjection(event.sessionId);
    taskTitles.ingest(event);
    storage.recordTaskCommentSessionEvent(event);
    conversationService.ingestSessionEvent(event);
    scheduledTasks.ingestSessionEvent(event);
    dingtalk.ingest(event);
    sessionCompletions.ingest(event);
    apns.ingest(event);
    liveActivities.ingest(event);
    missions.ingest(event);
    aiTeams.ingest(event);
    employeeImLifecycle.ingest(event);
    // 员工结构化回合结束时补位排队派发；inFlight 仍为 true 的事件不触发。
    const data = event.data as { employeeId?: unknown; structuredState?: { inFlight?: unknown } } | undefined;
    if (typeof data?.employeeId === "string" && data.structuredState?.inFlight !== true) {
      taskExecutionQueue.scheduleDrain(data.employeeId);
    }
    wsManager.emitEvent(event);
  });
  notifier.attach((event) => wsManager.emitEvent(event));
  systemCalls.attach({ emit: event => wsManager.emitEvent(event), notifyConversation: notifier.conversationSession });
  // Re-attach structured CLI runs that kept going inside terminald while the
  // previous web process was down; fire-and-forget, failures are logged inside.
  apns.start();
  liveActivities.start();
  void structuredSessions.recoverDetachedRuns().then(() => {
    liveActivityFactsReady = true;
    return taskExecutionQueue.drainAll();
  }, () => {
    wandWarn("会话恢复未确认：暂缓灵动岛远程更新，不将旧状态判为完成。");
  });
  aiTeams.reconcile();
  structuredSessions.resumeQueuedPiMessages();

  // ── Restart endpoint (needs server + wss in scope) ──

  /**
   * 统一的关服 + 重启。重启方式由 computeRelaunch 决定：
   *   - systemd 托管且已装服务 → 仅退出，交给 Restart=always 用（更新自修复后可能刚被
   *     重写的）ExecStart 拉起，避免再 spawn detached 子进程与 systemd 抢单实例 pidfile；
   *   - 否则 → spawn 一个 detached 子进程（bin 优先全局安装，确保更新后跑到新版）再退出。
   */
  let restartPending = false;
  function relaunchAfterShutdown(): void {
    if (restartPending) return;
    restartPending = true;
    const releaseDrain = structuredSessions.beginCoreRestartDrain();
    void (async () => {
      if (structuredSessions.getCoreTurnStatus().hasActiveTurns) {
        process.stdout.write("[wand] 等待原生 Core 回合完成后再重启…\n");
      }
      while (structuredSessions.getCoreTurnStatus().hasActiveTurns) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      }
      // Do not dispose tools/services while a native turn is still running.
      // The same barrier covers manual and auto restart.
      const plan = computeRelaunch({
        serviceInstalled: safeServiceInstalled(),
        globalCli: resolveGlobalWandCli(),
      });
      // Accepted iteration records can need the bounded Git compatibility retry;
      // a force-exit timer here would discard them before close() drains the queue.
      await close();
      if (plan.mode === "spawn") {
        spawn(process.execPath, [plan.bin ?? "", ...(plan.args ?? [])], {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
          env: process.env,
        }).unref();
      }
      process.exit(0);
    })().catch((error: unknown) => {
      restartPending = false;
      releaseDrain();
      wandError("等待 Core 回合后重启失败", getErrorMessage(error));
    });
  }

  app.post("/api/restart", requireAdmin, asyncRoute(async (_req, res) => {
    res.json({ ok: true, message: "服务正在重启..." });
    wsManager.emitEvent({
      type: "notification",
      sessionId: "__system__",
      data: { kind: "restart" },
    });
    const restartTimer = setTimeout(() => {
      relaunchAfterShutdown();
    }, 600);
    restartTimer.unref?.();
  }));

  function refreshDecisionRuntime(): void {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    const status = decisionExpert.status();
    const localHost = config.host === "::1" ? "[::1]" : config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
    decisionRuntime = status.enabled ? { url: `${protocol}://${localHost}:${port}`,
      ...(activeSslCertPath ? { caPath: activeSslCertPath } : {}),
      evaluate: (value, caller, signal) => decisionExpert.evaluate(value, caller, signal) } : null;
    autoAssignEvaluate = status.enabled
      ? (value, caller, signal) => decisionExpert.evaluate(value, caller, signal) : undefined;
  }

  let bindAddr = config.host === "0.0.0.0" ? "0.0.0.0" : config.host;
  const collectedUrls: ServerUrl[] = [];

  await new Promise<void>((resolve, reject) => {
    const cleanupFailedListen = async (): Promise<void> => {
      shuttingDown = true;
      stopIterationPrompts(storage);
      dingtalk.dispose();
      dingtalkDws.dispose();
      employeeImLifecycle.dispose();
      employeeIm.dispose();
      await scheduledTasks.dispose();
      decisions.dispose();
      systemFallback?.dispose();
      openRouter.dispose();
      try { processes.dispose(); } catch { /* noop */ }
      conversationService.dispose();
      localModels.dispose();
      try { structuredSessions.dispose(); } catch { /* noop */ }
      taskTitles.dispose();
      modelCatalog.dispose();
      await aiTeams.dispose();
      try { structuredHosts.rustClient?.disconnect(); } catch { /* noop */ }
      try { structuredLogger.dispose(); } catch { /* noop */ }
      try { wsManager.dispose(); } catch { /* noop */ }
      try { wss.close(); } catch { /* noop */ }
      try { server.close(); } catch { /* noop */ }
      authService.dispose();
      taskExecutionQueue.dispose();
      try {
        await whenIterationPromptsSettled(storage);
      } finally {
        storage.close();
      }
    };
    const onListenError = (err: NodeJS.ErrnoException): void => {
      feedback.capture("startup_failed", err);
      feedback.stop();
      server.off("error", onListenError);
      const startupError = err.code === "EADDRINUSE" ? new PortInUseError(config.port, config.host) : err;
      void cleanupFailedListen().then(() => {
        reject(startupError);
      }, cleanupError => reject(new AggregateError([startupError, cleanupError], "Server startup rollback failed")));
    };
    server.once("error", onListenError);
    server.listen(config.port, config.host, () => {
      server.off("error", onListenError);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : config.port;
      bindAddr = `${config.host}:${actualPort}`;
      refreshDecisionRuntime();
      const scheme: "HTTP" | "HTTPS" = useHttps ? "HTTPS" : "HTTP";
      // 主 URL：本机回环；若绑定 0.0.0.0 再补一个对外提示。
      collectedUrls.push({ url: `${protocol}://127.0.0.1:${actualPort}`, scheme });
      if (config.host === "0.0.0.0") {
        collectedUrls.push({ url: `${protocol}://0.0.0.0:${actualPort}`, scheme });
      } else if (config.host !== "127.0.0.1" && config.host !== "localhost") {
        collectedUrls.push({ url: `${protocol}://${config.host}:${actualPort}`, scheme });
      }
      resolve();
    });
  });

  if (!storage.hasCustomPassword() && config.password === "change-me") {
    wandWarn(
      "正在使用默认密码（change-me），任何能访问本机的人都可以登录。",
      "修改方法：在界面右上角「设置」中修改密码，或运行：node dist/cli.js config:set password <你的新密码>"
    );
  }

  const updateChecksEnabled = !testMode && process.env.WAND_DISABLE_UPDATE_CHECK !== "1";
  systemFallback?.start();
  if (!testMode) userMemory.start();
  if (!testMode) scheduledTasks.start();

  // Start configured background sessions after the server is already reachable.
  if (!testMode) {
    void processes.runStartupCommands().catch((error) => {
      console.error("[wand] Failed to start configured startup commands:", getErrorMessage(error));
    });
  }

  // Model discovery runs exclusively in the server. Its first result is
  // persisted; later checks only write when catalog content changes.
  // 变化后通知已连接的页面，下拉不用等用户点「刷新模型列表」。
  modelCatalog.onChanged((result) => {
    wsManager.emitEvent({
      type: "notification",
      sessionId: "__system__",
      data: { kind: "models", revision: result.revision, refreshedAt: result.refreshedAt },
    });
  });
  openRouter.onChanged(() => modelCatalog.publishManagedPiModels());
  if (!testMode) openRouter.start();
  let modelCatalogRefreshTimer: NodeJS.Timeout | null = null;
  if (!testMode) {
    void modelCatalog.refresh().catch(() => {});
    modelCatalogRefreshTimer = setInterval(() => {
      if (!shuttingDown) void modelCatalog.refresh().catch(() => {});
    }, MODEL_CATALOG_AUTO_REFRESH_INTERVAL_MS);
    modelCatalogRefreshTimer.unref();
  }

  // 每次扫描读取当前保留窗口；未完成、待验收和升级前任务归档不进入自动清理。
  // 保存任务保留设置后走同一条扫描，不等下一小时。
  const retentionDeps = {
    storage,
    sessions: sessionRegistry,
    taskRetention: () => config.taskRetention,
    releaseArchivedProviderHistory: (sessionIds: readonly string[]) => sessionRegistry.releaseArchivedProviderHistory(sessionIds),
  };
  const sweepRetention = createRetentionSweep(retentionDeps);
  runTaskRetentionSweep = () => {
    const result = sweepRetention();
    try {
      wsManager.emitEvent({
        type: "notification",
        sessionId: "__system__",
        data: { kind: "task-retention", ...result },
      });
    } catch { /* 扫描结果已经返回给保存请求，通知失败不回滚 */ }
    return result;
  };
  if (!testMode) taskTitles.refresh();
  let retentionTimer: NodeJS.Timeout | null = null;
  if (!testMode) {
    retentionTimer = startRetentionTimer(retentionDeps, 60 * 60 * 1000, sweepRetention);
  }

  // Express 4 does not forward rejected route promises automatically. Every
  // async route above is wrapped with asyncRoute, and this final middleware
  // keeps parser, synchronous middleware, and async failures JSON-shaped.
  const reportRequestFailure: ErrorRequestHandler = (error, req, _res, next) => {
    const status = typeof error?.status === "number" ? error.status : 500;
    if (status >= 500 && !req.path.startsWith("/api/feedback")) feedback.capture("http_5xx", error, feedbackFeatureForApiPath(req.path), feedbackRequestSecrets(req));
    next(error);
  };
  app.use(reportRequestFailure);
  app.use(jsonErrorHandler);
  activeFeedback = feedback;
  feedback.start();

  // Daemon-only maintenance does not restart Server, depend on npm auto-update
  // preferences, or stop a live execution. Startup recovery is already attached.
  if (!testMode) daemonMaintenance.start();
  if (!testMode && config.autoCleanupTemporaryFiles !== false) storageCleanup.start();

  // ── Auto-update logic ──

  // 同一目标版本自动安装失败后指数退避（30 分钟起，最长 6 小时），避免每轮轮询都重试
  // 同一个必失败的安装并刷屏；用户主动触发（切通道/打开开关）时清零重试。
  const autoUpdateFailures = new Map<string, { count: number; retryAt: number }>();
  let notifiedUpdateVersion: string | null = null;

  async function performAutoUpdate(options: { manual?: boolean } = {}): Promise<void> {
    if (shuttingDown) return;
    // 与 /api/update、provider CLI 更新共用一把互斥，避免两路同时改全局 npm 目录。
    if (updateState.updateInFlight || updateState.providerCliUpdateInFlight) return;
    const channel = getUpdateChannel();
    const info = await checkLatestPackageVersion(channel, true);
    if (shuttingDown || channel !== getUpdateChannel()) return;
    cachedUpdateInfo = info;
    if (!info.latest || !info.updateAvailable) return;

    const autoEnabled = storage.getConfigValue("autoUpdateWeb") === "true";
    if (!autoEnabled) {
      // 同一版本只提示一次；新连接的客户端由 cachedUpdateInfo 补发。
      if (notifiedUpdateVersion === info.latest && !options.manual) return;
      notifiedUpdateVersion = info.latest;
      process.stdout.write(
        `[wand] 发现新版本 ${info.latest}（当前 ${info.current}）。可在设置中更新${channel === "beta" ? "（Beta 通道）" : ""}。\n`
      );
      wsManager.emitEvent({
        type: "notification",
        sessionId: "__system__",
        data: { kind: "update", current: info.current, latest: info.latest },
      });
      return;
    }

    if (options.manual) autoUpdateFailures.delete(info.latest);
    const failure = autoUpdateFailures.get(info.latest);
    if (failure && Date.now() < failure.retryAt) return;

    // Checking npm is asynchronous; a manual update may have started meanwhile.
    if (updateState.updateInFlight || updateState.providerCliUpdateInFlight) return;
    updateState.updateInFlight = true;
    try {
      launchServerUpdate(adminUpdateDeps, info, (message) => recordUpdateFailure(message));
    } catch (error) {
      feedback.capture("update_failed", error);
      recordUpdateFailure(getErrorMessage(error, "未知错误"));
      updateState.updateInFlight = false;
    }

    function recordUpdateFailure(msg: string): void {
      const count = (autoUpdateFailures.get(info.latest!)?.count ?? 0) + 1;
      autoUpdateFailures.set(info.latest!, {
        count,
        retryAt: Date.now() + Math.min(30 * 60_000 * 2 ** (count - 1), 6 * 60 * 60_000),
      });
      process.stdout.write(`[wand] 自动更新失败: ${msg}\n`);
      wsManager.emitEvent({
        type: "notification",
        sessionId: "__system__",
        data: { kind: "auto-update-failed", current: info.current, latest: info.latest, error: msg },
      });
    }
  }

  async function performProviderCliAutoUpdate(): Promise<void> {
    if (shuttingDown || storage.getConfigValue("autoUpdateProviderClis") !== "true" || updateState.providerCliUpdateInFlight || updateState.updateInFlight) return;
    updateState.providerCliUpdateInFlight = true;
    try {
      const before = await refreshProviderCliUpdates();
      if (shuttingDown) return;
      const available = before.items.filter((item) => item.updateAvailable && item.updateSupported);
      if (!available.length) return;
      const commandResults = await updateProviderClis(before.items, available.map((item) => item.id), {
        inheritEnv: config.inheritEnv !== false,
        onLog: (line) => process.stdout.write(`[wand] ${line}\n`),
      });
      if (shuttingDown) return;
      const after = await refreshProviderCliUpdates();
      const results = verifyProviderCliUpdateResults(commandResults, after.items);
      for (const result of results) {
        if (!result.ok) feedback.capture("provider_update_failed", new Error(result.message));
        process.stdout.write(`[wand] CLI 自动更新 ${result.ok ? "完成" : "失败"}: ${result.message}\n`);
      }
      void modelCatalog.refresh().catch(() => {});
    } catch (error) {
      feedback.capture("provider_update_failed", error);
      process.stdout.write(`[wand] CLI 自动更新失败: ${getErrorMessage(error)}\n`);
    } finally {
      updateState.providerCliUpdateInFlight = false;
    }
  }

  let updateCheckTimer: NodeJS.Timeout | null = null;
  let providerCliUpdateTimer: NodeJS.Timeout | null = null;
  if (updateChecksEnabled) {
    // Background update check on startup
    performAutoUpdate().catch(() => {});

    // Periodic update check (every 30 minutes)
    updateCheckTimer = setInterval(() => {
      performAutoUpdate().catch(() => {});
    }, 30 * 60 * 1000);
    updateCheckTimer.unref();

    // 与 Wand 自身 npm 更新错峰，避免两个全局 updater 同时改 PATH / bin 链接。
    providerCliUpdateTimer = setTimeout(() => {
      performProviderCliAutoUpdate().catch(() => {});
      providerCliUpdateTimer = setInterval(() => {
        performProviderCliAutoUpdate().catch(() => {});
      }, 30 * 60 * 1000);
      providerCliUpdateTimer.unref();
    }, 2 * 60 * 1000);
    providerCliUpdateTimer.unref();
  }

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      shuttingDown = true;
      stopIterationPrompts(storage);
      feedback.stop();
      if (activeFeedback === feedback) activeFeedback = null;
      taskExecutionQueue.dispose();
      apns.dispose();
      liveActivities.dispose();
      dingtalk.dispose();
      dingtalkDws.dispose();
      employeeImLifecycle.dispose();
      employeeIm.dispose();
      taskTitles.dispose();
      modelCatalog.dispose();
      const teamShutdown = aiTeams.dispose();
      await scheduledTasks.dispose();
      await daemonMaintenance.stop();
      await storageCleanup.stop();
      decisions.dispose();
      systemFallback?.dispose();
      openRouter.dispose();
      await userMemory.dispose();
      if (updateCheckTimer) {
        clearInterval(updateCheckTimer);
        updateCheckTimer = null;
      }
      if (providerCliUpdateTimer) {
        clearTimeout(providerCliUpdateTimer);
        providerCliUpdateTimer = null;
      }
      if (modelCatalogRefreshTimer) {
        clearInterval(modelCatalogRefreshTimer);
        modelCatalogRefreshTimer = null;
      }
      if (retentionTimer) {
        clearInterval(retentionTimer);
        retentionTimer = null;
      }

      // Stop accepting requests first. Existing requests get a short grace
      // period while managers flush and active runners are cancelled.
      const serverClosed = new Promise<void>((resolve) => {
        let settled = false;
        let fallbackTimer: NodeJS.Timeout | null = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (fallbackTimer) clearTimeout(fallbackTimer);
          resolve();
        };
        fallbackTimer = setTimeout(() => {
          try { server.closeAllConnections?.(); } catch { /* ignore */ }
          finish();
        }, 3000);
        fallbackTimer.unref?.();
        try { server.close(() => finish()); } catch { finish(); }
      });

      try { processes.dispose(); } catch { /* best-effort shutdown */ }
      conversationService.dispose();
      localModels.dispose();
      try { structuredSessions.dispose(); } catch { /* best-effort shutdown */ }
      await teamShutdown;
      try { structuredHosts.rustClient?.disconnect(); } catch { /* best-effort shutdown */ }
      try { structuredLogger.dispose(); } catch { /* best-effort shutdown */ }
      try { wsManager.dispose(); } catch { /* best-effort shutdown */ }
      try { wss.close(); } catch { /* ignore */ }

      try {
        await serverClosed;
      } finally {
        // Auth cleanup must precede DatabaseSync.close() so its cleanup timer
        // can never retain or call a closed storage instance.
        authService.dispose();
        try {
          await whenIterationPromptsSettled(storage);
        } finally {
          storage.close();
        }
      }
    })();
    return closePromise;
  };

  return {
    processManager: processes,
    structuredSessions,
    authService,
    configPath,
    dbPath: resolveDatabasePath(configPath),
    urls: collectedUrls,
    bindAddr,
    httpsEnabled: useHttps,
    version: DISPLAY_VERSION,
    orphanRecoveredCount: processes.getOrphanRecoveredCount(),
    pathRepair,
    close,
  };
}
