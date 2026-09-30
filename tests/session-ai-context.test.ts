import assert from "node:assert/strict";
import test from "node:test";

import { resolveSessionAiContext, resolveSessionProvider, resolveSystemAiContext } from "../src/session-ai-context.js";
import type { SessionSnapshot } from "../src/types.js";

const config = {
  defaultModel: "claude-sonnet-4-6",
  defaultCodexModel: "gpt-5.5-codex",
  defaultOpenCodeModel: "anthropic/claude-sonnet-4-6",
  defaultGrokModel: "grok-4.5",
  defaultQoderModel: "performance",
  defaultPiModel: "anthropic/claude-sonnet-4-6",
  defaultGeminiModel: "gemini-2.5-pro",
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

test("resolveSessionProvider recognizes Qoder session representations", () => {
  assert.equal(resolveSessionProvider(session({ provider: "qoder" })), "qoder");
  assert.equal(resolveSessionProvider(session({ provider: undefined, runner: "qoder-cli-print" })), "qoder");
  assert.equal(resolveSessionProvider(session({ provider: undefined, command: "qodercli -p hello" })), "qoder");
});

test("resolveSessionProvider recognizes Gemini session representations", () => {
  assert.equal(resolveSessionProvider(session({ provider: "gemini" })), "gemini");
  assert.equal(resolveSessionProvider(session({ provider: undefined, runner: "gemini-cli-json" })), "gemini");
  assert.equal(resolveSessionProvider(session({
    provider: undefined,
    command: "gemini -p --output-format stream-json",
  })), "gemini");
});

test("resolveSessionAiContext uses the Gemini default model", () => {
  const context = resolveSessionAiContext(session({ provider: "gemini", command: "gemini" }), config);
  assert.equal(context.provider, "gemini");
  assert.equal(context.model, "gemini-2.5-pro");
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

test("resolveSessionAiContext uses the Qoder default model", () => {
  const context = resolveSessionAiContext(session({ provider: "qoder", command: "qodercli" }), config);
  assert.equal(context.provider, "qoder");
  assert.equal(context.model, "performance");
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

test("system AI CLI selection overrides the session provider and never reuses its model", () => {
  const snapshot = session({
    provider: "codex",
    selectedModel: "gpt-5.6-sol",
    thinkingEffort: "codex:xhigh",
  });
  const selected = resolveSystemAiContext(snapshot, {
    ...config,
    systemAiCli: "pi",
    systemAiModel: "  google/gemini-3  ",
  });
  assert.deepEqual(selected, {
    provider: "pi",
    model: "google/gemini-3",
    thinkingEffort: "deep",
    inheritEnv: true,
  });
  const defaultModel = resolveSystemAiContext(snapshot, {
    ...config,
    systemAiCli: "qoder",
    systemAiModel: "  ",
  });
  assert.equal(defaultModel.provider, "qoder");
  assert.equal(defaultModel.model, "performance");
  const legacy = resolveSystemAiContext(snapshot, config);
  assert.equal(legacy.provider, "codex");
  assert.equal(legacy.model, "gpt-5.6-sol");
});

test("resolveSystemAiContext keeps the current session CLI context when no system employee is available", () => {
  const context = resolveSystemAiContext(session({
    provider: "codex",
    selectedModel: "gpt-5.6-sol",
    thinkingEffort: "codex:xhigh",
  }), config);

  assert.equal(context.provider, "codex");
  assert.equal(context.model, "gpt-5.6-sol");
  assert.equal(context.thinkingEffort, "codex:xhigh");
  assert.equal(context.inheritEnv, true);
});
