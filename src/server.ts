import crypto from "node:crypto";
import compression from "compression";
import express, { NextFunction, Request, Response } from "express";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { spawn } from "node:child_process";
import os from "node:os";
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
import { ensureCertificates } from "./cert.js";
import { buildChildEnv } from "./env-utils.js";
import {
  getDefaultModelForProvider,
  getProviderDefaultModels,
  isExecutionMode,
  PREFERENCE_KEYS,
  resolveConfigDir,
  saveConfig,
  writePreferenceToStorage,
} from "./config.js";
import { getCachedModels, ModelRefreshOptions, refreshModels } from "./models.js";
import { ProcessManager, ProcessEvent } from "./process-manager.js";
import { SessionLogger } from "./session-logger.js";
import { SessionRegistry } from "./session-registry.js";
import { StructuredSessionManager } from "./structured-session-manager.js";
import { recordRecentPath, registerFileRoutes, streamFileWithRange } from "./server-file-routes.js";
import { registerSettingsRoutes } from "./server-settings-routes.js";
import {
  refreshProviderCliUpdateState,
  registerAdminUpdateRoutes,
  registerPublicUpdateRoutes,
  ServerUpdateState,
} from "./server-update-routes.js";
import { parseSessionCreationOrigin, registerClaudeHistoryRoutes, registerSessionRoutes } from "./server-session-routes.js";
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
import { DEPLOYMENT_CONFIG_KEYS, RuntimeConfigState } from "./runtime-config.js";
import { isServiceInstalled } from "./tui/commands.js";
import {
  canUseDetachedUpdateHelper,
  checkManagedServiceUpdatePreflight,
  startDetachedUpdateHelper,
} from "./update-helper.js";
import { registerUploadRoutes } from "./upload-routes.js";
import { optimizePrompt, PromptOptimizeError } from "./prompt-optimizer.js";
import { resolveDatabasePath, WandStorage, type AuthPrincipal, type AuthScope } from "./storage.js";
import {
  DEFAULT_BROWSER_EXTENSION_BASE_URL,
  buildPasswordSecurityReport,
  generatePassword,
  generateTotpCode,
  normalizePasswordItemType,
  type PasswordVaultItemFilter,
  type PasswordVaultItemInput,
} from "./password-manager.js";
import { deepRepairRuntimePath, formatPathRepairSummary, repairRuntimePath, type PathRepairResult } from "./path-repair.js";
import { DistributionManager } from "./distribution-manager.js";
import { isLogBusActive, wandTuiLog } from "./tui/log-bus.js";
import { EMBEDDED_WEB_ASSETS, type EmbeddedVendorAssetPath } from "./web-ui/embedded-assets.js";
import { renderApp } from "./web-ui/index.js";
import { WsBroadcastManager } from "./ws-broadcast.js";
import { checkRateLimit, recordFailedLogin, resetRateLimit } from "./middleware/rate-limit.js";
import { isBlockedFolderPath, normalizeFolderPath } from "./middleware/path-safety.js";
import {
  checkProviderCliUpdates,
  updateProviderClis,
  verifyProviderCliUpdateResults,
  type ProviderCliId,
  type ProviderCliUpdateStatus,
} from "./provider-cli-updater.js";
import {
  CommandRequest,
  SessionProvider,
  StructuredChatPersonaConfig,
  WandConfig
} from "./types.js";

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
const PKG_NODE_REQ = PKG_JSON.engines?.node ?? ">=22.5.0";
const PKG_REPO_URL = "https://github.com/co0ontty/wand";

// ── Update check cache ──

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

interface WandBuildInfo {
  commit: string | null;
  builtAt: string | null;
  version: string | null;
  channel: string | null;
}

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

function isExternalAvatarSource(value: string): boolean {
  return /^(https?:|data:)/i.test(value);
}

function normalizePersonaName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizePersonaAvatar(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveStructuredChatPersona(
  config: WandConfig
): StructuredChatPersonaConfig | undefined {
  const persona = config.structuredChatPersona;
  if (!persona) return undefined;

  const userName = normalizePersonaName(persona.user?.name);
  const userAvatar = normalizePersonaAvatar(persona.user?.avatar);
  const assistantName = normalizePersonaName(persona.assistant?.name);
  const assistantAvatar = normalizePersonaAvatar(persona.assistant?.avatar);

  if (!userName && !userAvatar && !assistantName && !assistantAvatar) {
    return undefined;
  }

  return {
    user: userName || userAvatar ? { name: userName, avatar: userAvatar } : undefined,
    assistant: assistantName || assistantAvatar ? { name: assistantName, avatar: assistantAvatar } : undefined,
  };
}

function resolveStructuredChatAvatarPath(
  configPath: string,
  config: WandConfig,
  role: "user" | "assistant"
): string | null {
  const avatar = role === "user"
    ? config.structuredChatPersona?.user?.avatar
    : config.structuredChatPersona?.assistant?.avatar;
  if (!avatar || isExternalAvatarSource(avatar)) {
    return null;
  }
  const configDir = resolveConfigDir(configPath);
  return path.isAbsolute(avatar) ? avatar : path.resolve(configDir, avatar);
}

async function buildStructuredChatPersonaPayload(
  configPath: string,
  config: WandConfig
): Promise<StructuredChatPersonaConfig | undefined> {
  const persona = resolveStructuredChatPersona(config);
  if (!persona) return undefined;

  const buildRole = async (role: "user" | "assistant"): Promise<StructuredChatPersonaConfig["user"] | undefined> => {
    const roleConfig = role === "user" ? persona.user : persona.assistant;
    if (!roleConfig) return undefined;

    let avatar = roleConfig.avatar;
    if (avatar && !isExternalAvatarSource(avatar)) {
      const resolvedPath = resolveStructuredChatAvatarPath(configPath, config, role);
      if (!resolvedPath) {
        avatar = undefined;
      } else {
        try {
          const fileStat = await stat(resolvedPath);
          avatar = fileStat.isFile() ? `/api/structured-chat-avatar/${role}` : undefined;
        } catch {
          avatar = undefined;
        }
      }
    }

    if (!roleConfig.name && !avatar) return undefined;
    return {
      name: roleConfig.name,
      avatar,
    };
  };

  const [user, assistant] = await Promise.all([buildRole("user"), buildRole("assistant")]);
  if (!user && !assistant) return undefined;
  return { user, assistant };
}

// ── Auth helpers ──

const requestPrincipals = new WeakMap<Request, AuthPrincipal>();

function buildRequireAuth(useHttps: boolean, storage: WandStorage, config: WandConfig, authService: AuthService) {
  return function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const principal = authService.authenticateSession(readSessionCookie(req, useHttps))
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
  "defaultModels",
  "defaultThinkingEffort",
  "defaultProvider",
  "defaultSessionKind",
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

function authenticateBearerAppToken(req: Request, storage: WandStorage, config: WandConfig): AuthPrincipal | null {
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

function appTokenLoginPayload(storage: WandStorage, config: WandConfig): { appToken: string; serverUrl: string } {
  return {
    appToken: generateAppToken(getEffectivePassword(storage, config), config.appSecret ?? ""),
    serverUrl: DEFAULT_BROWSER_EXTENSION_BASE_URL,
  };
}

// ── App connection token helpers ──

function generateAppToken(password: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(password).digest("hex");
}

function verifyAppToken(token: string, password: string, secret: string): boolean {
  const expected = generateAppToken(password, secret);
  return crypto.timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"));
}

function encodeConnectCode(url: string, token: string): string {
  return Buffer.from(`${url}#${token}`).toString("base64");
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function firstHeaderListValue(value: string | string[] | undefined): string | undefined {
  return firstHeaderValue(value)?.split(",")[0]?.trim();
}

function unquoteHeaderValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getForwardedParam(req: Request, key: string): string | undefined {
  const forwarded = firstHeaderListValue(req.headers.forwarded);
  if (!forwarded) return undefined;
  const targetKey = key.toLowerCase();
  for (const part of forwarded.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx < 1) continue;
    const partKey = part.slice(0, eqIdx).trim().toLowerCase();
    if (partKey !== targetKey) continue;
    return unquoteHeaderValue(part.slice(eqIdx + 1));
  }
  return undefined;
}

function normalizePublicProtocol(value: string | undefined): "http" | "https" | undefined {
  const proto = value?.trim().toLowerCase();
  if (proto === "http" || proto === "https") return proto;
  return undefined;
}

function getPublicRequestProtocol(req: Request, fallback: "http" | "https"): "http" | "https" {
  return (
    normalizePublicProtocol(firstHeaderListValue(req.headers["x-forwarded-proto"]))
    ?? normalizePublicProtocol(getForwardedParam(req, "proto"))
    ?? (firstHeaderListValue(req.headers["x-forwarded-ssl"])?.toLowerCase() === "on" ? "https" : undefined)
    ?? (firstHeaderListValue(req.headers["x-forwarded-scheme"])?.toLowerCase() === "https" ? "https" : undefined)
    ?? fallback
  );
}

function getPublicRequestHost(req: Request, config: WandConfig): string {
  return (
    firstHeaderListValue(req.headers["x-forwarded-host"])
    ?? getForwardedParam(req, "host")
    ?? req.headers.host
    ?? `${config.host}:${config.port}`
  );
}

function firstQueryStringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstQueryStringValue(value[0]);
  return undefined;
}

function normalizePublicOrigin(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (!parsed.hostname || parsed.username || parsed.password) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function isBrowserExtensionOrigin(value: string | undefined): boolean {
  if (!value) return false;
  return /^chrome-extension:\/\/[a-z]{32}$/i.test(value)
    || /^moz-extension:\/\/[0-9a-f-]+$/i.test(value)
    || /^safari-web-extension:\/\//i.test(value);
}

function isPrivateIpv4(address: string): boolean {
  if (address.startsWith("10.") || address.startsWith("192.168.")) return true;
  const match = address.match(/^172\.(\d+)\./);
  return match ? Number(match[1]) >= 16 && Number(match[1]) <= 31 : false;
}

function preferredLanIpv4(): string | undefined {
  const candidates: Array<{ address: string; score: number }> = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = entry.family as unknown;
      if (entry.internal || (family !== "IPv4" && family !== 4)) continue;
      let score = isPrivateIpv4(entry.address) ? 10 : 0;
      if (/^(en|eth|wlan)\d+$/i.test(name)) score += 10;
      candidates.push({ address: entry.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
  return candidates[0]?.address;
}

/**
 * App 连接码用于另一台设备。设置页若从 localhost 打开，直接编码浏览器 origin
 * 会让客户端连接它自己；监听 0.0.0.0 时自动换成本机优先 LAN IPv4。
 */
function resolveAppConnectOrigin(origin: string, config: WandConfig): string {
  if (config.host !== "0.0.0.0") return origin;
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    const isLocalOnly = hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "[::1]"
      || hostname === "::1"
      || hostname === "0.0.0.0"
      || hostname === "[::]";
    if (!isLocalOnly) return parsed.origin;
    const lanIp = preferredLanIpv4();
    if (!lanIp) return parsed.origin;
    parsed.hostname = lanIp;
    return parsed.origin;
  } catch {
    return origin;
  }
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

export interface ServerUrl {
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
  options: { modelRefreshOptions?: () => Partial<ModelRefreshOptions> } = {},
): Promise<ServerHandle> {
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
  app.set("trust proxy", "loopback, 172.16.0.0/12");
  const storage = new WandStorage(resolveDatabasePath(configPath));
  const runtimeConfig = new RuntimeConfigState(config);
  const authService = new AuthService(storage);
  const getModelRefreshOptions = (): ModelRefreshOptions => {
    const injected = options.modelRefreshOptions?.() ?? {};
    return {
      storage,
      inheritEnv: config.inheritEnv !== false,
      apiKey: process.env.ANTHROPIC_API_KEY,
      ...injected,
      configuredClaudeModels: [
        getProviderDefaultModels(config).claude,
        config.commitCli === "claude" ? config.commitModel : undefined,
        ...(injected.configuredClaudeModels ?? []),
      ],
    };
  };
  const configDir = resolveConfigDir(configPath);
  const distributionManager = new DistributionManager({
    configDir,
    configPath,
    config,
    repositoryUrl: PKG_REPO_URL,
  });
  const processes = new ProcessManager(config, storage, configDir);
  const structuredLogger = new SessionLogger(configDir, config.shortcutLogMaxBytes);
  const structuredSessions = new StructuredSessionManager(storage, config, structuredLogger);
  const sessionRegistry = new SessionRegistry(processes, structuredSessions, storage);
  const updateState = new ServerUpdateState();
  const getUpdateChannel = (): "stable" | "beta" =>
    normalizeUpdateChannel(storage.getConfigValue("updateChannel"));
  let disconnectAuthenticatedSockets = (): void => {};
  const refreshProviderCliUpdates = async (): Promise<{ items: ProviderCliUpdateStatus[]; checkedAt: string }> => {
    return refreshProviderCliUpdateState(updateState, config);
  };
  const useHttps = config.https === true;
  const protocol = useHttps ? "https" : "http";
  const requireAuth = buildRequireAuth(useHttps, storage, config, authService);
  const requireAdmin = buildRequireScope("admin");
  const requireSessions = buildRequireScope("sessions");
  const requireFiles = buildRequireScope("files");
  const requirePasswordVault = buildRequireScope("password-vault");
  // Route-specific parsers must run before the global parser. Once body-parser
  // has consumed a request, a later express.json() cannot tighten or widen it.
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

  const sendEmbeddedVendorAsset = (assetPath: EmbeddedVendorAssetPath, _req: Request, res: Response): void => {
    const asset = EMBEDDED_WEB_ASSETS.vendor[assetPath];
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.type(asset.contentType).send(asset.content);
  };
  app.get("/vendor/wterm/wterm.bundle.js", (req, res) => sendEmbeddedVendorAsset("/vendor/wterm/wterm.bundle.js", req, res));
  app.get("/vendor/wterm/terminal.css", (req, res) => sendEmbeddedVendorAsset("/vendor/wterm/terminal.css", req, res));
  app.get("/vendor/qrcode/qrcode.bundle.js", (req, res) => sendEmbeddedVendorAsset("/vendor/qrcode/qrcode.bundle.js", req, res));

  // ── Web UI endpoints ──

  app.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.type("html").send(renderApp(configPath));
  });

  app.get("/api/structured-chat-avatar/:role", asyncRoute(async (req, res) => {
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

      const ext = path.extname(resolvedPath).toLowerCase();
      const contentType = ext === ".svg"
        ? "image/svg+xml"
        : ext === ".png"
          ? "image/png"
          : ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : ext === ".webp"
              ? "image/webp"
              : ext === ".gif"
                ? "image/gif"
                : ext === ".avif"
                  ? "image/avif"
                  : null;
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
    if (!checkRateLimit(clientIp)) {
      res.status(429).json({ error: "登录尝试次数过多，请在 15 分钟后再试。" });
      return;
    }

    const { password, appToken, client } = req.body as { password?: string; appToken?: string; client?: string };
    const effectivePassword = getEffectivePassword(storage, config);

    // App token login is intentionally restricted even though the token remains
    // password-derived for compatibility with existing connect codes.
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
      if (password !== effectivePassword) {
        recordFailedLogin(clientIp);
        res.status(401).json({ error: "密码错误，请重试。" });
        return;
      }
      principal = { ...BROWSER_ADMIN_PRINCIPAL, scopes: [...BROWSER_ADMIN_PRINCIPAL.scopes] };
    }

    resetRateLimit(clientIp);
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
      ...(client === "browser-extension" ? appTokenLoginPayload(storage, config) : {}),
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

  registerPublicUpdateRoutes(app, distributionManager);

  // Public probe so the unauthenticated browser does not log a 401 on /api/config
  app.get("/api/session-check", (req, res) => {
    res.json({ authed: authService.validateSession(readSessionCookie(req, useHttps)) });
  });

  app.use("/api", requireAuth);

  // Connected apps receive only the route families used by native clients and
  // the browser extension. Browser-admin sessions implicitly satisfy all scopes.
  app.use([
    "/api/config",
    "/api/models",
    "/api/sessions",
    "/api/structured-sessions",
    "/api/commands",
    "/api/claude-history",
    "/api/codex-history",
    "/api/claude-sessions",
    "/api/codex-sessions",
    "/api/optimize-prompt",
  ], requireSessions);
  app.use([
    "/api/directory",
    "/api/folders",
    "/api/path-suggestions",
    "/api/recent-paths",
    "/api/file-preview",
    "/api/file-raw",
    "/api/file-write",
  ], requireFiles);
  app.use("/api/browser-extension", requirePasswordVault);

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
      defaultMode: config.defaultMode,
      defaultCwd: config.defaultCwd,
      defaultModel: defaultModels.claude,
      defaultCodexModel: defaultModels.codex,
      defaultOpenCodeModel: defaultModels.opencode,
      defaultModels,
      defaultThinkingEffort: config.defaultThinkingEffort ?? "off",
      commandPresets: config.commandPresets,
      structuredRunner: config.structuredRunner ?? "cli",
      structuredRunners: [
        { label: "Claude Structured", runner: "claude-cli-print" },
        { label: "Codex Structured", runner: "codex-cli-exec" },
        { label: "OpenCode Structured", runner: "opencode-cli-run" },
        { label: "Grok Structured", runner: "grok-cli-headless" },
      ],
      structuredChatPersona,
      cardDefaults: config.cardDefaults,
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

  // ── Browser extension password vault endpoints ──

  app.get("/api/browser-extension/status", (_req, res) => {
    res.json({
      ok: true,
      serverUrl: DEFAULT_BROWSER_EXTENSION_BASE_URL,
      features: {
        loginAutofill: true,
        saveLogins: true,
        federatedLoginMemory: true,
        passwordGenerator: true,
        totp: true,
        cardsAndIdentities: true,
        vaults: true,
        securityReport: true,
        passkeys: "webauthn-proxy",
      },
    });
  });

  app.get("/api/browser-extension/vaults", (_req, res) => {
    res.json({ vaults: storage.listPasswordVaults() });
  });

  app.post("/api/browser-extension/vaults", (req, res) => {
    try {
      const vault = storage.createPasswordVault((req.body as { name?: unknown }).name);
      res.status(201).json({ vault });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法创建 vault。") });
    }
  });

  app.get("/api/browser-extension/items", (req, res) => {
    const filter: PasswordVaultItemFilter = {
      q: firstQueryStringValue(req.query.q),
      url: firstQueryStringValue(req.query.url),
      vaultId: firstQueryStringValue(req.query.vaultId),
      type: req.query.type ? normalizePasswordItemType(firstQueryStringValue(req.query.type)) : undefined,
      limit: req.query.limit ? Number(firstQueryStringValue(req.query.limit)) : undefined,
    };
    res.json({ items: storage.listPasswordItems(filter) });
  });

  app.post("/api/browser-extension/items", (req, res) => {
    try {
      const item = storage.createPasswordItem(req.body as PasswordVaultItemInput);
      res.status(201).json({ item });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法保存条目。") });
    }
  });

  app.get("/api/browser-extension/items/:id", (req, res) => {
    const item = storage.getPasswordItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: "条目不存在。" });
      return;
    }
    res.json({ item });
  });

  app.put("/api/browser-extension/items/:id", (req, res) => {
    try {
      const item = storage.updatePasswordItem(req.params.id, req.body as PasswordVaultItemInput);
      if (!item) {
        res.status(404).json({ error: "条目不存在。" });
        return;
      }
      res.json({ item });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法更新条目。") });
    }
  });

  app.delete("/api/browser-extension/items/:id", (req, res) => {
    if (!storage.deletePasswordItem(req.params.id)) {
      res.status(404).json({ error: "条目不存在。" });
      return;
    }
    res.json({ ok: true });
  });

  app.post("/api/browser-extension/items/:id/use", (req, res) => {
    const item = storage.touchPasswordItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: "条目不存在。" });
      return;
    }
    res.json({ item });
  });

  app.get("/api/browser-extension/generator/password", (req, res) => {
    res.json({
      password: generatePassword({
        length: Number(firstQueryStringValue(req.query.length)),
        digits: firstQueryStringValue(req.query.digits) !== "false",
        symbols: firstQueryStringValue(req.query.symbols) !== "false",
      }),
    });
  });

  app.post("/api/browser-extension/totp/preview", (req, res) => {
    try {
      const { secret, digits, period } = req.body as { secret?: string; digits?: number; period?: number };
      if (!secret) {
        res.status(400).json({ error: "缺少 TOTP secret。" });
        return;
      }
      res.json({
        code: generateTotpCode(secret, Date.now(), digits ?? 6, period ?? 30),
        period: period ?? 30,
      });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法生成 TOTP。") });
    }
  });

  app.get("/api/browser-extension/security-report", (_req, res) => {
    res.json({ report: buildPasswordSecurityReport(storage.listPasswordItems({ includeArchived: false, limit: 200 })) });
  });

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
    getModelRefreshOptions,
    resolveAppConnectCode: (req) => {
      const effectivePassword = getEffectivePassword(storage, config);
      const requestProtocol = getPublicRequestProtocol(req, useHttps ? "https" : "http");
      const requestHost = getPublicRequestHost(req, config);
      const browserOrigin = normalizePublicOrigin(firstQueryStringValue(req.query.origin));
      const serverUrl = resolveAppConnectOrigin(browserOrigin ?? `${requestProtocol}://${requestHost}`, config);
      const token = generateAppToken(effectivePassword, config.appSecret ?? "");
      return { code: encodeConnectCode(serverUrl, token), url: serverUrl };
    },
  });

  registerAdminUpdateRoutes(app, {
    storage,
    config,
    configPath,
    requireAdmin,
    state: updateState,
    getDistributionSettings,
    getModelRefreshOptions,
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
  });
  registerClaudeHistoryRoutes(app, processes, structuredSessions, storage, sessionRegistry);
  registerUploadRoutes(app, processes);

  app.post("/api/optimize-prompt", asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as { text?: string; sessionId?: string };
    const text = typeof body.text === "string" ? body.text : "";
    let cwd: string | undefined;
    if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
      const snap = storage.getSession(body.sessionId);
      if (snap?.cwd) cwd = snap.cwd;
    }
    try {
      const optimized = await optimizePrompt(text, config.language ?? "", cwd, config.systemAi);
      res.json({ optimized });
    } catch (error) {
      if (error instanceof PromptOptimizeError) {
        const status = error.code === "EMPTY_INPUT" || error.code === "INPUT_TOO_LONG" ? 400 : 500;
        res.status(status).json({ error: error.message, errorCode: error.code });
        return;
      }
      res.status(500).json({ error: getErrorMessage(error, "提示词优化失败。") });
    }
  }));

  registerFileRoutes(app, { storage, defaultCwd: config.defaultCwd });

  // ── Session control ──

  app.post("/api/commands", (req, res) => {
    const body = req.body as CommandRequest & { sessionSource?: unknown; automationId?: unknown };
    if (!body.command?.trim()) {
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
      const provider: SessionProvider = body.provider === "codex" || /^codex\b/.test(body.command.trim())
        ? "codex"
        : body.provider === "opencode" || /^opencode\b/.test(body.command.trim())
          ? "opencode"
        : body.provider === "grok" || /^grok\b/.test(body.command.trim())
          ? "grok"
          : "claude";
      const effectiveModel = rawModel || getDefaultModelForProvider(config, provider) || undefined;
      const reqCols = typeof body.cols === "number" && Number.isFinite(body.cols) ? body.cols : undefined;
      const reqRows = typeof body.rows === "number" && Number.isFinite(body.rows) ? body.rows : undefined;
      const snapshot = processes.start(
        body.command,
        body.cwd,
        body.mode ?? config.defaultMode,
        initialInput || undefined,
        {
          worktreeEnabled: body.worktreeEnabled === true,
          provider,
          model: effectiveModel,
          cols: reqCols,
          rows: reqRows,
          thinkingEffort: body.thinkingEffort ?? config.defaultThinkingEffort,
          ...origin,
        }
      );
      recordRecentPath(storage, snapshot.cwd);
      res.status(201).json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法启动命令。请检查命令是否安装。") });
    }
  });

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
  const wsManager = new WsBroadcastManager(wss, () => config.cardDefaults ?? {}, useHttps, authService);
  wsManager.setup((id) => sessionRegistry.get(id));
  disconnectAuthenticatedSockets = () => wsManager.disconnectAll();
  wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") return;
    wandError("WebSocket 异常", err.message);
  });

  // Wire process events to WebSocket broadcast
  processes.on("process", (event: ProcessEvent) => {
    wsManager.emitEvent(event);
  });
  structuredSessions.setEventEmitter((event) => {
    wsManager.emitEvent(event);
  });

  // ── Restart endpoint (needs server + wss in scope) ──

  function safeServiceInstalled(): boolean {
    try {
      return isServiceInstalled();
    } catch {
      return false;
    }
  }

  /**
   * 统一的关服 + 重启。重启方式由 computeRelaunch 决定：
   *   - systemd 托管且已装服务 → 仅退出，交给 Restart=always 用（更新自修复后可能刚被
   *     重写的）ExecStart 拉起，避免再 spawn detached 子进程与 systemd 抢单实例 pidfile；
   *   - 否则 → spawn 一个 detached 子进程（bin 优先全局安装，确保更新后跑到新版）再退出。
   */
  function relaunchAfterShutdown(): void {
    const plan = computeRelaunch({
      serviceInstalled: safeServiceInstalled(),
      globalCli: resolveGlobalWandCli(),
    });
    void close().finally(() => {
      if (plan.mode === "spawn") {
        spawn(process.execPath, [plan.bin ?? "", ...(plan.args ?? [])], {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
          env: process.env,
        }).unref();
      }
      process.exit(0);
    });
    // Force exit after 5s if graceful shutdown stalls
    const forceExitTimer = setTimeout(() => process.exit(0), 5000);
    forceExitTimer.unref?.();
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

  let bindAddr = config.host === "0.0.0.0" ? "0.0.0.0" : config.host;
  const collectedUrls: ServerUrl[] = [];

  await new Promise<void>((resolve, reject) => {
    const cleanupFailedListen = (): void => {
      shuttingDown = true;
      try { processes.dispose(); } catch { /* noop */ }
      try { structuredSessions.dispose(); } catch { /* noop */ }
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

  const testMode = process.env.WAND_TEST_MODE === "1";
  const updateChecksEnabled = !testMode && process.env.WAND_DISABLE_UPDATE_CHECK !== "1";

  // Start configured background sessions after the server is already reachable.
  if (!testMode) {
    processes.runStartupCommands();
  }

  // Pre-warm model cache (probes claude --version + codex debug models).
  if (!testMode) {
    refreshModels(getModelRefreshOptions()).catch(() => {});
  }

  // ── Auto-update endpoints ──

  app.get("/api/auto-update", requireAdmin, (_req, res) => {
    const web = storage.getConfigValue("autoUpdateWeb") === "true";
    const apk = storage.getConfigValue("autoUpdateApk") === "true";
    const dmg = storage.getConfigValue("autoUpdateDmg") === "true";
    const cli = storage.getConfigValue("autoUpdateProviderClis") === "true";
    res.json({ web, apk, dmg, cli });
  });

  app.post("/api/auto-update", requireAdmin, (req, res) => {
    const { web, apk, dmg, cli } = req.body as { web?: boolean; apk?: boolean; dmg?: boolean; cli?: boolean };
    if (typeof web === "boolean") {
      storage.setConfigValue("autoUpdateWeb", String(web));
    }
    if (typeof apk === "boolean") {
      storage.setConfigValue("autoUpdateApk", String(apk));
    }
    if (typeof dmg === "boolean") {
      storage.setConfigValue("autoUpdateDmg", String(dmg));
    }
    if (typeof cli === "boolean") {
      storage.setConfigValue("autoUpdateProviderClis", String(cli));
    }
    res.json({
      web: storage.getConfigValue("autoUpdateWeb") === "true",
      apk: storage.getConfigValue("autoUpdateApk") === "true",
      dmg: storage.getConfigValue("autoUpdateDmg") === "true",
      cli: storage.getConfigValue("autoUpdateProviderClis") === "true",
    });
  });

  // ── Update channel (stable / beta) ──

  app.get("/api/update-channel", requireAdmin, (_req, res) => {
    res.json({
      channel: getUpdateChannel(),
      build: {
        commit: BUILD_INFO.commit,
        shortCommit: BUILD_INFO.commit ? BUILD_INFO.commit.slice(0, 7) : null,
        builtAt: BUILD_INFO.builtAt,
        channel: BUILD_INFO.channel,
      },
    });
  });

  app.post("/api/update-channel", requireAdmin, (req, res) => {
    const body = (req.body ?? {}) as { channel?: string };
    const channel = body.channel === "beta" ? "beta" : "stable";
    storage.setConfigValue("updateChannel", channel);
    res.json({ channel });
  });

  // Express 4 does not forward rejected route promises automatically. Every
  // async route above is wrapped with asyncRoute, and this final middleware
  // keeps parser, synchronous middleware, and async failures JSON-shaped.
  app.use(jsonErrorHandler);

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
      // Restart after a brief delay
      const restartTimer = setTimeout(() => {
        relaunchAfterShutdown();
      }, 1000);
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
      refreshModels(getModelRefreshOptions()).catch(() => {});
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
      if (updateCheckTimer) {
        clearInterval(updateCheckTimer);
        updateCheckTimer = null;
      }
      if (providerCliUpdateTimer) {
        clearTimeout(providerCliUpdateTimer);
        providerCliUpdateTimer = null;
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
      try { structuredSessions.dispose(); } catch { /* best-effort shutdown */ }
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
