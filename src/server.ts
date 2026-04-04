import express, { NextFunction, Request, Response } from "express";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";
import { WebSocketServer } from "ws";

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

import { ensureAvatarSeed, getAvatarSvg } from "./avatar.js";
import { createSession, revokeSession, setAuthStorage, validateSession } from "./auth.js";
import { ensureCertificates } from "./cert.js";
import { isExecutionMode, resolveConfigDir, saveConfig } from "./config.js";
import { ProcessManager, ProcessEvent, SessionInputError } from "./process-manager.js";
import { resolveDatabasePath, WandStorage } from "./storage.js";
import { renderApp } from "./web-ui/index.js";
import { parseMessages } from "./message-parser.js";
import { generatePwaManifest, generateServiceWorker } from "./pwa.js";
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
  WandConfig
} from "./types.js";

// ── Error helpers ──

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
        sessionStatus: error.sessionStatus ?? null,
      },
    };
  }

  return {
    statusCode: 400,
    payload: {
      error: getErrorMessage(error, "会话已结束，请启动新会话。"),
      errorCode: "INPUT_SEND_FAILED",
      sessionId,
      sessionStatus: null,
    },
  };
}

function getInputDebugMeta(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { error };
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

function normalizeMode(input: string | undefined, fallback: ExecutionMode): ExecutionMode {
  return isExecutionMode(input) ? input : fallback;
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

// ── Favorite / Recent path types ──

interface FavoritePath {
  path: string;
  name: string;
  icon?: string;
  addedAt: string;
}

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

const HIDDEN_CLAUDE_SESSIONS_KEY = "hidden_claude_sessions";

function getHiddenClaudeSessionIds(storage: WandStorage): Set<string> {
  return new Set(parseStoredPathList<string>(storage.getConfigValue(HIDDEN_CLAUDE_SESSIONS_KEY)));
}

function saveHiddenClaudeSessionIds(storage: WandStorage, hidden: Set<string>): void {
  storage.setConfigValue(HIDDEN_CLAUDE_SESSIONS_KEY, JSON.stringify(Array.from(hidden)));
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
  const useHttps = config.https === true;
  const protocol = useHttps ? "https" : "http";
  const nodeModulesDir = path.join(RUNTIME_ROOT_DIR, "node_modules");

  app.use(express.json({ limit: "1mb" }));
  app.use("/vendor/xterm", express.static(path.join(nodeModulesDir, "xterm")));
  app.use("/vendor/xterm-addon-fit", express.static(path.join(nodeModulesDir, "@xterm", "addon-fit")));

  // ── Web UI and PWA endpoints ──

  app.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.type("html").send(renderApp(configPath));
  });

  app.get("/manifest.json", (_req, res) => {
    res.setHeader("Content-Type", "application/manifest+json");
    res.send(generatePwaManifest());
  });

  app.get("/icon.svg", (_req, res) => {
    res.type("image/svg+xml").send(getAvatarSvg(avatarSeed, 192));
  });

  const iconsDir = path.resolve(
    existsSync(path.join(SERVER_MODULE_DIR, "web-ui", "content"))
      ? path.join(SERVER_MODULE_DIR, "web-ui", "content")
      : path.join(RUNTIME_ROOT_DIR, "src", "web-ui", "content")
  );

  app.get("/icon-192.png", (_req, res) => {
    res.type("image/svg+xml").send(getAvatarSvg(avatarSeed, 192));
  });

  app.get("/icon-512.png", (_req, res) => {
    res.type("image/svg+xml").send(getAvatarSvg(avatarSeed, 512));
  });

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

    const { password } = req.body as { password?: string };
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

  app.use("/api", requireAuth);

  // ── Config & Session info ──

  app.get("/api/config", (_req, res) => {
    res.json({
      host: config.host,
      port: config.port,
      defaultMode: config.defaultMode,
      defaultCwd: config.defaultCwd,
      commandPresets: config.commandPresets,
    });
  });

  // ── Settings endpoints ──

  app.get("/api/settings", (_req, res) => {
    const certPaths = {
      keyPath: path.join(configDir, "server.key"),
      certPath: path.join(configDir, "server.crt"),
    };
    const { password: _pw, ...safeConfig } = config;
    res.json({
      version: PKG_VERSION,
      packageName: PKG_NAME,
      nodeVersion: PKG_NODE_REQ,
      repoUrl: PKG_REPO_URL,
      config: safeConfig,
      hasCert: existsSync(certPaths.keyPath) && existsSync(certPaths.certPath),
    });
  });

  app.post("/api/settings/config", async (req, res) => {
    const body = req.body as Partial<WandConfig>;
    const allowedFields = ["host", "port", "https", "defaultMode", "defaultCwd", "shell"] as const;
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
        }
        changed = true;
      }
    }

    if (!changed) {
      res.status(400).json({ error: "没有可更新的配置字段。" });
      return;
    }

    try {
      await saveConfig(configPath, config);
      const { password: _pw, ...safeConfig } = config;
      res.json({ ok: true, config: safeConfig, restartRequired: true });
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

  app.post("/api/update", async (_req, res) => {
    try {
      const { updateAvailable } = await checkNpmLatestVersion();
      if (!updateAvailable) {
        res.json({ ok: true, message: "已经是最新版本。" });
        return;
      }
      res.json({ ok: true, message: "正在更新，请稍候..." });
      // Run update in background — the server will restart
      execAsync(`npm install -g ${PKG_NAME}@latest`, { timeout: 120000 }).catch(() => {});
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "更新失败。") });
    }
  });

  app.get("/api/sessions", (_req, res) => {
    res.json(processes.list());
  });

  app.get("/api/claude-history", (_req, res) => {
    try {
      const sessions = processes.listClaudeHistorySessions();
      const hidden = getHiddenClaudeSessionIds(storage);
      const filtered = hidden.size > 0
        ? sessions.filter((s: { claudeSessionId?: string }) => !s.claudeSessionId || !hidden.has(s.claudeSessionId))
        : sessions;
      res.json(filtered);
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "无法扫描 Claude 历史会话。") });
    }
  });

  app.delete("/api/claude-history/:claudeSessionId", (req, res) => {
    const claudeSessionId = req.params.claudeSessionId?.trim();
    if (!claudeSessionId) {
      res.status(400).json({ error: "会话 ID 不能为空。" });
      return;
    }
    const hidden = getHiddenClaudeSessionIds(storage);
    if (!hidden.has(claudeSessionId)) {
      hidden.add(claudeSessionId);
      saveHiddenClaudeSessionIds(storage, hidden);
    }
    res.json({ ok: true });
  });

  app.delete("/api/claude-history", (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd.trim() : "";
    if (!cwd) {
      res.status(400).json({ error: "目录不能为空。" });
      return;
    }

    try {
      const sessions = processes.listClaudeHistorySessions();
      const hidden = getHiddenClaudeSessionIds(storage);
      let added = 0;

      for (const session of sessions) {
        if (!session.claudeSessionId || session.cwd !== cwd) {
          continue;
        }
        if (hidden.has(session.claudeSessionId)) {
          continue;
        }
        hidden.add(session.claudeSessionId);
        added += 1;
      }

      if (added > 0) {
        saveHiddenClaudeSessionIds(storage, hidden);
      }

      res.json({ ok: true, deleted: added });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "无法删除该目录下的历史会话。") });
    }
  });

  app.post("/api/claude-history/batch-delete", express.json(), (req, res) => {
    const claudeSessionIds = Array.isArray(req.body?.claudeSessionIds)
      ? req.body.claudeSessionIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      : [];

    if (claudeSessionIds.length === 0) {
      res.status(400).json({ error: "至少提供一个历史会话 ID。" });
      return;
    }

    try {
      const hidden = getHiddenClaudeSessionIds(storage);
      let added = 0;
      for (const claudeSessionId of claudeSessionIds) {
        if (hidden.has(claudeSessionId)) {
          continue;
        }
        hidden.add(claudeSessionId);
        added += 1;
      }
      if (added > 0) {
        saveHiddenClaudeSessionIds(storage, hidden);
      }
      res.json({ ok: true, deleted: added });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "无法批量删除历史会话。") });
    }
  });

  app.post("/api/sessions/batch-delete", express.json(), (req, res) => {
    const sessionIds = Array.isArray(req.body?.sessionIds)
      ? req.body.sessionIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      : [];

    if (sessionIds.length === 0) {
      res.status(400).json({ error: "至少提供一个会话 ID。" });
      return;
    }

    let deleted = 0;
    const failed: string[] = [];

    for (const sessionId of sessionIds) {
      try {
        processes.delete(sessionId);
        deleted += 1;
      } catch {
        failed.push(sessionId);
      }
    }

    if (deleted === 0 && failed.length > 0) {
      res.status(400).json({ error: "无法批量删除会话。", failed });
      return;
    }

    res.json({ ok: true, deleted, failed });
  });

  app.get("/api/sessions/:id", (req, res) => {
    const snapshot = processes.get(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: "未找到该会话，可能已被删除。" });
      return;
    }
    if (req.query.format === "chat") {
      const messages = snapshot.messages && snapshot.messages.length > 0
        ? snapshot.messages
        : parseMessages(snapshot.output);
      res.json({ ...snapshot, messages });
    } else {
      res.json(snapshot);
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

  app.get("/api/favorite-paths", (_req, res) => {
    const stored = storage.getConfigValue("favorite_paths");
    const favorites = parseStoredPathList<FavoritePath>(stored);
    res.json(favorites.filter((f) => !isBlockedFolderPath(normalizeFolderPath(f.path))));
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
    if (favorites.some((f) => normalizeFolderPath(f.path) === resolvedFavoritePath)) {
      res.status(400).json({ error: "该路径已在收藏列表中。" });
      return;
    }
    const newFavorite: FavoritePath = {
      path: resolvedFavoritePath,
      name: name || path.basename(resolvedFavoritePath),
      icon: icon || "⭐",
      addedAt: new Date().toISOString(),
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
        initialInput || undefined
      );
      res.status(201).json(snapshot);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法启动命令。请检查命令是否安装。") });
    }
  });

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
      if (!/^claude\b/.test(command)) {
        res.status(400).json({ error: "只有 Claude 命令支持恢复功能。" });
        return;
      }
      const newMode = body.mode
        ? normalizeMode(body.mode, config.defaultMode)
        : normalizeMode(existingSession.mode, config.defaultMode);
      const resumeCommand = `${command} --resume ${claudeSessionId}`;
      const newSnapshot = processes.start(resumeCommand, existingSession.cwd, newMode, undefined, { resumedFromSessionId: sessionId });
      storage.saveSession({ ...existingSession, resumedToSessionId: newSnapshot.id });
      res.status(201).json({ resumedFromSessionId: sessionId, ...newSnapshot });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法恢复会话。") });
    }
  });

  app.post("/api/claude-sessions/:claudeSessionId/resume", (req, res) => {
    const claudeSessionId = String(req.params.claudeSessionId || "").trim();
    const body = req.body as { mode?: ExecutionMode; cwd?: string };
    try {
      if (!claudeSessionId) {
        res.status(400).json({ error: "Claude 会话 ID 不能为空。" });
        return;
      }
      const existingSession = storage.getLatestSessionByClaudeSessionId(claudeSessionId);
      if (existingSession) {
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
        const newSnapshot = processes.start(resumeCommand, existingSession.cwd, newMode, undefined, { resumedFromSessionId: existingSession.id });
        storage.saveSession({ ...existingSession, resumedToSessionId: newSnapshot.id });
        res.status(201).json({ resumedFromSessionId: existingSession.id, resumedClaudeSessionId: claudeSessionId, ...newSnapshot });
      } else {
        // No existing wand session — resume directly with cwd from request body
        const cwd = body.cwd?.trim();
        if (!cwd) {
          res.status(400).json({ error: "未找到对应的会话记录，请提供工作目录 (cwd)。" });
          return;
        }
        const newMode = normalizeMode(body.mode, config.defaultMode);
        const resumeCommand = `claude --resume ${claudeSessionId}`;
        const newSnapshot = processes.start(resumeCommand, cwd, newMode);
        res.status(201).json({ resumedClaudeSessionId: claudeSessionId, ...newSnapshot });
      }
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法按 Claude 会话 ID 恢复会话。") });
    }
  });

  app.post("/api/sessions/:id/input", (req, res) => {
    const body = req.body as InputRequest;
    const sessionId = req.params.id;
    const input = body.input ?? "";
    const view = body.view;
    const shortcutKey = body.shortcutKey;
    console.error("[wand] Input request received", { sessionId, inputLength: input.length, view: view ?? "chat" });
    try {
      const snapshot = processes.sendInput(sessionId, input, view, shortcutKey);
      console.error("[wand] Input request succeeded", { sessionId, status: snapshot.status, inputLength: input.length, view: view ?? "chat" });
      res.json(snapshot);
    } catch (error) {
      const response = getInputErrorResponse(error, sessionId);
      console.error("[wand] Input request failed", {
        sessionId, inputLength: input.length, view: view ?? "chat",
        responseStatus: response.statusCode, responsePayload: response.payload,
        error: getInputDebugMeta(error),
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
      res.json(processes.approvePermission(req.params.id));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法批准该授权请求。") });
    }
  });

  app.post("/api/sessions/:id/deny-permission", (req, res) => {
    try {
      res.json(processes.denyPermission(req.params.id));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法拒绝该授权请求。") });
    }
  });

  app.post("/api/sessions/:id/escalations/:requestId/resolve", (req, res) => {
    try {
      const { requestId } = req.params;
      const body = req.body as { resolution?: "approve_once" | "approve_turn" | "deny" };
      res.json(processes.resolveEscalation(req.params.id, requestId, body.resolution));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法处理该授权请求。") });
    }
  });

  app.post("/api/sessions/:id/stop", (req, res) => {
    try {
      res.json(processes.stop(req.params.id));
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

  // ── WebSocket broadcast layer ──

  const server = useHttps
    ? (() => {
        const ssl = ensureCertificates(resolveConfigDir(configPath));
        return createHttpsServer({ key: ssl.key, cert: ssl.cert }, app);
      })()
    : createHttpServer(app);

  const wss = new WebSocketServer({ server, path: "/ws" });
  const wsManager = new WsBroadcastManager(wss);
  wsManager.setup((id) => processes.get(id));

  // Wire process events to WebSocket broadcast
  processes.on("process", (event: ProcessEvent) => {
    wsManager.emitEvent(event);
  });

  // ── Start listening ──

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
  checkNpmLatestVersion().then(({ current, latest, updateAvailable }) => {
    if (updateAvailable) {
      process.stdout.write(
        `[wand] 发现新版本 ${latest}（当前 ${current}）。运行 npm install -g ${PKG_NAME}@latest 进行更新。\n`
      );
    }
  }).catch(() => {});
}
