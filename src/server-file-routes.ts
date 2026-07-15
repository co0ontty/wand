import crypto from "node:crypto";
import { exec } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import type { Express, Request, Response } from "express";

import { getErrorMessage } from "./error-utils.js";
import { asyncRoute } from "./express-async.js";
import { isBlockedFolderPath, isPathWithinBase, normalizeFolderPath } from "./middleware/path-safety.js";
import { parseBoundedInteger } from "./request-limits.js";
import type { WandStorage } from "./storage.js";
import type {
  DirectoryListing,
  FileEntry,
  FilePreviewKind,
  FilePreviewResponse,
  GitFileStatus,
  PathSuggestion,
} from "./types.js";

const execAsync = promisify(exec);
const DIRECTORY_MAX_ITEMS = 200;
const MAX_TEXT_PREVIEW_SIZE = 512 * 1024;
const MAX_TEXT_WRITE_SIZE = 1024 * 1024;
const MAX_RECENT_PATHS = 10;

interface RecentPath {
  path: string;
  name: string;
  lastUsedAt: string;
}

export interface ServerFileRoutesDependencies {
  storage: WandStorage;
  defaultCwd: string;
}

/** Persist a cwd to recent paths. Used by REST and session creation hooks. */
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
  recent = recent.filter((item) => normalizeFolderPath(item.path) !== resolved);
  recent.unshift({
    path: resolved,
    name: path.basename(resolved),
    lastUsedAt: new Date().toISOString(),
  });
  storage.setConfigValue("recent_paths", JSON.stringify(recent.slice(0, MAX_RECENT_PATHS)));
}

export function registerFileRoutes(app: Express, deps: ServerFileRoutesDependencies): void {
  const { storage, defaultCwd } = deps;

  app.get("/api/path-suggestions", asyncRoute(async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q : "";
    try {
      res.json(await listPathSuggestions(query, defaultCwd));
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法加载路径建议。") });
    }
  }));

  app.get("/api/directory", asyncRoute(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const includeGitStatus = req.query.gitStatus === "true";
    const targetPath = path.resolve(q || defaultCwd);

    try {
      const entries = await readdir(targetPath, { withFileTypes: true });
      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });
      const total = sorted.length;
      const sliced = sorted.slice(0, DIRECTORY_MAX_ITEMS);
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
          const fileStat = await lstat(fullPath);
          base.size = fileStat.size;
          base.mtime = fileStat.mtime.toISOString();
        } catch {
          // Per-entry permission/race failures do not fail the whole listing.
        }
        return base;
      }));
      if (includeGitStatus) items = await enrichWithGitStatus(items, targetPath);
      const payload: DirectoryListing = {
        items,
        truncated: total > DIRECTORY_MAX_ITEMS,
        total,
      };
      res.json(payload);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "无法读取目录。可能原因：路径不存在或权限不足。") });
    }
  }));

  app.get("/api/file-preview", asyncRoute(async (req, res) => {
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
      const payload: FilePreviewResponse = {
        kind: "text",
        path: resolvedPath,
        name: baseName,
        ext,
        size: fileStat.size,
        mime,
        lang: getLanguageFromExt(ext, filePath),
        content,
      };
      res.json(payload);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "Failed to read file") });
    }
  }));

  app.post("/api/file-write", asyncRoute(async (req, res) => {
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
      if (classifyFile(ext, baseName) !== "text") {
        res.status(415).json({ error: "仅支持编辑文本类文件。" });
        return;
      }
      const tmpPath = path.join(path.dirname(resolvedPath), `.${baseName}.wand-tmp-${crypto.randomBytes(6).toString("hex")}`);
      try {
        await writeFile(tmpPath, content, { encoding: "utf-8", mode: fileStat.mode & 0o777 });
        await rename(tmpPath, resolvedPath);
      } catch (writeError) {
        try { await unlink(tmpPath); } catch { /* best-effort temp cleanup */ }
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
  }));

  app.get("/api/file-raw", asyncRoute(async (req, res) => {
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
      // Inline responses are previews and stay size-bounded. Explicit downloads are
      // streamed with range support, so keeping the preview cap here would make the
      // file browser's "下载" action fail for the very files that are too large to
      // preview.
      if (!asDownload && fileStat.size > cap) {
        res.status(413).json({
          error: `文件超出可在线预览的上限（${Math.round(cap / 1024 / 1024)} MB）。`,
          size: fileStat.size,
          maxSize: cap,
        });
        return;
      }
      const encodedName = encodeURIComponent(baseName);
      streamFileWithRange(req, res, {
        filePath: resolvedPath,
        size: fileStat.size,
        contentType: kind === "binary" ? "application/octet-stream" : mimeForExt(ext),
        disposition: `${asDownload ? "attachment" : "inline"}; filename*=UTF-8''${encodedName}`,
        headers: {
          "Cache-Control": "private, max-age=60",
          "X-Content-Type-Options": "nosniff",
        },
        readErrorMessage: "Failed to read file",
      });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "Failed to read file") });
    }
  }));

  app.get("/api/folders", asyncRoute(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "/tmp";
    const targetPath = normalizeFolderPath(q);
    if (isBlockedFolderPath(targetPath)) {
      res.status(403).json({ error: "访问被拒绝：无法访问系统敏感目录。" });
      return;
    }

    try {
      const entries = await readdir(targetPath, { withFileTypes: true });
      const items: Array<{ path: string; name: string; type: "parent" | "dir"; isParent?: boolean }> = [];
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
  }));

  app.get("/api/quick-paths", asyncRoute(async (_req, res) => {
    const home = process.env.HOME || process.env.USERPROFILE || "/home";
    res.json([
      { path: "/tmp", name: "临时目录", icon: "🗑️" },
      { path: home, name: "主目录", icon: "🏠" },
      { path: process.cwd(), name: "当前目录", icon: "📂" },
      { path: "/", name: "根目录", icon: "📁" },
    ]);
  }));

  app.get("/api/recent-paths", (_req, res) => {
    const recent = parseStoredPathList<RecentPath>(storage.getConfigValue("recent_paths"));
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

  app.get("/api/validate-path", asyncRoute(async (req, res) => {
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
      const stats = await stat(resolvedPath);
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
      if (err.code === "ENOENT") res.json({ valid: false, error: "路径不存在" });
      else if (err.code === "EACCES") res.json({ valid: false, error: "没有访问权限" });
      else res.json({ valid: false, error: `无效路径: ${err.message}` });
    }
  }));

  app.get("/api/file-search", asyncRoute(async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 256) : "";
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : process.cwd();
    const maxDepth = parseBoundedInteger(req.query.depth, 5, 0, 8);
    const maxResults = parseBoundedInteger(req.query.limit, 50, 1, 200);
    const ignoredDirectories = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".wand-uploads"]);
    const maxVisitedEntries = 20_000;
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
      let visitedEntries = 0;
      async function searchDir(dirPath: string, currentDepth: number): Promise<void> {
        if (currentDepth > maxDepth || results.length >= maxResults || visitedEntries >= maxVisitedEntries) return;
        const entries = await readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= maxResults || visitedEntries >= maxVisitedEntries) break;
          visitedEntries += 1;
          if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
          const entryPath = path.join(dirPath, entry.name);
          const matchIndex = entry.name.toLowerCase().indexOf(queryLower);
          if (matchIndex !== -1) {
            results.push({
              path: entryPath,
              name: entry.name,
              type: entry.isDirectory() ? "dir" : "file",
              matchScore: matchIndex,
            });
          }
          if (entry.isDirectory()) await searchDir(entryPath, currentDepth + 1);
        }
      }
      await searchDir(resolvedCwd, 0);
      results.sort((a, b) => a.matchScore !== b.matchScore
        ? a.matchScore - b.matchScore
        : a.name.localeCompare(b.name));
      res.json({ results: results.slice(0, maxResults), query, cwd: resolvedCwd });
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "搜索失败。可能原因：路径不存在或权限不足。") });
    }
  }));
}

export function streamFileWithRange(
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
  for (const [name, value] of Object.entries(options.headers ?? {})) res.setHeader(name, value);
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
  stream.on("error", (error) => {
    if (!res.headersSent) {
      res.status(500).json({ error: getErrorMessage(error, options.readErrorMessage ?? "读取文件失败。") });
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

async function listPathSuggestions(input: string, fallbackCwd: string): Promise<PathSuggestion[]> {
  const normalizedInput = input.trim();
  const resolvedInput = normalizeFolderPath(normalizedInput || fallbackCwd);
  const endsWithSeparator = /[\\/]$/.test(normalizedInput);
  const searchDir = endsWithSeparator ? resolvedInput : path.dirname(resolvedInput);
  const partialName = endsWithSeparator ? "" : path.basename(resolvedInput);
  const entries = await readdir(searchDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !partialName || entry.name.toLowerCase().startsWith(partialName.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((entry) => ({ path: path.join(searchDir, entry.name), name: entry.name, isDirectory: true }));
}

function parseStoredPathList<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
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
    for (const line of stagedStdout.split("\n").filter((item) => item.trim())) {
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
    for (const filePath of untrackedStdout.split("\n").filter((item) => item.trim())) {
      const existing = statusMap.get(filePath);
      if (existing) existing.untracked = true;
      else statusMap.set(filePath, { untracked: true });
    }
  } catch {
    // Git decoration is optional.
  }
  return statusMap;
}

async function enrichWithGitStatus(items: FileEntry[], dirPath: string): Promise<FileEntry[]> {
  try {
    const gitRoot = await getGitRepoRoot(dirPath);
    if (!gitRoot) return items;
    const gitStatusMap = await getGitStatusMap(gitRoot);
    return items.map((item) => {
      const relativePath = path.relative(gitRoot, item.path).replace(/\\/g, "/");
      return { ...item, gitStatus: gitStatusMap.get(relativePath) };
    });
  } catch {
    return items;
  }
}

function getLanguageFromExt(ext: string, filePath: string): string {
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
    ".json": "json", ".html": "html", ".htm": "html", ".css": "css", ".scss": "scss", ".less": "less",
    ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust", ".java": "java", ".c": "c", ".cpp": "cpp",
    ".h": "c", ".hpp": "cpp", ".cs": "csharp", ".swift": "swift", ".kt": "kotlin", ".scala": "scala",
    ".php": "php", ".sh": "bash", ".bash": "bash", ".zsh": "bash", ".yaml": "yaml", ".yml": "yaml",
    ".toml": "toml", ".ini": "ini", ".xml": "xml", ".sql": "sql", ".graphql": "graphql", ".md": "markdown",
    ".markdown": "markdown", ".mdown": "markdown", ".mkd": "markdown", ".mkdn": "markdown", ".dockerfile": "dockerfile",
    ".gitignore": "plaintext", ".diff": "diff", ".patch": "diff", ".proto": "protobuf", ".env": "bash",
    ".editorconfig": "ini", ".mdx": "markdown", ".vue": "html", ".svelte": "html",
  };
  const baseName = path.basename(filePath).toLowerCase();
  if (baseName === "dockerfile") return "dockerfile";
  if (baseName === ".gitignore") return "plaintext";
  return map[ext] || "plaintext";
}

const TEXT_PREVIEWABLE_EXTS = new Set([
  ".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdx", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".jsonc", ".html", ".htm", ".css", ".scss", ".less", ".py", ".rb", ".go", ".rs", ".java",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".swift", ".kt", ".scala", ".php", ".sh", ".bash", ".zsh", ".fish",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".xml", ".sql", ".graphql", ".proto",
  ".dockerfile", ".gitignore", ".editorconfig", ".vue", ".svelte", ".txt", ".log", ".diff", ".patch", ".lua",
  ".r", ".dart", ".pl", ".pm",
]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico", ".heic", ".heif"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv", ".m4v", ".ogv"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"]);
const PDF_EXTS = new Set([".pdf"]);
const TEXT_BASENAME_ALLOW = new Set([
  "dockerfile", ".gitignore", ".dockerignore", ".env", ".env.local", ".env.development", ".env.production", ".env.test",
  "makefile", "readme", "license", "changelog",
]);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon", ".heic": "image/heic",
  ".heif": "image/heif", ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mkv": "video/x-matroska", ".m4v": "video/x-m4v", ".ogv": "video/ogg", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac", ".opus": "audio/opus",
};

const RAW_MAX_BYTES_BY_KIND: Record<FilePreviewKind, number> = {
  text: 5 * 1024 * 1024,
  image: 50 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  audio: 200 * 1024 * 1024,
  binary: 50 * 1024 * 1024,
};

function classifyFile(ext: string, baseName: string): FilePreviewKind {
  const lowerExt = ext.toLowerCase();
  const lowerBase = baseName.toLowerCase();
  if (IMAGE_EXTS.has(lowerExt)) return "image";
  if (PDF_EXTS.has(lowerExt)) return "pdf";
  if (VIDEO_EXTS.has(lowerExt)) return "video";
  if (AUDIO_EXTS.has(lowerExt)) return "audio";
  if (TEXT_PREVIEWABLE_EXTS.has(lowerExt) || TEXT_BASENAME_ALLOW.has(lowerBase)) return "text";
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
