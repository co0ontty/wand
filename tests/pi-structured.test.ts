import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { applyPiEvent, buildPiArgs, piToolName } from "../src/structured-pi-adapter.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { StructuredRunnerAdapter } from "../src/structured-runner.js";
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
  assert.equal(state.sessionId, null, "Pi has not written a resumable session file yet");
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

test("Pi does not save a session ID when a turn ends before the assistant replies", () => {
  const state = { blocks: [], result: "", sessionId: null };
  applyPiEvent(state, { type: "session", id: "unwritten-id" });
  applyPiEvent(state, { type: "message_end", message: { role: "user", content: [] } });
  assert.equal(state.sessionId, null);
});

test("Pi retries a previously failed Wand session without its missing resume ID", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-resume-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const missingId = "unwritten-id";
  storage.saveSession(session({
    id: "failed-pi",
    cwd: root,
    status: "failed",
    claudeSessionId: missingId,
    structuredState: {
      provider: "pi", runner: "pi-cli-json", inFlight: false, activeRequestId: null,
      lastError: `No session found matching '${missingId}'`,
    },
  }));
  let resumedWith: string | null | undefined;
  const runner: StructuredRunnerAdapter = {
    start(context) {
      resumedWith = context.session.claudeSessionId;
      return {
        args: buildPiArgs(context.session, context.prompt),
        spawnedAt: new Date().toISOString(), pid: null, interrupt() {},
        completion: Promise.resolve({
          state: { blocks: [{ type: "text", text: "done" }], result: "done", sessionId: "new-id" },
          exitCode: 0, signal: null, stderr: "", primaryError: null,
        }),
      };
    },
  };
  const manager = new StructuredSessionManager(
    storage, { ...defaultConfig(), defaultCwd: root }, null, undefined, { pi: runner },
  );
  t.after(() => manager.dispose());
  const result = await manager.sendMessage("failed-pi", "retry");
  assert.equal(resumedWith, null);
  assert.equal(result.claudeSessionId, "new-id");
});

test("Pi clears a missing resume ID after the CLI rejects it", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-missing-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const missingId = "unwritten-id";
  storage.saveSession(session({ id: "missing-pi", cwd: root, claudeSessionId: missingId }));
  const runner: StructuredRunnerAdapter = {
    start() {
      return {
        args: [], spawnedAt: new Date().toISOString(), pid: null, interrupt() {},
        completion: Promise.resolve({
          state: { blocks: [], result: "", sessionId: missingId },
          exitCode: 1, signal: null,
          stderr: `No session found matching '${missingId}'`, primaryError: null,
        }),
      };
    },
  };
  const manager = new StructuredSessionManager(
    storage, { ...defaultConfig(), defaultCwd: root }, null, undefined, { pi: runner },
  );
  t.after(() => manager.dispose());
  await assert.rejects(manager.sendMessage("missing-pi", "retry"), /No session found matching/);
  assert.equal(manager.get("missing-pi")?.claudeSessionId, null);
  assert.equal(storage.getSession("missing-pi")?.claudeSessionId, null);
});

test("Pi errors surface the provider message", () => {
  const state = { blocks: [], result: "", sessionId: null };
  assert.equal(applyPiEvent(state, {
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: "missing API key" },
  }), "missing API key");
});

test("Pi reconstructs assistant text from message_end and text_end when deltas are missing", () => {
  const fromEnd = { blocks: [], result: "", sessionId: null };
  assert.equal(applyPiEvent(fromEnd, {
    type: "message_end",
    message: {
      role: "assistant",
      model: "gpt-test",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "Hello from Pi" },
      ],
      usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    },
  }), null);
  assert.equal(fromEnd.result, "Hello from Pi");
  assert.equal(fromEnd.model, "gpt-test");
  assert.deepEqual(fromEnd.blocks, [
    { type: "thinking", thinking: "plan" },
    { type: "text", text: "Hello from Pi" },
  ]);

  const fromTextEnd = { blocks: [], result: "", sessionId: null };
  applyPiEvent(fromTextEnd, {
    type: "message_update",
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "final answer" },
  });
  assert.equal(fromTextEnd.result, "final answer");
  assert.deepEqual(fromTextEnd.blocks, [{ type: "text", text: "final answer" }]);
});
