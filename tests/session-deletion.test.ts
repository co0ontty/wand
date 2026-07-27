import assert from "node:assert/strict";
import test from "node:test";

import { deleteSessionWithProviderHistory } from "../src/server-session-routes.js";
import type { SessionSnapshot } from "../src/types.js";

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "wand-session",
    sessionKind: "structured",
    provider: "claude",
    command: "claude -p",
    cwd: "/tmp/project",
    mode: "managed",
    status: "idle",
    exitCode: null,
    startedAt: "2026-07-12T00:00:00.000Z",
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: "123e4567-e89b-42d3-a456-426614174000",
    ...overrides,
  };
}

function makeHarness(value: SessionSnapshot) {
  const calls = {
    processDeletes: [] as string[],
    structuredDeletes: [] as string[],
    claudeDeletes: [] as Array<Array<{ claudeSessionId: string; cwd: string }>>,
    codexDeletes: [] as string[][],
    openCodeDeletes: [] as string[][],
    qoderDeletes: [] as string[][],
  };
  const config = new Map<string, string>();
  const processes = {
    get: () => value,
    delete: (id: string) => { calls.processDeletes.push(id); },
    deleteClaudeHistoryFiles: (items: Array<{ claudeSessionId: string; cwd: string }>) => {
      calls.claudeDeletes.push(items);
      return items.length;
    },
    deleteCodexHistoryFiles: (ids: string[]) => {
      calls.codexDeletes.push(ids);
      return ids.length;
    },
    deleteOpenCodeHistorySessions: (ids: string[]) => {
      calls.openCodeDeletes.push(ids);
      return ids.length;
    },
    deleteQoderHistoryFiles: (ids: string[]) => {
      calls.qoderDeletes.push(ids);
      return ids.length;
    },
  };
  const structured = {
    // Both real managers can fall back to the shared storage snapshot. The
    // helper must choose the owner from sessionKind, not from get() truthiness.
    get: () => value,
    delete: (id: string) => { calls.structuredDeletes.push(id); },
  };
  const storage = {
    getConfigValue: (key: string) => config.get(key) ?? null,
    setConfigValue: (key: string, next: string) => { config.set(key, next); },
  };
  return { calls, config, processes, structured, storage };
}

test("deleting a structured Claude session also deletes and tombstones its native history", () => {
  const value = snapshot();
  const harness = makeHarness(value);

  deleteSessionWithProviderHistory(
    harness.processes,
    harness.structured,
    harness.storage,
    value.id,
  );

  assert.deepEqual(harness.calls.structuredDeletes, [value.id]);
  assert.deepEqual(harness.calls.processDeletes, []);
  assert.deepEqual(harness.calls.claudeDeletes, [[{
    claudeSessionId: value.claudeSessionId,
    cwd: value.cwd,
  }]]);
  assert.deepEqual(harness.calls.codexDeletes, []);
  assert.deepEqual(
    JSON.parse(harness.config.get("hidden_claude_session_ids") ?? "[]"),
    [value.claudeSessionId],
  );
});

test("deleting a PTY Codex session uses the process owner and removes the rollout", () => {
  const value = snapshot({
    sessionKind: "pty",
    provider: "codex",
    command: "codex resume",
  });
  const harness = makeHarness(value);

  deleteSessionWithProviderHistory(
    harness.processes,
    harness.structured,
    harness.storage,
    value.id,
  );

  assert.deepEqual(harness.calls.processDeletes, [value.id]);
  assert.deepEqual(harness.calls.structuredDeletes, []);
  assert.deepEqual(harness.calls.claudeDeletes, []);
  assert.deepEqual(harness.calls.codexDeletes, [[value.claudeSessionId!]]);
});

test("deleting a session without a provider history id only removes the Wand record", () => {
  const value = snapshot({ claudeSessionId: null });
  const harness = makeHarness(value);

  deleteSessionWithProviderHistory(
    harness.processes,
    harness.structured,
    harness.storage,
    value.id,
  );

  assert.deepEqual(harness.calls.structuredDeletes, [value.id]);
  assert.deepEqual(harness.calls.claudeDeletes, []);
  assert.deepEqual(harness.calls.codexDeletes, []);
  assert.equal(harness.config.has("hidden_claude_session_ids"), false);
});

test("deleting managed OpenCode and Qoder sessions also removes their native history", () => {
  for (const [provider, command, expected] of [
    ["opencode", "opencode run", "openCodeDeletes"],
    ["qoder", "qodercli -p", "qoderDeletes"],
  ] as const) {
    const value = snapshot({ provider, command, claudeSessionId: `${provider}-session-1` });
    const harness = makeHarness(value);

    deleteSessionWithProviderHistory(harness.processes, harness.structured, harness.storage, value.id);

    assert.deepEqual(harness.calls[expected], [[value.claudeSessionId]]);
  }
});
