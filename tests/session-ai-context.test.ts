import assert from "node:assert/strict";
import test from "node:test";

import { resolveSessionAiContext, resolveSessionProvider } from "../src/session-ai-context.js";
import type { SessionSnapshot } from "../src/types.js";

const config = {
  defaultModel: "claude-sonnet-4-6",
  defaultCodexModel: "gpt-5.5-codex",
  defaultThinkingEffort: "deep" as const,
  inheritEnv: true,
};

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "session-1",
    command: "claude",
    cwd: "/tmp/repo",
    mode: "managed",
    status: "idle",
    exitCode: null,
    startedAt: new Date(0).toISOString(),
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    ...overrides,
  };
}

test("resolveSessionProvider recognizes legacy Codex session representations", () => {
  assert.equal(resolveSessionProvider(session({ provider: "codex", command: "claude" })), "codex");
  assert.equal(resolveSessionProvider(session({ provider: undefined, structuredState: {
    provider: "codex",
    runner: "codex-cli-exec",
    lastError: null,
    inFlight: false,
    activeRequestId: null,
  } })), "codex");
  assert.equal(resolveSessionProvider(session({ provider: undefined, runner: "codex-cli-exec" })), "codex");
  assert.equal(resolveSessionProvider(session({ provider: undefined, command: "codex exec --json" })), "codex");
});

test("resolveSessionAiContext keeps provider-specific model and effort", () => {
  const codex = resolveSessionAiContext(session({
    provider: "codex",
    command: "codex",
    selectedModel: "gpt-5.4-codex",
    thinkingEffort: "max",
  }), config);
  assert.deepEqual(codex, {
    provider: "codex",
    model: "gpt-5.4-codex",
    thinkingEffort: "max",
    inheritEnv: true,
  });

  const claude = resolveSessionAiContext(session({ provider: "claude" }), config);
  assert.deepEqual(claude, {
    provider: "claude",
    model: "claude-sonnet-4-6",
    thinkingEffort: "deep",
    inheritEnv: true,
  });
});

test("resolveSessionAiContext uses Codex default for legacy Codex sessions", () => {
  const context = resolveSessionAiContext(session({
    provider: undefined,
    command: "codex resume 00000000-0000-0000-0000-000000000000",
    selectedModel: "default",
  }), config);

  assert.equal(context.provider, "codex");
  assert.equal(context.model, "gpt-5.5-codex");
});
