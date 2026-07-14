import assert from "node:assert/strict";
import test from "node:test";

import type { ProcessManager } from "../src/process-manager.js";
import { SessionRegistry } from "../src/session-registry.js";
import type { WandStorage } from "../src/storage.js";
import type { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { SessionSnapshot } from "../src/types.js";

function snapshot(id: string, kind: "pty" | "structured", title: string): SessionSnapshot {
  return {
    id,
    sessionKind: kind,
    provider: "claude",
    command: kind === "structured" ? "claude -p" : "claude",
    cwd: "/tmp/project",
    mode: "managed",
    status: kind === "structured" ? "idle" : "exited",
    exitCode: null,
    startedAt: `2026-07-14T00:00:0${id.length}.000Z`,
    endedAt: null,
    output: `${title}-output`,
    messages: [],
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    title,
  };
}

function harness() {
  const structuredRows = new Map<string, SessionSnapshot>();
  const ptyRows = new Map<string, SessionSnapshot>();
  const storageRows = new Map<string, SessionSnapshot>();
  const config = new Map<string, string>();
  const calls = {
    structuredUpdates: [] as string[],
    ptyUpdates: [] as string[],
    storageUpdates: [] as string[],
    structuredDeletes: [] as string[],
    ptyDeletes: [] as string[],
    storageDeletes: [] as string[],
    claudeDeletes: [] as string[],
  };

  const structured = {
    get: (id: string) => structuredRows.get(id) ?? null,
    listSlim: () => Array.from(structuredRows.values()),
    setSessionModel: (id: string, model: string | null) => ({ ...structuredRows.get(id)!, selectedModel: model }),
    setSessionThinkingEffort: (id: string, thinkingEffort: SessionSnapshot["thinkingEffort"]) => ({ ...structuredRows.get(id)!, thinkingEffort }),
    setSessionMode: (id: string, mode: SessionSnapshot["mode"]) => ({ ...structuredRows.get(id)!, mode }),
    setSessionTopic: (id: string, title: string, description: string) => ({ ...structuredRows.get(id)!, title, description }),
    setWorktreeMergeState: (id: string, status: SessionSnapshot["worktreeMergeStatus"], worktreeMergeInfo: SessionSnapshot["worktreeMergeInfo"]) => {
      calls.structuredUpdates.push(id);
      return { ...structuredRows.get(id)!, worktreeMergeStatus: status, worktreeMergeInfo };
    },
    delete: (id: string) => { calls.structuredDeletes.push(id); structuredRows.delete(id); },
  } as unknown as StructuredSessionManager;

  const processes = {
    getOwned: (id: string) => ptyRows.get(id) ?? null,
    listSlim: () => Array.from(ptyRows.values()),
    setSessionModel: (id: string, model: string | null) => ({ ...ptyRows.get(id)!, selectedModel: model }),
    setSessionThinkingEffort: (id: string, thinkingEffort: SessionSnapshot["thinkingEffort"]) => ({ ...ptyRows.get(id)!, thinkingEffort }),
    setSessionMode: (id: string, mode: SessionSnapshot["mode"]) => ({ ...ptyRows.get(id)!, mode }),
    setSessionTopic: (id: string, title: string, description: string) => ({ ...ptyRows.get(id)!, title, description }),
    setWorktreeMergeState: (id: string, status: SessionSnapshot["worktreeMergeStatus"], worktreeMergeInfo: SessionSnapshot["worktreeMergeInfo"]) => {
      calls.ptyUpdates.push(id);
      return { ...ptyRows.get(id)!, worktreeMergeStatus: status, worktreeMergeInfo };
    },
    delete: (id: string) => { calls.ptyDeletes.push(id); ptyRows.delete(id); },
    deleteClaudeHistoryFiles: (items: Array<{ claudeSessionId: string }>) => {
      calls.claudeDeletes.push(...items.map((item) => item.claudeSessionId));
      return items.length;
    },
    deleteCodexHistoryFiles: () => 0,
  } as unknown as ProcessManager;

  const storage = {
    getSession: (id: string) => storageRows.get(id) ?? null,
    loadSessions: () => Array.from(storageRows.values()),
    updateSessionRuntimeMetadata: (value: SessionSnapshot) => {
      calls.storageUpdates.push(value.id);
      storageRows.set(value.id, value);
    },
    deleteSession: (id: string) => { calls.storageDeletes.push(id); storageRows.delete(id); },
    getConfigValue: (key: string) => config.get(key) ?? null,
    setConfigValue: (key: string, value: string) => { config.set(key, value); },
  } as unknown as WandStorage;

  return {
    registry: new SessionRegistry(processes, structured, storage),
    structuredRows,
    ptyRows,
    storageRows,
    config,
    calls,
  };
}

test("SessionRegistry preserves structured, PTY, storage precedence without stale overwrites", () => {
  const h = harness();
  h.structuredRows.set("same", snapshot("same", "structured", "live-structured"));
  h.ptyRows.set("same", snapshot("same", "pty", "live-pty"));
  h.ptyRows.set("pty", snapshot("pty", "pty", "live-pty-only"));
  h.storageRows.set("same", snapshot("same", "structured", "stale-storage"));
  h.storageRows.set("pty", snapshot("pty", "pty", "stale-pty-storage"));
  h.storageRows.set("stored", snapshot("stored", "pty", "storage-only"));

  assert.equal(h.registry.ownerOf("same"), "structured");
  assert.equal(h.registry.ownerOf("pty"), "pty");
  assert.equal(h.registry.ownerOf("stored"), "storage");
  assert.equal(h.registry.get("same")?.title, "live-structured");
  assert.equal(h.registry.get("pty")?.title, "live-pty-only");
  assert.equal(h.registry.get("stored")?.title, "storage-only");

  const listed = h.registry.listSlim();
  assert.equal(listed.filter((item) => item.id === "same").length, 1);
  assert.equal(listed.find((item) => item.id === "same")?.title, "live-structured");
  assert.equal(listed.find((item) => item.id === "stored")?.output, "");

  h.registry.updateWorktreeState("same", "checking", { conflict: false });
  assert.deepEqual(h.calls.structuredUpdates, ["same"]);
  assert.deepEqual(h.calls.ptyUpdates, []);
  assert.deepEqual(h.calls.storageUpdates, []);

  h.registry.setSessionTopic("stored", "fresh", "fresh description");
  assert.equal(h.storageRows.get("stored")?.title, "fresh");
  assert.deepEqual(h.calls.storageUpdates, ["stored"]);
});

test("SessionRegistry deletion chooses one owner and preserves provider history ownership", () => {
  const h = harness();
  const value = {
    ...snapshot("same", "structured", "live"),
    claudeSessionId: "123e4567-e89b-42d3-a456-426614174000",
  };
  h.structuredRows.set("same", value);
  h.ptyRows.set("same", snapshot("same", "pty", "duplicate"));
  h.storageRows.set("same", snapshot("same", "structured", "stale"));

  assert.equal(h.registry.deleteWithProviderHistory("same")?.title, "live");
  assert.deepEqual(h.calls.structuredDeletes, ["same"]);
  assert.deepEqual(h.calls.ptyDeletes, []);
  assert.deepEqual(h.calls.storageDeletes, []);
  assert.deepEqual(h.calls.claudeDeletes, [value.claudeSessionId]);
  assert.deepEqual(JSON.parse(h.config.get("hidden_claude_session_ids") ?? "[]"), [value.claudeSessionId]);
});
