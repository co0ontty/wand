import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGeminiEvent,
  buildGeminiArgs,
  geminiApprovalMode,
  geminiToolName,
  isMissingGeminiSession,
  type GeminiTurnState,
} from "../src/structured-gemini-adapter.js";
import type { SessionSnapshot } from "../src/types.js";

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "wand-session",
    sessionKind: "structured",
    provider: "gemini",
    runner: "gemini-cli-json",
    command: "gemini -p --output-format stream-json",
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
    structuredState: { provider: "gemini", runner: "gemini-cli-json", inFlight: false, activeRequestId: null, lastError: null },
    autoRecovered: false,
    autoApprovePermissions: false,
    approvalStats: { tool: 0, command: 0, file: 0, total: 0 },
    selectedModel: null,
    thinkingEffort: null,
    ...overrides,
  };
}

test("Gemini args pin headless stream-json, trust the workspace, and carry model + resume", () => {
  // `-p ""` 只是 headless 开关；prompt 走 stdin（见 runner 的 stdinData）。
  assert.deepEqual(buildGeminiArgs(session({ selectedModel: "gemini-2.5-pro", claudeSessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" })), [
    "-p", "", "--output-format", "stream-json", "--skip-trust",
    "--model", "gemini-2.5-pro",
    "--approval-mode", "yolo",
    "--resume", "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  ]);
});

test("Gemini args omit the model sentinel and map every Wand mode to an approval mode", () => {
  assert.deepEqual(buildGeminiArgs(session({ selectedModel: "default" })), [
    "-p", "", "--output-format", "stream-json", "--skip-trust", "--approval-mode", "yolo",
  ]);
  assert.equal(geminiApprovalMode(session({ mode: "default" })), "default");
  assert.equal(geminiApprovalMode(session({ mode: "auto-edit" })), "auto_edit");
  assert.equal(geminiApprovalMode(session({ mode: "full-access" })), "yolo");
  assert.equal(geminiApprovalMode(session({ mode: "managed" })), "yolo");
  assert.equal(geminiApprovalMode(session({ mode: "default", autoApprovePermissions: true })), "yolo");
});

test("Gemini stream-json events accumulate deltas, tools, usage, and the session id", () => {
  const state: GeminiTurnState = { blocks: [], result: "", sessionId: null };
  applyGeminiEvent(state, { type: "init", session_id: "native-gemini-id", model: "gemini-3-pro-preview" });
  applyGeminiEvent(state, { type: "message", role: "user", content: "make it so" });
  applyGeminiEvent(state, { type: "message", role: "assistant", content: "Work", delta: true });
  applyGeminiEvent(state, { type: "message", role: "assistant", content: "ing", delta: true });
  applyGeminiEvent(state, { type: "tool_use", tool_name: "run_shell_command", tool_id: "call-1", parameters: { command: "pwd" } });
  applyGeminiEvent(state, { type: "tool_result", tool_id: "call-1", status: "success", output: "/tmp/project" });
  applyGeminiEvent(state, { type: "tool_use", tool_name: "replace", tool_id: "call-2", parameters: { file_path: "a.ts" } });
  applyGeminiEvent(state, { type: "tool_result", tool_id: "call-2", status: "error", error: { type: "TOOL_EXECUTION_ERROR", message: "not found" } });
  applyGeminiEvent(state, {
    type: "result",
    status: "success",
    stats: { total_tokens: 100, input_tokens: 60, output_tokens: 40, cached: 10, input: 50, duration_ms: 12, tool_calls: 2, models: {} },
  });

  assert.equal(state.sessionId, "native-gemini-id");
  assert.equal(state.model, "gemini-3-pro-preview");
  assert.equal(state.result, "Working");
  assert.deepEqual(state.usage, { inputTokens: 50, outputTokens: 40, cacheReadInputTokens: 10 });
  assert.deepEqual(state.blocks, [
    { type: "text", text: "Working" },
    { type: "tool_use", id: "call-1", name: "Bash", input: { command: "pwd" } },
    { type: "tool_result", tool_use_id: "call-1", content: "/tmp/project", is_error: false },
    { type: "tool_use", id: "call-2", name: "Edit", input: { file_path: "a.ts" } },
    { type: "tool_result", tool_use_id: "call-2", content: "not found", is_error: true },
  ]);
  assert.equal(geminiToolName("read_file"), "Read");
  assert.equal(geminiToolName("grep_search"), "Grep");
  assert.equal(geminiToolName("list_directory"), "Glob");
  assert.equal(geminiToolName("web_fetch"), "WebFetch");
  assert.equal(geminiToolName("mystery_tool"), "Gemini/mystery_tool");
});

test("Gemini error events only fail the turn at severity=error, and result carries the message", () => {
  const state: GeminiTurnState = { blocks: [], result: "", sessionId: null };
  assert.equal(applyGeminiEvent(state, { type: "error", severity: "warning", message: "Loop detected, stopping execution" }), null);
  assert.equal(
    applyGeminiEvent(state, { type: "error", severity: "error", message: "Maximum session turns exceeded" }),
    "Maximum session turns exceeded",
  );
  assert.equal(
    applyGeminiEvent(state, { type: "result", status: "error", error: { type: "INVALID_STREAM", message: "The model returned an empty response" } }),
    "The model returned an empty response",
  );
  assert.equal(applyGeminiEvent(state, { type: "result", status: "success", stats: { input_tokens: 0, output_tokens: 0 } }), null);
});

test("Gemini resume failures are recognised so the dead session id gets dropped", () => {
  assert.equal(isMissingGeminiSession('Error resuming session: Invalid session identifier "abc".'), true);
  assert.equal(isMissingGeminiSession("No previous sessions found for this project."), true);
  assert.equal(isMissingGeminiSession("gemini: command not found"), false);
  assert.equal(isMissingGeminiSession(null), false);
});
