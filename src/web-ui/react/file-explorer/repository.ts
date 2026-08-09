import type { FilePreviewFailure } from "../file-preview/types";
import type {
  FileExplorerEntry,
  FileExplorerListResult,
  FileExplorerMutationResult,
  FileExplorerRepository,
  FileExplorerSearchResult,
} from "./types";

type FetchLike = typeof fetch;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function readJson(response: Response): Promise<JsonRecord> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function failureFromResponse(
  response: Response,
  value: JsonRecord,
  fallback: string,
): FilePreviewFailure {
  return {
    message: stringValue(value.error, `${fallback} (HTTP ${response.status})`),
    status: response.status,
  };
}

function coerceEntry(record: JsonRecord): FileExplorerEntry | null {
  const path = stringValue(record.path);
  const name = stringValue(record.name);
  if (!path || !name) return null;
  const type = record.type === "dir" ? "dir" : "file";
  const entry: FileExplorerEntry = { path, name, type };
  if (typeof record.size === "number" && Number.isFinite(record.size)) entry.size = record.size;
  if (typeof record.mtime === "string" && record.mtime) entry.mtime = record.mtime;
  const git = isRecord(record.gitStatus) ? record.gitStatus : undefined;
  if (git) {
    const status: NonNullable<FileExplorerEntry["gitStatus"]> = {};
    const stagedRaw = stringValue(git.staged);
    const unstagedRaw = stringValue(git.unstaged);
    if (stagedRaw === "added" || stagedRaw === "modified" || stagedRaw === "deleted" || stagedRaw === "renamed") {
      status.staged = stagedRaw;
    }
    if (unstagedRaw === "modified" || unstagedRaw === "deleted") {
      status.unstaged = unstagedRaw;
    }
    if (git.untracked) status.untracked = true;
    entry.gitStatus = status;
  }
  return entry;
}

async function postMutation(
  fetchImpl: FetchLike,
  url: string,
  body: JsonRecord,
  fallback: string,
  affectedPath: string,
): Promise<FileExplorerMutationResult> {
  const response = await fetchImpl(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await readJson(response);
  if (!response.ok || typeof value.error === "string") {
    return { ok: false, failure: failureFromResponse(response, value, fallback) };
  }
  return { ok: true, affectedPath };
}

export class HttpFileExplorerRepository implements FileExplorerRepository {
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}

  async list(dirPath: string, signal?: AbortSignal): Promise<FileExplorerListResult> {
    const response = await this.fetchImpl(
      `/api/directory?q=${encodeURIComponent(dirPath)}&gitStatus=true`,
      { credentials: "same-origin", signal },
    );
    const value = await readJson(response);
    if (!response.ok || typeof value.error === "string") {
      return { ok: false, failure: failureFromResponse(response, value, "读取目录失败") };
    }
    const rawItems = Array.isArray(value.items) ? value.items : [];
    const entries: FileExplorerEntry[] = [];
    for (const item of rawItems) {
      const entry = isRecord(item) ? coerceEntry(item) : null;
      if (entry) entries.push(entry);
    }
    return {
      ok: true,
      entries,
      truncated: Boolean(value.truncated),
      total: finiteNumber(value.total, entries.length),
    };
  }

  async search(query: string, cwd: string, signal?: AbortSignal): Promise<FileExplorerSearchResult> {
    const params = new URLSearchParams({ q: query, cwd, depth: "5", limit: "80" });
    const response = await this.fetchImpl(
      `/api/file-search?${params.toString()}`,
      { credentials: "same-origin", signal },
    );
    const value = await readJson(response);
    if (!response.ok || typeof value.error === "string") {
      return { ok: false, failure: failureFromResponse(response, value, "搜索失败") };
    }
    const rawResults = Array.isArray(value.results) ? value.results : [];
    const results: FileExplorerEntry[] = [];
    for (const item of rawResults) {
      const entry = isRecord(item) ? coerceEntry(item) : null;
      if (entry) results.push(entry);
    }
    return { ok: true, results };
  }

  createFile(targetPath: string): Promise<FileExplorerMutationResult> {
    return postMutation(this.fetchImpl, "/api/file-create", { path: targetPath }, "创建文件失败", targetPath);
  }

  createDir(targetPath: string): Promise<FileExplorerMutationResult> {
    return postMutation(this.fetchImpl, "/api/dir-create", { path: targetPath }, "创建文件夹失败", targetPath);
  }

  rename(from: string, to: string): Promise<FileExplorerMutationResult> {
    return postMutation(this.fetchImpl, "/api/file-rename", { from, to }, "重命名失败", to);
  }

  delete(targetPath: string): Promise<FileExplorerMutationResult> {
    return postMutation(this.fetchImpl, "/api/file-delete", { path: targetPath }, "删除失败", targetPath);
  }
}

export const httpFileExplorerRepository = new HttpFileExplorerRepository();
