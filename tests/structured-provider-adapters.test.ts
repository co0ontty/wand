import assert from "node:assert/strict";
import test from "node:test";

import { buildClaudeCliArgs, buildClaudeSdkThinking } from "../src/structured-claude-adapter.js";
import { buildCodexArgs } from "../src/structured-codex-adapter.js";
import { applyOpenCodeEvent, buildOpenCodeArgs } from "../src/structured-opencode-adapter.js";
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
