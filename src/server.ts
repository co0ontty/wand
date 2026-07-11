import crypto from "node:crypto";
import { compareApkInstallOrder, compareSemver, extractSemver } from "./version-utils.js";
import compression from "compression";
import express, { NextFunction, Request, Response } from "express";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { exec, spawn } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";
import { WebSocketServer } from "ws";
import {
  createSession,
  readSessionCookie,
  revokeSession,
  SESSION_COOKIE_HTTP,
  SESSION_COOKIE_HTTPS,
  SESSION_COOKIE_LEGACY,
  setAuthStorage,
  validateSession,
} from "./auth.js";
import { ensureCertificates } from "./cert.js";
import { buildChildEnv } from "./env-utils.js";
import {
  getDefaultModelForProvider,
  getProviderDefaultModels,
  isExecutionMode,
  normalizeMode,
  PREFERENCE_KEYS,
  resolveConfigDir,
  saveConfig,
  writePreferenceToStorage,
} from "./config.js";
import { getCachedModels, refreshModels } from "./models.js";
import { ProcessManager, ProcessEvent } from "./process-manager.js";
import { SessionLogger } from "./session-logger.js";
import { StructuredSessionManager } from "./structured-session-manager.js";
import { getErrorMessage, registerClaudeHistoryRoutes, registerSessionRoutes } from "./server-session-routes.js";
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
import { isServiceInstalled } from "./tui/commands.js";
import {
  canUseDetachedUpdateHelper,
  checkManagedServiceUpdatePreflight,
  startDetachedUpdateHelper,
} from "./update-helper.js";
import { registerUploadRoutes } from "./upload-routes.js";
import { optimizePrompt, PromptOptimizeError } from "./prompt-optimizer.js";
import { resolveDatabasePath, WandStorage } from "./storage.js";
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
import { isLogBusActive, wandTuiLog } from "./tui/log-bus.js";
import { EMBEDDED_WEB_ASSETS, type EmbeddedVendorAssetPath } from "./web-ui/embedded-assets.js";
import { renderApp } from "./web-ui/index.js";
import { WsBroadcastManager } from "./ws-broadcast.js";
import { checkRateLimit, recordFailedLogin, resetRateLimit } from "./middleware/rate-limit.js";
import { isPathWithinBase, isBlockedFolderPath, normalizeFolderPath } from "./middleware/path-safety.js";
import {
  CommandRequest,
  DirectoryListing,
  ExecutionMode,
  FileEntry,
  FilePreviewKind,
  FilePreviewResponse,
  GitFileStatus,
  InputRequest,
  PathSuggestion,
  ResizeRequest,
  SessionProvider,
  StructuredChatPersonaConfig,
  WandConfig
} from "./types.js";

const execAsync = promisify(exec);
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
    return applyLocalBuildUpdateOverride(cached.info);
  }
  const info = await checkPackageUpdateAsync(PKG_VERSION, channel);
  if (info.latest) {
    packageUpdateCache.set(channel, { info, timestamp: now });
  }
  return applyLocalBuildUpdateOverride(info);
}

function applyLocalBuildUpdateOverride(info: PackageUpdateInfo): PackageUpdateInfo {
  if (info.channel === "stable" && BUILD_INFO.channel === "beta" && info.latest) {
    return { ...info, updateAvailable: true };
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

// ── Android APK update check cache ──

interface GitHubApkInfo {
  version: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  releaseNotes?: string;
}

let cachedGitHubApk: GitHubApkInfo | null = null;
let gitHubApkCacheTs = 0;
const GITHUB_APK_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

interface GitHubReleaseAssetHit {
  tagName: string;
  body?: string;
  asset: { name: string; browser_download_url: string; size: number };
}

// 按时间倒序遍历最近的 releases，取第一个带对应产物的。正常 tag release
// 会为每个平台出包；这里保留回退以兼容旧 release 或某次平台构建失败。
async function fetchGitHubReleaseAssetByExt(ext: string): Promise<GitHubReleaseAssetHit | null> {
  const apiUrl = PKG_REPO_URL.replace("github.com", "api.github.com/repos") + "/releases?per_page=30";
  const resp = await fetch(apiUrl, {
    headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "wand-server" },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) return null;
  const releases = await resp.json() as Array<{
    tag_name: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
    assets: Array<{ name: string; browser_download_url: string; size: number }>;
  }>;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const asset = release.assets.find(a => a.name.toLowerCase().endsWith(ext));
    if (asset) return { tagName: release.tag_name, body: release.body, asset };
  }
  return null;
}

async function fetchGitHubLatestApk(forceRefresh = false): Promise<GitHubApkInfo | null> {
  const now = Date.now();
  if (!forceRefresh && cachedGitHubApk && (now - gitHubApkCacheTs < GITHUB_APK_CACHE_TTL)) {
    return cachedGitHubApk;
  }
  try {
    const hit = await fetchGitHubReleaseAssetByExt(".apk");
    if (!hit) return cachedGitHubApk ?? null;
    // 版本号优先从文件名提取；回退到旧 release asset 时不能把当前 release tag
    // 误当成产物版本。
    const version = extractAndroidApkVersion(hit.asset.name)
      ?? extractAndroidApkVersion(hit.tagName)
      ?? hit.tagName.replace(/^v/, "");
    cachedGitHubApk = {
      version,
      downloadUrl: hit.asset.browser_download_url,
      fileName: hit.asset.name,
      size: hit.asset.size,
      releaseNotes: hit.body ? hit.body.trim().slice(0, 500) : undefined,
    };
    gitHubApkCacheTs = now;
    return cachedGitHubApk;
  } catch {
    return cachedGitHubApk ?? null;
  }
}

interface ResolvedApkVersion {
  version: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  source: "local" | "github";
  releaseNotes?: string;
}

/**
 * APK 更新通道：stable 只看正式版（无 prerelease 后缀），beta 额外包含
 * `-debug.MMDDHHMM` 这类 tag 后 master 构建。镜像 server 自身的 stable/beta 通道语义。
 */
type ApkUpdateChannel = "stable" | "beta";

function parseApkChannel(value: unknown): ApkUpdateChannel {
  return value === "beta" ? "beta" : "stable";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

async function refreshDistributionConfig(configPath: string, config: WandConfig): Promise<void> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }

  const android = asRecord(raw.android);
  if (android) {
    config.android = { ...(config.android ?? {}) };
    if (typeof android.enabled === "boolean") config.android.enabled = android.enabled;
    if (Object.prototype.hasOwnProperty.call(android, "apkDir")) {
      config.android.apkDir = typeof android.apkDir === "string" && android.apkDir.trim()
        ? android.apkDir.trim()
        : "android";
    }
    if (Object.prototype.hasOwnProperty.call(android, "currentApkFile")) {
      config.android.currentApkFile = typeof android.currentApkFile === "string"
        ? android.currentApkFile.trim()
        : "";
    }
  }

  const macos = asRecord(raw.macos);
  if (macos) {
    config.macos = { ...(config.macos ?? {}) };
    if (typeof macos.enabled === "boolean") config.macos.enabled = macos.enabled;
    if (Object.prototype.hasOwnProperty.call(macos, "dmgDir")) {
      config.macos.dmgDir = typeof macos.dmgDir === "string" && macos.dmgDir.trim()
        ? macos.dmgDir.trim()
        : "macos";
    }
    if (Object.prototype.hasOwnProperty.call(macos, "currentDmgFile")) {
      config.macos.currentDmgFile = typeof macos.currentDmgFile === "string"
        ? macos.currentDmgFile.trim()
        : "";
    }
  }
}

/** 版本号带 prerelease 后缀（如 -debug.06121811）即视为 beta 构建。 */
function isPrereleaseApkVersion(version: string | null): boolean {
  return !!version && version.includes("-");
}

async function resolveLatestApkVersion(
  configDir: string,
  config: WandConfig,
  channel: ApkUpdateChannel,
  configPath?: string
): Promise<ResolvedApkVersion | null> {
  // local 与 github 两个来源都看，按安装序取真正更新的那个（持平偏向 local：同源下载更快）。
  // 旧逻辑是「local 存在就一票否决」——本地目录留着旧包时，会把线上新版压住不提示。
  const localApk = await resolveAndroidApkAsset(configDir, config, channel, configPath);
  const local: ResolvedApkVersion | null = localApk && localApk.version
    ? {
      version: localApk.version,
      // 下载链接始终带通道参数，保证「提示的版本」和「下载到的文件」出自同一套过滤：
      // 裸 /android/download（网页下载页、二维码落地页）默认 beta = 目录里真正最新的包。
      downloadUrl: `${localApk.downloadUrl}?channel=${channel}`,
      fileName: localApk.fileName,
      size: localApk.size,
      source: "local",
    }
    : null;
  let github: ResolvedApkVersion | null = null;
  try {
    const ghApk = await fetchGitHubLatestApk();
    if (ghApk) {
      github = {
        version: ghApk.version,
        downloadUrl: ghApk.downloadUrl,
        fileName: ghApk.fileName,
        size: ghApk.size,
        source: "github",
        releaseNotes: ghApk.releaseNotes,
      };
    }
  } catch {
    // GitHub 不可达时静默回退 local
  }
  if (local && github) {
    return compareApkInstallOrder(github.version, local.version) > 0 ? github : local;
  }
  return local ?? github;
}

// ── macOS DMG update check cache ──

interface GitHubDmgInfo {
  version: string;
  downloadUrl: string;
  fileName: string;
  size: number;
}

let cachedGitHubDmg: GitHubDmgInfo | null = null;
let gitHubDmgCacheTs = 0;
const GITHUB_DMG_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchGitHubLatestDmg(forceRefresh = false): Promise<GitHubDmgInfo | null> {
  const now = Date.now();
  if (!forceRefresh && cachedGitHubDmg && (now - gitHubDmgCacheTs < GITHUB_DMG_CACHE_TTL)) {
    return cachedGitHubDmg;
  }
  try {
    const hit = await fetchGitHubReleaseAssetByExt(".dmg");
    if (!hit) return cachedGitHubDmg ?? null;
    // 同 APK：版本号优先从文件名提取，避免回退到旧 asset 时把 release tag 当成新版本。
    const version = extractMacosDmgVersion(hit.asset.name)
      ?? extractMacosDmgVersion(hit.tagName)
      ?? hit.tagName.replace(/^v/, "");
    cachedGitHubDmg = {
      version,
      downloadUrl: hit.asset.browser_download_url,
      fileName: hit.asset.name,
      size: hit.asset.size,
    };
    gitHubDmgCacheTs = now;
    return cachedGitHubDmg;
  } catch {
    return cachedGitHubDmg ?? null;
  }
}

interface ResolvedDmgVersion {
  version: string;
  downloadUrl: string;
  fileName: string;
  size: number;
  source: "local" | "github";
}

async function resolveLatestDmgVersion(
  configDir: string,
  config: WandConfig,
  configPath?: string,
): Promise<ResolvedDmgVersion | null> {
  const localDmg = await resolveMacosDmgAsset(configDir, config, configPath);
  if (localDmg && localDmg.version) {
    return {
      version: localDmg.version,
      downloadUrl: localDmg.downloadUrl,
      fileName: localDmg.fileName,
      size: localDmg.size,
      source: "local",
    };
  }
  const ghDmg = await fetchGitHubLatestDmg();
  if (ghDmg) {
    return {
      version: ghDmg.version,
      downloadUrl: ghDmg.downloadUrl,
      fileName: ghDmg.fileName,
      size: ghDmg.size,
      source: "github",
    };
  }
  return null;
}

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

// ── Git helpers ──

async function getGitRepoRoot(dirPath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd: dirPath });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function getGitStatusMap(gitRoot: string): Promise<Map<string, GitFileStatus>> {
  const statusMap = new Map<string, GitFileStatus>();

  try {
    const { stdout: stagedStdout } = await execAsync("git status --porcelain -uno", { cwd: gitRoot });
    const { stdout: untrackedStdout } = await execAsync("git ls-files --others --exclude-standard", { cwd: gitRoot });

    const lines = stagedStdout.split("\n").filter((line) => line.trim());
    for (const line of lines) {
      if (line.length < 4) continue;
      const stagedChar = line[0];
      const unstagedChar = line[1];
      const filePath = line.slice(3).trim();
      if (!filePath) continue;

      const status: GitFileStatus = {};
      if (stagedChar === "M") status.staged = "modified";
      else if (stagedChar === "A") status.staged = "added";
      else if (stagedChar === "D") status.staged = "deleted";
      else if (stagedChar === "R") status.staged = "renamed";
      if (unstagedChar === "M") status.unstaged = "modified";
      else if (unstagedChar === "D") status.unstaged = "deleted";
      statusMap.set(filePath, status);
    }

    const untrackedFiles = untrackedStdout.split("\n").filter((line) => line.trim());
    for (const filePath of untrackedFiles) {
      const existing = statusMap.get(filePath);
      if (existing) {
        existing.untracked = true;
      } else {
        statusMap.set(filePath, { untracked: true });
      }
    }

    return statusMap;
  } catch {
    return statusMap;
  }
}

async function enrichWithGitStatus(items: FileEntry[], dirPath: string): Promise<FileEntry[]> {
  try {
    const gitRoot = await getGitRepoRoot(dirPath);
    if (!gitRoot) return items;
    const gitStatusMap = await getGitStatusMap(gitRoot);

    return items.map((item) => {
      const relativePath = path.relative(gitRoot, item.path);
      const normalizedPath = relativePath.replace(/\\/g, "/");
      const gitStatus = gitStatusMap.get(normalizedPath);
      return { ...item, gitStatus: gitStatus || undefined };
    });
  } catch {
    return items;
  }
}

// ── Auth helpers ──

function buildRequireAuth(useHttps: boolean, storage: WandStorage, config: WandConfig) {
  return function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!validateSession(readSessionCookie(req, useHttps)) && !validateBearerAppToken(req, storage, config)) {
      res.status(401).json({ error: "未授权，请先登录。" });
      return;
    }
    next();
  };
}

function getEffectivePassword(storage: WandStorage, config: WandConfig): string {
  return storage.getPassword() ?? config.password;
}

function validateBearerAppToken(req: Request, storage: WandStorage, config: WandConfig): boolean {
  const header = firstHeaderValue(req.headers.authorization);
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return false;
  try {
    return verifyAppToken(token, getEffectivePassword(storage, config), config.appSecret ?? "");
  } catch {
    return false;
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

function decodeConnectCode(code: string): { url: string; token: string } | null {
  try {
    const decoded = Buffer.from(code, "base64").toString("utf8");
    const hashIdx = decoded.lastIndexOf("#");
    if (hashIdx < 1) return null;
    const url = decoded.substring(0, hashIdx);
    const token = decoded.substring(hashIdx + 1);
    if (!url.startsWith("http") || token.length < 16) return null;
    return { url, token };
  } catch {
    return null;
  }
}

interface AndroidApkAsset {
  fileName: string;
  filePath: string;
  size: number;
  updatedAt: string;
  version: string | null;
  downloadUrl: string;
  source: "local";
}

interface MacosDmgAsset {
  fileName: string;
  filePath: string;
  size: number;
  updatedAt: string;
  version: string | null;
  downloadUrl: string;
  source: "local";
}

/** Match a semver-looking token in a file name (with optional pre-release / build metadata). */
function resolveAndroidApkDir(configDir: string, config: WandConfig): string {
  const configuredDir = config.android?.apkDir?.trim();
  if (!configuredDir) {
    return path.join(configDir, "android");
  }
  return path.isAbsolute(configuredDir) ? configuredDir : path.resolve(configDir, configuredDir);
}

function extractAndroidApkVersion(fileName: string): string | null {
  return extractSemver(fileName.replace(/\.apk$/i, ""));
}

async function resolveAndroidApkAsset(
  configDir: string,
  config: WandConfig,
  channel: ApkUpdateChannel = "beta",
  configPath?: string,
): Promise<AndroidApkAsset | null> {
  if (configPath) await refreshDistributionConfig(configPath, config);
  if (config.android?.enabled !== true) return null;
  const apkDir = resolveAndroidApkDir(configDir, config);
  await mkdir(apkDir, { recursive: true });

  const configuredFile = config.android?.currentApkFile?.trim();
  // Beta is the local development channel: every check should pick the newest
  // APK in apkDir, so dropping a new debug build into the directory is enough.
  // currentApkFile remains a stable/manual pin and backward-compatible fallback.
  if (configuredFile && channel !== "beta") {
    const filePath = path.join(apkDir, path.basename(configuredFile));
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return null;
      const fileName = path.basename(filePath);
      const version = extractAndroidApkVersion(fileName);
      if (channel === "stable" && isPrereleaseApkVersion(version)) return null;
      return {
        fileName,
        filePath,
        size: fileStat.size,
        updatedAt: fileStat.mtime.toISOString(),
        version,
        downloadUrl: "/android/download",
        source: "local",
      };
    } catch {
      return null;
    }
  }

  const entries = await readdir(apkDir, { withFileTypes: true });
  const apkFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".apk"));
  if (apkFiles.length === 0) return null;

  const allCandidates = await Promise.all(apkFiles.map(async (entry) => {
    const filePath = path.join(apkDir, entry.name);
    const fileStat = await stat(filePath);
    return {
      entry,
      filePath,
      fileStat,
    };
  }));
  // 通道过滤：stable 只看正式版文件（无 prerelease 后缀的版本号），beta 全量。
  // 无版本号的文件两个通道都保留（排序时本来就垫底，仅在只有它时兜底可下载）。
  const candidates = channel === "beta"
    ? allCandidates
    : allCandidates.filter((c) => !isPrereleaseApkVersion(extractAndroidApkVersion(c.entry.name)));
  if (candidates.length === 0) return null;
  // 按版本号选"最新", 而非修改时间 —— cp/rsync/解压/checkout 都可能让低版本号文件的
  // mtime 更新, 用 mtime 会把旧版本号当成 latest 上报。版本相同或都无版本号时退回 mtime。
  // 注意用安装序比较（同三段时 debug > release，镜像 versionCode），不是标准 semver：
  // wand-v1.55.0.apk 与 wand-v1.55.0-debug.x.apk 并存时，debug 才是装得上的更新包。
  candidates.sort((a, b) => {
    const va = extractAndroidApkVersion(a.entry.name);
    const vb = extractAndroidApkVersion(b.entry.name);
    if (va && vb) {
      const cmp = compareApkInstallOrder(vb, va);
      if (cmp !== 0) return cmp;
    } else if (va && !vb) {
      return -1;
    } else if (!va && vb) {
      return 1;
    }
    return b.fileStat.mtimeMs - a.fileStat.mtimeMs;
  });
  const selected = candidates[0];
  return {
    fileName: selected.entry.name,
    filePath: selected.filePath,
    size: selected.fileStat.size,
    updatedAt: selected.fileStat.mtime.toISOString(),
    version: extractAndroidApkVersion(selected.entry.name),
    downloadUrl: "/android/download",
    source: "local",
  };
}

function resolveMacosDmgDir(configDir: string, config: WandConfig): string {
  const configuredDir = config.macos?.dmgDir?.trim();
  if (!configuredDir) {
    return path.join(configDir, "macos");
  }
  return path.isAbsolute(configuredDir) ? configuredDir : path.resolve(configDir, configuredDir);
}

function extractMacosDmgVersion(fileName: string): string | null {
  return extractSemver(fileName.replace(/\.dmg$/i, ""));
}

async function resolveMacosDmgAsset(
  configDir: string,
  config: WandConfig,
  configPath?: string,
): Promise<MacosDmgAsset | null> {
  if (configPath) await refreshDistributionConfig(configPath, config);
  if (config.macos?.enabled !== true) return null;
  const dmgDir = resolveMacosDmgDir(configDir, config);
  await mkdir(dmgDir, { recursive: true });

  const configuredFile = config.macos?.currentDmgFile?.trim();
  if (configuredFile) {
    const filePath = path.join(dmgDir, path.basename(configuredFile));
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return null;
      return {
        fileName: path.basename(filePath),
        filePath,
        size: fileStat.size,
        updatedAt: fileStat.mtime.toISOString(),
        version: extractMacosDmgVersion(path.basename(filePath)),
        downloadUrl: "/macos/download",
        source: "local",
      };
    } catch {
      return null;
    }
  }

  const entries = await readdir(dmgDir, { withFileTypes: true });
  const dmgFiles = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dmg"));
  if (dmgFiles.length === 0) return null;

  const candidates = await Promise.all(dmgFiles.map(async (entry) => {
    const filePath = path.join(dmgDir, entry.name);
    const fileStat = await stat(filePath);
    return {
      entry,
      filePath,
      fileStat,
    };
  }));
  candidates.sort((a, b) => {
    const va = extractMacosDmgVersion(a.entry.name);
    const vb = extractMacosDmgVersion(b.entry.name);
    if (va && vb) {
      const cmp = compareSemver(vb, va);
      if (cmp !== 0) return cmp;
    } else if (va && !vb) {
      return -1;
    } else if (!va && vb) {
      return 1;
    }
    return b.fileStat.mtimeMs - a.fileStat.mtimeMs;
  });
  const selected = candidates[0];
  return {
    fileName: selected.entry.name,
    filePath: selected.filePath,
    size: selected.fileStat.size,
    updatedAt: selected.fileStat.mtime.toISOString(),
    version: extractMacosDmgVersion(selected.entry.name),
    downloadUrl: "/macos/download",
    source: "local",
  };
}

async function listPathSuggestions(input: string, fallbackCwd: string): Promise<PathSuggestion[]> {
  const normalizedInput = input.trim();
  const baseInput = normalizedInput || fallbackCwd;
  const resolvedInput = normalizeFolderPath(baseInput);
  const endsWithSeparator = /[\\/]$/.test(normalizedInput);

  let searchDir = resolvedInput;
  let partialName = "";
  if (!endsWithSeparator) {
    searchDir = path.dirname(resolvedInput);
    partialName = path.basename(resolvedInput);
  }

  const entries = await readdir(searchDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !partialName || entry.name.toLowerCase().startsWith(partialName.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((entry) => ({
      path: path.join(searchDir, entry.name),
      name: entry.name,
      isDirectory: true,
    }));
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

// ── Recent path types ──

interface RecentPath {
  path: string;
  name: string;
  lastUsedAt: string;
}

function parseStoredPathList<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

const MAX_RECENT_PATHS = 10;

/** Persist a cwd to recent paths. Used by both REST and session creation hooks. */
export function recordRecentPath(storage: WandStorage, cwd: string | undefined | null): void {
  if (!cwd) return;
  const trimmed = cwd.trim();
  if (!trimmed) return;
  let resolved: string;
  try {
    resolved = normalizeFolderPath(trimmed);
  } catch {
    return;
  }
  if (isBlockedFolderPath(resolved)) return;
  const stored = storage.getConfigValue("recent_paths");
  let recent = parseStoredPathList<RecentPath>(stored);
  recent = recent.filter((r) => normalizeFolderPath(r.path) !== resolved);
  recent.unshift({
    path: resolved,
    name: path.basename(resolved),
    lastUsedAt: new Date().toISOString(),
  });
  recent = recent.slice(0, MAX_RECENT_PATHS);
  storage.setConfigValue("recent_paths", JSON.stringify(recent));
}

// ── File language detection ──

function getLanguageFromExt(ext: string, filePath: string): string {
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
    ".json": "json", ".html": "html", ".htm": "html",
    ".css": "css", ".scss": "scss", ".less": "less",
    ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust",
    ".java": "java", ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
    ".cs": "csharp", ".swift": "swift", ".kt": "kotlin", ".scala": "scala",
    ".php": "php", ".sh": "bash", ".bash": "bash", ".zsh": "bash",
    ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".ini": "ini",
    ".xml": "xml", ".sql": "sql", ".graphql": "graphql",
    ".md": "markdown", ".markdown": "markdown", ".mdown": "markdown",
    ".mkd": "markdown", ".mkdn": "markdown",
    ".dockerfile": "dockerfile", ".gitignore": "plaintext",
    ".diff": "diff", ".patch": "diff", ".proto": "protobuf",
    ".env": "bash", ".editorconfig": "ini",
    ".mdx": "markdown", ".vue": "html", ".svelte": "html",
  };
  const baseName = path.basename(filePath).toLowerCase();
  if (baseName === "dockerfile") return "dockerfile";
  if (baseName === ".gitignore") return "plaintext";
  return map[ext] || "plaintext";
}

// ── File preview classification ──

const TEXT_PREVIEWABLE_EXTS = new Set<string>([
  ".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdx",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".jsonc", ".html", ".htm", ".css", ".scss", ".less",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".swift", ".kt", ".scala", ".php", ".sh", ".bash", ".zsh", ".fish",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env",
  ".xml", ".sql", ".graphql", ".proto",
  ".dockerfile", ".gitignore", ".editorconfig",
  ".vue", ".svelte",
  ".txt", ".log", ".diff", ".patch",
  ".lua", ".r", ".dart", ".pl", ".pm",
]);

const IMAGE_EXTS = new Set<string>([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif",
  ".bmp", ".ico", ".heic", ".heif",
]);
const VIDEO_EXTS = new Set<string>([
  ".mp4", ".webm", ".mov", ".mkv", ".m4v", ".ogv",
]);
const AUDIO_EXTS = new Set<string>([
  ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus",
]);
const PDF_EXTS = new Set<string>([".pdf"]);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".m4v": "video/x-m4v",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".opus": "audio/opus",
};

const TEXT_BASENAME_ALLOW = new Set<string>([
  "dockerfile", ".gitignore", ".dockerignore", ".env", ".env.local",
  ".env.development", ".env.production", ".env.test",
  "makefile", "readme", "license", "changelog",
]);

function classifyFile(ext: string, baseName: string): FilePreviewKind {
  const lowerExt = ext.toLowerCase();
  const lowerBase = baseName.toLowerCase();
  if (IMAGE_EXTS.has(lowerExt)) return "image";
  if (PDF_EXTS.has(lowerExt)) return "pdf";
  if (VIDEO_EXTS.has(lowerExt)) return "video";
  if (AUDIO_EXTS.has(lowerExt)) return "audio";
  if (TEXT_PREVIEWABLE_EXTS.has(lowerExt)) return "text";
  if (TEXT_BASENAME_ALLOW.has(lowerBase)) return "text";
  // Files with no extension that look like text-y dotfiles
  if (lowerExt === "" && /^[a-z0-9._-]+$/i.test(lowerBase)) return "text";
  return "binary";
}

function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] || "application/octet-stream";
}

interface ParsedByteRange {
  start: number;
  end: number;
}

function parseByteRange(rangeHeader: string | undefined, total: number): ParsedByteRange | "invalid" | null {
  if (!rangeHeader) return null;
  const trimmed = rangeHeader.trim();
  if (!trimmed.startsWith("bytes=")) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";

  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1);
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= total) {
    return "invalid";
  }
  return { start, end };
}

function streamFileWithRange(
  req: Request,
  res: Response,
  options: {
    filePath: string;
    size: number;
    contentType: string;
    disposition?: string;
    headers?: Record<string, string>;
    readErrorMessage?: string;
  },
): void {
  res.setHeader("Content-Type", options.contentType);
  if (options.disposition) res.setHeader("Content-Disposition", options.disposition);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    res.setHeader(name, value);
  }
  res.setHeader("Accept-Ranges", "bytes");

  if (options.size === 0) {
    if (req.headers.range?.trim().startsWith("bytes=")) {
      res.status(416).setHeader("Content-Range", "bytes */0").end();
      return;
    }
    res.setHeader("Content-Length", "0");
    res.end();
    return;
  }

  const parsedRange = parseByteRange(req.headers.range, options.size);
  if (parsedRange === "invalid") {
    res.status(416).setHeader("Content-Range", `bytes */${options.size}`).end();
    return;
  }

  const start = parsedRange?.start ?? 0;
  const end = parsedRange?.end ?? options.size - 1;
  if (parsedRange) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${options.size}`);
  }
  res.setHeader("Content-Length", String(end - start + 1));

  const stream = createReadStream(options.filePath, { start, end });
  stream.on("error", (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: getErrorMessage(err, options.readErrorMessage ?? "读取文件失败。") });
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

// ── Main server ──

export interface ServerUrl {
  url: string;
  scheme: "HTTP" | "HTTPS";
}

export interface ServerHandle {
  processManager: ProcessManager;
  structuredSessions: StructuredSessionManager;
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

export async function startServer(config: WandConfig, configPath: string): Promise<ServerHandle> {
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
  app.set("trust proxy", "loopback, 172.16.0.0/12");
  const storage = new WandStorage(resolveDatabasePath(configPath));
  setAuthStorage(storage);
  const configDir = resolveConfigDir(configPath);
  const processes = new ProcessManager(config, storage, configDir);
  const structuredLogger = new SessionLogger(configDir, config.shortcutLogMaxBytes);
  const structuredSessions = new StructuredSessionManager(storage, config, structuredLogger);
  const useHttps = config.https === true;
  const protocol = useHttps ? "https" : "http";
  const requireAuth = buildRequireAuth(useHttps, storage, config);
  const nodeModulesDir = path.join(RUNTIME_ROOT_DIR, "node_modules");

  app.use(express.json({ limit: "1mb" }));
  app.use(compression({ threshold: 1024 }));
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

  app.get("/api/structured-chat-avatar/:role", async (req, res) => {
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
  });

  // ── Auth routes ──

  app.post("/api/login", (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    if (!checkRateLimit(clientIp)) {
      res.status(429).json({ error: "登录尝试次数过多，请在 15 分钟后再试。" });
      return;
    }

    const { password, appToken, client } = req.body as { password?: string; appToken?: string; client?: string };
    const effectivePassword = getEffectivePassword(storage, config);

    // App token login — derived from password, so password change invalidates it
    let authenticated = false;
    if (appToken) {
      try {
        authenticated = verifyAppToken(appToken, effectivePassword, config.appSecret ?? "");
      } catch {
        authenticated = false;
      }
    }

    if (!authenticated) {
      if (password !== effectivePassword) {
        recordFailedLogin(clientIp);
        res.status(401).json({ error: "密码错误，请重试。" });
        return;
      }
      authenticated = true;
    }

    resetRateLimit(clientIp);
    const token = createSession();
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
      ...(client === "browser-extension" ? appTokenLoginPayload(storage, config) : {}),
    });
  });

  app.post("/api/logout", (req, res) => {
    revokeSession(readSessionCookie(req, useHttps));
    // 全部名字都清一遍，避免遗留 cookie 在下次同源访问时被回放。
    for (const name of [SESSION_COOKIE_HTTPS, SESSION_COOKIE_HTTP, SESSION_COOKIE_LEGACY]) {
      res.clearCookie(name, { path: "/" });
    }
    res.json({ ok: true });
  });

  app.post("/api/set-password", requireAuth, (req, res) => {
    const { password } = req.body as { password?: string };
    if (!password || password.length < 6) {
      res.status(400).json({ error: "密码长度至少为 6 个字符。" });
      return;
    }
    storage.setPassword(password);
    res.json({ ok: true });
  });

  // ── Android APK update & download (no auth required) ──

  app.get("/api/android-apk-update", async (req, res) => {
    const currentVersion = (req.query.currentVersion as string)?.trim();
    if (!currentVersion) {
      res.status(400).json({ error: "Missing currentVersion query parameter." });
      return;
    }
    // 更新通道：beta 包含 -debug.* 构建，stable（默认，含不传参的老客户端）只推正式版。
    const channel = parseApkChannel(req.query.channel);
    const latest = await resolveLatestApkVersion(configDir, config, channel, configPath);
    if (!latest) {
      res.json({ updateAvailable: false, currentVersion, latestVersion: null, downloadUrl: null, source: null, channel });
      return;
    }
    // 安装序比较（镜像 versionCode），不是标准 semver：只在系统安装器真能装上时才提示，
    // 避免「提示升级 → 下载 → 被按降级拒装」的死循环（如已装 1.55.0-debug 提示装 1.55.0）。
    const updateAvailable = compareApkInstallOrder(latest.version, currentVersion) > 0;
    res.json({
      updateAvailable,
      currentVersion,
      latestVersion: latest.version,
      downloadUrl: updateAvailable ? latest.downloadUrl : null,
      fileName: updateAvailable ? latest.fileName : null,
      size: updateAvailable ? latest.size : null,
      source: latest.source,
      channel,
      releaseNotes: updateAvailable ? (latest.releaseNotes ?? null) : null,
    });
  });

  app.get("/android/download", async (req, res) => {
    // 更新弹窗的下载链接由 /api/android-apk-update 按通道生成（始终带 ?channel=）。
    // 裸 /android/download（网页下载页、二维码落地页）不带参时默认 beta ——
    // 保持「下载页拿到的就是目录里真正最新的包」的旧行为。
    const channel = req.query.channel === "stable" ? "stable" as const : "beta" as const;
    const androidApk = await resolveAndroidApkAsset(configDir, config, channel, configPath);
    if (!androidApk) {
      res.status(404).json({ error: "当前没有可下载的 APK 文件。" });
      return;
    }

    streamFileWithRange(req, res, {
      filePath: androidApk.filePath,
      size: androidApk.size,
      contentType: "application/vnd.android.package-archive",
      disposition: `attachment; filename="${encodeURIComponent(androidApk.fileName)}"`,
      readErrorMessage: "读取 APK 文件失败。",
    });
  });

  // ── macOS DMG update & download (no auth required) ──

  app.get("/api/macos-dmg-update", async (req, res) => {
    const currentVersion = (req.query.currentVersion as string)?.trim();
    if (!currentVersion) {
      res.status(400).json({ error: "Missing currentVersion query parameter." });
      return;
    }
    const latest = await resolveLatestDmgVersion(configDir, config, configPath);
    if (!latest) {
      res.json({ updateAvailable: false, currentVersion, latestVersion: null, downloadUrl: null, source: null });
      return;
    }
    const updateAvailable = compareSemver(latest.version, currentVersion) > 0;
    res.json({
      updateAvailable,
      currentVersion,
      latestVersion: latest.version,
      downloadUrl: updateAvailable ? latest.downloadUrl : null,
      fileName: updateAvailable ? latest.fileName : null,
      size: updateAvailable ? latest.size : null,
      source: latest.source,
    });
  });

  app.get("/macos/download", async (req, res) => {
    const macosDmg = await resolveMacosDmgAsset(configDir, config, configPath);
    if (!macosDmg) {
      res.status(404).json({ error: "当前没有可下载的 DMG 文件。" });
      return;
    }
    streamFileWithRange(req, res, {
      filePath: macosDmg.filePath,
      size: macosDmg.size,
      contentType: "application/x-apple-diskimage",
      disposition: `attachment; filename="${encodeURIComponent(macosDmg.fileName)}"`,
      readErrorMessage: "读取 DMG 文件失败。",
    });
  });

  // Public probe so the unauthenticated browser does not log a 401 on /api/config
  app.get("/api/session-check", (req, res) => {
    res.json({ authed: validateSession(readSessionCookie(req, useHttps)) });
  });

  app.use("/api", requireAuth);

  // ── Config & Session info ──

  app.get("/api/config", async (_req, res) => {
    const structuredChatPersona = await buildStructuredChatPersonaPayload(configPath, config);
    const defaultModels = getProviderDefaultModels(config);
    res.json({
      host: config.host,
      port: config.port,
      defaultProvider: config.defaultProvider ?? "claude",
      defaultSessionKind: config.defaultSessionKind ?? "structured",
      defaultMode: config.defaultMode,
      defaultCwd: config.defaultCwd,
      defaultModel: defaultModels.claude,
      defaultCodexModel: defaultModels.codex,
      defaultModels,
      defaultThinkingEffort: config.defaultThinkingEffort ?? "off",
      commandPresets: config.commandPresets,
      structuredRunner: config.structuredRunner ?? "cli",
      structuredRunners: [
        { label: "Claude Structured", runner: "claude-cli-print" },
        { label: "Codex Structured", runner: "codex-cli-exec" },
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
    });
  });

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

  app.get("/api/settings", async (_req, res) => {
    const certPaths = {
      keyPath: path.join(configDir, "server.key"),
      certPath: path.join(configDir, "server.crt"),
    };
    const { password: _pw, ...safeConfig } = config;
    const defaultModels = getProviderDefaultModels(config);
    const localApk = await resolveAndroidApkAsset(configDir, config, "beta", configPath);
    const ghApk = await fetchGitHubLatestApk();
    const apkDir = resolveAndroidApkDir(configDir, config);
    // Backward-compatible: pick best available for hasApk/version/downloadUrl
    const resolvedApk = localApk
      ? { hasApk: true, fileName: localApk.fileName, version: localApk.version, size: localApk.size, updatedAt: localApk.updatedAt, downloadUrl: localApk.downloadUrl, source: "local" as const }
      : ghApk
        ? { hasApk: true, fileName: ghApk.fileName, version: ghApk.version, size: ghApk.size, updatedAt: null, downloadUrl: ghApk.downloadUrl, source: "github" as const }
        : null;
    const localDmg = await resolveMacosDmgAsset(configDir, config, configPath);
    const ghDmg = await fetchGitHubLatestDmg();
    const dmgDir = resolveMacosDmgDir(configDir, config);
    const resolvedDmg = localDmg
      ? { hasDmg: true, fileName: localDmg.fileName, version: localDmg.version, size: localDmg.size, updatedAt: localDmg.updatedAt, downloadUrl: localDmg.downloadUrl, source: "local" as const }
      : ghDmg
        ? { hasDmg: true, fileName: ghDmg.fileName, version: ghDmg.version, size: ghDmg.size, updatedAt: null, downloadUrl: ghDmg.downloadUrl, source: "github" as const }
        : null;
    res.json({
      version: DISPLAY_VERSION,
      packageName: PKG_NAME,
      nodeVersion: PKG_NODE_REQ,
      repoUrl: PKG_REPO_URL,
      config: {
        ...safeConfig,
        defaultModel: defaultModels.claude,
        defaultCodexModel: defaultModels.codex,
        defaultModels,
      },
      hasCert: existsSync(certPaths.keyPath) && existsSync(certPaths.certPath),
      updateAvailable: cachedUpdateInfo?.updateAvailable ?? false,
      latestVersion: cachedUpdateInfo?.latest ?? null,
      updateChannel: getUpdateChannel(),
      build: {
        commit: BUILD_INFO.commit,
        shortCommit: BUILD_INFO.commit ? BUILD_INFO.commit.slice(0, 7) : null,
        builtAt: BUILD_INFO.builtAt,
        channel: BUILD_INFO.channel,
      },
      autoUpdate: {
        web: storage.getConfigValue("autoUpdateWeb") === "true",
        apk: storage.getConfigValue("autoUpdateApk") === "true",
        dmg: storage.getConfigValue("autoUpdateDmg") === "true",
      },
      androidApk: {
        enabled: config.android?.enabled === true,
        apkDir,
        hasApk: resolvedApk?.hasApk ?? false,
        fileName: resolvedApk?.fileName ?? null,
        version: resolvedApk?.version ?? null,
        size: resolvedApk?.size ?? null,
        updatedAt: resolvedApk?.updatedAt ?? null,
        downloadUrl: resolvedApk?.downloadUrl ?? null,
        source: resolvedApk?.source ?? null,
        local: localApk ? { fileName: localApk.fileName, version: localApk.version, size: localApk.size, updatedAt: localApk.updatedAt, downloadUrl: localApk.downloadUrl } : null,
        github: ghApk ? { fileName: ghApk.fileName, version: ghApk.version, size: ghApk.size, downloadUrl: ghApk.downloadUrl } : null,
      },
      macosDmg: {
        enabled: config.macos?.enabled === true,
        dmgDir,
        hasDmg: resolvedDmg?.hasDmg ?? false,
        fileName: resolvedDmg?.fileName ?? null,
        version: resolvedDmg?.version ?? null,
        size: resolvedDmg?.size ?? null,
        updatedAt: resolvedDmg?.updatedAt ?? null,
        downloadUrl: resolvedDmg?.downloadUrl ?? null,
        source: resolvedDmg?.source ?? null,
        local: localDmg ? { fileName: localDmg.fileName, version: localDmg.version, size: localDmg.size, updatedAt: localDmg.updatedAt, downloadUrl: localDmg.downloadUrl } : null,
        github: ghDmg ? { fileName: ghDmg.fileName, version: ghDmg.version, size: ghDmg.size, downloadUrl: ghDmg.downloadUrl } : null,
      },
    });
  });

  app.get("/api/android-apk", async (_req, res) => {
    const localApk = await resolveAndroidApkAsset(configDir, config, "beta", configPath);
    const ghApk = await fetchGitHubLatestApk();
    const apkDir = resolveAndroidApkDir(configDir, config);
    const resolvedApk = localApk
      ? { hasApk: true, fileName: localApk.fileName, version: localApk.version, size: localApk.size, updatedAt: localApk.updatedAt, downloadUrl: localApk.downloadUrl, source: "local" as const }
      : ghApk
        ? { hasApk: true, fileName: ghApk.fileName, version: ghApk.version, size: ghApk.size, updatedAt: null, downloadUrl: ghApk.downloadUrl, source: "github" as const }
        : null;
    res.json({
      enabled: config.android?.enabled === true,
      apkDir,
      hasApk: resolvedApk?.hasApk ?? false,
      fileName: resolvedApk?.fileName ?? null,
      version: resolvedApk?.version ?? null,
      size: resolvedApk?.size ?? null,
      updatedAt: resolvedApk?.updatedAt ?? null,
      downloadUrl: resolvedApk?.downloadUrl ?? null,
      source: resolvedApk?.source ?? null,
      local: localApk ? { fileName: localApk.fileName, version: localApk.version, size: localApk.size, updatedAt: localApk.updatedAt, downloadUrl: localApk.downloadUrl } : null,
      github: ghApk ? { fileName: ghApk.fileName, version: ghApk.version, size: ghApk.size, downloadUrl: ghApk.downloadUrl } : null,
    });
  });

  app.get("/api/macos-dmg", async (_req, res) => {
    const localDmg = await resolveMacosDmgAsset(configDir, config, configPath);
    const ghDmg = await fetchGitHubLatestDmg();
    const dmgDir = resolveMacosDmgDir(configDir, config);
    const resolvedDmg = localDmg
      ? { hasDmg: true, fileName: localDmg.fileName, version: localDmg.version, size: localDmg.size, updatedAt: localDmg.updatedAt, downloadUrl: localDmg.downloadUrl, source: "local" as const }
      : ghDmg
        ? { hasDmg: true, fileName: ghDmg.fileName, version: ghDmg.version, size: ghDmg.size, updatedAt: null, downloadUrl: ghDmg.downloadUrl, source: "github" as const }
        : null;
    res.json({
      enabled: config.macos?.enabled === true,
      dmgDir,
      hasDmg: resolvedDmg?.hasDmg ?? false,
      fileName: resolvedDmg?.fileName ?? null,
      version: resolvedDmg?.version ?? null,
      size: resolvedDmg?.size ?? null,
      updatedAt: resolvedDmg?.updatedAt ?? null,
      downloadUrl: resolvedDmg?.downloadUrl ?? null,
      source: resolvedDmg?.source ?? null,
      local: localDmg ? { fileName: localDmg.fileName, version: localDmg.version, size: localDmg.size, updatedAt: localDmg.updatedAt, downloadUrl: localDmg.downloadUrl } : null,
      github: ghDmg ? { fileName: ghDmg.fileName, version: ghDmg.version, size: ghDmg.size, downloadUrl: ghDmg.downloadUrl } : null,
    });
  });

  // 返回当前 inheritEnv 配置下，wand 启动 PTY / 结构化子进程时实际会传给
  // claude / codex 的环境变量集合。值会按下面的规则做掩码：
  //   - 名字里含 KEY/TOKEN/SECRET/PASSWORD/AUTH/CREDENTIAL/COOKIE/SESSION 的视为敏感
  //   - 敏感值默认显示为 ***（保留长度提示），可通过 ?reveal=1 取消掩码
  // 即使开启 reveal，仍只对已认证用户可见（路由由全局 requireAuth 保护）。
  app.get("/api/settings/env-preview", (req, res) => {
    const inheritEnv = config.inheritEnv !== false;
    // 复用与 process-manager / structured-session-manager 相同的组装逻辑，
    // 这样 UI 上看到的就是真正会被注入到子进程的那一份环境。
    const env = buildChildEnv(inheritEnv, {
      // PTY runner 还会注入 WAND_* 用于 mode 协调，这里也展示出来便于排查。
      WAND_MODE: "<runtime>",
      WAND_AUTO_CONFIRM: "<runtime>",
      WAND_AUTO_EDIT: "<runtime>",
    });
    const reveal = req.query.reveal === "1" || req.query.reveal === "true";
    const SENSITIVE_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE|SESSION)/i;
    const entries = Object.keys(env)
      .sort()
      .map((name) => {
        const raw = env[name] ?? "";
        const sensitive = SENSITIVE_PATTERN.test(name);
        const masked = sensitive && !reveal;
        // WAND_* 占位值不算敏感，保持原样。
        const isPlaceholder = raw.startsWith("<") && raw.endsWith(">");
        return {
          name,
          value: masked && !isPlaceholder ? "***" : raw,
          length: raw.length,
          sensitive,
        };
      });
    res.json({
      inheritEnv,
      total: entries.length,
      reveal,
      entries,
    });
  });

  app.get("/api/app-connect-code", requireAuth, (req, res) => {
    const effectivePassword = getEffectivePassword(storage, config);
    const protocol = getPublicRequestProtocol(req, useHttps ? "https" : "http");
    const host = getPublicRequestHost(req, config);
    const browserOrigin = normalizePublicOrigin(firstQueryStringValue(req.query.origin));
    const serverUrl = resolveAppConnectOrigin(browserOrigin ?? `${protocol}://${host}`, config);
    const appSecret = config.appSecret ?? "";
    const token = generateAppToken(effectivePassword, appSecret);
    const code = encodeConnectCode(serverUrl, token);
    res.json({ code, url: serverUrl });
  });

  app.post("/api/settings/config", async (req, res) => {
    const body = req.body as Partial<WandConfig> & { defaultModels?: { claude?: unknown; codex?: unknown } };
    // 部署字段：写 JSON，需要重启服务才生效（host/port/https 影响监听，shell 影响新 PTY）
    const deployFields = ["host", "port", "https", "shell"] as const;
    let touchedDeployField = false;
    let touchedPreferenceField = false;

    for (const field of deployFields) {
      if (!(field in body) || body[field] === undefined) continue;
      if (field === "port") {
        const p = Number(body.port);
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
          res.status(400).json({ error: `无效端口号: ${body.port}` });
          return;
        }
        config.port = p;
      } else if (field === "https") {
        config.https = body.https === true;
      } else if (field === "host") {
        config.host = String(body.host);
      } else if (field === "shell") {
        config.shell = String(body.shell);
      }
      touchedDeployField = true;
    }

    // 偏好字段：写 SQLite app_config，立即热生效（manager 持有 config 同一引用）。
    // defaultMode 单独做严格校验以保留 400 错误响应，其余字段走 writePreferenceToStorage 的统一类型化处理。
    if (body.defaultMode !== undefined && !isExecutionMode(body.defaultMode)) {
      res.status(400).json({ error: `无效执行模式: ${body.defaultMode}` });
      return;
    }
    if (body.defaultModels && typeof body.defaultModels === "object") {
      const modelDefaults = body.defaultModels;
      try {
        if (Object.prototype.hasOwnProperty.call(modelDefaults, "claude")) {
          writePreferenceToStorage(config, storage, "defaultModel", modelDefaults.claude);
          touchedPreferenceField = true;
        }
        if (Object.prototype.hasOwnProperty.call(modelDefaults, "codex")) {
          writePreferenceToStorage(config, storage, "defaultCodexModel", modelDefaults.codex);
          touchedPreferenceField = true;
        }
      } catch (err) {
        res.status(400).json({ error: getErrorMessage(err, "默认模型配置校验失败") });
        return;
      }
    }
    for (const field of PREFERENCE_KEYS) {
      if (!(field in body) || (body as Record<string, unknown>)[field] === undefined) continue;
      try {
        writePreferenceToStorage(config, storage, field, (body as Record<string, unknown>)[field]);
      } catch (err) {
        res.status(400).json({ error: getErrorMessage(err, `字段 ${field} 校验失败`) });
        return;
      }
      touchedPreferenceField = true;
    }

    if (!touchedDeployField && !touchedPreferenceField) {
      res.status(400).json({ error: "没有可更新的配置字段。" });
      return;
    }

    try {
      if (touchedDeployField) {
        await saveConfig(configPath, config);
      }
      const { password: _pw, ...safeConfig } = config;
      const defaultModels = getProviderDefaultModels(config);
      // 只有部署字段才需要重启；偏好字段已经热生效。
      res.json({
        ok: true,
        config: {
          ...safeConfig,
          defaultModel: defaultModels.claude,
          defaultCodexModel: defaultModels.codex,
          defaultModels,
        },
        restartRequired: touchedDeployField,
      });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "保存配置失败。") });
    }
  });

  app.get("/api/models", (_req, res) => {
    const cached = getCachedModels();
    const defaultModels = getProviderDefaultModels(config);
    res.json({
      models: cached.models,
      codexModels: cached.codexModels,
      claudeVersion: cached.claudeVersion,
      refreshedAt: cached.refreshedAt,
      defaultModel: defaultModels.claude,
      defaultCodexModel: defaultModels.codex,
      defaultModels,
    });
  });

  app.post("/api/models/refresh", async (_req, res) => {
    try {
      const refreshed = await refreshModels();
      const defaultModels = getProviderDefaultModels(config);
      res.json({
        models: refreshed.models,
        codexModels: refreshed.codexModels,
        claudeVersion: refreshed.claudeVersion,
        refreshedAt: refreshed.refreshedAt,
        defaultModel: defaultModels.claude,
        defaultCodexModel: defaultModels.codex,
        defaultModels,
      });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "刷新模型列表失败。") });
    }
  });

  app.post("/api/settings/upload-cert", async (req, res) => {
    const { key, cert } = req.body as { key?: string; cert?: string };
    if (!key || !cert) {
      res.status(400).json({ error: "请提供 key 和 cert 内容。" });
      return;
    }

    if (!key.includes("-----BEGIN") || !cert.includes("-----BEGIN")) {
      res.status(400).json({ error: "证书内容格式无效，请上传 PEM 格式的文件。" });
      return;
    }

    try {
      const keyPath = path.join(configDir, "server.key");
      const certPath = path.join(configDir, "server.crt");
      writeFileSync(keyPath, key, { mode: 0o600 });
      writeFileSync(certPath, cert, { mode: 0o644 });
      res.json({ ok: true, restartRequired: true });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "保存证书失败。") });
    }
  });

  // ── Global npm install (with leftover cleanup + ENOTEMPTY fallback) ──
  // 把所有恢复逻辑下沉到 ./npm-update-utils，TUI 和 server 共用，确保自动更新、
  // /api/update、tui installUpdate 三处行为一致。

  async function npmInstallGlobal(pkg: string, timeoutMs: number): Promise<void> {
    await installPackageGloballyAsync(pkg, timeoutMs, (line) => {
      process.stdout.write(`${line}\n`);
    });
  }

  /** 当前更新通道：stable（npm @latest，纯 tag）或 beta（npm @beta，tag + commit 尾标）。 */
  const getUpdateChannel = (): "stable" | "beta" =>
    normalizeUpdateChannel(storage.getConfigValue("updateChannel"));

  app.get("/api/check-update", async (_req, res) => {
    try {
      const channel = getUpdateChannel();
      const info = await checkLatestPackageVersion(channel, true);
      res.json({
        ...info,
        build: {
          commit: BUILD_INFO.commit,
          shortCommit: BUILD_INFO.commit ? BUILD_INFO.commit.slice(0, 7) : null,
          builtAt: BUILD_INFO.builtAt,
          channel: BUILD_INFO.channel,
        },
      });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "检查更新失败。") });
    }
  });

  let updateInFlight = false;
  app.post("/api/update", async (_req, res) => {
    if (updateInFlight) {
      res.status(409).json({ error: "更新正在进行中，请稍候。" });
      return;
    }
    updateInFlight = true;
    try {
      const channel = getUpdateChannel();
      const info = await checkLatestPackageVersion(channel, true);
      if (!info.latest) {
        res.status(502).json({ error: "无法连接到 npm registry。" });
        return;
      }
      if (!info.updateAvailable) {
        res.json({ ok: true, message: channel === "beta" ? "已是最新 Beta 版本。" : "已经是最新版本。" });
        return;
      }
      const targetLabel = info.latest;

      if (!canUseDetachedUpdateHelper()) {
        res.status(500).json({ error: "当前平台暂不支持 Web 异步更新，请在终端运行 install.sh 更新。" });
        return;
      }

      const helper = startDetachedUpdateHelper({
        installSpec: info.installSpec,
        configPath,
        parentPid: process.pid,
        cliArgs: process.argv.slice(2),
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 300000,
      });
      if (!helper.started) {
        res.status(500).json({ error: helper.message, detail: `script=${helper.scriptPath}\nlog=${helper.logPath}` });
        return;
      }
      process.stdout.write(`[wand] ${helper.message}\n`);
      wsManager.emitEvent({
        type: "notification",
        sessionId: "__system__",
        data: { kind: "auto-update-restart", current: info.current, latest: targetLabel },
      });

      res.json({
        ok: true,
        message: `已开始更新到 ${targetLabel}`,
        restartRequired: false,
        detachedUpdate: true,
        version: targetLabel,
        logPath: helper.logPath,
      });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "更新失败。") });
    } finally {
      updateInFlight = false;
    }
  });

  registerSessionRoutes(app, processes, structuredSessions, storage, config.defaultMode, config, (cwd) => {
    recordRecentPath(storage, cwd);
  });
  registerClaudeHistoryRoutes(app, processes, storage);
  registerUploadRoutes(app, processes);

  app.post("/api/optimize-prompt", express.json({ limit: "256kb" }), async (req, res) => {
    const body = (req.body ?? {}) as { text?: string; sessionId?: string };
    const text = typeof body.text === "string" ? body.text : "";
    let cwd: string | undefined;
    if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
      const snap = storage.getSession(body.sessionId);
      if (snap?.cwd) cwd = snap.cwd;
    }
    try {
      const optimized = await optimizePrompt(text, config.language ?? "", cwd);
      res.json({ optimized });
    } catch (error) {
      if (error instanceof PromptOptimizeError) {
        const status = error.code === "EMPTY_INPUT" || error.code === "INPUT_TOO_LONG" ? 400 : 500;
        res.status(status).json({ error: error.message, errorCode: error.code });
        return;
      }
      res.status(500).json({ error: getErrorMessage(error, "提示词优化失败。") });
    }
  });

  // ── Path suggestion ──

  app.get("/api/path-suggestions", async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q : "";
    try {
      const suggestions = await listPathSuggestions(query, config.defaultCwd);
      res.json(suggestions);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法加载路径建议。") });
    }
  });

  // ── File browsing ──

  const DIRECTORY_MAX_ITEMS = 200;
  app.get("/api/directory", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const includeGitStatus = req.query.gitStatus === "true";
    const targetPath = path.resolve(q || config.defaultCwd);

    try {
      const entries = await readdir(targetPath, { withFileTypes: true });
      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });
      const total = sorted.length;
      const truncated = total > DIRECTORY_MAX_ITEMS;
      const sliced = sorted.slice(0, DIRECTORY_MAX_ITEMS);

      // Fetch size/mtime in parallel; tolerate per-entry failures.
      let items: FileEntry[] = await Promise.all(sliced.map(async (entry) => {
        const fullPath = path.join(targetPath, entry.name);
        const isDir = entry.isDirectory();
        const base: FileEntry = {
          path: fullPath,
          name: entry.name,
          type: isDir ? "dir" : "file",
        };
        if (isDir) return base;
        try {
          const st = await lstat(fullPath);
          base.size = st.size;
          base.mtime = st.mtime.toISOString();
        } catch {
          // Permission errors etc — leave size/mtime undefined.
        }
        return base;
      }));

      if (includeGitStatus) {
        items = await enrichWithGitStatus(items, targetPath);
      }

      const payload: DirectoryListing = { items, truncated, total };
      res.json(payload);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法读取目录。可能原因：路径不存在或权限不足。") });
    }
  });

  const MAX_TEXT_PREVIEW_SIZE = 512 * 1024;
  app.get("/api/file-preview", async (req, res) => {
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!filePath) {
      res.status(400).json({ error: "Missing path parameter" });
      return;
    }

    const resolvedPath = path.resolve(filePath);
    if (isBlockedFolderPath(resolvedPath)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    try {
      const fileStat = await stat(resolvedPath);
      if (fileStat.isDirectory()) {
        res.status(400).json({ error: "Cannot preview a directory" });
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const baseName = path.basename(filePath);
      const kind = classifyFile(ext, baseName);
      const mime = mimeForExt(ext);

      // Non-text kinds: respond with metadata so the client can pick a renderer.
      if (kind !== "text") {
        const payload: FilePreviewResponse = {
          kind,
          path: resolvedPath,
          name: baseName,
          ext,
          size: fileStat.size,
          mime,
        };
        res.json(payload);
        return;
      }

      // Text/code preview path — still subject to the 512 KB cap.
      if (fileStat.size > MAX_TEXT_PREVIEW_SIZE) {
        res.status(413).json({
          error: "文件太大，无法在线预览（限 512 KB）。",
          truncated: true,
          size: fileStat.size,
          maxSize: MAX_TEXT_PREVIEW_SIZE,
        });
        return;
      }

      const content = await readFile(resolvedPath, "utf-8");
      const lang = getLanguageFromExt(ext, filePath);
      const payload: FilePreviewResponse = {
        kind: "text",
        path: resolvedPath,
        name: baseName,
        ext,
        size: fileStat.size,
        mime,
        lang,
        content,
      };
      res.json(payload);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "Failed to read file") });
    }
  });

  // Write/overwrite a text file's content. Used by the file-preview modal's
  // edit mode. Only text-classified files are writable, and only when the file
  // already exists (we never create files via this endpoint to keep the surface
  // narrow). Atomic via tmp-file + rename to avoid partial writes.
  const MAX_TEXT_WRITE_SIZE = 1024 * 1024; // 1 MB cap for safety
  app.post("/api/file-write", express.json({ limit: "2mb" }), async (req, res) => {
    const body = (req.body ?? {}) as { path?: unknown; content?: unknown };
    const filePath = typeof body.path === "string" ? body.path : "";
    const content = typeof body.content === "string" ? body.content : null;
    if (!filePath || content === null) {
      res.status(400).json({ error: "缺少 path 或 content 参数。" });
      return;
    }

    const resolvedPath = path.resolve(filePath);
    if (isBlockedFolderPath(resolvedPath)) {
      res.status(403).json({ error: "访问被拒绝：无法修改系统目录下的文件。" });
      return;
    }

    // Encode-size check (UTF-8 byte length, not character length).
    const byteLength = Buffer.byteLength(content, "utf-8");
    if (byteLength > MAX_TEXT_WRITE_SIZE) {
      res.status(413).json({
        error: `内容超出保存上限（${Math.round(MAX_TEXT_WRITE_SIZE / 1024)} KB）。`,
        size: byteLength,
        maxSize: MAX_TEXT_WRITE_SIZE,
      });
      return;
    }

    try {
      const fileStat = await stat(resolvedPath);
      if (fileStat.isDirectory()) {
        res.status(400).json({ error: "目标是目录，无法写入。" });
        return;
      }
      if (!fileStat.isFile()) {
        res.status(400).json({ error: "目标不是普通文件。" });
        return;
      }

      const ext = path.extname(resolvedPath).toLowerCase();
      const baseName = path.basename(resolvedPath);
      const kind = classifyFile(ext, baseName);
      if (kind !== "text") {
        res.status(415).json({ error: "仅支持编辑文本类文件。" });
        return;
      }

      // Atomic write: dump to a sibling temp file, then rename.
      const dir = path.dirname(resolvedPath);
      const tmpPath = path.join(
        dir,
        `.${baseName}.wand-tmp-${crypto.randomBytes(6).toString("hex")}`,
      );
      try {
        await writeFile(tmpPath, content, { encoding: "utf-8", mode: fileStat.mode & 0o777 });
        await rename(tmpPath, resolvedPath);
      } catch (writeError) {
        // Best-effort cleanup if rename failed but tmp got created.
        try { await unlink(tmpPath); } catch {}
        throw writeError;
      }

      const newStat = await stat(resolvedPath);
      res.json({
        ok: true,
        path: resolvedPath,
        size: newStat.size,
        mtime: newStat.mtime.toISOString(),
      });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "保存文件失败。") });
    }
  });

  // Streams the raw bytes of a file for inline media previews (image/PDF/video/audio)
  // and downloads. Honors HTTP Range so video/audio scrubbing works.
  const RAW_MAX_BYTES_BY_KIND: Record<FilePreviewKind, number> = {
    text: 5 * 1024 * 1024,
    image: 50 * 1024 * 1024,
    pdf: 50 * 1024 * 1024,
    video: 200 * 1024 * 1024,
    audio: 200 * 1024 * 1024,
    binary: 50 * 1024 * 1024,
  };

  app.get("/api/file-raw", async (req, res) => {
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    const asDownload = req.query.download === "1" || req.query.download === "true";
    if (!filePath) {
      res.status(400).json({ error: "Missing path parameter" });
      return;
    }

    const resolvedPath = path.resolve(filePath);
    if (isBlockedFolderPath(resolvedPath)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    try {
      const fileStat = await stat(resolvedPath);
      if (!fileStat.isFile()) {
        res.status(400).json({ error: "Not a regular file" });
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const baseName = path.basename(filePath);
      const kind = classifyFile(ext, baseName);
      const cap = RAW_MAX_BYTES_BY_KIND[kind] ?? RAW_MAX_BYTES_BY_KIND.binary;
      if (fileStat.size > cap) {
        res.status(413).json({
          error: `文件超出可在线预览的上限（${Math.round(cap / 1024 / 1024)} MB）。`,
          size: fileStat.size,
          maxSize: cap,
        });
        return;
      }

      const mime = mimeForExt(ext);
      // SVG can be served with its proper type; binary fallback uses octet-stream.
      const contentType = kind === "binary" ? "application/octet-stream" : mime;

      // Encode the filename for Content-Disposition (RFC 5987).
      const encodedName = encodeURIComponent(baseName);
      const disposition = asDownload
        ? `attachment; filename*=UTF-8''${encodedName}`
        : `inline; filename*=UTF-8''${encodedName}`;

      streamFileWithRange(req, res, {
        filePath: resolvedPath,
        size: fileStat.size,
        contentType,
        disposition,
        headers: {
          "Cache-Control": "private, max-age=60",
          "X-Content-Type-Options": "nosniff",
        },
        readErrorMessage: "Failed to read file",
      });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "Failed to read file") });
    }
  });

  app.get("/api/folders", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "/tmp";
    const targetPath = normalizeFolderPath(q);

    if (isBlockedFolderPath(targetPath)) {
      res.status(403).json({ error: "访问被拒绝：无法访问系统敏感目录。" });
      return;
    }

    try {
      const entries = await readdir(targetPath, { withFileTypes: true });
      const items: any[] = [];

      const parentPath = path.dirname(targetPath);
      if (parentPath !== targetPath) {
        items.push({ path: parentPath, name: "..", type: "parent", isParent: true });
      }

      entries
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 100)
        .forEach((entry) => {
          items.push({ path: path.join(targetPath, entry.name), name: entry.name, type: "dir" });
        });

      res.json({ currentPath: targetPath, items });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") {
        res.status(404).json({ error: "路径不存在：" + q, currentPath: q, items: [] });
      } else if (code === "EACCES") {
        res.status(403).json({ error: "权限不足，无法访问：" + q, currentPath: q, items: [] });
      } else {
        res.status(400).json({ error: "无法读取目录：" + getErrorMessage(error, "未知错误"), currentPath: q, items: [] });
      }
    }
  });

  app.get("/api/quick-paths", async (_req, res) => {
    const home = process.env.HOME || process.env.USERPROFILE || "/home";
    res.json([
      { path: "/tmp", name: "临时目录", icon: "🗑️" },
      { path: home, name: "主目录", icon: "🏠" },
      { path: process.cwd(), name: "当前目录", icon: "📂" },
      { path: "/", name: "根目录", icon: "📁" },
    ]);
  });

  app.get("/api/recent-paths", (_req, res) => {
    const stored = storage.getConfigValue("recent_paths");
    const recent = parseStoredPathList<RecentPath>(stored);
    res.json(recent.filter((item) => !isBlockedFolderPath(normalizeFolderPath(item.path))));
  });

  app.post("/api/recent-paths", (req, res) => {
    const { path: usedPath } = req.body as { path?: string };
    if (!usedPath) {
      res.status(400).json({ error: "路径不能为空。" });
      return;
    }
    const resolvedRecentPath = normalizeFolderPath(usedPath);
    if (isBlockedFolderPath(resolvedRecentPath)) {
      res.status(403).json({ error: "访问被拒绝：无法保存系统敏感目录。" });
      return;
    }
    recordRecentPath(storage, resolvedRecentPath);
    res.json({
      path: resolvedRecentPath,
      name: path.basename(resolvedRecentPath),
      lastUsedAt: new Date().toISOString(),
    });
  });

  app.get("/api/validate-path", async (req, res) => {
    const inputPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!inputPath.trim()) {
      res.json({ valid: false, error: "路径不能为空" });
      return;
    }
    try {
      const resolvedPath = normalizeFolderPath(inputPath);
      if (isBlockedFolderPath(resolvedPath)) {
        res.json({ valid: false, error: "访问被拒绝：无法访问系统敏感目录。", resolvedPath });
        return;
      }
      const stats = await import("node:fs/promises").then((fs) => fs.stat(resolvedPath));
      if (!stats.isDirectory()) {
        res.json({ valid: false, error: "路径不是目录", resolvedPath });
        return;
      }
      try {
        await readdir(resolvedPath);
        res.json({ valid: true, resolvedPath, name: path.basename(resolvedPath) });
      } catch {
        res.json({ valid: false, error: "没有读取权限", resolvedPath });
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        res.json({ valid: false, error: "路径不存在" });
      } else if (err.code === "EACCES") {
        res.json({ valid: false, error: "没有访问权限" });
      } else {
        res.json({ valid: false, error: `无效路径: ${err.message}` });
      }
    }
  });

  app.get("/api/file-search", async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q : "";
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : process.cwd();
    const maxDepth = typeof req.query.depth === "string" ? parseInt(req.query.depth, 10) : 5;
    const maxResults = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;

    const allowedBase = process.cwd();
    const resolvedCwd = path.resolve(allowedBase, cwd);
    if (!isPathWithinBase(resolvedCwd, allowedBase)) {
      res.status(403).json({ error: "访问被拒绝：路径必须在项目目录内。" });
      return;
    }

    if (!query) {
      res.json({ results: [], query: "", cwd: resolvedCwd });
      return;
    }

    try {
      const results: Array<{ path: string; name: string; type: "dir" | "file"; matchScore: number }> = [];
      const queryLower = query.toLowerCase();

      async function searchDir(dirPath: string, currentDepth: number): Promise<void> {
        if (currentDepth > maxDepth || results.length >= maxResults) return;
        const entries = await readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= maxResults) break;
          const entryPath = path.join(dirPath, entry.name);
          const nameLower = entry.name.toLowerCase();
          const matchIndex = nameLower.indexOf(queryLower);
          if (matchIndex !== -1) {
            results.push({
              path: entryPath,
              name: entry.name,
              type: entry.isDirectory() ? "dir" : "file",
              matchScore: matchIndex,
            });
          }
          if (entry.isDirectory()) {
            await searchDir(entryPath, currentDepth + 1);
          }
        }
      }

      await searchDir(resolvedCwd, 0);
      results.sort((a, b) => {
        if (a.matchScore !== b.matchScore) return a.matchScore - b.matchScore;
        return a.name.localeCompare(b.name);
      });
      res.json({ results: results.slice(0, maxResults), query, cwd: resolvedCwd });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "搜索失败。可能原因：路径不存在或权限不足。") });
    }
  });

  // ── Session control ──

  app.post("/api/commands", (req, res) => {
    const body = req.body as CommandRequest;
    if (!body.command?.trim()) {
      res.status(400).json({ error: "请输入要执行的命令。" });
      return;
    }
    const initialInput = body.initialInput?.trim();
    try {
      const rawModel = typeof body.model === "string" ? body.model.trim() : "";
      const provider: SessionProvider = body.provider === "codex" || /^codex\b/.test(body.command.trim()) ? "codex" : "claude";
      const effectiveModel = rawModel || getDefaultModelForProvider(config, provider) || undefined;
      const reqCols = typeof body.cols === "number" && Number.isFinite(body.cols) ? body.cols : undefined;
      const reqRows = typeof body.rows === "number" && Number.isFinite(body.rows) ? body.rows : undefined;
      const snapshot = processes.start(
        body.command,
        body.cwd,
        normalizeMode(body.mode, config.defaultMode),
        initialInput || undefined,
        {
          worktreeEnabled: body.worktreeEnabled === true,
          provider,
          model: effectiveModel,
          cols: reqCols,
          rows: reqRows,
          thinkingEffort: body.thinkingEffort ?? config.defaultThinkingEffort,
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
    perMessageDeflate: {
      zlibDeflateOptions: { level: 1 },
      threshold: 512,
      concurrencyLimit: 10,
    },
  });
  const wsManager = new WsBroadcastManager(wss, () => config.cardDefaults ?? {}, useHttps);
  wsManager.setup((id) => structuredSessions.get(id) ?? processes.get(id));
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
    try {
      wss.clients.forEach((client) => client.close());
    } catch {
      /* noop */
    }
    server.close(() => {
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
    setTimeout(() => process.exit(0), 5000);
  }

  app.post("/api/restart", async (_req, res) => {
    res.json({ ok: true, message: "服务正在重启..." });
    wsManager.emitEvent({
      type: "notification",
      sessionId: "__system__",
      data: { kind: "restart" },
    });
    setTimeout(() => {
      relaunchAfterShutdown();
    }, 600);
  });

  let bindAddr = config.host === "0.0.0.0" ? "0.0.0.0" : config.host;
  const collectedUrls: ServerUrl[] = [];

  await new Promise<void>((resolve, reject) => {
    const cleanupFailedListen = (): void => {
      try { wss.close(); } catch { /* noop */ }
      try { server.close(); } catch { /* noop */ }
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
    refreshModels().catch(() => {});
  }

  // ── Auto-update endpoints ──

  app.get("/api/auto-update", (_req, res) => {
    const web = storage.getConfigValue("autoUpdateWeb") === "true";
    const apk = storage.getConfigValue("autoUpdateApk") === "true";
    const dmg = storage.getConfigValue("autoUpdateDmg") === "true";
    res.json({ web, apk, dmg });
  });

  app.post("/api/auto-update", express.json(), (req, res) => {
    const { web, apk, dmg } = req.body as { web?: boolean; apk?: boolean; dmg?: boolean };
    if (typeof web === "boolean") {
      storage.setConfigValue("autoUpdateWeb", String(web));
    }
    if (typeof apk === "boolean") {
      storage.setConfigValue("autoUpdateApk", String(apk));
    }
    if (typeof dmg === "boolean") {
      storage.setConfigValue("autoUpdateDmg", String(dmg));
    }
    res.json({
      web: storage.getConfigValue("autoUpdateWeb") === "true",
      apk: storage.getConfigValue("autoUpdateApk") === "true",
      dmg: storage.getConfigValue("autoUpdateDmg") === "true",
    });
  });

  // ── Update channel (stable / beta) ──

  app.get("/api/update-channel", (_req, res) => {
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

  app.post("/api/update-channel", express.json(), (req, res) => {
    const body = (req.body ?? {}) as { channel?: string };
    const channel = body.channel === "beta" ? "beta" : "stable";
    storage.setConfigValue("updateChannel", channel);
    res.json({ channel });
  });

  // ── Auto-update logic ──

  async function performAutoUpdate(): Promise<void> {
    const channel = getUpdateChannel();
    const info = await checkLatestPackageVersion(channel, true);
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
      data: { kind: "auto-update-start", current: info.current, latest: info.latest },
    });

    try {
      await npmInstallGlobal(info.installSpec, 120000);
      // 镜像 install.sh：装完用全局安装刷新服务 unit（ExecStart/PATH），重启才会跑到新版。
      const repair = repairServiceUnitAfterUpdate(configPath);
      if (repair.scope) process.stdout.write(`[wand] ${repair.message}\n`);
      process.stdout.write(`[wand] 自动更新完成，正在重启...\n`);
      wsManager.emitEvent({
        type: "notification",
        sessionId: "__system__",
        data: { kind: "auto-update-restart", current: info.current, latest: info.latest },
      });
      // Restart after a brief delay
      setTimeout(() => {
        relaunchAfterShutdown();
      }, 1000);
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

  let updateCheckTimer: NodeJS.Timeout | null = null;
  if (updateChecksEnabled) {
    // Background update check on startup
    performAutoUpdate().catch(() => {});

    // Periodic update check (every 30 minutes)
    updateCheckTimer = setInterval(() => {
      performAutoUpdate().catch(() => {});
    }, 30 * 60 * 1000);
    updateCheckTimer.unref();
  }

  const close = (): Promise<void> => new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { storage.close(); } catch { /* ignore */ }
      resolve();
    };
    try { wss.clients.forEach((c) => c.close()); } catch { /* ignore */ }
    try { wss.close(); } catch { /* ignore */ }
    if (updateCheckTimer) clearInterval(updateCheckTimer);
    try {
      server.close(() => finish());
    } catch {
      finish();
      return;
    }
    setTimeout(finish, 3000); // 兜底：3s 内未关完强制 resolve
  });

  return {
    processManager: processes,
    structuredSessions,
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
