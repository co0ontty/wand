import crypto from "node:crypto";
import express, { NextFunction, Request, Response } from "express";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
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
import { isExecutionMode, normalizeCardDefaults, resolveConfigDir, saveConfig } from "./config.js";
import { ProcessManager, ProcessEvent } from "./process-manager.js";
import { StructuredSessionManager } from "./structured-session-manager.js";
import { generatePwaManifest, generateServiceWorker } from "./pwa.js";
import { getErrorMessage, registerClaudeHistoryRoutes, registerSessionRoutes } from "./server-session-routes.js";
import { resolveDatabasePath, WandStorage } from "./storage.js";
import { renderApp } from "./web-ui/index.js";
import { WsBroadcastManager } from "./ws-broadcast.js";
import { checkRateLimit, recordFailedLogin, resetRateLimit } from "./middleware/rate-limit.js";
import { isPathWithinBase, isBlockedFolderPath, normalizeFolderPath } from "./middleware/path-safety.js";
import {
  CommandRequest,
  ExecutionMode,
  FileEntry,
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
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
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
  process.stderr.write(`\n✗ [wand] ${label}：${message}\n`);
  if (suggestion) process.stderr.write(`  解决方法：${suggestion}\n`);
  process.stderr.write("\n");
}

function wandWarn(message: string, hint?: string): void {
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

// ── Main server ──

export async function startServer(config: WandConfig, configPath: string): Promise<void> {
  const app = express();
  const storage = new WandStorage(resolveDatabasePath(configPath));
  setAuthStorage(storage);
  const configDir = resolveConfigDir(configPath);
  const avatarSeed = await ensureAvatarSeed(configDir);
  const processes = new ProcessManager(config, storage, configDir);
  const structuredSessions = new StructuredSessionManager(storage, config);
  const useHttps = config.https === true;
  const protocol = useHttps ? "https" : "http";
  const nodeModulesDir = path.join(RUNTIME_ROOT_DIR, "node_modules");

  app.use(express.json({ limit: "1mb" }));
  app.use("/vendor/xterm", express.static(path.join(nodeModulesDir, "@xterm", "xterm")));
  app.use("/vendor/xterm-addon-fit", express.static(path.join(nodeModulesDir, "@xterm", "addon-fit")));
  app.use("/vendor/xterm-addon-serialize", express.static(path.join(nodeModulesDir, "@xterm", "addon-serialize")));

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
      structuredRunners: [{ label: "Claude Structured", runner: "claude-cli-print" }],
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
    const allowedFields = ["host", "port", "https", "defaultMode", "defaultCwd", "shell", "language"] as const;
    let changed = false;

    for (const field of allowedFields) {
      if (field in body && body[field] !== undefined) {
        if (field === "port") {
          const p = Number(body.port);
          if (!Number.isInteger(p) || p < 1 || p > 65535) {
            res.status(400).json({ error: `无效端口号: ${body.port}` });
            return;
          }
          config.port = p;
        } else if (field === "https") {
          config.https = body.https === true;
        } else if (field === "defaultMode") {
          if (!isExecutionMode(body.defaultMode)) {
            res.status(400).json({ error: `无效执行模式: ${body.defaultMode}` });
            return;
          }
          config.defaultMode = body.defaultMode;
        } else if (field === "host") {
          config.host = String(body.host);
        } else if (field === "defaultCwd") {
          config.defaultCwd = String(body.defaultCwd);
        } else if (field === "shell") {
          config.shell = String(body.shell);
        } else if (field === "language") {
          config.language = typeof body.language === "string" ? body.language.trim() : "";
        }
        changed = true;
      }
    }

    // Handle cardDefaults separately (nested object, no restart needed)
    if (body.cardDefaults !== undefined) {
      config.cardDefaults = normalizeCardDefaults(body.cardDefaults);
      changed = true;
    }

    if (!changed) {
      res.status(400).json({ error: "没有可更新的配置字段。" });
      return;
    }

    // cardDefaults-only changes don't need restart
    const restartRequired = allowedFields.some((f) => f in body && body[f] !== undefined);

    try {
      await saveConfig(configPath, config);
      const { password: _pw, ...safeConfig } = config;
      res.json({ ok: true, config: safeConfig, restartRequired });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "保存配置失败。") });
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
      await execAsync(`npm install -g ${PKG_NAME}@latest`, { timeout: 120000 });
      res.json({ ok: true, message: `已更新到 ${latest}，请重启 wand 服务以生效。` });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "更新失败。") });
    } finally {
      updateInFlight = false;
    }
  });

  registerSessionRoutes(app, processes, structuredSessions, storage, config.defaultMode);
  registerClaudeHistoryRoutes(app, processes, storage);

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

  app.get("/api/directory", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const includeGitStatus = req.query.gitStatus === "true";
    const targetPath = path.resolve(process.cwd(), q);
    const allowedBase = process.cwd();
    if (!isPathWithinBase(targetPath, allowedBase)) {
      res.status(403).json({ error: "访问被拒绝：路径必须在项目目录内。" });
      return;
    }

    try {
      const entries = await readdir(targetPath, { withFileTypes: true });
      let items: FileEntry[] = entries
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 100)
        .map((entry) => ({
          path: path.join(targetPath, entry.name),
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file" as const,
        }));

      if (includeGitStatus) {
        items = await enrichWithGitStatus(items, targetPath);
      }

      res.json(items);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法读取目录。可能原因：路径不存在或权限不足。") });
    }
  });

  const MAX_FILE_SIZE = 512 * 1024;
  app.get("/api/file-preview", async (req, res) => {
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!filePath) {
      res.status(400).json({ error: "Missing path parameter" });
      return;
    }

    const resolvedPath = path.resolve(filePath);
    const allowedBase = process.cwd();
    if (!isPathWithinBase(resolvedPath, allowedBase)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    try {
      const fileStat = await stat(resolvedPath);
      if (fileStat.isDirectory()) {
        res.status(400).json({ error: "Cannot preview a directory" });
        return;
      }
      if (fileStat.size > MAX_FILE_SIZE) {
        res.status(413).json({ error: "File too large", truncated: true, size: fileStat.size, maxSize: MAX_FILE_SIZE });
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const previewableExts = [
        ".md", ".markdown", ".mdown", ".mkd", ".mkdn",
        ".ts", ".tsx", ".js", ".jsx", ".json", ".html", ".css", ".scss", ".less",
        ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
        ".cs", ".swift", ".kt", ".scala", ".php", ".sh", ".bash", ".zsh",
        ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env",
        ".xml", ".sql", ".graphql", ".proto",
        ".dockerfile", ".gitignore", ".env", ".editorconfig",
        ".mdx", ".vue", ".svelte",
        ".txt", ".log", ".diff", ".patch",
      ];

      const isText = previewableExts.includes(ext) ||
        ext === "" ||
        [".gitignore", "dockerfile", ".env.local", ".env.development"].some((e) => filePath.toLowerCase().endsWith(e));

      if (!isText) {
        res.status(415).json({ error: "Unsupported file type", ext });
        return;
      }

      const content = await readFile(resolvedPath, "utf-8");
      const lang = getLanguageFromExt(ext, filePath);
      res.json({ path: resolvedPath, name: path.basename(filePath), ext, lang, content, size: fileStat.size });
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
    const stored = storage.getConfigValue("recent_paths");
    let recent = parseStoredPathList<RecentPath>(stored);
    recent = recent.filter((r) => normalizeFolderPath(r.path) !== resolvedRecentPath);
    const newRecent: RecentPath = {
      path: resolvedRecentPath,
      name: path.basename(resolvedRecentPath),
      lastUsedAt: new Date().toISOString(),
    };
    recent.unshift(newRecent);
    recent = recent.slice(0, MAX_RECENT_PATHS);
    storage.setConfigValue("recent_paths", JSON.stringify(recent));
    res.json(newRecent);
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
      const snapshot = processes.start(
        body.command,
        body.cwd,
        normalizeMode(body.mode, config.defaultMode),
        initialInput || undefined,
        {
          worktreeEnabled: body.worktreeEnabled === true,
          provider: body.provider,
        }
      );
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

  const wss = new WebSocketServer({ server, path: "/ws" });
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

  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, config.host, () => {
      const listenAddr = config.host === "0.0.0.0" ? "0.0.0.0 (所有接口)" : config.host;
      process.stdout.write(
        `[wand] Web console listening on ${listenAddr}:${config.port}\n` +
        `[wand] 本地访问: ${protocol}://127.0.0.1:${config.port}\n`
      );
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

  // Background update check on startup
  checkNpmLatestVersion().then((info) => {
    cachedUpdateInfo = info;
    if (info.updateAvailable) {
      process.stdout.write(
        `[wand] 发现新版本 ${info.latest}（当前 ${info.current}）。运行 npm install -g ${PKG_NAME}@latest 进行更新。\n`
      );
      // Broadcast update notification to all connected WS clients
      wsManager.emitEvent({
        type: "notification",
        sessionId: "__system__",
        data: { kind: "update", current: info.current, latest: info.latest },
      });
    }
  }).catch(() => {});
}
