import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeCliProtocolReducer } from "../src/structured-claude-protocol.js";
import { buildReplayProcessor } from "../src/structured-session-manager-replay.js";
import { collectAgentRuns, getAgentRunStatusSummary } from "../src/web-ui/browser/agent-runs.js";
import type { ContentBlock, SessionSnapshot } from "../src/types.js";

// Shapes verified against TASK-71's Qoder 1.1.72 / protocol 1.5.0 recording.
// Local paths, names and ids are replaced; no model is called and no file read.
const session = { provider: "qoder", runner: "qoder-cli-print", mode: "managed" } as SessionSnapshot;
const ack = "Async agent launched successfully.\nagentId: ageneral-purpose-example\n"
  + "The agent is working in the background. You will be notified automatically when it completes.\n"
  + "output_file: /tmp/qoder/tasks/task-a.output";
const live = { sessionRunning: true, inLatestWindow: true };
const settled = { sessionRunning: false, inLatestWindow: true };

function dispatch(id: string) {
  return { type: "assistant", message: { id: `dispatch-${id}`, content: [
    { type: "tool_use", id, name: "Agent", input: { description: `Inspect ${id}`, subagent_type: "general-purpose", run_in_background: true } },
  ] } };
}
function result(id: string, content = ack) {
  return { type: "user", tool_use_result: { isAsync: content === ack }, message: { content: [
    { type: "tool_result", tool_use_id: id, content },
  ] } };
}
function notification(id: string, status = "completed") {
  return { type: "system", subtype: "task_notification", task_id: `native-${id}`, tool_use_id: id,
    status, output_file: "/not/read/by/reducer.output", summary: `Agent ${id} finished` };
}
function index(blocks: ContentBlock[]) {
  return collectAgentRuns([{ role: "assistant", content: blocks }]);
}

test("Qoder: a launch receipt and a parent's completion claim do not establish child completion", () => {
  const reducer = new ClaudeCliProtocolReducer(session);
  reducer.apply(dispatch("a"), true);
  reducer.apply(result("a"), true);
  reducer.apply({ type: "assistant", message: { id: "parent", content: [{ type: "text", text: "两个子代理均已完成，A 的结果是…" }] } }, true);
  reducer.apply({ type: "result", subtype: "success", result: "all done" }, true);
  const run = index(reducer.state.blocks).runs[0];
  for (const activity of [live, settled]) {
    assert.equal(getAgentRunStatusSummary(run, activity).status, "background", "receipt-only compatibility state, labelled unknown by clients");
  }
  assert.ok(run.agents[0].receipt);
  assert.equal(run.agents[0].result?.block.content, ack);
});

test("Qoder: native terminal events correlate two children by tool_use_id, not task id or notification order", () => {
  const reducer = new ClaudeCliProtocolReducer(session);
  for (const id of ["a", "b"]) { reducer.apply(dispatch(id), true); reducer.apply(result(id), true); }
  assert.equal(reducer.apply(notification("b"), true), true);
  let agents = index(reducer.state.blocks).agentByTaskId;
  assert.ok(agents.get("a")?.receipt);
  assert.equal(agents.get("b")?.receipt, null);
  assert.match(agents.get("b")?.result?.block.content, /原生摘要：Agent b finished/);
  assert.match(agents.get("b")?.result?.block.content, /未提供结果正文/);
  reducer.apply(notification("a", "failed"), true);
  agents = index(reducer.state.blocks).agentByTaskId;
  assert.equal(agents.size, 2);
  assert.equal(agents.get("a")?.result?.block.is_error, true);
  assert.equal(agents.get("b")?.result?.block.is_error, false);
  assert.equal(agents.get("b")?.blocks.filter(ref => ref.block.content === ack).length, 1, "retain original receipt as diagnostics");
  const count = reducer.state.blocks.length;
  assert.equal(reducer.apply(notification("b"), true), false);
  assert.equal(reducer.state.blocks.length, count, "duplicate notifications are idempotent");
});

test("Qoder: terminal events arriving in a later CLI turn still carry the original dispatch id", () => {
  const first = new ClaudeCliProtocolReducer(session);
  first.apply(dispatch("a"), true); first.apply(result("a"), true);
  const next = new ClaudeCliProtocolReducer({ ...session, messages: [{ role: "assistant", content: first.state.blocks }] });
  next.apply(notification("a"), true);
  const runs = collectAgentRuns([
    { role: "assistant", content: first.state.blocks },
    { role: "assistant", content: next.state.blocks },
  ]);
  assert.equal(runs.agents.length, 1);
  assert.equal(runs.agents[0].meta.taskDescription, "Inspect a");
  assert.equal(getAgentRunStatusSummary(runs.runs[0], settled).status, "completed");
  assert.equal(runs.agents[0].receipt, null);
});

test("Qoder: unknown statuses, missing correlation ids, task updates and parent prose never synthesize terminal results", () => {
  const reducer = new ClaudeCliProtocolReducer(session);
  for (const event of [
    { ...notification("a"), tool_use_id: undefined },
    notification("a", "running"), notification("a", "unknown"),
    { type: "system", subtype: "task_updated", task_id: "a", patch: { status: "completed" } },
    { type: "system", subtype: "background_tasks_changed", tasks: [] },
  ]) reducer.apply(event, true);
  assert.deepEqual(reducer.state.blocks, []);
  const claude = new ClaudeCliProtocolReducer({ ...session, provider: "claude", runner: "claude-cli-print" });
  claude.apply(notification("a"), true);
  assert.deepEqual(claude.state.blocks, [], "do not assume other providers use Qoder's notification contract");
});

test("Qoder: a real correlated result body takes precedence over native status summaries in either order", () => {
  for (const notifyFirst of [false, true]) {
    const reducer = new ClaudeCliProtocolReducer(session);
    reducer.apply(dispatch("a"), true); reducer.apply(result("a"), true);
    if (notifyFirst) reducer.apply(notification("a"), true);
    reducer.apply(result("a", "# Actual child result\n\nFull body"), true);
    if (!notifyFirst) reducer.apply(notification("a"), true);
    const agent = index(reducer.state.blocks).agents[0];
    assert.equal(agent.result?.block.content, "# Actual child result\n\nFull body");
    assert.equal(agent.receipt, null);
  }
});

test("Qoder: a late launch receipt cannot revert a native terminal notification", () => {
  const reducer = new ClaudeCliProtocolReducer(session);
  reducer.apply(dispatch("a"), true);
  reducer.apply(notification("a"), true);
  reducer.apply(result("a"), true);
  assert.equal(getAgentRunStatusSummary(index(reducer.state.blocks).runs[0], settled).status, "completed");
  assert.equal(index(reducer.state.blocks).agents[0].receipt, null);
});

test("Qoder: background shell notifications and uncorrelated native ids do not become subagents", () => {
  const reducer = new ClaudeCliProtocolReducer(session);
  reducer.apply({ type: "assistant", message: { id: "bash", content: [{ type: "tool_use", id: "shell", name: "Bash", input: { command: "pwd" } }] } }, true);
  reducer.apply(notification("shell"), true);
  reducer.apply(notification("missing-agent"), true);
  assert.equal(index(reducer.state.blocks).agents.length, 0);
  assert.equal(reducer.state.blocks.filter(block => block.type === "tool_result").length, 0);
});

test("Qoder replay uses the same native terminal projection as live reduction", () => {
  const events = [dispatch("a"), result("a"), notification("a")];
  const liveReducer = new ClaudeCliProtocolReducer(session);
  const replay = buildReplayProcessor(session);
  for (const event of events) { liveReducer.apply(event, true); replay.feed(JSON.stringify(event)); }
  assert.deepEqual(replay.state.blocks, liveReducer.state.blocks);
  assert.equal(getAgentRunStatusSummary(index(replay.state.blocks).runs[0], settled).status, "completed");
});
