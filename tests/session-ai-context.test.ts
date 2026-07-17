import assert from "node:assert/strict";
import test from "node:test";

import { resolveCommitAiContext, resolveSessionAiContext, resolveSessionProvider } from "../src/session-ai-context.js";
import type { SessionSnapshot } from "../src/types.js";

const config = {
  defaultModel: "claude-sonnet-4-6",
  defaultCodexModel: "gpt-5.5-codex",
  defaultOpenCodeModel: "anthropic/claude-sonnet-4-6",
  defaultGrokModel: "grok-4.5",
  defaultThinkingEffort: "deep" as const,
  inheritEnv: true,
  commitCli: "claude" as const,
  commitModel: "claude-haiku-4-5",
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

test("resolveSessionProvider recognizes OpenCode session representations", () => {
  assert.equal(resolveSessionProvider(session({ provider: "opencode" })), "opencode");
  assert.equal(resolveSessionProvider(session({ provider: undefined, runner: "opencode-cli-run" })), "opencode");
  assert.equal(resolveSessionProvider(session({ provider: undefined, command: "opencode run --format json" })), "opencode");
});

test("resolveSessionProvider recognizes Grok session representations", () => {
  assert.equal(resolveSessionProvider(session({ provider: "grok" })), "grok");
  assert.equal(resolveSessionProvider(session({ provider: undefined, runner: "grok-cli-headless" })), "grok");
  assert.equal(resolveSessionProvider(session({
    provider: undefined,
    command: "grok -p --output-format streaming-json",
  })), "grok");
});

test("resolveSessionAiContext uses the OpenCode default model", () => {
  const context = resolveSessionAiContext(session({ provider: "opencode", command: "opencode" }), config);
  assert.equal(context.provider, "opencode");
  assert.equal(context.model, "anthropic/claude-sonnet-4-6");
});

test("resolveSessionAiContext uses the Grok default model", () => {
  const context = resolveSessionAiContext(session({ provider: "grok", command: "grok" }), config);
  assert.equal(context.provider, "grok");
  assert.equal(context.model, "grok-4.5");
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

test("resolveCommitAiContext uses commit CLI and model independently from the session", () => {
  const context = resolveCommitAiContext(session({
    provider: "claude",
    selectedModel: "claude-opus-4-6",
    thinkingEffort: "standard",
  }), {
    ...config,
    commitCli: "codex",
    commitModel: "gpt-5.4-mini",
  });

  assert.deepEqual(context, {
    provider: "codex",
    model: "gpt-5.4-mini",
    thinkingEffort: "standard",
    inheritEnv: true,
  });
});

test("resolveCommitAiContext leaves model unset when commit model follows the CLI default", () => {
  const context = resolveCommitAiContext(session({ provider: "codex" }), {
    ...config,
    commitCli: "claude",
    commitModel: "default",
  });

  assert.equal(context.provider, "claude");
  assert.equal(context.model, undefined);
});

test("resolveCommitAiContext keeps CLI selected when a direct API profile is enabled", () => {
  const context = resolveCommitAiContext(session({ provider: "claude" }), {
    ...config,
    commitAiSource: "cli",
    systemAi: {
      enabled: true,
      protocol: "anthropic",
      baseUrl: "https://api.example.test",
      apiKey: "secret",
      model: "model-a",
    },
  });

  assert.equal(context.systemAi, undefined);
});

test("resolveCommitAiContext uses the direct API selected for commits", () => {
  const context = resolveCommitAiContext(session({ provider: "claude" }), {
    ...config,
    commitAiSource: "api",
    systemAi: {
      enabled: false,
      protocol: "anthropic",
      baseUrl: "https://api.example.test",
      apiKey: "secret",
      model: "model-a",
      authHeader: "x-api-key",
    },
  });

  assert.deepEqual(context.systemAi, {
    enabled: true,
    protocol: "anthropic",
    baseUrl: "https://api.example.test",
    apiKey: "secret",
    model: "model-a",
    authHeader: "x-api-key",
  });
});
