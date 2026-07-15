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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

export interface ProviderHistoryScannerOptions {
  claudeHome?: string;
  codexSessionsDir?: string;
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
  private readonly claudeIndex = new Map<string, CachedSummary<ClaudeHistorySession>>();
  private readonly codexIndex = new Map<string, CachedSummary<CodexHistorySession>>();
  private parsedFiles = 0;

  constructor(options: ProviderHistoryScannerOptions = {}) {
    this.claudeHome = options.claudeHome ?? path.join(os.homedir(), ".claude");
    this.claudeProjectsDir = path.join(this.claudeHome, "projects");
    this.codexSessionsDir = options.codexSessionsDir ?? path.join(os.homedir(), ".codex", "sessions");
  }

  getDiagnostics(): { parsedFiles: number; claudeEntries: number; codexEntries: number } {
    return { parsedFiles: this.parsedFiles, claudeEntries: this.claudeIndex.size, codexEntries: this.codexIndex.size };
  }

  invalidate(provider?: "claude" | "codex"): void {
    if (!provider || provider === "claude") this.claudeIndex.clear();
    if (!provider || provider === "codex") this.codexIndex.clear();
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
}
