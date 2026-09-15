import type {
  QuickCommitFile,
  QuickCommitInput,
  QuickCommitLoadOptions,
  QuickCommitPushInput,
  QuickCommitPushResponse,
  QuickCommitRepository,
  QuickCommitResponse,
  QuickCommitStatus,
  QuickCommitSuggestion,
} from "./types";
import { finiteNumber, isRecord, stringValue, type JsonRecord } from "../json-utils";

type FetchLike = typeof fetch;
async function readRecord(response: Response, fallback: string): Promise<JsonRecord> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`${fallback} (HTTP ${response.status})`);
  }
  const record = isRecord(value) ? value : {};
  if (!response.ok) throw new Error(stringValue(record.error, `${fallback} (HTTP ${response.status})`));
  return record;
}

function normalizeFiles(value: unknown): QuickCommitFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== "string") return [];
    const rawState = isRecord(item.submoduleState) ? item.submoduleState : null;
    return [{
      path: item.path,
      status: stringValue(item.status),
      isSubmodule: item.isSubmodule === true,
      submoduleState: rawState ? {
        commitChanged: rawState.commitChanged === true,
        hasTrackedChanges: rawState.hasTrackedChanges === true,
        hasUntracked: rawState.hasUntracked === true,
      } : undefined,
    }];
  });
}

export function normalizeQuickCommitStatus(value: unknown): QuickCommitStatus {
  const record = isRecord(value) ? value : {};
  const files = normalizeFiles(record.files);
  const rawLastCommit = isRecord(record.lastCommit) ? record.lastCommit : null;
  const lastCommit = rawLastCommit ? {
    hash: stringValue(rawLastCommit.hash),
    shortHash: stringValue(rawLastCommit.shortHash),
    subject: stringValue(rawLastCommit.subject),
  } : undefined;
  return {
    isGit: record.isGit === true,
    branch: stringValue(record.branch),
    modifiedCount: Math.max(0, finiteNumber(record.modifiedCount, files.length)),
    files,
    head: stringValue(record.head),
    ahead: Math.max(0, finiteNumber(record.ahead)),
    behind: Math.max(0, finiteNumber(record.behind)),
    lastCommit,
    latestTag: stringValue(record.latestTag),
    hasSubmodule: record.hasSubmodule === true || files.some((file) => file.isSubmodule),
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

export class HttpQuickCommitRepository implements QuickCommitRepository {
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  async loadStatus(
    sessionId: string,
    options: QuickCommitLoadOptions = {},
  ): Promise<QuickCommitStatus> {
    const response = await this.fetchImpl(
      `/api/sessions/${encodeURIComponent(sessionId)}/git-status`,
      { credentials: "same-origin", signal: options.signal },
    );
    return normalizeQuickCommitStatus(await readRecord(response, "无法加载 Git 状态。"));
  }

  async generate(
    sessionId: string,
    options: QuickCommitLoadOptions = {},
  ): Promise<QuickCommitSuggestion> {
    const response = await this.fetchImpl(
      `/api/sessions/${encodeURIComponent(sessionId)}/generate-commit-message`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: options.signal,
      },
    );
    const data = await readRecord(response, "AI 生成失败。");
    return { message: stringValue(data.message), suggestedTag: stringValue(data.suggestedTag).trim() };
  }

  async commit(sessionId: string, input: QuickCommitInput): Promise<QuickCommitResponse> {
    const response = await this.fetchImpl(
      `/api/sessions/${encodeURIComponent(sessionId)}/quick-commit`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    const data = await readRecord(response, "快捷提交失败。");
    const commit = isRecord(data.commit) && typeof data.commit.hash === "string"
      ? { hash: data.commit.hash, message: stringValue(data.commit.message) }
      : undefined;
    const tag = isRecord(data.tag) && typeof data.tag.name === "string"
      ? { name: data.tag.name }
      : undefined;
    const submoduleCommits = Array.isArray(data.submoduleCommits)
      ? data.submoduleCommits.flatMap((item) => (
          isRecord(item) && typeof item.path === "string" && typeof item.hash === "string"
            ? [{ path: item.path, hash: item.hash }]
            : []
        ))
      : [];
    return {
      ok: data.ok !== false,
      commit,
      tag,
      pushed: data.pushed === true,
      pushError: stringValue(data.pushError),
      submoduleCommits,
    };
  }

  async push(sessionId: string, input: QuickCommitPushInput): Promise<QuickCommitPushResponse> {
    const response = await this.fetchImpl(
      `/api/sessions/${encodeURIComponent(sessionId)}/git/push`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    const data = await readRecord(response, "推送失败。");
    return {
      ok: data.ok !== false,
      pushedCommits: data.pushedCommits === true,
      pushedTags: data.pushedTags === true,
      error: stringValue(data.error),
    };
  }
}

export const httpQuickCommitRepository = new HttpQuickCommitRepository();
