import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { ProcessManager, PtyInputDeliveryError } from "../src/process-manager.js";
import type {
  TerminalAttachResult, TerminalDataEvent, TerminalExitEvent, TerminalHost,
  TerminalProcess, TerminalSessionState, TerminalSpawnRequest,
} from "../src/terminal-host.js";
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

test("ProcessManager installs a Render resync snapshot before notifying clients", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pm-render-resync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionId = "render-resync";
  const stored: SessionSnapshot = {
    id: sessionId, sessionKind: "pty", runner: "pty", command: "/bin/sh",
    cwd: root, mode: "default", status: "running", exitCode: null,
    startedAt: new Date().toISOString(), endedAt: null, output: "old",
    archived: false, archivedAt: null, ptyOutputSeq: 1,
  };
  const initial: TerminalSessionState = {
    sessionId, incarnationId: "inc-1", pid: 42, status: "running", exitCode: null,
    cols: 80, rows: 24, seq: 1, output: "old", chunks: [],
    terminalSnapshot: { version: 1, data: "old", cols: 80, rows: 24, pending: [] },
    launchMarkerToken: null,
  };
  let resyncListener: ((state: TerminalSessionState) => void) | null = null;
  const terminal: TerminalProcess = {
    sessionId, incarnationId: "inc-1", pid: 42,
    write() {}, resize() {}, kill() {},
    onData(_listener: (event: TerminalDataEvent) => void) { return { dispose() {} }; },
    onExit(_listener: (event: TerminalExitEvent) => void) { return { dispose() {} }; },
    onResync(listener) { resyncListener = listener; return { dispose() { resyncListener = null; } }; },
  };
  const host: TerminalHost = {
    persistent: true,
    attach(): TerminalAttachResult { return { process: terminal, state: initial, replay: [], isNew: false }; },
    async createOrAttach(_request: TerminalSpawnRequest): Promise<TerminalAttachResult> {
      throw new Error("unexpected spawn");
    },
    forget() {}, disconnect() {},
  };
  const storage = new FakeStorage([stored]) as unknown as WandStorage;
  const manager = new ProcessManager(
    { ...defaultConfig(), defaultCwd: root, startupCommands: [] }, storage, root, host,
  );
  t.after(() => manager.dispose());
  let stateAtNotice: SessionSnapshot | null = null;
  manager.on("process", (event: { type: string }) => {
    if (event.type === "resync") stateAtNotice = manager.get(sessionId);
  });
  assert.ok(resyncListener);
  resyncListener!({
    ...initial, seq: 4, cols: 100, rows: 30, output: "full recovered output",
    terminalSnapshot: {
      version: 1, data: "full recovered screen", cols: 100, rows: 30, pending: [],
    },
  });
  assert.equal(stateAtNotice?.output, "full recovered output");
  assert.equal(stateAtNotice?.ptyOutputSeq, 4);
  assert.equal(stateAtNotice?.ptyCols, 100);
  const screen = manager.getTerminalState(sessionId);
  assert.ok(screen);
  assert.equal(screen.cols, 100);
  assert.match(screen.data + screen.pending.map((operation) =>
    operation.type === "data" ? operation.data : "").join(""), /full recovered screen/);
  assert.equal(storage.getSession(sessionId)?.output, "full recovered output");
});

test("rejected confirmed PTY write leaves input tracking and persisted state untouched", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pm-input-rejection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionId = "rejected-input";
  const stored: SessionSnapshot = {
    id: sessionId, sessionKind: "pty", runner: "pty", command: "/bin/sh",
    cwd: root, mode: "default", status: "running", exitCode: null,
    startedAt: new Date().toISOString(), endedAt: null, output: "unchanged",
    archived: false, archivedAt: null, ptyOutputSeq: 1,
  };
  const state: TerminalSessionState = {
    sessionId, incarnationId: "inc-1", pid: 42, status: "running", exitCode: null,
    cols: 80, rows: 24, seq: 1, output: "unchanged", chunks: [],
    terminalSnapshot: null, launchMarkerToken: null,
  };
  let deferredWrite = false;
  let confirmWrite: (() => void) | null = null;
  const process: TerminalProcess = {
    sessionId, incarnationId: "inc-1", pid: 42,
    write() {}, async writeConfirmed() {
      if (!deferredWrite) throw new Error("Render write rejected");
      await new Promise<void>((resolve) => { confirmWrite = resolve; });
    },
    resize() {}, kill() {},
    onData() { return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
  };
  const host: TerminalHost = {
    persistent: true,
    attach(): TerminalAttachResult { return { process, state, replay: [], isNew: false }; },
    async createOrAttach(): Promise<TerminalAttachResult> { throw new Error("unexpected spawn"); },
    forget() {}, disconnect() {},
  };
  const storage = new FakeStorage([stored]) as unknown as WandStorage;
  const manager = new ProcessManager(
    { ...defaultConfig(), defaultCwd: root, startupCommands: [] }, storage, root, host,
  );
  t.after(() => manager.dispose());
  await assert.rejects(
    manager.sendInputConfirmed(sessionId, "never delivered\r", "chat", "enter_text"),
    (error: unknown) => error instanceof PtyInputDeliveryError
      && error.sessionId === sessionId
      && error.cause instanceof Error,
  );
  const record = (manager as unknown as {
    sessions: Map<string, { ptyTopicDraft?: unknown }>;
  }).sessions.get(sessionId);
  assert.equal(record?.ptyTopicDraft, undefined);
  assert.equal(storage.getSession(sessionId)?.output, "unchanged");
  assert.equal(manager.get(sessionId)?.messages, undefined);

  deferredWrite = true;
  const inFlight = manager.sendInputConfirmed(sessionId, "old incarnation\r", "chat");
  manager.stop(sessionId);
  assert.ok(confirmWrite);
  confirmWrite();
  await assert.rejects(inFlight, PtyInputDeliveryError);
  assert.equal(storage.getSession(sessionId)?.status, "stopped");
});

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
  manager.dispose();
});

test("ProcessManager recovers an OpenCode ses_* id from its local session index", (t) => {
  const oldDataHome = process.env.XDG_DATA_HOME;
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-opencode-recovery-"));
  const dataHome = path.join(root, "data");
  process.env.XDG_DATA_HOME = dataHome;
  t.after(() => {
    if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldDataHome;
    rmSync(root, { recursive: true, force: true });
  });

  const cwd = path.join(root, "workspace");
  const dbDir = path.join(dataHome, "opencode");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, "opencode.db"));
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)");
  const startedAtMs = Date.now() - 20_000;
  const endedAtMs = startedAtMs + 10_000;
  db.prepare("INSERT INTO session (id, parent_id, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?)")
    .run("ses_wand_resume", null, cwd, startedAtMs + 1_000, endedAtMs - 1_000);
  db.prepare("INSERT INTO session (id, parent_id, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?)")
    .run("ses_subagent", "ses_wand_resume", cwd, startedAtMs + 2_000, endedAtMs);
  db.close();

  const storedSession: SessionSnapshot = {
    id: "wand-opencode-session",
    sessionKind: "pty",
    provider: "opencode",
    runner: "pty",
    command: "opencode",
    cwd,
    mode: "default",
    status: "exited",
    exitCode: 0,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
  };
  const storage = new FakeStorage([storedSession]) as unknown as WandStorage;
  const manager = new ProcessManager(
    { ...defaultConfig(), defaultCwd: cwd, startupCommands: [] },
    storage,
    path.join(root, ".wand"),
  );

  assert.equal(manager.get(storedSession.id)?.claudeSessionId, "ses_wand_resume");
  assert.equal(storage.getSession(storedSession.id)?.claudeSessionId, "ses_wand_resume");
  manager.dispose();
});
