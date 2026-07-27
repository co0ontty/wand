import assert from "node:assert/strict";
import test from "node:test";

import { markManagedProviderHistory } from "../src/server-session-routes.js";
import type { SessionSnapshot } from "../src/types.js";

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "wand-session",
    sessionKind: "structured",
    provider: "codex",
    command: "codex exec --json",
    cwd: "/tmp/project",
    mode: "full-access",
    status: "running",
    exitCode: null,
    startedAt: "2026-07-14T11:10:44.253Z",
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: "019f6052-8e6e-79b1-9992-00ede1a5daa3",
    ...overrides,
  };
}

function history(id: string, managedByWand = false) {
  return {
    claudeSessionId: id,
    managedByWand,
    firstUserMessage: "继续优化安卓客户端的会话折叠、展示等逻辑",
  };
}

test("structured Codex history is marked as Wand-managed", () => {
  const matching = history("019f6052-8e6e-79b1-9992-00ede1a5daa3");
  const external = history("019f6054-86a9-7781-8d7d-1fe294b37b3e");

  const result = markManagedProviderHistory(
    [matching, external],
    [snapshot()],
    "codex",
  );

  assert.equal(result[0].managedByWand, true);
  assert.equal(result[1].managedByWand, false);
  assert.equal(matching.managedByWand, false, "cached history entries must not be mutated");
});

test("history ownership is provider-specific", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const result = markManagedProviderHistory(
    [history(id)],
    [snapshot({ provider: "claude", command: "claude -p", claudeSessionId: id })],
    "codex",
  );

  assert.equal(result[0].managedByWand, false);
});

test("legacy structured snapshots fall back to structuredState provider", () => {
  const id = "123e4567-e89b-42d3-a456-426614174001";
  const result = markManagedProviderHistory(
    [history(id)],
    [snapshot({
      provider: undefined,
      command: "wand structured runner",
      claudeSessionId: id,
      structuredState: { provider: "claude", runner: "claude-cli-print" },
    })],
    "claude",
  );

  assert.equal(result[0].managedByWand, true);
});
