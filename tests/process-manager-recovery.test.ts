import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { ProcessManager } from "../src/process-manager.js";
import type { SessionSnapshot } from "../src/types.js";
import type { WandStorage } from "../src/storage.js";

class FakeStorage {
  private readonly sessions = new Map<string, SessionSnapshot>();

  constructor(sessions: SessionSnapshot[]) {
    for (const session of sessions) {
      this.sessions.set(session.id, session);
    }
  }

  loadSessions(): SessionSnapshot[] {
    return Array.from(this.sessions.values());
  }

  getSession(id: string): SessionSnapshot | null {
    return this.sessions.get(id) ?? null;
  }

  saveSession(snapshot: SessionSnapshot): void {
    this.sessions.set(snapshot.id, snapshot);
  }

  saveSessionMetadata(snapshot: SessionSnapshot): void {
    this.updateSessionRuntimeMetadata(snapshot);
  }

  updateSessionRuntimeMetadata(snapshot: SessionSnapshot): void {
    const current = this.sessions.get(snapshot.id);
    this.sessions.set(snapshot.id, {
      ...snapshot,
      output: current?.output ?? snapshot.output,
      messages: current?.messages,
    });
  }

  checkpointSessionOutput(id: string, output: string): void {
    const current = this.sessions.get(id);
    if (current) this.sessions.set(id, { ...current, output });
  }

  checkpointSessionMessages(id: string, messages: NonNullable<SessionSnapshot["messages"]>): void {
    const current = this.sessions.get(id);
    if (current) this.sessions.set(id, { ...current, messages });
  }

  deleteSession(id: string): void {
    this.sessions.delete(id);
  }
}

function claudeProjectDir(home: string, cwd: string): string {
  return path.join(home, ".claude", "projects", path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
}

test("ProcessManager recovers missing Claude session id for exited PTY sessions on startup", (t) => {
  const oldHome = process.env.HOME;
  const home = mkdtempSync(path.join(os.tmpdir(), "wand-pm-recovery-"));
  process.env.HOME = home;
  t.after(() => {
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  const cwd = path.join(home, "workspace", "repo");
  mkdirSync(cwd, { recursive: true });

  const startedAtMs = Date.now() - 60_000;
  const endedAtMs = startedAtMs + 30_000;
  const startedAt = new Date(startedAtMs).toISOString();
  const endedAt = new Date(endedAtMs).toISOString();
  const firstUserAt = new Date(startedAtMs + 5_000).toISOString();
  const assistantAt = new Date(startedAtMs + 10_000).toISOString();
  const claudeSessionId = "22222222-2222-4222-8222-222222222222";

  const projectDir = claudeProjectDir(home, cwd);
  mkdirSync(projectDir, { recursive: true });
  const historyFile = path.join(projectDir, `${claudeSessionId}.jsonl`);
  writeFileSync(historyFile, [
    JSON.stringify({ sessionId: claudeSessionId, type: "user", timestamp: firstUserAt, message: { role: "user", content: "hello" } }),
    JSON.stringify({ sessionId: claudeSessionId, type: "assistant", timestamp: assistantAt, message: { role: "assistant", content: "hi" } }),
  ].join("\n") + "\n");
  const mtime = new Date(endedAtMs);
  utimesSync(historyFile, mtime, mtime);

  const storedSession: SessionSnapshot = {
    id: "wand-session-1",
    sessionKind: "pty",
    provider: "claude",
    runner: "pty",
    command: "claude",
    cwd,
    mode: "default",
    status: "exited",
    exitCode: 0,
    startedAt,
    endedAt,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ],
  };

  const storage = new FakeStorage([storedSession]) as unknown as WandStorage;
  const config = { ...defaultConfig(), defaultCwd: cwd, startupCommands: [] };
  const manager = new ProcessManager(config, storage, path.join(home, ".wand"));

  assert.equal(manager.get(storedSession.id)?.claudeSessionId, claudeSessionId);
  assert.equal(storage.getSession(storedSession.id)?.claudeSessionId, claudeSessionId);
});
