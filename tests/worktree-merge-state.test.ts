import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { ProcessManager } from "../src/process-manager.js";
import type { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { ProcessEvent, SessionSnapshot } from "../src/types.js";

class MemoryStorage {
  readonly sessions = new Map<string, SessionSnapshot>();

  constructor(initial: SessionSnapshot[]) {
    for (const snapshot of initial) this.saveSession(snapshot);
  }

  loadSessions(): SessionSnapshot[] {
    return Array.from(this.sessions.values(), (snapshot) => structuredClone(snapshot));
  }

  getSession(id: string): SessionSnapshot | null {
    const snapshot = this.sessions.get(id);
    return snapshot ? structuredClone(snapshot) : null;
  }

  saveSession(snapshot: SessionSnapshot): void {
    this.sessions.set(snapshot.id, structuredClone(snapshot));
  }

  saveSessionMetadata(snapshot: SessionSnapshot): void {
    this.updateSessionRuntimeMetadata(snapshot);
  }

  updateSessionRuntimeMetadata(snapshot: SessionSnapshot): void {
    const current = this.sessions.get(snapshot.id);
    this.saveSession({ ...snapshot, output: current?.output ?? snapshot.output, messages: current?.messages });
  }

  checkpointSessionOutput(id: string, output: string): void {
    const current = this.sessions.get(id);
    if (current) this.saveSession({ ...current, output });
  }

  checkpointSessionMessages(id: string, messages: NonNullable<SessionSnapshot["messages"]>): void {
    const current = this.sessions.get(id);
    if (current) this.saveSession({ ...current, messages });
  }

  deleteSession(id: string): void {
    this.sessions.delete(id);
  }
}

function snapshot(
  id: string,
  sessionKind: "pty" | "structured",
): SessionSnapshot {
  return {
    id,
    sessionKind,
    provider: "opencode",
    runner: sessionKind === "pty" ? "pty" : "opencode-cli-run",
    command: sessionKind === "pty" ? "opencode" : "opencode run --format json",
    cwd: "/tmp/project",
    mode: "default",
    worktreeEnabled: true,
    worktree: { branch: `wand/${id}`, path: `/tmp/worktrees/${id}` },
    status: sessionKind === "pty" ? "exited" : "idle",
    exitCode: 0,
    startedAt: "2026-07-14T00:00:00.000Z",
    endedAt: "2026-07-14T00:01:00.000Z",
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    messages: [],
    structuredState: sessionKind === "structured"
      ? {
          provider: "opencode",
          runner: "opencode-cli-run",
          lastError: null,
          inFlight: false,
          activeRequestId: null,
        }
      : undefined,
  };
}

test("PTY worktree merge updates remain canonical in memory and storage", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-worktree-pty-"));
  const initial = snapshot("pty-worktree", "pty");
  const storage = new MemoryStorage([initial]);
  const manager = new ProcessManager(
    { ...defaultConfig(), defaultCwd: root, startupCommands: [] },
    storage as unknown as WandStorage,
    path.join(root, ".wand"),
  );
  t.after(() => {
    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  const events: ProcessEvent[] = [];
  manager.on("process", (event) => events.push(event));
  const updated = manager.setWorktreeMergeState(initial.id, "merged", {
    targetBranch: "main",
    mergeCommit: "abc123",
    cleanupDone: false,
    conflict: false,
  });

  assert.equal(updated?.worktreeMergeStatus, "merged");
  assert.equal(manager.get(initial.id)?.worktreeMergeStatus, "merged");
  assert.equal(manager.get(initial.id)?.worktreeMergeInfo?.mergeCommit, "abc123");
  assert.equal(storage.getSession(initial.id)?.worktreeMergeStatus, "merged");

  // Any later manager-owned metadata save must retain the merge state instead
  // of restoring the stale pre-merge in-memory snapshot over the DB row.
  manager.setSessionTopic(initial.id, "Merged", "Worktree merged");
  assert.equal(storage.getSession(initial.id)?.worktreeMergeInfo?.cleanupDone, false);
  assert.ok(events.some((event) => (
    event.type === "status"
    && (event.data as { worktreeMergeStatus?: string }).worktreeMergeStatus === "merged"
  )));
});

test("structured worktree merge updates remain canonical in memory and storage", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-worktree-structured-"));
  const initial = snapshot("structured-worktree", "structured");
  const storage = new MemoryStorage([initial]);
  const manager = new StructuredSessionManager(
    storage as unknown as WandStorage,
    { ...defaultConfig(), defaultCwd: root, startupCommands: [] },
  );
  t.after(() => {
    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  const events: ProcessEvent[] = [];
  manager.setEventEmitter((event) => events.push(event));
  const updated = manager.setWorktreeMergeState(initial.id, "failed", {
    targetBranch: "main",
    lastError: "merge conflict",
    conflict: true,
  });

  assert.equal(updated?.worktreeMergeStatus, "failed");
  assert.equal(manager.get(initial.id)?.worktreeMergeStatus, "failed");
  assert.equal(manager.get(initial.id)?.worktreeMergeInfo?.lastError, "merge conflict");
  assert.equal(storage.getSession(initial.id)?.worktreeMergeStatus, "failed");

  manager.setSessionTopic(initial.id, "Conflict", "Resolve the merge conflict");
  assert.equal(storage.getSession(initial.id)?.worktreeMergeInfo?.conflict, true);
  assert.ok(events.some((event) => (
    event.type === "status"
    && (event.data as { worktreeMergeStatus?: string }).worktreeMergeStatus === "failed"
  )));
});
