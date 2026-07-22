import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  type Dirent,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;
const WORKTREE_DIR_PATTERN = /--?\.?(?:wand-worktrees|claude-worktrees)-/;

export interface ClaudeHistorySession {
  claudeSessionId: string;
  projectDir: string;
  cwd: string;
  firstUserMessage: string;
  timestamp: string;
  mtimeMs: number;
  hasConversation: boolean;
  managedByWand: boolean;
}

export interface CodexHistorySession {
  claudeSessionId: string;
  cwd: string;
  firstUserMessage: string;
  firstUserAt: string;
  timestamp: string;
  mtimeMs: number;
  hasUser: boolean;
  hasConversation: boolean;
  managedByWand: boolean;
  provider: "codex";
}

/** OpenCode persists session metadata and messages in its local SQLite database. */
export interface OpenCodeHistorySession {
  claudeSessionId: string;
  cwd: string;
  firstUserMessage: string;
  timestamp: string;
  mtimeMs: number;
  hasConversation: boolean;
  managedByWand: boolean;
  provider: "opencode";
}

/** Qoder CLI keeps one JSONL transcript per project-local native session. */
export interface QoderHistorySession {
  claudeSessionId: string;
  cwd: string;
  firstUserMessage: string;
  timestamp: string;
  mtimeMs: number;
  hasConversation: boolean;
  managedByWand: boolean;
  provider: "qoder";
}

export interface ProviderHistoryScannerOptions {
  claudeHome?: string;
  codexSessionsDir?: string;
  openCodeDatabasePath?: string;
  /** Qoder and Qoder CN use separate config roots; callers may override both for tests. */
  qoderProjectsDirs?: string[];
}

interface CachedSummary<T> {
  mtimeMs: number;
  size: number;
  summary: T | null;
}

function readHead(filePath: string, maxBytes: number): { text: string; mtimeMs: number; size: number } | null {
  let fd: number | null = null;
  try {
    const stats = statSync(filePath);
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(1, stats.size)));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.toString("utf8", 0, bytesRead), mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/** Best-effort inverse of Claude's non-alphanumeric-to-dash project encoding. */
function invertNormalizedProjectDir(dirName: string): string {
  const naive = dirName.replace(/-/g, "/");
  if (existsSync(naive)) return naive;
  const parts = dirName.split("-").filter(Boolean);
  if (parts.length === 0 || parts.length > 20) return naive;

  let candidates = ["/" + parts[0]];
  for (let index = 1; index < parts.length; index += 1) {
    const next: string[] = [];
    for (const prefix of candidates) {
      next.push(`${prefix}/${parts[index]}`);
      next.push(`${prefix}-${parts[index]}`);
    }
    if (index < parts.length - 1) {
      const valid = next.filter((candidate) => {
        try { return existsSync(candidate); } catch { return false; }
      });
      candidates = valid.length > 0 ? valid : next;
    } else {
      candidates = next;
    }
    if (candidates.length > 200) candidates = candidates.slice(0, 200);
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? naive;
}

function parseClaudeSummary(
  filePath: string,
  id: string,
  cwd: string,
  head: { text: string; mtimeMs: number },
): ClaudeHistorySession {
  let timestamp = "";
  let firstUserMessage = "";
  let hasUser = false;
  let hasAssistant = false;
  for (const line of head.text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        timestamp?: string;
        content?: string;
        message?: { role?: string; content?: unknown };
      };
      if (!timestamp && parsed.timestamp) timestamp = parsed.timestamp;
      if (parsed.type === "user" || parsed.message?.role === "user") {
        hasUser = true;
        const content = typeof parsed.content === "string"
          ? parsed.content
          : typeof parsed.message?.content === "string"
            ? parsed.message.content
            : "";
        if (!firstUserMessage && content.trim()) firstUserMessage = content.trim().slice(0, 120);
      }
      if (parsed.type === "assistant" || parsed.message?.role === "assistant") hasAssistant = true;
    } catch {
      continue;
    }
  }
  return {
    claudeSessionId: id,
    projectDir: path.basename(path.dirname(filePath)),
    cwd,
    firstUserMessage,
    timestamp: timestamp || new Date(head.mtimeMs).toISOString(),
    mtimeMs: head.mtimeMs,
    hasConversation: hasUser && hasAssistant,
    managedByWand: false,
  };
}

function isCodexSystemInjectedText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("#") || trimmed.startsWith("<");
}

function qoderMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: unknown; text?: unknown } => Boolean(block && typeof block === "object"))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function isQoderGeneratedMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<local-command-caveat>") || trimmed.startsWith("<command-message>");
}

function parseQoderSummary(
  id: string,
  head: { text: string; mtimeMs: number },
): QoderHistorySession {
  let cwd = "";
  let timestamp = "";
  let firstUserMessage = "";
  let aiTitle = "";
  let hasUser = false;
  let hasAssistant = false;

  for (const line of head.text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: {
      type?: unknown;
      timestamp?: unknown;
      cwd?: unknown;
      directories?: unknown;
      sessionId?: unknown;
      isMeta?: unknown;
      message?: { role?: unknown; content?: unknown };
      aiTitle?: unknown;
    };
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!timestamp && typeof parsed.timestamp === "string") timestamp = parsed.timestamp;
    if (!cwd && typeof parsed.cwd === "string") cwd = parsed.cwd;
    if (!cwd && parsed.type === "workspace-directories" && Array.isArray(parsed.directories)) {
      const directory = parsed.directories.find((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (directory) cwd = directory;
    }
    if (parsed.type === "ai-title" && typeof parsed.aiTitle === "string" && parsed.aiTitle.trim()) {
      aiTitle = parsed.aiTitle.trim();
    }
    const role = parsed.message?.role;
    if (parsed.type === "user" && role === "user") {
      const text = qoderMessageText(parsed.message?.content).trim();
      if (text && parsed.isMeta !== true && !isQoderGeneratedMessage(text)) {
        hasUser = true;
        if (!firstUserMessage) firstUserMessage = text.slice(0, 120);
      }
    } else if (parsed.type === "assistant" && role === "assistant") {
      hasAssistant = true;
    }
  }

  return {
    claudeSessionId: id,
    cwd,
    firstUserMessage: aiTitle || firstUserMessage,
    timestamp: timestamp || new Date(head.mtimeMs).toISOString(),
    mtimeMs: head.mtimeMs,
    hasConversation: hasUser && hasAssistant,
    managedByWand: false,
    provider: "qoder",
  };
}

/**
 * Codex versions used before quick commit enabled `--ephemeral` persisted these
 * internal one-shot prompts as ordinary sessions. Hide those legacy artifacts
 * without deleting their files; newly generated quick-commit calls never land
 * in the history directory in the first place.
 */
function isWandQuickCommitPrompt(text: string): boolean {
  const trimmed = text.trimStart();
  return (trimmed.startsWith("阅读以下 git diff，用")
      && trimmed.includes("写一条简洁的 commit message。要求：祈使句，不超过 50 字，描述「做了什么」。只输出 message 本身"))
    || (trimmed.startsWith("阅读以下 git diff，完成两件事：")
      && trimmed.includes("请严格输出**单行 JSON 对象**"))
    || (trimmed.startsWith("根据以下 commit message 和 git diff 推荐一个语义化版本 tag")
      && trimmed.includes("严格输出**单行 JSON 对象**"))
    || trimmed.startsWith("你正在作为 Wand 的快捷提交兜底执行器运行。");
}

function parseCodexSummary(head: { text: string; mtimeMs: number }): CodexHistorySession | null {
  let id = "";
  let cwd = "";
  let timestamp = "";
  let firstUserMessage = "";
  let firstUserAt = "";
  let hasUser = false;
  let hasAssistant = false;

  for (const line of head.text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: {
      type?: string;
      timestamp?: string;
      payload?: {
        type?: string;
        id?: string;
        cwd?: string;
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
      };
    };
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!timestamp && parsed.timestamp) timestamp = parsed.timestamp;
    const payload = parsed.payload;
    if (!payload) continue;
    if (parsed.type === "session_meta" || payload.type === "session_meta") {
      if (!id && typeof payload.id === "string") id = payload.id;
      if (!cwd && typeof payload.cwd === "string") cwd = payload.cwd;
      continue;
    }
    if (payload.type === "message" && payload.role === "user") {
      const text = Array.isArray(payload.content)
        ? payload.content
            .filter((block) => block?.type === "input_text" && typeof block.text === "string")
            .map((block) => block.text as string)
            .join("")
        : "";
      if (text.trim()) {
        hasUser = true;
        if (!firstUserAt && parsed.timestamp) firstUserAt = parsed.timestamp;
        if (!firstUserMessage && !isCodexSystemInjectedText(text)) firstUserMessage = text.trim().slice(0, 120);
      }
    } else if (payload.type === "message" && payload.role === "assistant") {
      hasAssistant = true;
    }
  }
  if (!id) return null;
  if (isWandQuickCommitPrompt(firstUserMessage)) return null;
  return {
    claudeSessionId: id,
    cwd,
    firstUserMessage,
    firstUserAt,
    timestamp: timestamp || new Date(head.mtimeMs).toISOString(),
    mtimeMs: head.mtimeMs,
    hasUser,
    hasConversation: hasUser && hasAssistant,
    managedByWand: false,
    provider: "codex",
  };
}

/**
 * Incremental provider-history index. Directory entries are refreshed on each
 * scan, while unchanged JSONL heads are reused by (path, mtime, size).
 */
export class ProviderHistoryScanner {
  private readonly claudeHome: string;
  private readonly claudeProjectsDir: string;
  private readonly codexSessionsDir: string;
  private readonly openCodeDatabasePath: string;
  private readonly qoderProjectsDirs: string[];
  private readonly claudeIndex = new Map<string, CachedSummary<ClaudeHistorySession>>();
  private readonly codexIndex = new Map<string, CachedSummary<CodexHistorySession>>();
  private readonly qoderIndex = new Map<string, CachedSummary<QoderHistorySession>>();
  private openCodeFingerprint: string | null = null;
  private openCodeSessions: OpenCodeHistorySession[] = [];
  private parsedFiles = 0;

  constructor(options: ProviderHistoryScannerOptions = {}) {
    this.claudeHome = options.claudeHome ?? path.join(os.homedir(), ".claude");
    this.claudeProjectsDir = path.join(this.claudeHome, "projects");
    this.codexSessionsDir = options.codexSessionsDir ?? path.join(os.homedir(), ".codex", "sessions");
    const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
    this.openCodeDatabasePath = options.openCodeDatabasePath ?? path.join(dataHome, "opencode", "opencode.db");
    this.qoderProjectsDirs = options.qoderProjectsDirs ?? [
      path.join(os.homedir(), ".qoder", "projects"),
      path.join(os.homedir(), ".qoder-cn", "projects"),
    ];
  }

  getDiagnostics(): { parsedFiles: number; claudeEntries: number; codexEntries: number; openCodeEntries: number; qoderEntries: number } {
    return {
      parsedFiles: this.parsedFiles,
      claudeEntries: this.claudeIndex.size,
      codexEntries: this.codexIndex.size,
      openCodeEntries: this.openCodeSessions.length,
      qoderEntries: this.qoderIndex.size,
    };
  }

  invalidate(provider?: "claude" | "codex" | "opencode" | "qoder"): void {
    if (!provider || provider === "claude") this.claudeIndex.clear();
    if (!provider || provider === "codex") this.codexIndex.clear();
    if (!provider || provider === "opencode") {
      this.openCodeFingerprint = null;
      this.openCodeSessions = [];
    }
    if (!provider || provider === "qoder") this.qoderIndex.clear();
  }

  listClaudeHistorySessions(): ClaudeHistorySession[] {
    const observed = new Set<string>();
    const results: ClaudeHistorySession[] = [];
    let dirs: Dirent<string>[];
    try { dirs = readdirSync(this.claudeProjectsDir, { withFileTypes: true }); } catch { return []; }

    for (const dir of dirs) {
      if (!dir.isDirectory() || WORKTREE_DIR_PATTERN.test(dir.name)) continue;
      const dirPath = path.join(this.claudeProjectsDir, dir.name);
      const cwd = invertNormalizedProjectDir(dir.name);
      let files: Dirent<string>[];
      try { files = readdirSync(dirPath, { withFileTypes: true }); } catch { continue; }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        const id = file.name.slice(0, -6);
        if (!UUID_PATTERN.test(id)) continue;
        const filePath = path.join(dirPath, file.name);
        observed.add(filePath);
        let stats: { mtimeMs: number; size: number };
        try { stats = statSync(filePath); } catch { continue; }
        let cached = this.claudeIndex.get(filePath);
        if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
          const head = readHead(filePath, 8192);
          if (!head) continue;
          cached = { mtimeMs: head.mtimeMs, size: head.size, summary: parseClaudeSummary(filePath, id, cwd, head) };
          this.claudeIndex.set(filePath, cached);
          this.parsedFiles += 1;
        }
        if (cached.summary) results.push({ ...cached.summary, managedByWand: false });
      }
    }
    for (const filePath of this.claudeIndex.keys()) {
      if (!observed.has(filePath)) this.claudeIndex.delete(filePath);
    }
    return results.sort((left, right) => right.mtimeMs - left.mtimeMs);
  }

  private listCodexRolloutFiles(): string[] {
    try {
      return readdirSync(this.codexSessionsDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl"))
        .map((entry) => {
          const parent = (entry as { parentPath?: string; path?: string }).parentPath
            ?? (entry as { path?: string }).path
            ?? this.codexSessionsDir;
          return path.join(parent, entry.name);
        });
    } catch {
      return [];
    }
  }

  listCodexHistorySessions(): CodexHistorySession[] {
    const observed = new Set<string>();
    const byThread = new Map<string, CodexHistorySession>();
    for (const filePath of this.listCodexRolloutFiles()) {
      observed.add(filePath);
      let stats: { mtimeMs: number; size: number };
      try { stats = statSync(filePath); } catch { continue; }
      let cached = this.codexIndex.get(filePath);
      if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
        const head = readHead(filePath, 65536);
        if (!head) continue;
        cached = { mtimeMs: head.mtimeMs, size: head.size, summary: parseCodexSummary(head) };
        this.codexIndex.set(filePath, cached);
        this.parsedFiles += 1;
      }
      const summary = cached.summary;
      if (!summary) continue;
      const existing = byThread.get(summary.claudeSessionId);
      if (!existing || summary.mtimeMs > existing.mtimeMs) {
        byThread.set(summary.claudeSessionId, { ...summary, managedByWand: false });
      }
    }
    for (const filePath of this.codexIndex.keys()) {
      if (!observed.has(filePath)) this.codexIndex.delete(filePath);
    }
    return Array.from(byThread.values()).sort((left, right) => right.mtimeMs - left.mtimeMs);
  }

  hasCodexSessionFile(threadId: string): boolean {
    return UUID_PATTERN.test(threadId)
      && this.listCodexHistorySessions().some((session) => session.claudeSessionId === threadId);
  }

  listOpenCodeHistorySessions(): OpenCodeHistorySession[] {
    const databasePaths = [this.openCodeDatabasePath, `${this.openCodeDatabasePath}-wal`];
    const fingerprint = databasePaths.map((filePath) => {
      try {
        const stats = statSync(filePath);
        return `${filePath}:${stats.mtimeMs}:${stats.size}`;
      } catch {
        return `${filePath}:missing`;
      }
    }).join("|");
    if (fingerprint === this.openCodeFingerprint) {
      return this.openCodeSessions.map((session) => ({ ...session, managedByWand: false }));
    }

    this.openCodeFingerprint = fingerprint;
    if (!existsSync(this.openCodeDatabasePath)) {
      this.openCodeSessions = [];
      return [];
    }

    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(this.openCodeDatabasePath, { readOnly: true });
      const rows = database.prepare(`
        SELECT
          session.id AS id,
          session.directory AS cwd,
          session.title AS title,
          session.time_created AS time_created,
          session.time_updated AS time_updated,
          SUM(CASE WHEN json_extract(message.data, '$.role') = 'user' THEN 1 ELSE 0 END) AS user_count,
          SUM(CASE WHEN json_extract(message.data, '$.role') = 'assistant' THEN 1 ELSE 0 END) AS assistant_count
        FROM session
        LEFT JOIN message ON message.session_id = session.id
        GROUP BY session.id
        ORDER BY session.time_updated DESC
        LIMIT 1000
      `).all() as Array<{
        id: unknown;
        cwd: unknown;
        title: unknown;
        time_created: unknown;
        time_updated: unknown;
        user_count: unknown;
        assistant_count: unknown;
      }>;
      this.openCodeSessions = rows.flatMap((row) => {
        if (typeof row.id !== "string" || !PROVIDER_SESSION_ID_PATTERN.test(row.id)) return [];
        if (typeof row.cwd !== "string" || !row.cwd.trim()) return [];
        const mtimeMs = Number(row.time_updated);
        const createdMs = Number(row.time_created);
        if (!Number.isFinite(mtimeMs) || !Number.isFinite(createdMs)) return [];
        return [{
          claudeSessionId: row.id,
          cwd: row.cwd,
          firstUserMessage: typeof row.title === "string" ? row.title.trim().slice(0, 120) : "",
          timestamp: new Date(createdMs).toISOString(),
          mtimeMs,
          hasConversation: Number(row.user_count) > 0 && Number(row.assistant_count) > 0,
          managedByWand: false,
          provider: "opencode" as const,
        }];
      });
      return this.openCodeSessions.map((session) => ({ ...session }));
    } catch {
      this.openCodeSessions = [];
      return [];
    } finally {
      try { database?.close(); } catch { /* best-effort read-only probe */ }
    }
  }

  private listQoderTranscriptFiles(): string[] {
    const files: string[] = [];
    for (const projectsDir of this.qoderProjectsDirs) {
      let projects: Dirent<string>[];
      try { projects = readdirSync(projectsDir, { withFileTypes: true }); } catch { continue; }
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const projectDir = path.join(projectsDir, project.name);
        let entries: Dirent<string>[];
        try { entries = readdirSync(projectDir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(projectDir, entry.name));
        }
      }
    }
    return files;
  }

  listQoderHistorySessions(): QoderHistorySession[] {
    const observed = new Set<string>();
    const bySessionId = new Map<string, QoderHistorySession>();
    for (const filePath of this.listQoderTranscriptFiles()) {
      const id = path.basename(filePath, ".jsonl");
      if (!PROVIDER_SESSION_ID_PATTERN.test(id)) continue;
      observed.add(filePath);
      let stats: { mtimeMs: number; size: number };
      try { stats = statSync(filePath); } catch { continue; }
      let cached = this.qoderIndex.get(filePath);
      if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
        const head = readHead(filePath, 65536);
        if (!head) continue;
        cached = { mtimeMs: head.mtimeMs, size: head.size, summary: parseQoderSummary(id, head) };
        this.qoderIndex.set(filePath, cached);
        this.parsedFiles += 1;
      }
      const summary = cached.summary;
      if (!summary || !summary.cwd) continue;
      const existing = bySessionId.get(summary.claudeSessionId);
      if (!existing || summary.mtimeMs > existing.mtimeMs) {
        bySessionId.set(summary.claudeSessionId, { ...summary, managedByWand: false });
      }
    }
    for (const filePath of this.qoderIndex.keys()) {
      if (!observed.has(filePath)) this.qoderIndex.delete(filePath);
    }
    return Array.from(bySessionId.values()).sort((left, right) => right.mtimeMs - left.mtimeMs);
  }

  deleteClaudeHistoryFiles(sessions: Array<{ claudeSessionId: string; cwd: string }>): number {
    let deleted = 0;
    for (const { claudeSessionId, cwd } of sessions) {
      if (!UUID_PATTERN.test(claudeSessionId)) continue;
      const normalized = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
      const jsonlPath = path.join(this.claudeProjectsDir, normalized, `${claudeSessionId}.jsonl`);
      try { unlinkSync(jsonlPath); deleted += 1; } catch { /* already absent */ }
      this.claudeIndex.delete(jsonlPath);
      for (const sub of ["session-env", "tasks", "todos"]) {
        const dir = path.join(this.claudeHome, sub, claudeSessionId);
        try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    return deleted;
  }

  deleteCodexHistoryFiles(threadIds: string[]): number {
    const valid = new Set(threadIds.filter((id) => UUID_PATTERN.test(id)));
    if (valid.size === 0) return 0;
    let deleted = 0;
    for (const filePath of this.listCodexRolloutFiles()) {
      let cached = this.codexIndex.get(filePath);
      if (!cached) {
        const head = readHead(filePath, 65536);
        if (!head) continue;
        cached = { mtimeMs: head.mtimeMs, size: head.size, summary: parseCodexSummary(head) };
        this.codexIndex.set(filePath, cached);
        this.parsedFiles += 1;
      }
      if (cached.summary && valid.has(cached.summary.claudeSessionId)) {
        try { unlinkSync(filePath); deleted += 1; } catch { /* already absent */ }
        this.codexIndex.delete(filePath);
      }
    }
    return deleted;
  }

  deleteOpenCodeHistorySessions(sessionIds: string[]): number {
    const ids = sessionIds.filter((id) => PROVIDER_SESSION_ID_PATTERN.test(id));
    if (ids.length === 0 || !existsSync(this.openCodeDatabasePath)) return 0;
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(this.openCodeDatabasePath);
      database.exec("PRAGMA foreign_keys = ON");
      const remove = database.prepare("DELETE FROM session WHERE id = ?");
      let deleted = 0;
      for (const id of ids) deleted += Number(remove.run(id).changes ?? 0);
      this.invalidate("opencode");
      return deleted;
    } catch {
      return 0;
    } finally {
      try { database?.close(); } catch { /* best effort */ }
    }
  }

  deleteQoderHistoryFiles(sessionIds: string[]): number {
    const ids = new Set(sessionIds.filter((id) => PROVIDER_SESSION_ID_PATTERN.test(id)));
    if (ids.size === 0) return 0;
    let deleted = 0;
    for (const filePath of this.listQoderTranscriptFiles()) {
      const id = path.basename(filePath, ".jsonl");
      if (!ids.has(id)) continue;
      try { unlinkSync(filePath); deleted += 1; } catch { /* already absent */ }
      this.qoderIndex.delete(filePath);
    }
    return deleted;
  }
}
