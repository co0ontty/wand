import { createHash } from "node:crypto";
import { isArchiveBlocked } from "./archive-policy.js";
import { logInfo } from "./runtime-log.js";
import { isSystemAiCall } from "./system-ai-call.js";
import { systemAiSessions } from "./system-ai-session-recorder.js";
import { cleanupWorktreeSync } from "./git-worktree.js";
import type { ProcessManager } from "./process-manager.js";
import { inferProviderFromCommand } from "./session-provider.js";
import type { WandStorage } from "./storage.js";
import type { StructuredSessionManager } from "./structured-session-manager.js";
import type { ExecutionMode,SessionSnapshot,ConversationTurn } from "./types.js";
import { enrichStructuredMessages } from "./structured-client-protocol.js";

export type SessionOwner = "structured" | "pty" | "storage";

export type ProviderHistoryDeleter = Pick<
  ProcessManager,
  | "deleteClaudeHistoryFiles"
  | "deleteCodexHistoryFiles"
  | "deleteOpenCodeHistorySessions"
  | "deleteQoderHistoryFiles"
  | "deletePiHistoryFiles"
  | "deleteGrokHistoryFiles"
>;

export function deleteProviderNativeHistory(
  deleter: ProviderHistoryDeleter,
  provider: string,
  providerSessionId: string,
  cwd: string,
): void {
  const id = providerSessionId.trim();
  if (!id) return;
  switch (provider) {
    case "claude":
      deleter.deleteClaudeHistoryFiles([{ claudeSessionId: id, cwd }]);
      break;
    case "codex":
      deleter.deleteCodexHistoryFiles([id]);
      break;
    case "opencode":
      deleter.deleteOpenCodeHistorySessions([id]);
      break;
    case "qoder":
      deleter.deleteQoderHistoryFiles([id]);
      break;
    case "pi":
      deleter.deletePiHistoryFiles([id]);
      break;
    case "grok":
      deleter.deleteGrokHistoryFiles([id]);
      break;
    default:
      break;
  }
}

type HiddenSessionStore = Pick<WandStorage, "getConfigValue" | "setConfigValue">;

/** The owner deletes the managed session first; native history/tombstones have one implementation. */
export function deleteOwnedSessionWithHistory(
  remove: () => SessionSnapshot | null,
  deleter: ProviderHistoryDeleter,
  storage: HiddenSessionStore,
  options: { barrier?: Promise<void> | null; canCleanup?: () => boolean; isSettled?: () => boolean } = {},
): SessionSnapshot | null {
  const snapshot = remove();
  const providerSessionId = snapshot?.claudeSessionId?.trim();
  if (!snapshot || !providerSessionId) {
    void options.barrier?.catch(() => {});
    return snapshot;
  }
  const provider = sessionProvider(snapshot);
  // Hide immediately so history cannot reappear between row removal and CLI exit.
  if (options.canCleanup?.() !== false) addHiddenSessionIds(storage, [providerSessionId]);
  const cleanup = () => {
    if (options.canCleanup?.() === false || options.isSettled?.() === false) return;
    addHiddenSessionIds(storage, [providerSessionId]);
    deleteProviderNativeHistory(deleter, provider, providerSessionId, snapshot.cwd);
  };
  const failed = () => { logInfo("[SessionCleanup] CLI session cleanup could not complete; artifacts were preserved."); };
  if (options.barrier) void options.barrier.then(cleanup).catch(failed);
  else {
    try { cleanup(); } catch { failed(); }
  }
  return snapshot;
}

function sessionProvider(snapshot: SessionSnapshot): string {
  return snapshot.provider ?? snapshot.structuredState?.provider ?? inferProviderFromCommand(snapshot.command) ?? "claude";
}


/** 读取 `hidden_claude_session_ids`；坏数据 / 空值按空集合处理，不抛错。 */
export function readHiddenSessionIds(storage: Pick<HiddenSessionStore, "getConfigValue">): Set<string> {
  const raw = storage.getConfigValue("hidden_claude_session_ids");
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

/** 写回 `hidden_claude_session_ids`（保持既有的 JSON 数组格式）。 */
export function writeHiddenSessionIds(storage: Pick<HiddenSessionStore, "setConfigValue">, ids: Set<string>): void {
  storage.setConfigValue("hidden_claude_session_ids", JSON.stringify(Array.from(ids)));
}

/** 追加若干 provider 原生 session id；无变化时不写盘。 */
export function addHiddenSessionIds(storage: HiddenSessionStore, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const hidden = readHiddenSessionIds(storage);
  let changed = false;
  for (const id of ids) {
    if (hidden.has(id)) continue;
    hidden.add(id);
    changed = true;
  }
  if (changed) writeHiddenSessionIds(storage, hidden);
}

/** 移除若干 provider 原生 session id；无变化时不写盘。 */
export function removeHiddenSessionIds(storage: HiddenSessionStore, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const hidden = readHiddenSessionIds(storage);
  let changed = false;
  for (const id of ids) {
    changed = hidden.delete(id) || changed;
  }
  if (changed) writeHiddenSessionIds(storage, hidden);
}

/**
 * Coordinates session ownership without merging the two runner managers.
 * Live structured state wins over PTY, and both win over a durable fallback.
 */
export class SessionRegistry {
  private readonly messageProjections = new Map<string, { revision: string; source: ConversationTurn[]; projected: ConversationTurn[] }>();
  private readonly messageEpochs = new Map<string, number>();
  invalidateMessageProjection(id: string): void {
    this.messageProjections.delete(id);
    this.messageEpochs.set(id, (this.messageEpochs.get(id) ?? 0) + 1);
    if (this.messageEpochs.size > 2048) this.messageEpochs.delete(this.messageEpochs.keys().next().value!);
  }
  /** One semantic pass per source/revision, shared by HTTP and all WS readers. */
  transportMessages(id: string, messages: ConversationTurn[]): ConversationTurn[] {
    // Some live adapters append in place before the debounced event boundary. A
    // content digest prevents cached semantics from crossing that mutation window.
    const raw = JSON.stringify(messages);
    const digest = createHash("sha256").update(raw).digest("hex");
    const revision = `${this.storage.projectionRevision()}:${this.messageEpochs.get(id) ?? 0}:${digest}`;
    const cached = this.messageProjections.get(id);
    if (cached?.revision === revision) return cached.projected;
    const projected = enrichStructuredMessages(messages, id);
    this.messageProjections.delete(id);
    if (raw.length <= 1024 * 1024 && messages.length <= 2000 && messages.reduce((n, turn) => n + turn.content.length, 0) <= 10000) {
      this.messageProjections.set(id, { revision, source: messages, projected });
      while (this.messageProjections.size > 16) this.messageProjections.delete(this.messageProjections.keys().next().value!);
    }
    return projected;
  }

  /** Deleted owners can still be exiting; listSlim alone no longer sees them. */
  private readonly nativeDeletionBarriers = new Map<string, Set<Promise<void>>>();

  constructor(
    private readonly processes: ProcessManager,
    private readonly structured: StructuredSessionManager,
    private readonly storage: WandStorage,
  ) {}

  ownerOf(id: string): SessionOwner | null {
    if (this.structured.get(id)) return "structured";
    if (this.processes.getOwned(id)) return "pty";
    return this.storage.getSession(id) ? "storage" : null;
  }

  get(id: string): SessionSnapshot | null {
    const snapshot = this.structured.get(id) ?? this.processes.getOwned(id) ?? this.storage.getSession(id);
    const membership = this.storage.getSessionWorkspace(id);
    return snapshot ? { ...snapshot, ...membership, ...this.storage.getSessionCompletion(id) } : null;
  }

  getLatest(id: string): SessionSnapshot | null {
    return this.get(id);
  }

  /** Runtime facts and membership only; list/policy reads must not hydrate transcripts. */
  getSlim(id: string): SessionSnapshot | null {
    const snapshot = this.structured.getSlim(id) ?? this.processes.getOwnedSlim(id) ?? this.storage.getSessionSlim(id);
    return snapshot ? { ...snapshot, ...this.storage.getSessionWorkspace(id), ...this.storage.getSessionCompletion(id) } : null;
  }

  listSlim(options?: { runtimeOnly?: boolean }): SessionSnapshot[] {
    const byId = new Map<string, SessionSnapshot>();
    for (const snapshot of this.structured.listSlim()) byId.set(snapshot.id, snapshot);
    for (const snapshot of this.processes.listSlim()) {
      if (!byId.has(snapshot.id)) byId.set(snapshot.id, snapshot);
    }
    for (const snapshot of this.storage.loadSessionsSlim()) {
      const live = byId.get(snapshot.id);
      if (options?.runtimeOnly && !live) continue;
      byId.set(snapshot.id, live ? {
        ...live, workspaceId: snapshot.workspaceId, workspaceTaskId: snapshot.workspaceTaskId,
        completionRevision: snapshot.completionRevision,
        viewedCompletionRevision: snapshot.viewedCompletionRevision,
      } : snapshot);
    }
    return Array.from(byId.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Membership belongs to storage; both runners only refresh their live projection. */
  refreshSessionWorkspace(id: string): void {
    const membership = this.storage.getSessionWorkspace(id);
    if (!membership) return;
    const owner = this.ownerOf(id);
    if (owner === "structured") this.structured.setSessionWorkspace(id, membership);
    else if (owner === "pty") this.processes.setSessionWorkspace(id, membership);
  }

  setSessionModel(id: string, model: string | null): SessionSnapshot | null {
    const owner = this.ownerOf(id);
    if (owner === "structured") return this.structured.setSessionModel(id, model);
    if (owner === "pty") return this.processes.setSessionModel(id, model);
    return this.updateStored(id, (snapshot) => ({
      ...snapshot,
      selectedModel: model?.trim() || null,
      structuredState: (snapshot.sessionKind ?? "pty") === "structured"
        ? { ...snapshot.structuredState!, model: model?.trim() || undefined }
        : snapshot.structuredState,
    }));
  }

  setSessionThinkingEffort(id: string, effort: SessionSnapshot["thinkingEffort"]): SessionSnapshot | null {
    const owner = this.ownerOf(id);
    if (owner === "structured") return this.structured.setSessionThinkingEffort(id, effort);
    if (owner === "pty") return this.processes.setSessionThinkingEffort(id, effort);
    return this.updateStored(id, (snapshot) => ({ ...snapshot, thinkingEffort: effort }));
  }

  setSessionMode(id: string, mode: ExecutionMode): SessionSnapshot | null {
    const owner = this.ownerOf(id);
    if (owner === "structured") return this.structured.setSessionMode(id, mode);
    if (owner === "pty") return this.processes.setSessionMode(id, mode);
    return this.updateStored(id, (snapshot) => ({ ...snapshot, mode }));
  }

  setSessionTopic(id: string, title: string, description: string): SessionSnapshot | null {
    const owner = this.ownerOf(id);
    if (owner === "structured") return this.structured.setSessionTopic(id, title, description);
    if (owner === "pty") return this.processes.setSessionTopic(id, title, description);
    return this.updateStored(id, (snapshot) => ({ ...snapshot, title, description, summary: description }));
  }

  /**
   * 归档 / 取消归档一个会话：只写标记，不杀进程、不删历史；真正的清理留给保留期扫描。
   * 会话可能只存在于 storage（重启后未加载），因此 storage-only 也要能改。
   */
  /** 停掉空闲 PTY 壳。保留期只对「进程还在、但没有正在处理的回合」调用。 */
  stop(id: string): SessionSnapshot | null {
    if (this.ownerOf(id) !== "pty") return this.get(id);
    return this.processes.stop(id);
  }

  setArchived(id: string, archived: boolean): SessionSnapshot | null {
    const current = this.getLatest(id);
    if (current && !!current.archived === archived && (!archived || current.archivedAt)) return current;
    if (archived && current && isArchiveBlocked(current)) {
      throw Object.assign(new Error("会话仍在执行或等待处理，完成后才能归档。"), { statusCode: 409 });
    }
    const owner = this.ownerOf(id);
    if (owner === "structured") return this.structured.setSessionArchived(id, archived);
    if (owner === "pty") return this.processes.setSessionArchived(id, archived);
    return this.updateStored(id, (snapshot) => ({
      ...snapshot,
      archived,
      archivedAt: archived ? new Date().toISOString() : null,
    }));
  }

  updateWorktreeState(
    id: string,
    status: SessionSnapshot["worktreeMergeStatus"],
    info: SessionSnapshot["worktreeMergeInfo"],
  ): SessionSnapshot | null {
    const owner = this.ownerOf(id);
    if (owner === "structured") return this.structured.setWorktreeMergeState(id, status, info);
    if (owner === "pty") return this.processes.setWorktreeMergeState(id, status, info);
    return this.updateStored(id, (snapshot) => ({
      ...snapshot,
      worktreeMergeStatus: status,
      worktreeMergeInfo: info ?? null,
    }));
  }

  private deleteManagedSession(id: string): SessionSnapshot | null {
    const snapshot = this.get(id);
    if (!snapshot) return null;
    if (isSystemAiCall(snapshot)) {
      systemAiSessions(this.storage).remove(id);
      return snapshot;
    }
    // Best-effort: tear down the session's isolated worktree (directory +
    // branch) before removing the session record. Without this, deleting a
    // session that was never merged leaves an orphan under `.wand-worktrees/`
    // and a dangling `wand/*` branch forever — the merge path is the only
    // other place that cleans them up. Force removal is intentional: deleting
    // a session means discarding everything tied to it.
    if (snapshot.worktree) {
      try { cleanupWorktreeSync(snapshot.worktree); } catch { /* never block deletion */ }
    }
    const owner = this.ownerOf(id);
    if (owner === "structured") {
      this.structured.delete(id);
    } else if (owner === "pty") {
      this.processes.delete(id);
    } else if (snapshot.sessionKind === "structured") {
      this.structured.delete(id);
    } else {
      this.processes.delete(id);
    }
    return snapshot;
  }

  /** All destructive paths, including retention, remove native session artifacts. */
  delete(id: string): SessionSnapshot | null {
    const snapshot = this.get(id);
    if (!snapshot) return null;
    const manager = this.ownerOf(id) === "structured" || snapshot.sessionKind === "structured"
      ? this.structured : this.processes;
    const ownBarrier = manager.nativeHistoryCleanupBarrier?.(id);
    const key = `${sessionProvider(snapshot)}\0${snapshot.claudeSessionId?.trim() ?? ""}`;
    if (ownBarrier) {
      const pending = this.nativeDeletionBarriers.get(key) ?? new Set<Promise<void>>();
      pending.add(ownBarrier);
      this.nativeDeletionBarriers.set(key, pending);
      void ownBarrier.then(() => {
        pending.delete(ownBarrier);
        if (!pending.size && this.nativeDeletionBarriers.get(key) === pending) this.nativeDeletionBarriers.delete(key);
      }, () => { /* Unknown exit continues to protect all aliases of this native ID. */ });
    }
    const pending = this.nativeDeletionBarriers.get(key);
    const barrier = pending?.size ? Promise.all([...pending]).then(() => {}) : null;
    const canCleanup = () => !this.listSlim().some((other) => other.id !== id
      && other.claudeSessionId?.trim() === snapshot.claudeSessionId?.trim()
      && sessionProvider(other) === sessionProvider(snapshot));
    return deleteOwnedSessionWithHistory(() => this.deleteManagedSession(id), this.processes, this.storage,
      { barrier, canCleanup, isSettled: () => !this.nativeDeletionBarriers.has(key) });
  }

  deleteWithProviderHistory(id: string): SessionSnapshot | null {
    return this.delete(id);
  }

  private updateStored(
    id: string,
    update: (snapshot: SessionSnapshot) => SessionSnapshot,
  ): SessionSnapshot | null {
    const current = this.storage.getSession(id);
    if (!current) return null;
    const next = update(current);
    this.storage.updateSessionRuntimeMetadata(next);
    return next;
  }
}
