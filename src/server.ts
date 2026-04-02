import express, { NextFunction, Request, Response } from "express";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";
import { WebSocketServer, WebSocket } from "ws";

const execAsync = promisify(exec);
import { createSession, revokeSession, setAuthStorage, validateSession } from "./auth.js";
import { ensureCertificates } from "./cert.js";
import { isExecutionMode, resolveConfigDir } from "./config.js";
import { ProcessManager, ProcessEvent, SessionInputError } from "./process-manager.js";
import { resolveDatabasePath, WandStorage } from "./storage.js";
import { renderApp } from "./web-ui/index.js";
import {
  CommandRequest,
  ExecutionMode,
  FileEntry,
  GitFileStatus,
  InputRequest,
  PathSuggestion,
  ResizeRequest,
  WandConfig
} from "./types.js";
import { parseMessages } from "./message-parser.js";

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getInputErrorResponse(error: unknown, sessionId: string) {
  if (error instanceof SessionInputError) {
    const statusCode = error.code === "SESSION_NOT_FOUND" ? 404 : 409;
    return {
      statusCode,
      payload: {
        error: error.message,
        errorCode: error.code,
        sessionId,
        sessionStatus: error.sessionStatus ?? null
      }
    };
  }

  return {
    statusCode: 400,
    payload: {
      error: getErrorMessage(error, "会话已结束，请启动新会话。"),
      errorCode: "INPUT_SEND_FAILED",
      sessionId,
      sessionStatus: null
    }
  };
}

function getInputDebugMeta(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { error };
}

function isPathWithinBase(targetPath: string, basePath: string): boolean {
  const relativePath = path.relative(basePath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

const BLOCKED_FOLDER_PATHS = ["/etc", "/root", "/boot"];

function isBlockedFolderPath(targetPath: string): boolean {
  return BLOCKED_FOLDER_PATHS.some((blockedPath) => {
    const relativePath = path.relative(blockedPath, targetPath);
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  });
}

function normalizeFolderPath(inputPath: string): string {
  return path.resolve(inputPath);
}

/**
 * Check if a directory is inside a git repository
 */
async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    await execAsync("git rev-parse --is-inside-work-tree", { cwd: dirPath });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the git repository root directory
 */
async function getGitRepoRoot(dirPath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd: dirPath });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Get git status for all files in a directory
 * Returns a map of relative file paths to their git status
 */
async function getGitStatusMap(gitRoot: string): Promise<Map<string, GitFileStatus>> {
  const statusMap = new Map<string, GitFileStatus>();

  try {
    // Get git status in porcelain format (stable for parsing)
    // -uno: don't list untracked files (we'll get them separately)
    const { stdout: stagedStdout } = await execAsync(
      "git status --porcelain -uno",
      { cwd: gitRoot }
    );

    // Get untracked files separately
    const { stdout: untrackedStdout } = await execAsync(
      "git ls-files --others --exclude-standard",
      { cwd: gitRoot }
    );

    // Parse staged/unstaged changes
    const lines = stagedStdout.split("\n").filter(line => line.trim());
    for (const line of lines) {
      if (line.length < 4) continue;

      const stagedChar = line[0];
      const unstagedChar = line[1];
      const filePath = line.slice(3).trim();

      if (!filePath) continue;

      const status: GitFileStatus = {};

      // Parse staged status
      if (stagedChar === "M") status.staged = "modified";
      else if (stagedChar === "A") status.staged = "added";
      else if (stagedChar === "D") status.staged = "deleted";
      else if (stagedChar === "R") status.staged = "renamed";

      // Parse unstaged status
      if (unstagedChar === "M") status.unstaged = "modified";
      else if (unstagedChar === "D") status.unstaged = "deleted";

      statusMap.set(filePath, status);
    }

    // Parse untracked files
    const untrackedFiles = untrackedStdout.split("\n").filter(line => line.trim());
    for (const filePath of untrackedFiles) {
      const existing = statusMap.get(filePath);
      if (existing) {
        existing.untracked = true;
      } else {
        statusMap.set(filePath, { untracked: true });
      }
    }

    return statusMap;
  } catch (error) {
    // Git command failed, return empty map
    return statusMap;
  }
}

/**
 * Enrich file entries with git status
 */
async function enrichWithGitStatus(
  items: FileEntry[],
  dirPath: string
): Promise<FileEntry[]> {
  try {
    const gitRoot = await getGitRepoRoot(dirPath);
    if (!gitRoot) {
      return items;
    }

    const gitStatusMap = await getGitStatusMap(gitRoot);

    return items.map((item) => {
      // Get path relative to git root
      const relativePath = path.relative(gitRoot, item.path);
      // Normalize path separators for cross-platform compatibility
      const normalizedPath = relativePath.replace(/\\/g, '/');
      const gitStatus = gitStatusMap.get(normalizedPath);

      return {
        ...item,
        gitStatus: gitStatus || undefined
      };
    });
  } catch {
    return items;
  }
}

// Simple in-memory rate limiter for login attempts
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 10; // 10 attempts per window

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record || now > record.resetAt) {
    return true;
  }

  return record.count < RATE_LIMIT_MAX;
}

function recordFailedLogin(ip: string): void {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return;
  }

  record.count++;
}

function resetRateLimit(ip: string): void {
  loginAttempts.delete(ip);
}

function cleanupRateLimiter(): void {
  const now = Date.now();
  for (const [ip, record] of loginAttempts.entries()) {
    if (now > record.resetAt) {
      loginAttempts.delete(ip);
    }
  }
}

// Cleanup rate limiter every 5 minutes
setInterval(cleanupRateLimiter, 5 * 60 * 1000);

// Catch-all for unexpected startup errors
process.on("uncaughtException", (err) => {
  wandError("服务器异常", err.message, "请检查配置是否正确，或尝试重启服务。");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  wandError("未处理的异步错误", msg);
});

// ── Friendly error / warn / info helpers ──────────────────────────────────
function wandError(label: string, message: string, suggestion?: string): void {
  process.stderr.write(`\n✗ [wand] ${label}：${message}\n`);
  if (suggestion) process.stderr.write(`  解决方法：${suggestion}\n`);
  process.stderr.write("\n");
}

function wandWarn(message: string, hint?: string): void {
  process.stderr.write(`⚠️  [wand] 警告：${message}\n`);
  if (hint) process.stderr.write(`  提示：${hint}\n`);
}

function wandInfo(message: string): void {
  process.stdout.write(`ℹ️  [wand] ${message}\n`);
}

export async function startServer(config: WandConfig, configPath: string): Promise<void> {
  const app = express();
  const storage = new WandStorage(resolveDatabasePath(configPath));
  setAuthStorage(storage);
  const processes = new ProcessManager(config, storage, resolveConfigDir(configPath));
  const useHttps = config.https !== false; // Default to true
  const protocol = useHttps ? "https" : "http";

  app.use(express.json({ limit: "1mb" }));
  app.use("/vendor/xterm", express.static(path.resolve(process.cwd(), "node_modules/xterm")));
  app.use("/vendor/xterm-addon-fit", express.static(path.resolve(process.cwd(), "node_modules/@xterm/addon-fit")));

  app.get("/", (_req, res) => {
    res.type("html").send(renderApp(configPath));
  });

  // PWA manifest
  app.get("/manifest.json", (_req, res) => {
    res.type("json").send(JSON.stringify({
      id: "/",
      scope: "/",
      name: "Wand Console",
      short_name: "Wand",
      description: "Local CLI Console for Vibe Coding",
      start_url: "/",
      display: "standalone",
      background_color: "#f6f1e8",
      theme_color: "#c5653d",
      orientation: "any",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }
      ],
      categories: ["developer tools", "productivity"],
      shortcuts: [
        { name: "New Session", url: "/?action=new", description: "Start a new CLI session" }
      ]
    }));
  });

  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
    <defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#d77a52"/>
      <stop offset="100%" style="stop-color:#a95130"/>
    </linearGradient></defs>
    <rect width="192" height="192" rx="38" fill="url(#g)"/>
    <text x="96" y="128" text-anchor="middle" font-family="system-ui,sans-serif" font-size="88" font-weight="700" fill="white">W</text>
  </svg>`;

  app.get("/icon.svg", (_req, res) => {
    res.type("svg").send(iconSvg);
  });

  const iconsDir = path.resolve(
    existsSync(path.join(process.cwd(), "dist", "web-ui", "content"))
      ? path.join(process.cwd(), "dist", "web-ui", "content")
      : path.join(process.cwd(), "src", "web-ui", "content")
  );

  app.get("/icon-192.png", (_req, res) => {
    res.sendFile(path.join(iconsDir, "icon-192.png"), { maxAge: "1y" });
  });

  app.get("/icon-512.png", (_req, res) => {
    res.sendFile(path.join(iconsDir, "icon-512.png"), { maxAge: "1y" });
  });

  // Service Worker for offline support
  app.get("/sw.js", (_req, res) => {
    res.type("javascript").send(`
const STATIC_CACHE = 'wand-static-v2';
const RUNTIME_CACHE = 'wand-runtime-v2';
const APP_SHELL = '/';
const STATIC_ASSETS = [
  APP_SHELL,
  '/manifest.json',
  '/icon.svg',
  '/vendor/xterm/css/xterm.css',
  '/vendor/xterm/lib/xterm.js',
  '/vendor/xterm-addon-fit/lib/addon-fit.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
        .map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && request.method === 'GET') {
    const clone = response.clone();
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, clone);
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET') {
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => new Response(JSON.stringify({ error: 'Offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }))
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(APP_SHELL, clone));
          return response;
        })
        .catch(async () => (await caches.match(APP_SHELL)) || Response.error())
    );
    return;
  }

  event.respondWith(
    cacheFirst(request).catch(async () => {
      const cached = await caches.match(request);
      return cached || (await caches.match(APP_SHELL)) || Response.error();
    })
  );
});
`);
  });

  app.get("/offline", (_req, res) => {
    res.type("html").send(renderApp(configPath));
  });

  app.post("/api/login", (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    if (!checkRateLimit(clientIp)) {
      res.status(429).json({ error: "登录尝试次数过多，请在 15 分钟后再试。" });
      return;
    }

    const { password } = req.body as { password?: string };

    // Check password: prefer database password, fallback to config password
    const dbPassword = storage.getPassword();
    const effectivePassword = dbPassword ?? config.password;

    if (password !== effectivePassword) {
      recordFailedLogin(clientIp);
      res.status(401).json({ error: "密码错误，请重试。" });
      return;
    }

    resetRateLimit(clientIp);
    const token = createSession();
    res.cookie("wand_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: useHttps,
      maxAge: 1000 * 60 * 60 * 12
    });
    res.json({ ok: true });
  });

  app.post("/api/logout", (req, res) => {
    revokeSession(readSessionCookie(req));
    res.clearCookie("wand_session");
    res.json({ ok: true });
  });

  // Set password endpoint (requires auth)
  app.post("/api/set-password", requireAuth, (req, res) => {
    const { password } = req.body as { password?: string };
    if (!password || password.length < 6) {
      res.status(400).json({ error: "密码长度至少为 6 个字符。" });
      return;
    }
    storage.setPassword(password);
    res.json({ ok: true });
  });

  app.use("/api", requireAuth);

  app.get("/api/config", (_req, res) => {
    res.json({
      host: config.host,
      port: config.port,
      defaultMode: config.defaultMode,
      defaultCwd: config.defaultCwd,
      commandPresets: config.commandPresets
    });
  });

  app.get("/api/sessions", (_req, res) => {
    res.json(processes.list());
  });

  app.get("/api/path-suggestions", async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q : "";

    try {
      const suggestions = await listPathSuggestions(query, config.defaultCwd);
      res.json(suggestions);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法加载路径建议。") });
    }
  });

  app.get("/api/directory", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const includeGitStatus = req.query.gitStatus === "true";
    const targetPath = path.resolve(process.cwd(), q);

    // Security check: ensure the resolved path is within the current working directory
    const allowedBase = process.cwd();
    if (!isPathWithinBase(targetPath, allowedBase)) {
      res.status(403).json({ error: "访问被拒绝：路径必须在项目目录内。" });
      return;
    }

    try {
      const entries = await readdir(targetPath, { withFileTypes: true });
      let items: FileEntry[] = entries
        .sort((a, b) => {
          // Directories first, then alphabetically
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 100)
        .map((entry) => ({
          path: path.join(targetPath, entry.name),
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file" as const
        }));

      // Enrich with git status if requested
      if (includeGitStatus) {
        items = await enrichWithGitStatus(items, targetPath);
      }

      res.json(items);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法读取目录。可能原因：路径不存在或权限不足。") });
    }
  });

  // File preview API - reads file contents with size limit
  const MAX_FILE_SIZE = 512 * 1024; // 512KB limit
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
        // Markdown
        ".md", ".markdown", ".mdown", ".mkd", ".mkdn",
        // Code
        ".ts", ".tsx", ".js", ".jsx", ".json", ".html", ".css", ".scss", ".less",
        ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
        ".cs", ".swift", ".kt", ".scala", ".php", ".sh", ".bash", ".zsh",
        ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env",
        ".xml", ".sql", ".graphql", ".proto",
        ".dockerfile", ".gitignore", ".env", ".editorconfig",
        ".mdx", ".vue", ".svelte",
        // Text
        ".txt", ".log", ".diff", ".patch"
      ];

      const isText = previewableExts.includes(ext) ||
        ext === "" ||
        [".gitignore", "dockerfile", ".env.local", ".env.development"].some(e => filePath.toLowerCase().endsWith(e));

      if (!isText) {
        res.status(415).json({ error: "Unsupported file type", ext });
        return;
      }

      const content = await readFile(resolvedPath, "utf-8");
      const lang = getLanguageFromExt(ext, filePath);

      res.json({
        path: resolvedPath,
        name: path.basename(filePath),
        ext,
        lang,
        content,
        size: fileStat.size
      });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "Failed to read file") });
    }
  });

  // Helper to detect language from extension
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
      ".mdx": "markdown", ".vue": "html", ".svelte": "html"
    };
    const baseName = path.basename(filePath).toLowerCase();
    if (baseName === "dockerfile") return "dockerfile";
    if (baseName === ".gitignore") return "plaintext";
    return map[ext] || "plaintext";
  }

  // Folder picker API - starts from /tmp by default, supports navigation
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

      // Add parent directory navigation (..)
      const parentPath = path.dirname(targetPath);
      if (parentPath !== targetPath) {
        items.push({
          path: parentPath,
          name: "..",
          type: "parent",
          isParent: true
        });
      }

      // Add subdirectories
      entries
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 100)
        .forEach((entry) => {
          items.push({
            path: path.join(targetPath, entry.name),
            name: entry.name,
            type: "dir"
          });
        });

      res.json({
        currentPath: targetPath,
        items: items
      });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        res.status(404).json({ error: "路径不存在：" + q, currentPath: q, items: [] });
      } else if (error.code === 'EACCES') {
        res.status(403).json({ error: "权限不足，无法访问：" + q, currentPath: q, items: [] });
      } else {
        res.status(400).json({ error: "无法读取目录：" + getErrorMessage(error, "未知错误"), currentPath: q, items: [] });
      }
    }
  });

  // Quick paths API - returns common paths for quick access
  app.get("/api/quick-paths", async (req, res) => {
    const home = process.env.HOME || process.env.USERPROFILE || '/home';
    const quickPaths = [
      { path: "/tmp", name: "临时目录", icon: "🗑️" },
      { path: home, name: "主目录", icon: "🏠" },
      { path: process.cwd(), name: "当前目录", icon: "📂" },
      { path: "/", name: "根目录", icon: "📁" }
    ];
    res.json(quickPaths);
  });

  // ============ Favorite Paths API ============

interface FavoritePath {
  path: string;
  name: string;
  icon?: string;
  addedAt: string;
}

function parseStoredPathList<T>(raw: string | null): T[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

  app.get("/api/favorite-paths", (_req, res) => {
    const stored = storage.getConfigValue("favorite_paths");
    const favorites = parseStoredPathList<FavoritePath>(stored);
    res.json(favorites.filter((favorite) => !isBlockedFolderPath(normalizeFolderPath(favorite.path))));
  });

  app.post("/api/favorite-paths", (req, res) => {
    const { path: favPath, name, icon } = req.body as { path?: string; name?: string; icon?: string };
    if (!favPath) {
      res.status(400).json({ error: "路径不能为空。" });
      return;
    }

    const resolvedFavoritePath = normalizeFolderPath(favPath);
    if (isBlockedFolderPath(resolvedFavoritePath)) {
      res.status(403).json({ error: "访问被拒绝：无法收藏系统敏感目录。" });
      return;
    }

    const stored = storage.getConfigValue("favorite_paths");
    const favorites = parseStoredPathList<FavoritePath>(stored);

    // Check if already exists
    if (favorites.some((f) => normalizeFolderPath(f.path) === resolvedFavoritePath)) {
      res.status(400).json({ error: "该路径已在收藏列表中。" });
      return;
    }

    const newFavorite: FavoritePath = {
      path: resolvedFavoritePath,
      name: name || path.basename(resolvedFavoritePath),
      icon: icon || "⭐",
      addedAt: new Date().toISOString()
    };

    favorites.push(newFavorite);
    storage.setConfigValue("favorite_paths", JSON.stringify(favorites));
    res.status(201).json(newFavorite);
  });

  app.delete("/api/favorite-paths", (req, res) => {
    const { path: delPath } = req.body as { path?: string };
    if (!delPath) {
      res.status(400).json({ error: "路径不能为空。" });
      return;
    }

    const stored = storage.getConfigValue("favorite_paths");
    const favorites = parseStoredPathList<FavoritePath>(stored);

    const index = favorites.findIndex((f) => f.path === delPath);
    if (index === -1) {
      res.status(404).json({ error: "未找到该收藏路径。" });
      return;
    }

    favorites.splice(index, 1);
    storage.setConfigValue("favorite_paths", JSON.stringify(favorites));
    res.json({ ok: true });
  });

  // ============ Recent Paths API ============

  interface RecentPath {
    path: string;
    name: string;
    lastUsedAt: string;
  }

  const MAX_RECENT_PATHS = 10;

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

    // Remove existing entry for this path (to update position)
    recent = recent.filter((r) => normalizeFolderPath(r.path) !== resolvedRecentPath);

    // Add to front
    const newRecent: RecentPath = {
      path: resolvedRecentPath,
      name: path.basename(resolvedRecentPath),
      lastUsedAt: new Date().toISOString()
    };
    recent.unshift(newRecent);

    // Keep only last N entries
    recent = recent.slice(0, MAX_RECENT_PATHS);

    storage.setConfigValue("recent_paths", JSON.stringify(recent));
    res.json(newRecent);
  });

  // ============ Path Validation API ============

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

      const stats = await import("node:fs/promises").then(fs => fs.stat(resolvedPath));

      if (!stats.isDirectory()) {
        res.json({ valid: false, error: "路径不是目录", resolvedPath });
        return;
      }

      // Check read permission
      try {
        await readdir(resolvedPath);
        res.json({ valid: true, resolvedPath, name: path.basename(resolvedPath) });
      } catch (permError) {
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

  // File search API - supports fuzzy matching across directory tree
  app.get("/api/file-search", async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q : "";
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : process.cwd();
    const maxDepth = typeof req.query.depth === "string" ? parseInt(req.query.depth, 10) : 5;
    const maxResults = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;

    // Security check: ensure cwd is within allowed base
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

      // Recursive search function
      async function searchDir(dirPath: string, currentDepth: number): Promise<void> {
        if (currentDepth > maxDepth || results.length >= maxResults) return;

        const entries = await readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= maxResults) break;

          // Skip hidden files and node_modules
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

          const entryPath = path.join(dirPath, entry.name);
          const nameLower = entry.name.toLowerCase();

          // Check if name matches query (fuzzy match)
          const matchIndex = nameLower.indexOf(queryLower);
          if (matchIndex !== -1) {
            results.push({
              path: entryPath,
              name: entry.name,
              type: entry.isDirectory() ? "dir" : "file",
              matchScore: matchIndex // Lower score = better match (appears earlier in name)
            });
          }

          // Recurse into directories
          if (entry.isDirectory()) {
            await searchDir(entryPath, currentDepth + 1);
          }
        }
      }

      await searchDir(resolvedCwd, 0);

      // Sort by match score (earlier match = better) and then alphabetically
      results.sort((a, b) => {
        if (a.matchScore !== b.matchScore) return a.matchScore - b.matchScore;
        return a.name.localeCompare(b.name);
      });

      res.json({ results: results.slice(0, maxResults), query, cwd: resolvedCwd });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "搜索失败。可能原因：路径不存在或权限不足。") });
    }
  });

  app.get("/api/sessions/:id", (req, res) => {
    const snapshot = processes.get(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话，可能已被删除。" });
      return;
    }
    if (req.query.format === "chat") {
      // Prefer PTY-derived structured messages, fall back to parsing raw output
      const messages = snapshot.messages && snapshot.messages.length > 0
        ? snapshot.messages
        : parseMessages(snapshot.output);
      res.json({ ...snapshot, messages });
    } else {
      res.json(snapshot);
    }
  });

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
        initialInput || undefined
      );
      res.status(201).json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法启动命令。请检查命令是否正确安装。") });
    }
  });

  // Resume a session with a different mode (e.g., switch from terminal to chat)
  app.post("/api/sessions/:id/resume", (req, res) => {
    const sessionId = req.params.id;
    const body = req.body as { mode?: ExecutionMode; view?: "chat" | "terminal" };

    try {
      const existingSession = processes.get(sessionId) || storage.getSession(sessionId);
      if (!existingSession) {
        res.status(404).json({ error: "会话不存在。" });
        return;
      }

      const claudeSessionId = existingSession.claudeSessionId;
      if (!claudeSessionId) {
        res.status(400).json({ error: "此会话没有 Claude 会话 ID，无法恢复。" });
        return;
      }

      const command = existingSession.command.trim();
      const isClaude = /^claude\b/.test(command);
      if (!isClaude) {
        res.status(400).json({ error: "只有 Claude 命令支持恢复功能。" });
        return;
      }

      const newMode = body.mode
        ? normalizeMode(body.mode, config.defaultMode)
        : normalizeMode(existingSession.mode, config.defaultMode);
      const resumeCommand = `${command} --resume ${claudeSessionId}`;
      const newSnapshot = processes.start(
        resumeCommand,
        existingSession.cwd,
        newMode,
        undefined,
        { resumedFromSessionId: sessionId }
      );

      // Persist the resumedToSessionId on the original session
      storage.saveSession({
        ...existingSession,
        resumedToSessionId: newSnapshot.id
      });

      res.status(201).json({
        resumedFromSessionId: sessionId,
        ...newSnapshot
      });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法恢复会话。") });
    }
  });

  app.post("/api/claude-sessions/:claudeSessionId/resume", (req, res) => {
    const claudeSessionId = String(req.params.claudeSessionId || "").trim();
    const body = req.body as { mode?: ExecutionMode };

    try {
      if (!claudeSessionId) {
        res.status(400).json({ error: "Claude 会话 ID 不能为空。" });
        return;
      }

      const existingSession = storage.getLatestSessionByClaudeSessionId(claudeSessionId);
      if (!existingSession) {
        res.status(404).json({ error: "未找到对应的 Claude 会话记录。" });
        return;
      }

      const command = existingSession.command.trim();
      if (!/^claude\b/.test(command)) {
        res.status(400).json({ error: "只有 Claude 命令支持按 Claude Session ID 恢复。" });
        return;
      }
      if (!existingSession.cwd || !processes.hasClaudeSessionFile(existingSession.cwd, claudeSessionId)) {
        res.status(400).json({ error: "对应的 Claude 历史会话文件不存在，无法恢复。" });
        return;
      }

      const newMode = body.mode
        ? normalizeMode(body.mode, config.defaultMode)
        : normalizeMode(existingSession.mode, config.defaultMode);
      const resumeCommand = `${command} --resume ${claudeSessionId}`;
      const newSnapshot = processes.start(
        resumeCommand,
        existingSession.cwd,
        newMode,
        undefined,
        { resumedFromSessionId: existingSession.id }
      );

      storage.saveSession({
        ...existingSession,
        resumedToSessionId: newSnapshot.id
      });

      res.status(201).json({
        resumedFromSessionId: existingSession.id,
        resumedClaudeSessionId: claudeSessionId,
        ...newSnapshot
      });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法按 Claude 会话 ID 恢复会话。") });
    }
  });

  app.post("/api/sessions/:id/input", (req, res) => {
    const body = req.body as InputRequest;
    const sessionId = req.params.id;
    const input = body.input ?? "";
    const view = body.view;

    console.error("[wand] Input request received", {
      sessionId,
      inputLength: input.length,
      view: view ?? "chat"
    });

    try {
      const snapshot = processes.sendInput(sessionId, input, view);
      console.error("[wand] Input request succeeded", {
        sessionId,
        status: snapshot.status,
        inputLength: input.length,
        view: view ?? "chat"
      });
      res.json(snapshot);
    } catch (error) {
      const response = getInputErrorResponse(error, sessionId);
      console.error("[wand] Input request failed", {
        sessionId,
        inputLength: input.length,
        view: view ?? "chat",
        responseStatus: response.statusCode,
        responsePayload: response.payload,
        error: getInputDebugMeta(error)
      });
      res.status(response.statusCode).json(response.payload);
    }
  });

  app.post("/api/sessions/:id/resize", (req, res) => {
    const body = req.body as ResizeRequest;
    try {
      const snapshot = processes.resize(req.params.id, body.cols ?? 0, body.rows ?? 0);
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法调整终端大小。") });
    }
  });

  app.post("/api/sessions/:id/approve-permission", (req, res) => {
    try {
      const snapshot = processes.approvePermission(req.params.id);
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法批准该授权请求。") });
    }
  });

  app.post("/api/sessions/:id/deny-permission", (req, res) => {
    try {
      const snapshot = processes.denyPermission(req.params.id);
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法拒绝该授权请求。") });
    }
  });

  app.post("/api/sessions/:id/escalations/:requestId/resolve", (req, res) => {
    try {
      const { requestId } = req.params;
      const body = req.body as { resolution?: "approve_once" | "approve_turn" | "deny" };
      const snapshot = processes.resolveEscalation(req.params.id, requestId, body.resolution);
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法处理该授权请求。") });
    }
  });

  app.post("/api/sessions/:id/stop", (req, res) => {
    try {
      const snapshot = processes.stop(req.params.id);
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法停止会话。") });
    }
  });

  app.delete("/api/sessions/:id", (req, res) => {
    try {
      processes.delete(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法删除会话。") });
    }
  });

  await processes.runStartupCommands();

  // Create server (HTTP or HTTPS) - useHttps and protocol already defined above
  const server = useHttps
    ? (() => {
        const ssl = ensureCertificates(resolveConfigDir(configPath));
        return createHttpsServer({ key: ssl.key, cert: ssl.cert }, app);
      })()
    : createHttpServer(app);

  const wss = new WebSocketServer({ server, path: "/ws" });

  // Track WebSocket clients with their subscriptions and send queues
  interface WsClient {
    ws: WebSocket;
    sendQueue: string[];
    sendInProgress: boolean;
    backpressurePaused: boolean;
    lastOutputBySession: Map<string, { output: string; messages?: string; timestamp: number }>;
  }
  const wsClients = new Set<WsClient>();
  const MAX_QUEUE_SIZE = 500; // Max messages in queue before applying backpressure
  const OUTPUT_DEBOUNCE_MS = 50; // Debounce PTY output updates to reduce flicker

  // Output debounce cache - batch rapid output events per session
  const outputDebounceCache = new Map<string, { event: ProcessEvent; timer: NodeJS.Timeout }>();

  // Process send queue for a WebSocket client
  function processWsQueue(client: WsClient): void {
    if (client.sendInProgress || client.sendQueue.length === 0 || client.backpressurePaused) {
      return;
    }
    client.sendInProgress = true;
    const message = client.sendQueue.shift()!;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message, (err) => {
        client.sendInProgress = false;
        if (err) {
          // Error sending, drop message
          return;
        }
        // Check backpressure threshold
        const threshold = MAX_QUEUE_SIZE * 0.8;
        if (client.backpressurePaused && client.sendQueue.length < threshold) {
          client.backpressurePaused = false;
        }
        // Continue processing queue
        processWsQueue(client);
      });
    } else {
      client.sendInProgress = false;
    }
  }

  // Broadcast process events to WebSocket clients with debouncing and backpressure control
  processes.on("process", (event: ProcessEvent) => {
    // Debounce output events to reduce flicker during rapid streaming
    if (event.type === "output") {
      const existing = outputDebounceCache.get(event.sessionId);
      if (existing) {
        clearTimeout(existing.timer);
      }
      const timer = setTimeout(() => {
        outputDebounceCache.delete(event.sessionId);
        broadcastEvent(event);
      }, OUTPUT_DEBOUNCE_MS);
      outputDebounceCache.set(event.sessionId, { event, timer });
      return;
    }

    // Non-output events (started, ended, status) are sent immediately
    broadcastEvent(event);
  });

  function broadcastEvent(event: ProcessEvent): void {
    const message = JSON.stringify(event);
    for (const client of wsClients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        // Apply backpressure if queue is too large
        if (client.sendQueue.length >= MAX_QUEUE_SIZE) {
          client.backpressurePaused = true;
          continue;
        }
        if (!client.backpressurePaused) {
          client.sendQueue.push(message);
          processWsQueue(client);
        }
      }
    }
  }

  wss.on("connection", (ws, req) => {
    const sessionToken = readSessionCookie(req);

    if (!sessionToken || !validateSession(sessionToken)) {
      ws.close(1008, "Unauthorized");
      return;
    }

    const client: WsClient = {
      ws,
      sendQueue: [],
      sendInProgress: false,
      backpressurePaused: false,
      lastOutputBySession: new Map()
    };
    wsClients.add(client);

    ws.on("close", () => {
      wsClients.delete(client);
    });

    ws.on("error", () => {
      // Already closed, ignore
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Handle subscribe/unsubscribe for specific sessions
        if (msg.type === "subscribe" && msg.sessionId) {
          // Client wants updates for a specific session
          const snapshot = processes.get(msg.sessionId);
          if (snapshot) {
            // Send full session snapshot including messages for reconnection recovery
            ws.send(JSON.stringify({
              type: "init",
              sessionId: msg.sessionId,
              data: {
                ...snapshot,
                // Ensure messages are included for chat mode recovery
                messages: snapshot.messages,
                // Include full output for terminal mode recovery
                output: snapshot.output
              }
            }));
          } else {
            // Session not found - might be deleted or never existed
            ws.send(JSON.stringify({
              type: "error",
              sessionId: msg.sessionId,
              error: "Session not found"
            }));
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });
  });

  // Start server
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

  // Print security warnings
  if (!storage.hasCustomPassword() && config.password === "change-me") {
    wandWarn(
      "正在使用默认密码（change-me），任何能访问本机的人都可以登录。",
      "修改方法：在界面右上角「设置」中修改密码，或运行：node dist/cli.js config:set password <你的新密码>"
    );
  }
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!validateSession(readSessionCookie(req))) {
    res.status(401).json({ error: "未授权，请先登录。" });
    return;
  }
  next();
}

function normalizeMode(input: string | undefined, fallback: ExecutionMode): ExecutionMode {
  return isExecutionMode(input) ? input : fallback;
}

function readSessionCookie(req: { headers: { cookie?: string } }): string | undefined {
  const cookie = req.headers.cookie;
  if (!cookie) {
    return undefined;
  }

  const match = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("wand_session="));

  return match?.slice("wand_session=".length);
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
      isDirectory: true
    }));
}
