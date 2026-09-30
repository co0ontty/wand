import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isPlausibleTaskTitle } from "./task-title.js";
import type { SessionProvider } from "./types.js";

const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_CAP_BYTES = 2 * 1024 * 1024;
const GROK_WALK_LIMIT = 4_000;

/** 各 provider 状态根目录，测试可整体替换。 */
export interface NativeTitleHomes {
  codexHome?: string;
  qoderProjectsDirs?: string[];
  openCodeDatabasePath?: string;
  grokSessionsDir?: string;
}

/**
 * provider 自己在运行期写下的会话标题：
 * codex `session_index.jsonl` 的 thread_name、qoder 转录里的 ai-title、
 * OpenCode SQLite 的 session.title、grok `summary.json` 的 generated_title。
 * Claude / Pi / Gemini 没有这个入口，返回空串让调用方回退系统硅基员工。
 */
export async function readNativeSessionTitle(
  provider: SessionProvider,
  providerSessionId: string | null | undefined,
  cwd: string,
  homes: NativeTitleHomes = {},
): Promise<string> {
  const id = providerSessionId?.trim() ?? "";
  if (!id || !SESSION_ID_PATTERN.test(id)) return "";
  switch (provider) {
    case "codex":
      return readCodexNativeTitle(id, homes.codexHome);
    case "qoder":
      return readQoderNativeTitle(id, homes.qoderProjectsDirs);
    case "opencode":
      return readOpenCodeNativeTitle(id, homes.openCodeDatabasePath);
    case "grok":
      return readGrokNativeTitle(id, cwd, homes.grokSessionsDir);
    default:
      return "";
  }
}

function acceptNativeTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  const title = value.replace(/\s+/g, " ").trim();
  return title && isPlausibleTaskTitle(title) ? title : "";
}

function readTail(filePath: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    const stats = statSync(filePath);
    const length = Math.min(maxBytes, Math.max(0, stats.size));
    const buffer = Buffer.alloc(length);
    fd = openSync(filePath, "r");
    const readAt = stats.size - length;
    const bytesRead = readSync(fd, buffer, 0, length, readAt);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* 只读兜底 */ }
    }
  }
}

function readHead(filePath: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    const stats = statSync(filePath);
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(1, stats.size)));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* 只读兜底 */ }
    }
  }
}

interface CacheEntry {
  key: string;
  title: string;
}

const nativeTitleCache = new Map<string, CacheEntry>();

function fingerprint(filePath: string): string {
  try {
    const stats = statSync(filePath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "missing";
  }
}

/** 同一会话在同一次生成里会被反复问到（标题、快捷提交、resume），按文件指纹缓存。 */
function cachedTitle(cacheKey: string, sourcePath: string, read: () => string): string {
  const key = `${cacheKey}|${sourcePath}`;
  const stamp = fingerprint(sourcePath);
  const hit = nativeTitleCache.get(key);
  if (hit && hit.key === stamp) return hit.title;
  const title = read();
  if (nativeTitleCache.size > 512) nativeTitleCache.clear();
  nativeTitleCache.set(key, { key: stamp, title });
  return title;
}

function readCodexNativeTitle(threadId: string, codexHome?: string): string {
  if (!UUID_PATTERN.test(threadId)) return "";
  const index = path.join(codexHome ?? path.join(os.homedir(), ".codex"), "session_index.jsonl");
  if (!existsSync(index)) return "";
  return cachedTitle(`codex:${threadId}`, index, () => {
    let title = "";
    for (const line of readTail(index, READ_CAP_BYTES).split("\n")) {
      if (!line.includes(threadId)) continue;
      try {
        const parsed = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
        if (parsed.id === threadId) title = acceptNativeTitle(parsed.thread_name);
      } catch {
        continue;
      }
    }
    return title;
  });
}

function readQoderNativeTitle(sessionId: string, projectsDirs?: string[]): string {
  const dirs = projectsDirs ?? [
    path.join(os.homedir(), ".qoder", "projects"),
    path.join(os.homedir(), ".qoder-cn", "projects"),
  ];
  for (const projectsDir of dirs) {
    let projects: string[];
    try { projects = readdirSync(projectsDir); } catch { continue; }
    for (const project of projects) {
      const transcript = path.join(projectsDir, project, `${sessionId}.jsonl`);
      if (!existsSync(transcript)) continue;
      const title = cachedTitle(`qoder:${sessionId}`, transcript, () => {
        let found = "";
        for (const line of readHead(transcript, READ_CAP_BYTES).split("\n")) {
          if (!line.includes('"ai-title"')) continue;
          try {
            const parsed = JSON.parse(line) as { type?: unknown; aiTitle?: unknown };
            if (parsed.type === "ai-title") found = acceptNativeTitle(parsed.aiTitle);
          } catch {
            continue;
          }
        }
        return found;
      });
      if (title) return title;
    }
  }
  return "";
}

/** OpenCode 未命名会话的占位标题不能当原生标题用。 */
const OPENCODE_PLACEHOLDER_TITLE = /^(?:new session|untitled session)\b/i;

function readOpenCodeNativeTitle(sessionId: string, databasePath?: string): string {
  const dbPath = databasePath ?? path.join(
    process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share"),
    "opencode", "opencode.db",
  );
  if (!existsSync(dbPath)) return "";
  return cachedTitle(`opencode:${sessionId}`, dbPath, () => {
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(dbPath, { readOnly: true });
      const row = database.prepare("SELECT title FROM session WHERE id = ?").get(sessionId) as
        { title?: unknown } | undefined;
      const title = acceptNativeTitle(row?.title);
      return title && !OPENCODE_PLACEHOLDER_TITLE.test(title) ? title : "";
    } catch {
      return "";
    } finally {
      try { database?.close(); } catch { /* 只读探测 */ }
    }
  });
}

function grokSessionDirs(grokSessionsDir: string, cwd: string): string[] {
  const encoded = encodeURIComponent(cwd);
  const primary = path.join(grokSessionsDir, encoded);
  if (existsSync(primary)) return [primary];
  const visited: string[] = [];
  let queue: Array<{ dir: string; depth: number }> = [{ dir: grokSessionsDir, depth: 0 }];
  while (queue.length > 0 && visited.length < GROK_WALK_LIMIT) {
    const next: typeof queue = [];
    for (const item of queue) {
      let entries: string[];
      try { entries = readdirSync(item.dir); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(item.dir, entry);
        let stats;
        try { stats = statSync(full); } catch { continue; }
        if (!stats.isDirectory()) continue;
        visited.push(full);
        if (item.depth < 2) next.push({ dir: full, depth: item.depth + 1 });
      }
    }
    queue = next;
  }
  return visited;
}

function readGrokNativeTitle(sessionId: string, cwd: string, grokSessionsDir?: string): string {
  if (!UUID_PATTERN.test(sessionId)) return "";
  const root = grokSessionsDir ?? path.join(os.homedir(), ".grok", "sessions");
  if (!existsSync(root)) return "";
  for (const dir of grokSessionDirs(root, cwd)) {
    const summary = path.join(dir, sessionId, "summary.json");
    if (!existsSync(summary)) continue;
    const title = cachedTitle(`grok:${sessionId}`, summary, () => {
      try {
        const parsed = JSON.parse(readHead(summary, 65_536)) as { generated_title?: unknown };
        return acceptNativeTitle(parsed.generated_title);
      } catch {
        return "";
      }
    });
    if (title) return title;
  }
  return "";
}

/** 只用于测试与降级：清掉按文件指纹缓存的原生标题。 */
export function clearNativeSessionTitleCache(): void {
  nativeTitleCache.clear();
}
