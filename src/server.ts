import { OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import crypto from "node:crypto";
import compression from "compression";
import express, { NextFunction, Request, Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { WebSocketServer } from "ws";
import {
  AuthService,
  BROWSER_ADMIN_PRINCIPAL,
  CONNECTED_APP_PRINCIPAL,
  principalHasScope,
  readSessionCookie,
  SESSION_COOKIE_HTTP,
  SESSION_COOKIE_HTTPS,
  SESSION_COOKIE_LEGACY,
} from "./auth.js";
import { type WandBuildInfo } from "./build-info.js";
import { ensureCertificates } from "./cert.js";
import {
  getDefaultModelForProvider,
  getProviderDefaultModels,
  isExecutionMode,
  resolveConfigDir,
  writePreferenceToStorage,
} from "./config.js";
import { ModelCatalogService, type ModelRefreshOptions } from "./models.js";
import { defaultModelGroupSelector } from "./model-groups.js";

import { ProcessManager, ProcessEvent } from "./process-manager.js";
import { SessionLogger } from "./session-logger.js";
import { coreHarnessAgentDir, warmCoreHarness } from "./harness-engine.js";
import { SessionRegistry } from "./session-registry.js";
import { SessionCompletionTracker } from "./session-completion.js";
import { resolveSystemAiContext } from "./session-ai-context.js";
import { StructuredSessionManager } from "./structured-session-manager.js";
import { SettingsWebAccess, registerSettingsWebAccessRoute } from "./settings-web-access.js";
import { DecisionService } from "./decision-service.js";
import type { DecisionRuntimeAccess } from "./decision-runner.js";
import { registerDecisionRoutes } from "./server-decision-routes.js";
import { recordRecentPath, registerFileRoutes } from "./server-file-routes.js";
import { registerLocalPreviewRoutes } from "./server-local-preview-routes.js";
import { registerSettingsRoutes } from "./server-settings-routes.js";
import { registerSpeechRoutes } from "./server-speech-routes.js";
import { SpeechPolisherService } from "./speech-polisher-service.js";
import { SPEECH_POLISHER_KEY } from "./speech-polisher-identity.js";
import { registerLocalModelRoutes } from "./server-local-model-routes.js";
import { LocalModelSetupService } from "./local-model-setup.js";
import { DecisionExpertService } from "./decision-expert-service.js";
import { DECISION_EXPERT_KEY } from "./decision-expert-identity.js";
import { SpeechService } from "./speech-service.js";
import {
  appTokenLoginPayload,
  buildStructuredChatPersonaPayload,
  isBrowserExtensionOrigin,
  resolveAppConnectCode,
  resolveStructuredChatAvatarPath,
  verifyAppToken,
} from "./server-app-connect.js";
import { firstHeaderValue, sendRouteError } from "./server-request.js";
import { inferProviderFromCommand, isSessionProvider } from "./session-provider.js";
import { registerVaultRoutes } from "./server-vault-routes.js";
import { registerGithubRoutes } from "./server-github-routes.js";
import { registerTaskRoutes } from "./server-task-routes.js";
import { getGithubConnectorStatus } from "./github-connector.js";
import { registerMissionRoutes } from "./server-mission-routes.js";
import { Missions } from "./missions.js";
import { AI_TEAM_CHAT_PREFIX, createAiTeamRunner } from "./ai-team-runner.js";
import { ConversationService } from "./conversation-service.js";
import type { ConversationSessionUpdate } from "./conversation-types.js";
import { CONVERSATION_RELAY_PREFIX } from "./conversation-types.js";
import { forwardConversationRelay, registerConversationRoutes } from "./server-conversation-routes.js";
import type { AiTeamLiveUpdate } from "./ai-team-types.js";
import { registerAiTeamRoutes } from "./server-ai-team-routes.js";
import { registerTeamDispatchRoutes } from "./server-team-dispatch-routes.js";
import { registerSiliconEmployeeRoutes } from "./server-employee-routes.js";
import { defaultRoleForCli } from "./default-employee.js";
import { UserMemoryService } from "./user-memory.js";
import { registerUserMemoryRoutes, userMemoryOperationLog } from "./server-user-memory.js";
import { registerAttentionRoutes } from "./server-attention-routes.js";
import {
  refreshProviderCliUpdateState,
  registerAdminUpdateRoutes,
  registerPublicUpdateRoutes,
  ServerUpdateState,
} from "./server-update-routes.js";
import { parseSessionCreationOrigin, registerClaudeHistoryRoutes, registerSessionRoutes } from "./server-session-routes.js";
import { registerWorkspaceRoutes } from "./server-workspace-routes.js";
import { resolveSessionCwd } from "./session-cwd.js";
import { resolveWorkspaceIdForNewSession } from "./workspace-binding.js";
import { getErrorMessage } from "./error-utils.js";
import { asyncRoute, jsonErrorHandler } from "./express-async.js";
import {
  checkPackageUpdateAsync,
  installPackageGloballyAsync,
  normalizeUpdateChannel,
  resolveGlobalWandCli,
  type PackageUpdateInfo,
  type UpdateChannel,
} from "./npm-update-utils.js";
import { repairServiceUnitAfterUpdate } from "./service-self-repair.js";
import { computeRelaunch } from "./relaunch.js";
import { createRetentionSweep, startRetentionTimer, type RetentionResult } from "./retention.js";
import { RuntimeConfigState } from "./runtime-config.js";
import { safeServiceInstalled } from "./tui/runtime-utils.js";
import {
  checkManagedServiceUpdatePreflight,
} from "./update-helper.js";
import { toSessionDetailDTO } from "./session-transport.js";
import { compactToolMessagesForTransport, windowMessagesForTransport } from "./message-truncator.js";
import { enrichStructuredMessages } from "./structured-client-protocol.js";
import { registerUploadRoutes } from "./upload-routes.js";
import { optimizePrompt, PromptOptimizeError } from "./prompt-optimizer.js";
import { resolveDatabasePath, WandStorage, type AuthPrincipal, type AuthScope } from "./storage.js";
import { deepRepairRuntimePath, formatPathRepairSummary, repairRuntimePath, type PathRepairResult } from "./path-repair.js";
import { DistributionManager } from "./distribution-manager.js";
import { isLogBusActive, wandTuiLog } from "./tui/log-bus.js";
import { EMBEDDED_WEB_ASSETS, type EmbeddedVendorAssetPath } from "./web-ui/embedded-assets.js";
import { renderApp } from "./web-ui/index.js";
import { getAiTeamsChunk, getScriptAsset } from "./web-ui/scripts.js";
import { getStylesAsset } from "./web-ui/styles.js";
import { WsBroadcastManager } from "./ws-broadcast.js";
import { TerminalDaemonClient } from "./terminal-daemon-client.js";
import { createUpgradeAwareTerminalHost } from "./render-host.js";
import { DaemonAdmission, DaemonMaintenance } from "./daemon-maintenance.js";
import { createDaemonMaintenanceTargets } from "./daemon-maintenance-targets.js";
import { registerDaemonMaintenanceRoutes } from "./server-daemon-maintenance-routes.js";
import { terminalDaemonBuildIsCurrent } from "./terminal-daemon-build.js";
import { createUpgradeAwareStructuredHost } from "./render-structured-host.js";
import type { TerminalHost } from "./terminal-host.js";
import { checkPasswordRateLimit, recordFailedPassword, resetPasswordRateLimit } from "./middleware/rate-limit.js";
import {
  updateProviderClis,
  verifyProviderCliUpdateResults,
  type ProviderCliUpdateStatus,
} from "./provider-cli-updater.js";
import { CommandRequest, SessionProvider, WandConfig } from "./types.js";
import { userAuthor } from "./user-profile.js";

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
const PKG_NODE_REQ = PKG_JSON.engines?.node ?? ">=24.21.0";
const PKG_REPO_URL = "https://github.com/co0ontty/wand";

/** 结构化聊天头像允许的图片类型；未知扩展名回 415。 */
const AVATAR_CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
};

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
  const info = await checkPackageUpdateAsync(PKG_VERSION, channel);
  if (info.latest) {
    packageUpdateCache.set(channel, { info, timestamp: now });
  }
  return info;
}

// ── Build info (构建时打入的 commit SHA) + Beta 通道 ──

/** 读取 dist/build-info.json（由 scripts/stamp-build-info.js 在 build 时生成）。 */
function readBuildInfo(): WandBuildInfo {
  try {
    const raw = readFileSync(path.join(SERVER_MODULE_DIR, "build-info.json"), "utf8");
    const j = JSON.parse(raw) as Partial<WandBuildInfo>;
    return {
      commit: typeof j.commit === "string" && j.commit ? j.commit : null,
      builtAt: typeof j.builtAt === "string" && j.builtAt ? j.builtAt : null,
      version: typeof j.version === "string" && j.version ? j.version : null,
      channel: typeof j.channel === "string" && j.channel ? j.channel : null,
    };
  } catch {
    // dev（tsx 跑 src/）或老版本（无此文件）时降级为全 null。
    return { commit: null, builtAt: null, version: null, channel: null };
  }
}

const BUILD_INFO = readBuildInfo();
const DISPLAY_VERSION = BUILD_INFO.version || PKG_VERSION;
const SERVER_INSTANCE_ID = crypto.randomUUID();

// ── Auth helpers ──

const requestPrincipals = new WeakMap<Request, AuthPrincipal>();

function buildRequireAuth(useHttps: boolean, storage: WandStorage, config: WandConfig, authService: AuthService, settingsAccess: SettingsWebAccess) {
  return function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const sessionToken = readSessionCookie(req, useHttps);
    const sessionPrincipal = authService.authenticateSession(sessionToken);
    const principal = (sessionPrincipal && principalHasScope(sessionPrincipal, "session-preferences") &&
      settingsAccess.accepts(sessionToken, req.headers.cookie) ? BROWSER_ADMIN_PRINCIPAL : sessionPrincipal)
      ?? authenticateBearerAppToken(req, storage, config);
    if (!principal) {
      res.status(401).json({ error: "未授权，请先登录。" });
      return;
    }
    requestPrincipals.set(req, principal);
    next();
  };
}

function buildRequireScope(scope: AuthScope) {
  return function requireScope(req: Request, res: Response, next: NextFunction): void {
    const principal = requestPrincipals.get(req);
    if (!principal) {
      res.status(401).json({ error: "未授权，请先登录。" });
      return;
    }
    if (!principalHasScope(principal, scope)) {
      res.status(403).json({ error: "当前连接没有执行此操作的权限。" });
      return;
    }
    next();
  };
}

const CONNECTED_APP_PREFERENCE_KEYS = new Set([
  "defaultMode",
  "defaultModel",
  "defaultCodexModel",
  "defaultOpenCodeModel",
  "defaultGrokModel",
  "defaultQoderModel",
  "defaultModels",
  "defaultThinkingEffort",
  "defaultProvider",
  "defaultSessionKind",
  "defaultEngine",
  "defaultTaskWorktree",
]);

function requireAdminOrSessionPreferences(req: Request, res: Response, next: NextFunction): void {
  const principal = requestPrincipals.get(req);
  if (!principal) {
    res.status(401).json({ error: "未授权，请先登录。" });
    return;
  }
  if (principalHasScope(principal, "admin")) {
    next();
    return;
  }
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const keys = Object.keys(body);
  if (!principalHasScope(principal, "session-preferences")
    || keys.length === 0
    || keys.some((key) => !CONNECTED_APP_PREFERENCE_KEYS.has(key))) {
    res.status(403).json({ error: "当前连接只能修改新会话默认偏好。" });
    return;
  }
  next();
}

function getEffectivePassword(storage: WandStorage, config: WandConfig): string {
  return storage.getPassword() ?? config.password;
}

function authenticateBearerAppToken(
  req: { headers: { authorization?: string | string[] } },
  storage: WandStorage,
  config: WandConfig,
): AuthPrincipal | null {
  const header = firstHeaderValue(req.headers.authorization);
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  try {
    return verifyAppToken(token, getEffectivePassword(storage, config), config.appSecret ?? "")
      ? { ...CONNECTED_APP_PRINCIPAL, scopes: [...CONNECTED_APP_PRINCIPAL.scopes] }
      : null;
  } catch {
    return null;
  }
}

/**
 * 解析 PTY 会话的 provider：显式 `provider` 字段优先，其次按命令前缀识别；
 * 都识别不出时回落到 Claude，与旧版客户端行为保持一致。
 */
function resolveProviderForCommand(provider: unknown, command: string): SessionProvider {
  if (isSessionProvider(provider)) return provider;
  return inferProviderFromCommand(command) ?? "claude";
}

// ── Startup error handling ──

process.on("uncaughtException", (err) => {
  wandError("服务器异常", err.message, "请检查配置是否正确，或尝试重启服务。");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
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

  const app = express();
  let shuttingDown = false;
  const testMode = process.env.WAND_TEST_MODE === "1";
  app.set("trust proxy", "loopback, 172.16.0.0/12");
  const storage = new WandStorage(resolveDatabasePath(configPath));
  const runtimeConfig = new RuntimeConfigState(config);
  const openRouter = new OpenRouterFreeModelsService(storage, options.openRouterFetch);
  const speechPolisher = new SpeechPolisherService({ config, free: openRouter,
    employee: () => storage.getSystemSiliconEmployee(SPEECH_POLISHER_KEY) });
  const authService = new AuthService(storage);
  const settingsAccess = new SettingsWebAccess();
  const decisions = new DecisionService(config.localDecision);
  const decisionExpert = new DecisionExpertService({ local: decisions, free: openRouter, config,
    employee: () => storage.getSystemSiliconEmployee(DECISION_EXPERT_KEY) });
  // 默认模型优先读存储（UI 改设置后实时生效），未设置时由 getPreference 回落到 config。
  const getCurrentDefaultModels = (): { claude: string; codex: string; opencode: string; grok: string; qoder: string; pi: string; gemini: string } => ({
    claude: storage.getPreference("pref:defaultModel", config.defaultModel ?? ""),
    codex: storage.getPreference("pref:defaultCodexModel", config.defaultCodexModel ?? ""),
    opencode: storage.getPreference("pref:defaultOpenCodeModel", config.defaultOpenCodeModel ?? ""),
    grok: storage.getPreference("pref:defaultGrokModel", config.defaultGrokModel ?? ""),
    qoder: storage.getPreference("pref:defaultQoderModel", config.defaultQoderModel ?? ""),
    pi: storage.getPreference("pref:defaultPiModel", config.defaultPiModel ?? ""),
    gemini: storage.getPreference("pref:defaultGeminiModel", config.defaultGeminiModel ?? ""),
  });

  const getModelRefreshOptions = (): ModelRefreshOptions => {
    const injected = options.modelRefreshOptions?.() ?? {};
    const currentDefaults = getCurrentDefaultModels();
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
  const speech = new SpeechService(storage, configDir);
  const localModels = new LocalModelSetupService({ configDir, speech, decisions,
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
  const daemonAdmission = new DaemonAdmission();
  const terminalHost = daemonAdmission.terminal(ptyHosts.host);
  let decisionRuntime: DecisionRuntimeAccess | null = null;
  let autoAssignEvaluate: DecisionRuntimeAccess["evaluate"];
  const processes = new ProcessManager(config, storage, configDir, terminalHost,
    { resolveDecisionEvaluate: () => autoAssignEvaluate });
  const structuredLogger = new SessionLogger(configDir, config.shortcutLogMaxBytes);
  // Production startup provides a daemon-backed host for structured CLI runs
  // even when Render owns every PTY. In-process hosts are for test injection.
  const legacyStructuredHost = ptyHosts.legacyHost
    ?? (ptyHosts.host instanceof TerminalDaemonClient ? ptyHosts.host : null);
  const structuredHosts = await createUpgradeAwareStructuredHost(
    configPath, legacyStructuredHost, config.structured?.processHost,
  );
  const structuredSessions = new StructuredSessionManager(
    storage, config, structuredLogger, {},
    structuredHosts.host ? daemonAdmission.structured(structuredHosts.host) : undefined, () => decisionRuntime, openRouter,
    () => autoAssignEvaluate,
  );
  // core harness 预热：只读本机 Pi 认证与模型目录，不联网。失败不影响启动，
  // 但要在开始接输入前得到确定结论，否则首轮引擎裁决会因缓存未就绪而退回 CLI。
  const coreHarnessStatus = await warmCoreHarness(config.harness);
  if (coreHarnessStatus) {
    console.log(coreHarnessStatus.available
      ? `[wand] core harness 可用（Pi provider ${coreHarnessStatus.providerCount} 个、模型 ${coreHarnessStatus.modelCount} 个，agentDir ${coreHarnessStatus.agentDir}）；pi 结构化会话将使用进程内引擎。`
      : `[wand] core harness 不可用，pi 结构化会话回退 CLI：${coreHarnessStatus.reason}`);
  }
  const sessionRegistry = new SessionRegistry(processes, structuredSessions, storage);
  const sessionCompletions = new SessionCompletionTracker(storage, (id) => sessionRegistry.get(id));
  const missions = new Missions(storage, structuredSessions, sessionRegistry);
  // 任务保留的立即扫描也晚绑定：设置路由先注册，WebSocket 和会话表稍后才就绪。
  let runTaskRetentionSweep = (): RetentionResult => ({
    archivedSessions: 0, purgedSessions: 0, archivedTasks: 0, purgedTasks: 0, purgedTeamRuns: 0,
  });
  // wsManager 在后面才建：团队运行的变更通知经由这个转发口，接好之前静默丢弃。
  let notifyAiTeamRun = (_data:
    | { kind: "ai-team-run"; runId: string; taskId: string }
    | { kind: "ai-team-definition"; teamId: string }
    | { kind: "silicon-employee-definition"; employeeId: string }): void => {};
  // 运行中步骤的 live 文本推送（§4.9），同样走系统通知，接好之前静默丢弃。
  let notifyAiTeamRunLive = (_update: AiTeamLiveUpdate): void => {};
  let notifyConversationSession = (_update: ConversationSessionUpdate): void => {};
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
      gemini: "geminiModels",
    } as const)[provider];
    return cache[key].map((entry) => entry.id);
  };
  let conversations: ConversationService | null = null;
  const aiTeams = createAiTeamRunner({
    storage, config, structured: structuredSessions, processes, sessions: sessionRegistry,
    selfAuthor: () => userAuthor(config.userProfile),
    notify: (run) => {
      conversations?.importRun(run);
      notifyAiTeamRun({ kind: "ai-team-run", runId: run.id, taskId: run.taskId });
    },
    notifyLive: (update) => notifyAiTeamRunLive(update),
    models: aiTeamModelIds,
    chatHistoryTurns: id => conversations?.history(id) ?? [],
    // 成员名单里的模型名：`default` 哨兵换成服务端为该 CLI 配置的默认模型。
    defaultModelOf: (provider) => getDefaultModelForProvider(config, provider),
  });
  const conversationService = new ConversationService({ storage, config, structured: structuredSessions, runner: aiTeams,
    notifySession: update => notifyConversationSession(update), deleteSession: id => { sessionRegistry.deleteWithProviderHistory(id); } });
  conversations = conversationService;
  conversationService.migrateExistingChats();
  for (const prefix of [CONVERSATION_RELAY_PREFIX, AI_TEAM_CHAT_PREFIX]) {
    structuredSessions.registerRelay(prefix, (sessionId, input) => forwardConversationRelay(conversationService, sessionId, input));
  }
  const updateState = new ServerUpdateState();
  const daemonMaintenance = new DaemonMaintenance({
    targets: testMode ? [] : await createDaemonMaintenanceTargets(configPath, ptyHosts, structuredHosts.rustClient, config.render?.binaryPath),
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
    log: (error) => wandError("底层组件自动更新暂缓，将稍后重试", getErrorMessage(error)),
  });
  const getUpdateChannel = (): "stable" | "beta" =>
    normalizeUpdateChannel(storage.getConfigValue("updateChannel"));
  let disconnectAuthenticatedSockets = (): void => {};
  const refreshProviderCliUpdates = async (): Promise<{ items: ProviderCliUpdateStatus[]; checkedAt: string }> => {
    return refreshProviderCliUpdateState(updateState, config);
  };
  const useHttps = config.https === true;
  const protocol = useHttps ? "https" : "http";
  const requireAuth = buildRequireAuth(useHttps, storage, config, authService, settingsAccess);
  const requireAdmin = buildRequireScope("admin");
  const requireSessions = buildRequireScope("sessions");
  const requireFiles = buildRequireScope("files");
  const requirePasswordVault = buildRequireScope("password-vault");
  // Local preview traffic may contain arbitrary POST bodies. Mounting it before
  // Express body parsers keeps uploads, SSE and non-JSON requests streamable.
  registerLocalPreviewRoutes(app, { requireAuth, requireFiles });

  // Route-specific parsers must run before the global parser. Once body-parser
  // has consumed a request, a later express.json() cannot tighten or widen it.
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
  app.use((req, res, next) => {
    const origin = firstHeaderValue(req.headers.origin);
    if (origin && isBrowserExtensionOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS" && origin && isBrowserExtensionOrigin(origin)) {
      res.status(204).end();
      return;
    }
    next();
  });

  const requestedHash = (req: Request): string | undefined =>
    typeof req.query.v === "string" ? req.query.v : undefined;
  const setAssetCache = (req: Request, res: Response, hash: string, visibility: "public" | "private"): void => {
    // Never cache new bytes under an old URL after a package replacement. An old
    // process can still serve its embedded version; a new process serves current
    // bytes without caching the mismatch so an in-flight page remains usable.
    res.setHeader("Cache-Control", requestedHash(req) === hash
      ? `${visibility}, max-age=31536000, immutable`
      : "no-store");
  };
  const sendEmbeddedVendorAsset = (assetPath: EmbeddedVendorAssetPath, req: Request, res: Response): void => {
    const asset = EMBEDDED_WEB_ASSETS.vendor[assetPath];
    setAssetCache(req, res, asset.hash, "public");
    res.type(asset.contentType).send(asset.content);
  };
  app.get("/vendor/xterm/xterm.bundle.js", (req, res) => sendEmbeddedVendorAsset("/vendor/xterm/xterm.bundle.js", req, res));
  app.get("/vendor/xterm/xterm.css", (req, res) => sendEmbeddedVendorAsset("/vendor/xterm/xterm.css", req, res));
  app.get("/vendor/qrcode/qrcode.bundle.js", (req, res) => sendEmbeddedVendorAsset("/vendor/qrcode/qrcode.bundle.js", req, res));
  app.get("/assets/app.css", (req, res) => {
    const asset = getStylesAsset(requestedHash(req));
    setAssetCache(req, res, asset.hash, "public");
    res.type("text/css").send(asset.content);
  });
  app.get("/assets/app.js", (req, res) => {
    const asset = getScriptAsset(configPath, requestedHash(req));
    setAssetCache(req, res, asset.hash, "private");
    res.type("application/javascript").send(asset.content);
  });
  app.get("/assets/ai-teams.js", (req, res) => {
    const chunk = getAiTeamsChunk(requestedHash(req));
    setAssetCache(req, res, chunk.hash, "public");
    res.type("application/javascript").send(chunk.content);
  });

  // ── Web UI endpoints ──

  app.get(["/", "/settings"], (req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.type("html").send(renderApp(configPath, /^\/settings\/?$/.test(req.path) ? "settings" : "console",
      req.query.client === "app" ? "client" : "browser"));
  });

  app.get("/api/structured-chat-avatar/:role", requireAuth, asyncRoute(async (req, res) => {
    const role = req.params.role === "user" || req.params.role === "assistant"
      ? req.params.role
      : null;
    if (!role) {
      res.status(404).end();
      return;
    }

    const resolvedPath = resolveStructuredChatAvatarPath(configPath, config, role);
    if (!resolvedPath) {
      res.status(404).end();
      return;
    }

    try {
      const fileStat = await stat(resolvedPath);
      if (!fileStat.isFile()) {
        res.status(404).end();
        return;
      }

      const contentType = AVATAR_CONTENT_TYPES[path.extname(resolvedPath).toLowerCase()];
      if (!contentType) {
        res.status(415).json({ error: "不支持的头像格式。" });
        return;
      }

      res.setHeader("X-Content-Type-Options", "nosniff");
      res.type(contentType).sendFile(resolvedPath);
    } catch {
      res.status(404).end();
    }
  }));

  // ── Auth routes ──

  app.post("/api/login", (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    const { password, appToken, client } = req.body as { password?: string; appToken?: string; client?: string };
    const effectivePassword = getEffectivePassword(storage, config);

    // App token login is intentionally restricted even though the token remains
    // password-derived for compatibility with existing connect codes.
    // A stale token gets 401 without feeding the counter: the client cannot fix it by
    // retrying, and one device holding one used to lock out every user behind the same
    // reverse proxy IP. An active lock still gates unverified attempts.
    let principal: AuthPrincipal | null = null;
    if (appToken) {
      try {
        if (verifyAppToken(appToken, effectivePassword, config.appSecret ?? "")) {
          principal = { ...CONNECTED_APP_PRINCIPAL, scopes: [...CONNECTED_APP_PRINCIPAL.scopes] };
        }
      } catch {
        principal = null;
      }
    }

    if (!principal) {
      const lock = checkPasswordRateLimit(clientIp);
      if (lock) {
        const minutes = Math.max(1, Math.ceil(lock.retryAfter / 60));
        res.setHeader("Retry-After", String(lock.retryAfter));
        res
          .status(429)
          .json({ error: `登录尝试次数过多，请在约 ${minutes} 分钟后再试。`, retryAfter: lock.retryAfter });
        return;
      }
    }

    if (!principal) {
      if (password !== effectivePassword) {
        if (!appToken) recordFailedPassword(clientIp);
        res.status(401).json({ error: "密码错误，请重试。" });
        return;
      }
      principal = { ...BROWSER_ADMIN_PRINCIPAL, scopes: [...BROWSER_ADMIN_PRINCIPAL.scopes] };
    }

    resetPasswordRateLimit(clientIp);
    const token = authService.createSession(principal);
    const cookieOpts = {
      httpOnly: true,
      sameSite: "strict" as const,
      path: "/",
      maxAge: 1000 * 60 * 60 * 12,
    };
    // 主 cookie：按 scheme 分名字，避免被旧的同名 Secure cookie 阻挡覆盖。
    // 兼容 cookie `wand_session`：老 macOS APP（WandAuth.swift 写死了找 `wand_session`）需要这份才能登录。
    //   - HTTPS 模式：legacy 也带 Secure，浏览器与 APP 都能用
    //   - HTTP 模式：legacy 不带 Secure。浏览器场景下若之前留有同名 Secure cookie 会被 Strict Secure
    //     Cookies 拦截（无害噪音，主 cookie `wand_session_local` 兜得住）；APP 走 native cookie API
    //     不受这条策略约束，能正确拿到
    if (useHttps) {
      res.cookie(SESSION_COOKIE_HTTPS, token, { ...cookieOpts, secure: true });
      res.cookie(SESSION_COOKIE_LEGACY, token, { ...cookieOpts, secure: true });
    } else {
      res.cookie(SESSION_COOKIE_HTTP, token, { ...cookieOpts, secure: false });
      res.cookie(SESSION_COOKIE_LEGACY, token, { ...cookieOpts, secure: false });
    }
    res.json({
      ok: true,
      principal,
      ...(client === "browser-extension"
        ? appTokenLoginPayload(req, config, useHttps, getEffectivePassword(storage, config))
        : {}),
    });
  });

  app.post("/api/logout", (req, res) => {
    authService.revokeSession(readSessionCookie(req, useHttps));
    // 全部名字都清一遍，避免遗留 cookie 在下次同源访问时被回放。
    for (const name of [SESSION_COOKIE_HTTPS, SESSION_COOKIE_HTTP, SESSION_COOKIE_LEGACY]) {
      res.clearCookie(name, { path: "/" });
    }
    res.json({ ok: true });
  });

  app.post("/api/set-password", requireAuth, requireAdmin, (req, res) => {
    const { password } = req.body as { password?: string };
    if (!password || password.length < 6) {
      res.status(400).json({ error: "密码长度至少为 6 个字符。" });
      return;
    }
    storage.setPassword(password);
    authService.revokeAllSessions();
    disconnectAuthenticatedSockets();
    for (const name of [SESSION_COOKIE_HTTPS, SESSION_COOKIE_HTTP, SESSION_COOKIE_LEGACY]) {
      res.clearCookie(name, { path: "/" });
    }
    res.json({ ok: true, reauthenticationRequired: true });
  });

  // ── Android APK update & download (no auth required) ──

  registerPublicUpdateRoutes(app, distributionManager, config.publicOrigin);

  // Public probe so the unauthenticated browser does not log a 401 on /api/config
  app.get("/api/session-check", (req, res) => {
    res.json({ authed: authService.validateSession(readSessionCookie(req, useHttps)) });
  });

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
      const principal = requestPrincipals.get(req);
      return !!principal && principalHasScope(principal, "admin");
    },
    log: error => wandError("底层组件强制更新未完成", getErrorMessage(error)) });

  // Connected apps receive only the route families used by native clients and
  // the browser extension. Browser-admin sessions implicitly satisfy all scopes.
  app.use([
    "/api/config",
    "/api/models",
    "/api/sessions",
    "/api/session-list",
    "/api/session-directories",
    "/api/structured-sessions",
    "/api/conversations",
    "/api/commands",
    "/api/user-memory",
    "/api/claude-history",
    "/api/codex-history",
    "/api/opencode-history",
    "/api/qoder-history",
    "/api/grok-history",
    "/api/pi-history",
    "/api/claude-sessions",
    "/api/codex-sessions",
    "/api/opencode-sessions",
    "/api/qoder-sessions",
    "/api/grok-sessions",
    "/api/pi-sessions",
    "/api/optimize-prompt",
    "/api/inbox",
    "/api/missions",
    "/api/workspaces",
    "/api/workspace-tasks",
  ], requireSessions);
  app.use([
    "/api/directory",
    "/api/folders",
    "/api/path-suggestions",
    "/api/recent-paths",
    "/api/file-preview",
    "/api/file-raw",
    "/api/file-write",
    "/api/file-create",
    "/api/dir-create",
    "/api/file-rename",
    "/api/file-delete",
    "/api/quick-paths",
    "/api/validate-path",
    "/api/file-search",
    "/api/local-file",
  ], requireFiles);
  app.use("/api/browser-extension", requirePasswordVault);
  app.use("/api/silicon-employees/:employeeId/knowledge", requireSessions);
  app.use(userMemoryOperationLog(storage));
  const userMemory = new UserMemoryService({
    storage, config,
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
    const principal = requestPrincipals.get(req);
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
      updateAvailable: cachedUpdateInfo?.updateAvailable ?? false,
      latestVersion: cachedUpdateInfo?.latest ?? null,
      updateChannel: getUpdateChannel(),
      currentVersion: DISPLAY_VERSION,
      packageVersion: PKG_VERSION,
      canManageSettings: !!principal && principalHasScope(principal, "admin"),
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
    getCachedUpdateInfo: () => cachedUpdateInfo,
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
  registerTaskRoutes(app, { storage, sessions: sessionRegistry, structured: structuredSessions, processes, config, aiTeams });
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
    notifyEmployeeChanged: (employeeId) => notifyAiTeamRun({ kind: "silicon-employee-definition", employeeId }),
  });
  registerAttentionRoutes(app, { sessions: sessionRegistry, runner: aiTeams });
  registerConversationRoutes(app, conversationService);

  registerAdminUpdateRoutes(app, {
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
    emitSystemNotification: (data) => {
      wsManager.emitEvent({ type: "notification", sessionId: "__system__", data });
    },
  });

  // ── Global npm install (with leftover cleanup + ENOTEMPTY fallback) ──
  // 把所有恢复逻辑下沉到 ./npm-update-utils，TUI 和 server 共用，确保自动更新、
  // /api/update、tui installUpdate 三处行为一致。

  async function npmInstallGlobal(pkg: string, timeoutMs: number): Promise<void> {
    await installPackageGloballyAsync(pkg, timeoutMs, (line) => {
      process.stdout.write(`${line}\n`);
    });
  }

  registerSessionRoutes(app, processes, structuredSessions, storage, config.defaultMode, config, sessionRegistry, (cwd) => {
    recordRecentPath(storage, cwd);
  }, (event) => wsManager.emitEvent(event), decisionExpert);
  registerClaudeHistoryRoutes(app, processes, storage);
  registerWorkspaceRoutes(app, storage, sessionRegistry, { config });
  registerMissionRoutes(app, missions);
  registerUploadRoutes(app, sessionRegistry);
  registerSpeechRoutes(app, { speech, requireSessions, requireAdmin, polisher: speechPolisher });
  registerLocalModelRoutes(app, { models: localModels, requireSessions, requireAdmin });

  app.post("/api/optimize-prompt", asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as { text?: string; sessionId?: string };
    const text = typeof body.text === "string" ? body.text : "";
    let cwd: string | undefined;
    let ai: ReturnType<typeof resolveSystemAiContext> | undefined;
    if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
      const snapshot = sessionRegistry.getLatest(body.sessionId);
      if (snapshot?.cwd) cwd = snapshot.cwd;
      if (snapshot) ai = resolveSystemAiContext(snapshot, config, storage.getSystemSiliconEmployee());
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
      ai = resolveSystemAiContext(defaultSession, config, storage.getSystemSiliconEmployee());
    }
    try {
      const optimized = await optimizePrompt(text, config.language ?? "", cwd, ai);
      res.json({ optimized });
    } catch (error) {
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

  app.post("/api/commands", asyncRoute(async (req, res) => {
    const body = req.body as CommandRequest & { sessionSource?: unknown; automationId?: unknown;
      employeeId?: unknown; teamId?: unknown; subject?: { type?: unknown; id?: unknown } };
    if (body.employeeId !== undefined || body.teamId !== undefined
      || (body.subject !== undefined && body.subject?.type !== "cli")) {
      res.status(400).json({ error: "PTY 只能选择 CLI 工具。" });
      return;
    }
    const interactiveShell = body.shell === true;
    if (!interactiveShell && !body.command?.trim()) {
      res.status(400).json({ error: "请输入要执行的命令。" });
      return;
    }
    if (body.mode !== undefined && !isExecutionMode(body.mode)) {
      res.status(400).json({ error: `无效执行模式: ${String(body.mode)}` });
      return;
    }
    const initialInput = body.initialInput?.trim();
    try {
      const origin = parseSessionCreationOrigin(body);
      const rawModel = typeof body.model === "string" ? body.model.trim() : "";
      const rawCommand = body.command?.trim() ?? "";
      const provider: SessionProvider | undefined = interactiveShell
        ? undefined
        : resolveProviderForCommand(body.provider, rawCommand);
      // Older clients used the provider id as the PTY command. Qoder's executable
      // is named qodercli, so keep those clients working while preserving custom commands.
      const command = provider === "qoder" && rawCommand === "qoder"
        ? "qodercli"
        : rawCommand;
      const effectiveModel = provider
        ? rawModel || defaultModelGroupSelector(config.modelGroups, provider, getDefaultModelForProvider(config, provider)) || getDefaultModelForProvider(config, provider) || undefined
        : undefined;
      const reqCols = typeof body.cols === "number" && Number.isFinite(body.cols) ? body.cols : undefined;
      const reqRows = typeof body.rows === "number" && Number.isFinite(body.rows) ? body.rows : undefined;
      const sessionCwd = resolveSessionCwd(body.cwd, config.defaultCwd);
      const workspaceId = resolveWorkspaceIdForNewSession(storage, sessionCwd, body.workspaceId);
      const role = !interactiveShell && !body.systemPrompt?.trim() && origin.sessionSource === "interactive"
        && (isSessionProvider(body.provider) || inferProviderFromCommand(command))
        ? defaultRoleForCli(storage, provider) : null;
      const snapshot = await (interactiveShell
        ? processes.startShell(sessionCwd, body.mode ?? "default", {
            worktreeEnabled: body.worktreeEnabled === true,
            cols: reqCols,
            rows: reqRows,
            workspaceId,
            workspaceTaskId: body.workspaceTaskId,
            ...origin,
          })
        : processes.start(
            command,
            sessionCwd,
            body.mode ?? config.defaultMode,
            initialInput || undefined,
            {
              worktreeEnabled: body.worktreeEnabled === true,
              provider,
              model: effectiveModel,
              cols: reqCols,
              rows: reqRows,
              thinkingEffort: body.thinkingEffort ?? config.defaultThinkingEffort,
              systemPrompt: body.systemPrompt?.trim() || role?.prompt,
              employeeId: role?.id,
              employeeName: role?.name,
              employeeAvatar: role?.avatar,
              workspaceId,
              workspaceTaskId: body.workspaceTaskId,
              ...origin,
            }
          ));
      recordRecentPath(storage, snapshot.cwd);
      const compactTools = req.get("X-Wand-Tool-Projection") === "compact"
        || req.query.compactTools === "1";
      if (compactTools) {
        const messages = compactToolMessagesForTransport(
          enrichStructuredMessages(snapshot.messages ?? [], snapshot.id),
        );
        const windowed = windowMessagesForTransport(messages, config.cardDefaults ?? {});
        res.status(201).json(toSessionDetailDTO(snapshot, windowed));
      } else {
        res.status(201).json(toSessionDetailDTO(snapshot));
      }
    } catch (error) {
      sendRouteError(res, error, "无法启动命令。请检查命令是否安装。");
    }
  }));

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
    wandError("WebSocket 异常", err.message);
  });

  // Wire process events to WebSocket broadcast
  processes.on("process", (event: ProcessEvent) => {
    sessionCompletions.ingest(event);
    missions.ingest(event);
    aiTeams.ingest(event);
    wsManager.emitEvent(event);
  });
  structuredSessions.setEventEmitter((event) => {
    conversationService.ingestSessionEvent(event);
    sessionCompletions.ingest(event);
    missions.ingest(event);
    aiTeams.ingest(event);
    wsManager.emitEvent(event);
  });
  notifyAiTeamRun = (data) => {
    wsManager.emitEvent({ type: "notification", sessionId: "__system__", data });
  };
  notifyAiTeamRunLive = (update) => {
    wsManager.emitEvent({
      type: "notification", sessionId: "__system__", data: { kind: "ai-team-step-live", ...update },
    });
  };
  notifyConversationSession = update => {
    wsManager.emitEvent({ type: "notification", sessionId: "__system__", data: { kind: "conversation-session-preview", ...update } });
  };
  // Re-attach structured CLI runs that kept going inside terminald while the
  // previous web process was down; fire-and-forget, failures are logged inside.
  void structuredSessions.recoverDetachedRuns();
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
      // Do not dispose tools/services or arm the force-exit timer while a native
      // turn is still running. The same barrier covers manual and auto restart.
      const plan = computeRelaunch({
        serviceInstalled: safeServiceInstalled(),
        globalCli: resolveGlobalWandCli(),
      });
      const forceExitTimer = setTimeout(() => process.exit(0), 5000);
      forceExitTimer.unref?.();
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
    const cleanupFailedListen = (): void => {
      shuttingDown = true;
      decisions.dispose();
      openRouter.dispose();
      try { processes.dispose(); } catch { /* noop */ }
      conversationService.dispose();
      localModels.dispose();
      speech.dispose();
      speechPolisher.dispose();
      try { structuredSessions.dispose(); } catch { /* noop */ }
      aiTeams.dispose();
      try { structuredHosts.rustClient?.disconnect(); } catch { /* noop */ }
      try { structuredLogger.dispose(); } catch { /* noop */ }
      try { wsManager.dispose(); } catch { /* noop */ }
      try { wss.close(); } catch { /* noop */ }
      try { server.close(); } catch { /* noop */ }
      authService.dispose();
      try { storage.close(); } catch { /* noop */ }
    };
    const onListenError = (err: NodeJS.ErrnoException): void => {
      server.off("error", onListenError);
      cleanupFailedListen();
      if (err.code === "EADDRINUSE") {
        reject(new PortInUseError(config.port, config.host));
        return;
      }
      reject(err);
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
  if (!testMode) userMemory.start();

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

  // 会话仍按固定 7 天归档再清理；任务窗口每次扫描读取当前设置。
  // 保存任务保留设置后走同一条扫描，不等下一小时。
  const retentionDeps = {
    storage,
    sessions: sessionRegistry,
    taskRetention: () => config.taskRetention,
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
  let retentionTimer: NodeJS.Timeout | null = null;
  if (!testMode) {
    retentionTimer = startRetentionTimer(retentionDeps, 60 * 60 * 1000, sweepRetention);
  }

  // Express 4 does not forward rejected route promises automatically. Every
  // async route above is wrapped with asyncRoute, and this final middleware
  // keeps parser, synchronous middleware, and async failures JSON-shaped.
  app.use(jsonErrorHandler);

  // Daemon-only maintenance does not restart Server, depend on npm auto-update
  // preferences, or stop a live execution. Startup recovery is already attached.
  if (!testMode) daemonMaintenance.start();

  // ── Auto-update logic ──

  async function performAutoUpdate(): Promise<void> {
    if (shuttingDown) return;
    const channel = getUpdateChannel();
    const info = await checkLatestPackageVersion(channel, true);
    if (shuttingDown) return;
    cachedUpdateInfo = info;
    if (!info.latest || !info.updateAvailable) return;

    const autoEnabled = storage.getConfigValue("autoUpdateWeb") === "true";
    if (!autoEnabled) {
      // Not auto-updating, just notify
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

    const servicePreflight = checkManagedServiceUpdatePreflight();
    if (!servicePreflight.ok) {
      process.stdout.write(`[wand] 自动更新已取消: ${servicePreflight.message}\n`);
      wsManager.emitEvent({
        type: "notification",
        sessionId: "__system__",
        data: {
          kind: "auto-update-failed",
          current: info.current,
          latest: info.latest,
          error: servicePreflight.message,
        },
      });
      return;
    }

    // Auto-update: install and restart
    process.stdout.write(
      `[wand] 自动更新：正在从 ${info.current} 更新到 ${info.latest}...\n`
    );
    wsManager.emitEvent({
      type: "notification",
      sessionId: "__system__",
      data: {
        kind: "auto-update-start",
        current: info.current,
        latest: info.latest,
        previousInstanceId: SERVER_INSTANCE_ID,
      },
    });

    try {
      await npmInstallGlobal(info.installSpec, 120000);
      if (shuttingDown) return;
      // 镜像 install.sh：装完用全局安装刷新服务 unit（ExecStart/PATH），重启才会跑到新版。
      const repair = repairServiceUnitAfterUpdate(configPath);
      if (repair.scope) process.stdout.write(`[wand] ${repair.message}\n`);
      process.stdout.write(`[wand] 自动更新完成，正在重启...\n`);
      wsManager.emitEvent({
        type: "notification",
        sessionId: "__system__",
        data: {
          kind: "auto-update-restart",
          current: info.current,
          latest: info.latest,
          previousInstanceId: SERVER_INSTANCE_ID,
        },
      });
      // Manual and automatic restarts share the same live admission barrier.
      const restartTimer = setTimeout(() => relaunchAfterShutdown(), 1000);
      restartTimer.unref?.();
    } catch (error) {
      const msg = getErrorMessage(error, "未知错误");
      process.stdout.write(`[wand] 自动更新失败: ${msg}\n`);
      // 失败不重启、保留旧版；通知前端，避免静默。
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
        process.stdout.write(`[wand] CLI 自动更新 ${result.ok ? "完成" : "失败"}: ${result.message}\n`);
      }
      void modelCatalog.refresh().catch(() => {});
    } catch (error) {
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
      await daemonMaintenance.stop();
      decisions.dispose();
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
      speech.dispose();
      speechPolisher.dispose();
      try { structuredSessions.dispose(); } catch { /* best-effort shutdown */ }
      aiTeams.dispose();
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
        try { storage.close(); } catch { /* ignore */ }
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
