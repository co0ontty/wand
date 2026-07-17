import assert from "node:assert/strict";
import test from "node:test";

import { buildClaudeCliArgs, buildClaudeSdkThinking } from "../src/structured-claude-adapter.js";
import { buildCodexArgs } from "../src/structured-codex-adapter.js";
import { applyOpenCodeEvent, buildOpenCodeArgs } from "../src/structured-opencode-adapter.js";
import { applyGrokEvent, buildGrokArgs } from "../src/structured-grok-adapter.js";
import type { SessionSnapshot } from "../src/types.js";

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "wand-1",
    sessionKind: "structured",
    provider: "claude",
    runner: "claude-cli-print",
    command: "claude",
    cwd: "/repo",
    mode: "assist",
    status: "idle",
    exitCode: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    ...overrides,
  };
}

test("Codex adapter emits permission, model, effort, and resume arguments in protocol order", () => {
  assert.deepEqual(buildCodexArgs(session({
    provider: "codex",
    runner: "codex-cli-exec",
    mode: "agent",
    selectedModel: "gpt-5.4",
    thinkingEffort: "max",
    claudeSessionId: "thread-1",
  })), [
    "exec", "--json", "--color", "never",
    "--sandbox", "workspace-write",
    "--skip-git-repo-check",
    "--model", "gpt-5.4",
    "-c", "model_reasoning_effort=xhigh",
    "resume", "thread-1", "-",
  ]);

  assert.ok(buildCodexArgs(session({ mode: "managed" })).includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("Claude adapter keeps variadic permission flags ahead of all following flags", () => {
  assert.deepEqual(buildClaudeCliArgs(session({
    mode: "managed",
    selectedModel: "claude-opus-4-6",
    thinkingEffort: "deep",
    claudeSessionId: "session-1",
  }), {
    permissionPolicy: { permissionMode: "acceptEdits", allowedTools: ["Read", "mcp__figma"] },
    systemPromptParts: ["work independently", "reply in Chinese"],
  }), [
    "-p", "--verbose", "--output-format", "stream-json",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read", "mcp__figma",
    "--append-system-prompt", "work independently",
    "--append-system-prompt", "reply in Chinese",
    "--model", "claude-opus-4-6",
    "--effort", "medium",
    "--disallowedTools", "AskUserQuestion",
    "--resume", "session-1",
  ]);
  assert.deepEqual(buildClaudeSdkThinking("off"), { type: "disabled" });
  assert.deepEqual(buildClaudeSdkThinking("standard"), { type: "enabled", budgetTokens: 4096 });
});

test("OpenCode adapter maps args and stream events without session lifecycle state", () => {
  assert.deepEqual(buildOpenCodeArgs(session({
    provider: "opencode",
    runner: "opencode-cli-run",
    mode: "auto-edit",
    selectedModel: "anthropic/claude-sonnet-4-6",
    thinkingEffort: "codex:ultra",
    claudeSessionId: "oc-1",
  })), [
    "run", "--format", "json", "--thinking",
    "--model", "anthropic/claude-sonnet-4-6",
    "--variant", "ultra",
    "--dangerously-skip-permissions",
    "--session", "oc-1",
  ]);

  const state = { blocks: [], result: "", sessionId: null };
  assert.equal(applyOpenCodeEvent(state, {
    type: "tool_use",
    sessionID: "oc-2",
    part: { tool: "shell", state: { title: "Run tests", input: { command: "npm test" }, output: "ok" } },
  }, () => "generated-id"), null);
  assert.equal(state.sessionId, "oc-2");
  assert.deepEqual(state.blocks, [
    { type: "tool_use", id: "generated-id", name: "Bash", description: "Run tests", input: { command: "npm test" } },
    { type: "tool_result", tool_use_id: "generated-id", content: "ok", is_error: false },
  ]);

  assert.equal(applyOpenCodeEvent(state, { type: "error", error: { message: { text: "boom" } } }), "boom");
});

test("Grok adapter maps official streaming-json chunks, usage, and resume arguments", () => {
  assert.deepEqual(buildGrokArgs(session({
    provider: "grok",
    runner: "grok-cli-headless",
    mode: "managed",
    selectedModel: "grok-4.5",
    thinkingEffort: "deep",
    claudeSessionId: "grok-session-1",
  }), "hello"), [
    "--no-auto-update", "-p", "hello", "--output-format", "streaming-json",
    "--model", "grok-4.5", "--effort", "high", "--always-approve",
    "--resume", "grok-session-1",
  ]);

  const state = { blocks: [], result: "", sessionId: null };
  applyGrokEvent(state, { type: "thought", data: "checking" });
  applyGrokEvent(state, { type: "text", data: "WAND" });
  applyGrokEvent(state, { type: "text", data: "_OK" });
  assert.equal(applyGrokEvent(state, {
    type: "end",
    sessionId: "grok-session-2",
    usage: { input_tokens: 10, output_tokens: 4, reasoning_tokens: 2, cache_read_input_tokens: 3 },
    total_cost_usd: 0.25,
  }), null);
  assert.equal(state.sessionId, "grok-session-2");
  assert.equal(state.result, "WAND_OK");
  assert.deepEqual(state.blocks, [
    { type: "thinking", thinking: "checking" },
    { type: "text", text: "WAND_OK" },
  ]);
  assert.deepEqual(state.usage, {
    inputTokens: 10,
    outputTokens: 4,
    reasoningOutputTokens: 2,
    cacheReadInputTokens: 3,
    totalCostUsd: 0.25,
  });
  assert.equal(applyGrokEvent(state, { type: "error", message: "boom" }), "boom");
});
