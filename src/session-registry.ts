import type { ProcessManager } from "./process-manager.js";
import type { StructuredSessionManager } from "./structured-session-manager.js";
import type { WandStorage } from "./storage.js";
import type { ExecutionMode, SessionSnapshot } from "./types.js";

export type SessionOwner = "structured" | "pty" | "storage";

function slimSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  const { output: _output, messages: _messages, ...slim } = snapshot;
  return { ...slim, output: "" } as SessionSnapshot;
}

function addHiddenProviderSessionId(storage: WandStorage, id: string): void {
  const raw = storage.getConfigValue("hidden_claude_session_ids");
  let hidden: Set<string>;
  try {
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    hidden = new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    hidden = new Set();
  }
  if (hidden.has(id)) return;
  hidden.add(id);
  storage.setConfigValue("hidden_claude_session_ids", JSON.stringify(Array.from(hidden)));
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
      ?? (/^codex\b/i.test(snapshot.command.trim())
        ? "codex"
        : /^opencode\b/i.test(snapshot.command.trim()) ? "opencode" : "claude");
    if (provider === "claude") {
      this.processes.deleteClaudeHistoryFiles([{ claudeSessionId: providerSessionId, cwd: snapshot.cwd }]);
    } else if (provider === "codex") {
      this.processes.deleteCodexHistoryFiles([providerSessionId]);
    } else {
      return snapshot;
    }
    addHiddenProviderSessionId(this.storage, providerSessionId);
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
