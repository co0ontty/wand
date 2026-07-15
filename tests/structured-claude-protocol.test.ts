import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeCliProtocolReducer } from "../src/structured-claude-protocol.js";
import type { SessionSnapshot } from "../src/types.js";

function session(): SessionSnapshot {
  return {
    id: "session",
    cwd: process.cwd(),
    mode: "assist",
    status: "running",
    output: "",
    startedAt: new Date(0).toISOString(),
    endedAt: null,
    exitCode: null,
    sessionKind: "structured",
    provider: "claude",
    runner: "claude-cli-print",
  } as SessionSnapshot;
}

test("ClaudeCliProtocolReducer merges cumulative and splice-style assistant frames", () => {
  const reducer = new ClaudeCliProtocolReducer(session());
  reducer.apply({
    type: "assistant",
    session_id: "claude-session",
    message: { id: "message", content: [{ type: "thinking", thinking: "checking" }] },
  }, false);
  reducer.apply({
    type: "assistant",
    session_id: "claude-session",
    message: {
      id: "message",
      content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "a.ts" } }],
    },
  }, false);
  reducer.apply({
    type: "assistant",
    message: {
      id: "answer",
      content: [{ type: "text", text: "draft" }],
    },
  }, false);
  reducer.apply({
    type: "assistant",
    message: {
      id: "answer",
      content: [{ type: "text", text: "final answer" }],
    },
  }, false);

  assert.equal(reducer.state.sessionId, "claude-session");
  assert.deepEqual(reducer.state.blocks, [
    { type: "thinking", thinking: "checking" },
    { type: "tool_use", id: "read", name: "Read", description: undefined, input: { file_path: "a.ts" } },
    { type: "text", text: "final answer" },
  ]);
});

test("ClaudeCliProtocolReducer tags subagents, normalizes questions, and detects waiting", () => {
  const reducer = new ClaudeCliProtocolReducer(session());
  reducer.apply({
    type: "assistant",
    message: {
      id: "parent",
      content: [{
        type: "tool_use",
        id: "task-1",
        name: "Agent",
        input: { subagent_type: "Explore", description: "inspect" },
      }],
    },
  }, false);
  reducer.apply({
    type: "assistant",
    parent_tool_use_id: "task-1",
    message: { id: "child", content: [{ type: "text", text: "found it" }] },
  }, false);
  reducer.apply({
    type: "assistant",
    message: {
      id: "ask",
      content: [{
        type: "tool_use",
        id: "ask-1",
        name: "AskUserQuestion",
        input: { questions: "[{\"question\":\"Continue?\"}]" },
      }],
    },
  }, false);

  const task = reducer.state.blocks.find((block) => block.type === "tool_use" && block.id === "task-1");
  const child = reducer.state.blocks.find((block) => block.type === "text" && block.text === "found it");
  const ask = reducer.state.blocks.find((block) => block.type === "tool_use" && block.id === "ask-1");
  assert.equal(task?.__subagent?.agentType, "Explore");
  assert.equal(child?.__subagent?.taskId, "task-1");
  assert.deepEqual(ask?.type === "tool_use" ? ask.input.questions : null, [{ question: "Continue?" }]);
  assert.equal(reducer.askUserQuestionDetected, true);
});

test("ClaudeCliProtocolReducer keeps final model, usage, and result authoritative", () => {
  const reducer = new ClaudeCliProtocolReducer(session());
  reducer.apply({
    type: "result",
    session_id: "claude-session",
    result: " done ",
    modelUsage: { "claude-opus": {} },
    usage: { input_tokens: 5, output_tokens: 8, cache_read_input_tokens: 2 },
    total_cost_usd: 0.1,
  }, false);

  assert.equal(reducer.state.result, "done");
  assert.equal(reducer.state.model, "claude-opus");
  assert.deepEqual(reducer.state.usage, {
    inputTokens: 5,
    outputTokens: 8,
    cacheReadInputTokens: 2,
    cacheCreationInputTokens: undefined,
    totalCostUsd: 0.1,
  });
});
