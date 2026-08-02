import assert from "node:assert/strict";
import test from "node:test";

import { applyPiEvent, buildPiArgs, piToolName } from "../src/structured-pi-adapter.js";
import type { SessionSnapshot } from "../src/types.js";

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "wand-session",
    sessionKind: "structured",
    provider: "pi",
    runner: "pi-cli-json",
    command: "pi --mode json --print",
    cwd: "/tmp/project",
    mode: "managed",
    status: "idle",
    exitCode: null,
    startedAt: new Date(0).toISOString(),
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    messages: [],
    queuedMessages: [],
    structuredState: { provider: "pi", runner: "pi-cli-json", inFlight: false, activeRequestId: null, lastError: null },
    autoRecovered: false,
    autoApprovePermissions: true,
    approvalStats: { tool: 0, command: 0, file: 0, total: 0 },
    selectedModel: null,
    thinkingEffort: null,
    ...overrides,
  };
}

test("Pi args use JSON print mode and preserve model, thinking, resume, and prompt", () => {
  assert.deepEqual(buildPiArgs(session({
    selectedModel: "openai/gpt-5.4",
    thinkingEffort: "deep",
    claudeSessionId: "pi-session-id",
  }), "continue please"), [
    "--mode", "json", "--print",
    "--model", "openai/gpt-5.4",
    "--thinking", "high",
    "--session", "pi-session-id",
    "continue please",
  ]);
});

test("Pi JSON events map streaming content, tools, usage, model, and session id", () => {
  const state = { blocks: [], result: "", sessionId: null };
  applyPiEvent(state, { type: "session", id: "native-pi-id" });
  applyPiEvent(state, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "plan" } });
  applyPiEvent(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } });
  applyPiEvent(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Pi" } });
  applyPiEvent(state, { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "pwd" } });
  applyPiEvent(state, { type: "tool_execution_end", toolCallId: "tool-1", result: { content: [{ type: "text", text: "/tmp/project" }] }, isError: false });
  applyPiEvent(state, {
    type: "message_end",
    message: { role: "assistant", model: "gpt-test", usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } }, stopReason: "stop" },
  });

  assert.equal(state.sessionId, "native-pi-id");
  assert.equal(state.result, "Hello Pi");
  assert.equal(state.model, "gpt-test");
  assert.deepEqual(state.usage, { inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 2, cacheCreationInputTokens: 1, totalCostUsd: 0.01 });
  assert.deepEqual(state.blocks, [
    { type: "thinking", thinking: "plan" },
    { type: "text", text: "Hello Pi" },
    { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
    { type: "tool_result", tool_use_id: "tool-1", content: "/tmp/project", is_error: false },
  ]);
  assert.equal(piToolName("custom"), "Pi/custom");
});

test("Pi errors surface the provider message", () => {
  const state = { blocks: [], result: "", sessionId: null };
  assert.equal(applyPiEvent(state, {
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "missing API key" },
  }), "missing API key");
});
