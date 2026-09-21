import type {
  QuickCommitContextMode,
  QuickCommitFile,
  QuickCommitInput,
  QuickCommitIterationContext,
  QuickCommitIterationEntry,
  QuickCommitLoadOptions,
  QuickCommitPushInput,
  QuickCommitPushResponse,
  QuickCommitRepository,
  QuickCommitResponse,
  QuickCommitSelection,
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

function normalizeMode(value: unknown, fallback: QuickCommitContextMode): QuickCommitContextMode {
  return value === "iteration" || value === "diff" ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item) : [];
}

function normalizeEntries(value: unknown): QuickCommitIterationEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string") return [];
    return [{
      id: item.id,
      title: stringValue(item.title),
      detail: stringValue(item.detail),
      createdAt: stringValue(item.createdAt),
      consumed: item.consumed === true,
      consumedCommit: stringValue(item.consumedCommit),
      source: stringValue(item.source),
    }];
  });
}

/** 服务端返回的迭代上下文；缺字段一律兑成安全默认值，面板不会因此崩。 */
export function normalizeQuickCommitContext(value: unknown): QuickCommitIterationContext {
  const record = isRecord(value) ? value : {};
  const iteration = isRecord(record.iteration) ? record.iteration : {};
  const entries = normalizeEntries(record.entries);
  const defaultEntryIds = stringList(record.defaultEntryIds);
  const selectableIds = stringList(record.selectableIds);
  return {
    iteration: {
      id: stringValue(iteration.id),
      name: stringValue(iteration.name),
      isDefault: iteration.isDefault === true,
    },
    entries,
    defaultEntryIds,
    selectableIds: selectableIds.length > 0 ? selectableIds : entries.map((entry) => entry.id),
    truncated: record.truncated === true,
    effectiveMode: normalizeMode(record.effectiveMode, defaultEntryIds.length > 0 ? "iteration" : "diff"),
    mode: normalizeMode(record.mode, "iteration"),
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

  async loadContext(
    sessionId: string,
    options: QuickCommitLoadOptions = {},
  ): Promise<QuickCommitIterationContext> {
    const response = await this.fetchImpl(
      `/api/sessions/${encodeURIComponent(sessionId)}/iteration-context`,
      { credentials: "same-origin", signal: options.signal },
    );
    return normalizeQuickCommitContext(await readRecord(response, "无法读取本轮变更。"));
  }

  async saveContextMode(
    sessionId: string,
    mode: QuickCommitContextMode,
  ): Promise<QuickCommitContextMode> {
    const response = await this.fetchImpl(
      `/api/sessions/${encodeURIComponent(sessionId)}/iteration-context`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      },
    );
    const data = await readRecord(response, "无法保存输入选择。");
    return normalizeMode(data.mode, mode);
  }

  async generate(
    sessionId: string,
    options: QuickCommitLoadOptions & { selection?: QuickCommitSelection; includeDiff?: boolean } = {},
  ): Promise<QuickCommitSuggestion> {
    // 只发真正有值的字段：没选过就不替服务端做决定（它用记住的偏好兜底）。
    const body: Record<string, unknown> = {};
    if (options.selection) {
      body.mode = options.selection.mode;
      body.entryIds = [...options.selection.entryIds];
    }
    if (options.includeDiff) body.includeDiff = true;
    const response = await this.fetchImpl(
      `/api/sessions/${encodeURIComponent(sessionId)}/generate-commit-message`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      },
    );
    const data = await readRecord(response, "AI 生成失败。");
    const context = isRecord(data.commitContext) ? data.commitContext : null;
    return {
      message: stringValue(data.message),
      suggestedTag: stringValue(data.suggestedTag).trim(),
      contextSource: normalizeMode(context?.source, "diff"),
      entryIds: stringList(context?.entryIds),
    };
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
    const rawContext = isRecord(data.commitContext) ? data.commitContext : null;
    return {
      ok: data.ok !== false,
      commit,
      tag,
      pushed: data.pushed === true,
      pushError: stringValue(data.pushError),
      submoduleCommits,
      commitContext: rawContext
        ? { source: normalizeMode(rawContext.source, "diff"), entryIds: stringList(rawContext.entryIds) }
        : null,
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
