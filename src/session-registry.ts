import { cleanupWorktreeSync } from "./git-worktree.js";
import { inferProviderFromCommand } from "./session-provider.js";
import type { ProcessManager } from "./process-manager.js";
import type { StructuredSessionManager } from "./structured-session-manager.js";
import type { WandStorage } from "./storage.js";
import type { ExecutionMode, SessionSnapshot } from "./types.js";

export type SessionOwner = "structured" | "pty" | "storage";

function slimSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  const { output: _output, messages: _messages, ...slim } = snapshot;
  return { ...slim, output: "" } as SessionSnapshot;
}

type HiddenSessionStore = Pick<WandStorage, "getConfigValue" | "setConfigValue">;

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
    return this.structured.get(id) ?? this.processes.getOwned(id) ?? this.storage.getSession(id);
  }

  getLatest(id: string): SessionSnapshot | null {
    return this.get(id);
  }

  listSlim(): SessionSnapshot[] {
    const byId = new Map<string, SessionSnapshot>();
    for (const snapshot of this.structured.listSlim()) byId.set(snapshot.id, snapshot);
    for (const snapshot of this.processes.listSlim()) {
      if (!byId.has(snapshot.id)) byId.set(snapshot.id, snapshot);
    }
    for (const snapshot of this.storage.loadSessions()) {
      if (!byId.has(snapshot.id)) byId.set(snapshot.id, slimSnapshot(snapshot));
    }
    return Array.from(byId.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
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

  delete(id: string): SessionSnapshot | null {
    const snapshot = this.get(id);
    if (!snapshot) return null;
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
    if (owner === "structured") this.structured.delete(id);
    else if (owner === "pty") this.processes.delete(id);
    else this.storage.deleteSession(id);
    return snapshot;
  }

  deleteWithProviderHistory(id: string): SessionSnapshot | null {
    const snapshot = this.delete(id);
    const providerSessionId = snapshot?.claudeSessionId?.trim();
    if (!snapshot || !providerSessionId) return snapshot;

    const provider = snapshot.provider
      ?? snapshot.structuredState?.provider
      ?? inferProviderFromCommand(snapshot.command)
      ?? "claude";
    if (provider === "claude") {
      this.processes.deleteClaudeHistoryFiles([{ claudeSessionId: providerSessionId, cwd: snapshot.cwd }]);
    } else if (provider === "codex") {
      this.processes.deleteCodexHistoryFiles([providerSessionId]);
    } else {
      return snapshot;
    }
    addHiddenSessionIds(this.storage, [providerSessionId]);
    return snapshot;
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
