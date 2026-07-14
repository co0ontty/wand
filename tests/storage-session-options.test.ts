import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { WandStorage } from "../src/storage.js";
import type { SessionSnapshot } from "../src/types.js";

const DURABLE_OPTION_KEYS = [
  "autonomyPolicy",
  "approvalPolicy",
  "allowedScopes",
  "pendingEscalation",
  "lastEscalationResult",
  "autoApprovePermissions",
  "approvalStats",
  "selectedModel",
  "thinkingEffort",
  "ptyCols",
  "ptyRows",
  "currentTaskTitle",
  "summary",
] as const satisfies ReadonlyArray<keyof SessionSnapshot>;

function tempDatabase(t: TestContext, prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "wand.db");
}

function snapshot(id: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id,
    sessionSource: "interactive",
    sessionKind: "pty",
    provider: "claude",
    runner: "pty",
    command: "claude",
    cwd: "/tmp",
    mode: "managed",
    status: "running",
    exitCode: null,
    startedAt: "2026-07-14T00:00:00.000Z",
    endedAt: null,
    output: "persisted output",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    ...overrides,
  };
}

function assertDurableOptions(actual: SessionSnapshot, expected: SessionSnapshot): void {
  for (const key of DURABLE_OPTION_KEYS) {
    assert.deepEqual(actual[key], expected[key], `round-trip mismatch for ${key}`);
  }
}

test("session runtime options survive a full close and reopen round-trip", (t) => {
  const dbPath = tempDatabase(t, "wand-session-options-");
  const expected = snapshot("full-round-trip", {
    autonomyPolicy: "agent-max",
    approvalPolicy: "remember-this-turn",
    allowedScopes: ["write_file", "run_command", "network", "outside_workspace", "dangerous_shell"],
    pendingEscalation: {
      requestId: "request-pending",
      scope: "outside_workspace",
      runner: "pty",
      source: "workspace_policy_limit",
      resolution: "approve_turn",
      target: "/private/project",
      reason: "Needs access outside the workspace",
    },
    lastEscalationResult: {
      requestId: "request-complete",
      resolution: "deny",
      reason: "User denied access",
    },
    autoApprovePermissions: false,
    approvalStats: { tool: 0, command: 2, file: 3, total: 5 },
    selectedModel: "gpt-5.3-codex",
    thinkingEffort: "codex:xhigh",
    ptyCols: 211,
    ptyRows: 73,
    currentTaskTitle: "Durable task title",
    summary: "Durable session summary",
  });

  const writer = new WandStorage(dbPath);
  writer.saveSession(snapshot(expected.id, { autonomyPolicy: "assist", summary: "superseded" }));
  writer.saveSession(expected);
  writer.close();

  const rawDb = new DatabaseSync(dbPath);
  const row = rawDb.prepare("SELECT session_options FROM command_sessions WHERE id = ?")
    .get(expected.id) as { session_options: string };
  rawDb.close();
  assert.equal((JSON.parse(row.session_options) as { schemaVersion?: unknown }).schemaVersion, 1);

  const reader = new WandStorage(dbPath);
  const actual = reader.getSession(expected.id);
  reader.close();

  assert.ok(actual);
  assertDurableOptions(actual, expected);
  assert.equal(actual.permissionBlocked, true);
});

test("metadata updates persist null, falsey, and empty runtime option values", (t) => {
  const dbPath = tempDatabase(t, "wand-session-options-metadata-");
  const initial = snapshot("metadata-round-trip", {
    autonomyPolicy: "agent",
    approvalPolicy: "approve-once",
    allowedScopes: ["network"],
    pendingEscalation: {
      requestId: "pending",
      scope: "network",
      runner: "json",
      source: "tool_permission_request",
      reason: "Network access",
    },
    lastEscalationResult: {
      requestId: "previous",
      resolution: "approve_once",
      reason: "Approved once",
    },
    autoApprovePermissions: false,
    approvalStats: { tool: 1, command: 1, file: 1, total: 3 },
    selectedModel: "claude-sonnet-4-6",
    thinkingEffort: "deep",
    ptyCols: 160,
    ptyRows: 48,
    currentTaskTitle: "Before",
    summary: "Before metadata update",
  });
  const updated = snapshot(initial.id, {
    autonomyPolicy: "assist",
    approvalPolicy: "ask-every-time",
    allowedScopes: [],
    pendingEscalation: null,
    lastEscalationResult: null,
    autoApprovePermissions: true,
    approvalStats: { tool: 0, command: 0, file: 0, total: 0 },
    selectedModel: null,
    thinkingEffort: null,
    ptyCols: 80,
    ptyRows: 24,
    currentTaskTitle: "",
    summary: "",
  });

  const writer = new WandStorage(dbPath);
  writer.saveSession(initial);
  writer.saveSessionMetadata(updated);
  writer.close();

  const reader = new WandStorage(dbPath);
  const actual = reader.getSession(updated.id);
  reader.close();

  assert.ok(actual);
  assertDurableOptions(actual, updated);
  assert.equal(actual.permissionBlocked, false);
});

test("targeted session checkpoints do not rewrite unrelated payload columns", (t) => {
  const dbPath = tempDatabase(t, "wand-session-checkpoints-");
  const initialMessages: NonNullable<SessionSnapshot["messages"]> = [{
    role: "user",
    content: [{ type: "text", text: "initial" }],
  }];
  const storage = new WandStorage(dbPath);
  storage.saveSession(snapshot("targeted", {
    output: "initial output",
    messages: initialMessages,
    queuedMessages: ["old queue"],
  }));

  storage.updateSessionRuntimeMetadata(snapshot("targeted", {
    mode: "assist",
    output: "must not overwrite output",
    messages: [{ role: "assistant", content: [{ type: "text", text: "must not overwrite messages" }] }],
    queuedMessages: ["new queue"],
    title: "runtime metadata",
  }));
  let stored = storage.getSession("targeted");
  assert.equal(stored?.output, "initial output");
  assert.deepEqual(stored?.messages, initialMessages);
  assert.deepEqual(stored?.queuedMessages, ["new queue"]);
  assert.equal(stored?.title, "runtime metadata");

  storage.checkpointSessionOutput("targeted", "checkpointed output");
  const checkpointedMessages: NonNullable<SessionSnapshot["messages"]> = [{
    role: "assistant",
    content: [{ type: "text", text: "checkpointed messages" }],
  }];
  storage.checkpointSessionMessages("targeted", checkpointedMessages, {
    provider: "claude",
    runner: "claude-sdk",
    inFlight: true,
    activeRequestId: "request-1",
  });
  stored = storage.getSession("targeted");
  assert.equal(stored?.output, "checkpointed output", "message checkpoint without output must preserve output");
  assert.deepEqual(stored?.messages, checkpointedMessages);
  assert.equal(stored?.structuredState?.activeRequestId, "request-1");

  storage.checkpointSessionMessages("targeted", checkpointedMessages, stored?.structuredState, "folded output");
  assert.equal(storage.getSession("targeted")?.output, "folded output");
  storage.close();
});

test("legacy schema migration adds session_options and malformed JSON falls back safely", (t) => {
  const dbPath = tempDatabase(t, "wand-session-options-migration-");
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE command_sessions (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      output TEXT NOT NULL
    )
  `);
  legacyDb.prepare(`
    INSERT INTO command_sessions (id, command, cwd, mode, status, exit_code, started_at, ended_at, output)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("legacy", "claude", "/tmp", "managed", "stopped", null, "2026-07-14T00:00:00.000Z", null, "legacy output");
  legacyDb.close();

  const migratedStorage = new WandStorage(dbPath);
  const migrated = migratedStorage.getSession("legacy");
  migratedStorage.close();
  assert.equal(migrated?.id, "legacy");
  assert.equal(migrated?.autonomyPolicy, undefined);

  const inspectDb = new DatabaseSync(dbPath);
  const columns = inspectDb.prepare("PRAGMA table_info(command_sessions)").all() as Array<{ name: string }>;
  const defaultRow = inspectDb.prepare("SELECT session_options FROM command_sessions WHERE id = 'legacy'")
    .get() as { session_options: string };
  inspectDb.prepare("UPDATE command_sessions SET session_options = ? WHERE id = 'legacy'").run("{not-json");
  inspectDb.close();

  assert.ok(columns.some((column) => column.name === "session_options"));
  assert.deepEqual(JSON.parse(defaultRow.session_options), { schemaVersion: 1 });

  const corruptedStorage = new WandStorage(dbPath);
  const corrupted = corruptedStorage.getSession("legacy");
  corruptedStorage.close();

  assert.equal(corrupted?.id, "legacy");
  assert.equal(corrupted?.output, "legacy output");
  assert.equal(corrupted?.autonomyPolicy, undefined);
  assert.equal(corrupted?.pendingEscalation, undefined);
  assert.equal(corrupted?.permissionBlocked, undefined);
});

test("transaction commits atomically and rolls back the original error", (t) => {
  const dbPath = tempDatabase(t, "wand-storage-transaction-");
  const storage = new WandStorage(dbPath);
  t.after(() => storage.close());

  const result = storage.transaction(() => {
    storage.setConfigValue("first", "one");
    storage.setConfigValue("second", "two");
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(storage.getConfigValue("first"), "one");
  assert.equal(storage.getConfigValue("second"), "two");

  const original = new Error("rollback marker");
  assert.throws(() => storage.transaction(() => {
    storage.setConfigValue("rolled-back", "value");
    throw original;
  }), (error) => error === original);
  assert.equal(storage.getConfigValue("rolled-back"), null);

  storage.saveAuthSession("first-token", Date.now() + 60_000);
  storage.saveAuthSession("second-token", Date.now() + 60_000);
  storage.deleteAllAuthSessions();
  assert.equal(storage.getAuthSession("first-token"), null);
  assert.equal(storage.getAuthSession("second-token"), null);
});
