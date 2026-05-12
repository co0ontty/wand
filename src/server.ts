import crypto from "node:crypto";
import compression from "compression";
import express, { NextFunction, Request, Response } from "express";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";
import { WebSocketServer } from "ws";
import { ensureAvatarSeed, getAvatarSvg } from "./avatar.js";
import { createSession, revokeSession, setAuthStorage, validateSession } from "./auth.js";
import { ensureCertificates } from "./cert.js";
import { buildChildEnv } from "./env-utils.js";
import {
  isExecutionMode,
  PREFERENCE_KEYS,
  resolveConfigDir,
  saveConfig,
  writePreferenceToStorage,
} from "./config.js";
import { getCachedModels, refreshModels } from "./models.js";
import { ProcessManager, ProcessEvent } from "./process-manager.js";
import { SessionLogger } from "./session-logger.js";
import { StructuredSessionManager } from "./structured-session-manager.js";
import { generatePwaManifest, generateServiceWorker } from "./pwa.js";
import { getErrorMessage, registerClaudeHistoryRoutes, registerSessionRoutes } from "./server-session-routes.js";
import { installPackageGloballyAsync } from "./npm-update-utils.js";
import { registerUploadRoutes } from "./upload-routes.js";
import { optimizePrompt, PromptOptimizeError } from "./prompt-optimizer.js";
import { resolveDatabasePath, WandStorage } from "./storage.js";
import { isLogBusActive, wandTuiLog } from "./tui/log-bus.js";
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

let cachedLatestVersion: string | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Cached update result broadcast to new clients on connect. */
let cachedUpdateInfo: { current: string; latest: string; updateAvailable: boolean } | null = null;

async function checkNpmLatestVersion(forceRefresh = false): Promise<{ current: string; latest: string; updateAvailable: boolean }> {
  const now = Date.now();
  if (forceRefresh || !cachedLatestVersion || (now - cacheTimestamp > CACHE_TTL_MS)) {
    try {
      const { stdout } = await execAsync(`npm view ${PKG_NAME} version`, { timeout: 15000 });
      cachedLatestVersion = stdout.trim();
      cacheTimestamp = now;
    } catch {
      cachedLatestVersion = null;
    }
  }
  const latest = cachedLatestVersion || PKG_VERSION;
  return {
    current: PKG_VERSION,
    latest,
    updateAvailable: latest !== PKG_VERSION && compareSemver(latest, PKG_VERSION) > 0,
  };
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, ...rest] = v.split("-");
    const pre = rest.join("-");
    const mainParts = main.split(".").map((n) => Number(n) || 0);
    return { mainParts, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.mainParts[i] || 0) - (pb.mainParts[i] || 0);
    if (diff !== 0) return diff;
  }
  // Main version equal — apply semver prerelease rule: no prerelease > with prerelease.
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && !pb.pre) return 0;
  // Both have prerelease: lexical compare handles debug.MMDDHHMM ordering.
  if (pa.pre < pb.pre) return -1;
  if (pa.pre > pb.pre) return 1;
  return 0;
}

// ── Android APK update check cache ──

interface GitHubApkInfo {
  version: string;
  downloadUrl: string;
  fileName: string;
  size: number;
}

let cachedGitHubApk: GitHubApkInfo | null = null;
let gitHubApkCacheTs = 0;
const GITHUB_APK_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchGitHubLatestApk(forceRefresh = false): Promise<GitHubApkInfo | null> {
  const now = Date.now();
  if (!forceRefresh && cachedGitHubApk && (now - gitHubApkCacheTs < GITHUB_APK_CACHE_TTL)) {
    return cachedGitHubApk;
  }
  try {
    const apiUrl = PKG_REPO_URL.replace("github.com", "api.github.com/repos") + "/releases/latest";
    const resp = await fetch(apiUrl, {
      headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "wand-server" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return cachedGitHubApk ?? null;
    const release = await resp.json() as {
      tag_name: string;
      assets: Array<{ name: string; browser_download_url: string; size: number }>;
    };
    const apkAsset = release.assets.find(a => a.name.toLowerCase().endsWith(".apk"));
    if (!apkAsset) return cachedGitHubApk ?? null;
    const version = extractAndroidApkVersion(release.tag_name) ?? release.tag_name.replace(/^v/, "");
    cachedGitHubApk = {
      version,
      downloadUrl: apkAsset.browser_download_url,
      fileName: apkAsset.name,
      size: apkAsset.size,
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
}

async function resolveLatestApkVersion(configDir: string, config: WandConfig): Promise<ResolvedApkVersion | null> {
  // Priority 1: local APK file
  const localApk = await resolveAndroidApkAsset(configDir, config);
  if (localApk && localApk.version) {
    return {
      version: localApk.version,
      downloadUrl: localApk.downloadUrl,
      fileName: localApk.fileName,
      size: localApk.size,
      source: "local",
    };
  }
  // Priority 2: GitHub Release
  const ghApk = await fetchGitHubLatestApk();
  if (ghApk) {
    return {
      version: ghApk.version,
      downloadUrl: ghApk.downloadUrl,
      fileName: ghApk.fileName,
      size: ghApk.size,
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

async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    await execAsync("git rev-parse --is-inside-work-tree", { cwd: dirPath });
    return true;
  } catch {
    return false;
  }
}

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

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!validateSession(readSessionCookie(req))) {
    res.status(401).json({ error: "未授权，请先登录。" });
    return;
  }
  next();
}

function readSessionCookie(req: { headers: { cookie?: string } }): string | undefined {
  const cookie = req.headers.cookie;
  if (!cookie) return undefined;
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("wand_session="));
  return match?.slice("wand_session=".length);
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

function normalizeMode(input: string | undefined, fallback: ExecutionMode): ExecutionMode {
  return isExecutionMode(input) ? input : fallback;
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

function resolveAndroidApkDir(configDir: string, config: WandConfig): string {
  const configuredDir = config.android?.apkDir?.trim();
  if (!configuredDir) {
    return path.join(configDir, "android");
  }
  return path.isAbsolute(configuredDir) ? configuredDir : path.resolve(configDir, configuredDir);
}

function extractAndroidApkVersion(fileName: string): string | null {
  const nameWithoutExt = fileName.replace(/\.apk$/i, "");
  const match = nameWithoutExt.match(/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/);
  return match ? match[1] : null;
}

async function resolveAndroidApkAsset(configDir: string, config: WandConfig): Promise<AndroidApkAsset | null> {
  if (config.android?.enabled !== true) return null;
  const apkDir = resolveAndroidApkDir(configDir, config);
  await mkdir(apkDir, { recursive: true });

  const configuredFile = config.android?.currentApkFile?.trim();
  if (configuredFile) {
    const filePath = path.join(apkDir, path.basename(configuredFile));
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return null;
      return {
        fileName: path.basename(filePath),
        filePath,
        size: fileStat.size,
        updatedAt: fileStat.mtime.toISOString(),
        version: extractAndroidApkVersion(path.basename(filePath)),
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

  const candidates = await Promise.all(apkFiles.map(async (entry) => {
    const filePath = path.join(apkDir, entry.name);
    const fileStat = await stat(filePath);
    return {
      entry,
      filePath,
      fileStat,
    };
  }));
  candidates.sort((a, b) => b.fileStat.mtimeMs - a.fileStat.mtimeMs);
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

async function listPathSuggestions(input: string, fallbackCwd: string): Promise<PathSuggestion[]> {
  const normalizedInput = input.trim();
  const baseInput = normalizedInput || fallbackCwd;
  const resolvedInput = path.resolve(process.cwd(), baseInput);
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
  const msg = reason instanceof Error ? reason.message : String(reason);
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

/** Hidden files that should still surface even when "show hidden" is off. */
const HIDDEN_ALLOWLIST = new Set<string>([
  ".gitignore", ".gitattributes", ".gitmodules",
  ".env", ".env.local", ".env.example",
  ".editorconfig", ".prettierrc", ".eslintrc",
  ".dockerignore", ".npmrc", ".nvmrc",
  ".browserslistrc", ".babelrc",
]);

function isHiddenEntry(name: string): boolean {
  if (!name.startsWith(".")) return false;
  if (HIDDEN_ALLOWLIST.has(name)) return false;
  // Common patterns like `.env.production` are also kept visible
  for (const allowed of HIDDEN_ALLOWLIST) {
    if (name.startsWith(allowed + ".")) return false;
  }
  return true;
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
  close(): Promise<void>;
}

export async function startServer(config: WandConfig, configPath: string): Promise<ServerHandle> {
  const app = express();
  const storage = new WandStorage(resolveDatabasePath(configPath));
  setAuthStorage(storage);
  const configDir = resolveConfigDir(configPath);
  const avatarSeed = await ensureAvatarSeed(configDir);
  const processes = new ProcessManager(config, storage, configDir);
  const structuredLogger = new SessionLogger(configDir, config.shortcutLogMaxBytes);
  const structuredSessions = new StructuredSessionManager(storage, config, structuredLogger);
  const useHttps = config.https === true;
  const protocol = useHttps ? "https" : "http";
  const nodeModulesDir = path.join(RUNTIME_ROOT_DIR, "node_modules");

  app.use(express.json({ limit: "1mb" }));
  app.use(compression({ threshold: 1024 }));

  const vendorCacheOpts = { maxAge: "7d", immutable: true };
  const contentDir = existsSync(path.join(SERVER_MODULE_DIR, "web-ui", "content"))
    ? path.join(SERVER_MODULE_DIR, "web-ui", "content")
    : path.join(RUNTIME_ROOT_DIR, "src", "web-ui", "content");
  app.use("/vendor/wterm", express.static(path.join(contentDir, "vendor", "wterm"), vendorCacheOpts));
  app.use("/vendor/qrcode", express.static(path.join(contentDir, "vendor", "qrcode"), vendorCacheOpts));

  // ── Web UI and PWA endpoints ──

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

  app.get("/manifest.json", (_req, res) => {
    res.setHeader("Content-Type", "application/manifest+json");
    res.send(generatePwaManifest());
  });

  for (const [route, size] of [["/icon.svg", 192], ["/icon-192.png", 192], ["/icon-512.png", 512]] as const) {
    app.get(route, (_req, res) => {
      res.type("image/svg+xml").send(getAvatarSvg(avatarSeed, size));
    });
  }

  const iconsDir = path.resolve(
    existsSync(path.join(SERVER_MODULE_DIR, "web-ui", "content"))
      ? path.join(SERVER_MODULE_DIR, "web-ui", "content")
      : path.join(RUNTIME_ROOT_DIR, "src", "web-ui", "content")
  );

  app.get("/sw.js", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Service-Worker-Allowed", "/");
    res.send(generateServiceWorker());
  });

  app.get("/offline", (_req, res) => {
    res.type("html").send(renderApp(configPath));
  });

  // ── Auth routes ──

  app.post("/api/login", (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    if (!checkRateLimit(clientIp)) {
      res.status(429).json({ error: "登录尝试次数过多，请在 15 分钟后再试。" });
      return;
    }

    const { password, appToken } = req.body as { password?: string; appToken?: string };
    const dbPassword = storage.getPassword();
    const effectivePassword = dbPassword ?? config.password;

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
    res.cookie("wand_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: useHttps,
      maxAge: 1000 * 60 * 60 * 12,
    });
    res.json({ ok: true });
  });

  app.post("/api/logout", (req, res) => {
    revokeSession(readSessionCookie(req));
    res.clearCookie("wand_session");
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
    const latest = await resolveLatestApkVersion(configDir, config);
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

  app.get("/android/download", async (_req, res) => {
    const androidApk = await resolveAndroidApkAsset(configDir, config);
    if (config.android?.enabled !== true) {
      res.status(404).json({ error: "Android APK 下载未启用。" });
      return;
    }
    if (!androidApk) {
      res.status(404).json({ error: "当前没有可下载的 APK 文件。" });
      return;
    }
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Length", String(androidApk.size));
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(androidApk.fileName)}"`);
    createReadStream(androidApk.filePath).pipe(res);
  });

  app.use("/api", requireAuth);

  // ── Config & Session info ──

  app.get("/api/config", async (_req, res) => {
    const structuredChatPersona = await buildStructuredChatPersonaPayload(configPath, config);
    res.json({
      host: config.host,
      port: config.port,
      defaultMode: config.defaultMode,
      defaultCwd: config.defaultCwd,
      commandPresets: config.commandPresets,
      structuredRunner: config.structuredRunner ?? "cli",
      structuredRunners: [
        { label: "Claude Structured", runner: "claude-cli-print" },
        { label: "Codex Structured", runner: "codex-cli-exec" },
      ],
      structuredChatPersona,
      cardDefaults: config.cardDefaults,
      updateAvailable: cachedUpdateInfo?.updateAvailable ?? false,
      latestVersion: cachedUpdateInfo?.latest ?? null,
      currentVersion: PKG_VERSION,
    });
  });

  // ── Settings endpoints ──

  app.get("/api/settings", async (_req, res) => {
    const certPaths = {
      keyPath: path.join(configDir, "server.key"),
      certPath: path.join(configDir, "server.crt"),
    };
    const { password: _pw, ...safeConfig } = config;
    const localApk = await resolveAndroidApkAsset(configDir, config);
    const ghApk = await fetchGitHubLatestApk();
    const apkDir = resolveAndroidApkDir(configDir, config);
    // Backward-compatible: pick best available for hasApk/version/downloadUrl
    const resolvedApk = localApk
      ? { hasApk: true, fileName: localApk.fileName, version: localApk.version, size: localApk.size, updatedAt: localApk.updatedAt, downloadUrl: localApk.downloadUrl, source: "local" as const }
      : ghApk
        ? { hasApk: true, fileName: ghApk.fileName, version: ghApk.version, size: ghApk.size, updatedAt: null, downloadUrl: ghApk.downloadUrl, source: "github" as const }
        : null;
    res.json({
      version: PKG_VERSION,
      packageName: PKG_NAME,
      nodeVersion: PKG_NODE_REQ,
      repoUrl: PKG_REPO_URL,
      config: safeConfig,
      hasCert: existsSync(certPaths.keyPath) && existsSync(certPaths.certPath),
      updateAvailable: cachedUpdateInfo?.updateAvailable ?? false,
      latestVersion: cachedUpdateInfo?.latest ?? null,
      autoUpdate: {
        web: storage.getConfigValue("autoUpdateWeb") === "true",
        apk: storage.getConfigValue("autoUpdateApk") === "true",
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
    });
  });

  app.get("/api/android-apk", async (_req, res) => {
    const localApk = await resolveAndroidApkAsset(configDir, config);
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
    const dbPassword = storage.getPassword();
    const effectivePassword = dbPassword ?? config.password;
    const protocol = useHttps ? "https" : "http";
    const host = req.headers.host || `${config.host}:${config.port}`;
    const serverUrl = `${protocol}://${host}`;
    const appSecret = config.appSecret ?? "";
    const token = generateAppToken(effectivePassword, appSecret);
    const code = encodeConnectCode(serverUrl, token);
    res.json({ code });
  });

  app.post("/api/settings/config", async (req, res) => {
    const body = req.body as Partial<WandConfig>;
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
      // 只有部署字段才需要重启；偏好字段已经热生效。
      res.json({ ok: true, config: safeConfig, restartRequired: touchedDeployField });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "保存配置失败。") });
    }
  });

  app.get("/api/models", (_req, res) => {
    const cached = getCachedModels();
    res.json({
      models: cached.models,
      codexModels: cached.codexModels,
      claudeVersion: cached.claudeVersion,
      refreshedAt: cached.refreshedAt,
      defaultModel: config.defaultModel ?? "",
    });
  });

  app.post("/api/models/refresh", async (_req, res) => {
    try {
      const refreshed = await refreshModels();
      res.json({
        models: refreshed.models,
        codexModels: refreshed.codexModels,
        claudeVersion: refreshed.claudeVersion,
        refreshedAt: refreshed.refreshedAt,
        defaultModel: config.defaultModel ?? "",
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

  app.get("/api/check-update", async (_req, res) => {
    try {
      const result = await checkNpmLatestVersion(true);
      res.json(result);
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
      const { updateAvailable, latest } = await checkNpmLatestVersion(true);
      if (!updateAvailable) {
        res.json({ ok: true, message: "已经是最新版本。" });
        return;
      }
      await npmInstallGlobal(`${PKG_NAME}@latest`, 120000);
      // 装包成功后告知前端可以发起重启；前端会随即调用 /api/restart 完成自动重启。
      res.json({
        ok: true,
        message: `已更新到 ${latest}`,
        restartRequired: true,
        version: latest,
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
    const showHidden = req.query.showHidden === "true";
    const targetPath = path.resolve(q || config.defaultCwd);
    if (isBlockedFolderPath(targetPath)) {
      res.status(403).json({ error: "访问被拒绝：无法访问系统敏感目录。" });
      return;
    }

    try {
      const entries = await readdir(targetPath, { withFileTypes: true });
      const visible = showHidden ? entries : entries.filter((e) => !isHiddenEntry(e.name));
      const sorted = visible.sort((a, b) => {
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

      const total = fileStat.size;
      const range = req.headers.range;
      // Safe to cache raw bytes briefly inside the user's browser.
      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", disposition);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("X-Content-Type-Options", "nosniff");

      if (range && /^bytes=/.test(range)) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) {
          res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
          return;
        }
        const startStr = match[1];
        const endStr = match[2];
        let start = startStr === "" ? 0 : parseInt(startStr, 10);
        let end = endStr === "" ? total - 1 : parseInt(endStr, 10);
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= total) {
          res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
          return;
        }
        const chunkSize = end - start + 1;
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        res.setHeader("Content-Length", String(chunkSize));
        const stream = createReadStream(resolvedPath, { start, end });
        stream.on("error", () => res.destroy());
        stream.pipe(res);
        return;
      }

      res.setHeader("Content-Length", String(total));
      const stream = createReadStream(resolvedPath);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
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
    } catch (error: any) {
      if (error.code === "ENOENT") {
        res.status(404).json({ error: "路径不存在：" + q, currentPath: q, items: [] });
      } else if (error.code === "EACCES") {
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
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
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
      const effectiveModel = rawModel || (config.defaultModel ?? "").trim() || undefined;
      const reqCols = typeof body.cols === "number" && Number.isFinite(body.cols) ? body.cols : undefined;
      const reqRows = typeof body.rows === "number" && Number.isFinite(body.rows) ? body.rows : undefined;
      const snapshot = processes.start(
        body.command,
        body.cwd,
        normalizeMode(body.mode, config.defaultMode),
        initialInput || undefined,
        {
          worktreeEnabled: body.worktreeEnabled === true,
          provider: body.provider,
          model: effectiveModel,
          cols: reqCols,
          rows: reqRows,
        }
      );
      recordRecentPath(storage, body.cwd ?? snapshot.cwd);
      res.status(201).json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法启动命令。请检查命令是否安装。") });
    }
  });

  // ── WebSocket broadcast layer ──

  const server = useHttps
    ? (() => {
        const ssl = ensureCertificates(resolveConfigDir(configPath));
        return createHttpsServer({ key: ssl.key, cert: ssl.cert }, app);
      })()
    : createHttpServer(app);

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    perMessageDeflate: {
      zlibDeflateOptions: { level: 1 },
      threshold: 512,
      concurrencyLimit: 10,
    },
  });
  const wsManager = new WsBroadcastManager(wss, () => config.cardDefaults ?? {});
  wsManager.setup((id) => structuredSessions.get(id) ?? processes.get(id));

  // Wire process events to WebSocket broadcast
  processes.on("process", (event: ProcessEvent) => {
    wsManager.emitEvent(event);
  });
  structuredSessions.setEventEmitter((event) => {
    wsManager.emitEvent(event);
  });

  // ── Restart endpoint (needs server + wss in scope) ──

  app.post("/api/restart", async (_req, res) => {
    res.json({ ok: true, message: "服务正在重启..." });
    wsManager.emitEvent({
      type: "notification",
      sessionId: "__system__",
      data: { kind: "restart" },
    });
    setTimeout(() => {
      // Close all WebSocket connections first
      wss.clients.forEach((client) => client.close());
      server.close(() => {
        spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
          env: process.env,
        }).unref();
        process.exit(0);
      });
      // Force exit after 5s if graceful shutdown stalls
      setTimeout(() => process.exit(0), 5000);
    }, 600);
  });

  let bindAddr = config.host === "0.0.0.0" ? "0.0.0.0" : config.host;
  const collectedUrls: ServerUrl[] = [];

  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, config.host, () => {
      bindAddr = `${config.host}:${config.port}`;
      const scheme: "HTTP" | "HTTPS" = useHttps ? "HTTPS" : "HTTP";
      // 主 URL：本机回环；若绑定 0.0.0.0 再补一个对外提示。
      collectedUrls.push({ url: `${protocol}://127.0.0.1:${config.port}`, scheme });
      if (config.host === "0.0.0.0") {
        collectedUrls.push({ url: `${protocol}://0.0.0.0:${config.port}`, scheme });
      } else if (config.host !== "127.0.0.1" && config.host !== "localhost") {
        collectedUrls.push({ url: `${protocol}://${config.host}:${config.port}`, scheme });
      }
      resolve();
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        wandError(
          `端口 ${config.port} 已被占用`,
          `可能有另一个 Wand 进程正在运行。`,
          `解决方法（二选一）：\n1. 在浏览器中访问当前运行的 Wand\n2. 或者终止占用端口的进程：\n   kill $(lsof -ti :${config.port})\n\n如果你确定没有其他实例在运行，可能是有程序意外占用了端口。`
        );
        process.exit(1);
      }
      reject(err);
    });
  });

  if (!storage.hasCustomPassword() && config.password === "change-me") {
    wandWarn(
      "正在使用默认密码（change-me），任何能访问本机的人都可以登录。",
      "修改方法：在界面右上角「设置」中修改密码，或运行：node dist/cli.js config:set password <你的新密码>"
    );
  }

  // Start configured background sessions after the server is already reachable.
  processes.runStartupCommands();

  // Pre-warm model cache (probes claude --version + codex debug models).
  refreshModels().catch(() => {});

  // ── Auto-update endpoints ──

  app.get("/api/auto-update", (_req, res) => {
    const web = storage.getConfigValue("autoUpdateWeb") === "true";
    const apk = storage.getConfigValue("autoUpdateApk") === "true";
    res.json({ web, apk });
  });

  app.post("/api/auto-update", express.json(), (req, res) => {
    const { web, apk } = req.body as { web?: boolean; apk?: boolean };
    if (typeof web === "boolean") {
      storage.setConfigValue("autoUpdateWeb", String(web));
    }
    if (typeof apk === "boolean") {
      storage.setConfigValue("autoUpdateApk", String(apk));
    }
    res.json({
      web: storage.getConfigValue("autoUpdateWeb") === "true",
      apk: storage.getConfigValue("autoUpdateApk") === "true",
    });
  });

  // ── Auto-update logic ──

  async function performAutoUpdate(): Promise<void> {
    const info = await checkNpmLatestVersion(true);
    cachedUpdateInfo = info;
    if (!info.updateAvailable) return;

    const autoEnabled = storage.getConfigValue("autoUpdateWeb") === "true";
    if (!autoEnabled) {
      // Not auto-updating, just notify
      process.stdout.write(
        `[wand] 发现新版本 ${info.latest}（当前 ${info.current}）。运行 npm install -g ${PKG_NAME}@latest 进行更新。\n`
      );
      wsManager.emitEvent({
        type: "notification",
        sessionId: "__system__",
        data: { kind: "update", current: info.current, latest: info.latest },
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
      await npmInstallGlobal(`${PKG_NAME}@latest`, 120000);
      process.stdout.write(`[wand] 自动更新完成，正在重启...\n`);
      wsManager.emitEvent({
        type: "notification",
        sessionId: "__system__",
        data: { kind: "auto-update-restart", current: info.current, latest: info.latest },
      });
      // Restart after a brief delay
      setTimeout(() => {
        wss.clients.forEach((client) => client.close());
        server.close(() => {
          spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: process.cwd(),
            env: process.env,
          }).unref();
          process.exit(0);
        });
        setTimeout(() => process.exit(0), 5000);
      }, 1000);
    } catch (error) {
      process.stdout.write(`[wand] 自动更新失败: ${getErrorMessage(error, "未知错误")}\n`);
    }
  }

  // Background update check on startup
  performAutoUpdate().catch(() => {});

  // Periodic update check (every 30 minutes)
  setInterval(() => {
    performAutoUpdate().catch(() => {});
  }, 30 * 60 * 1000);

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
    version: PKG_VERSION,
    orphanRecoveredCount: processes.getOrphanRecoveredCount(),
    close,
  };
}
