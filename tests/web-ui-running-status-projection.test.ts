import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBlock, ConversationTurn } from "../src/types.js";
import { computeRunningPhase, projectRunningStatus, runningStatusText, silenceNotice, type RunningActivityShape } from "../src/web-ui/running-activity.js";

const start = "2026-10-07T04:00:00Z";
const now = Date.parse(start) + 90_000;
const tool = (id = "t", name = "Bash"): ContentBlock => ({ type: "tool_use", id, name, input: { command: "SECRET COMMAND" }, activity: { kind: "run_command", label: "SECRET LABEL" } });
const assistant = (...content: ContentBlock[]): ConversationTurn => ({ role: "assistant", requestId: "req", content });
const source = (...messages: ConversationTurn[]): RunningActivityShape => ({ id: "s", structuredState: { inFlight: true, activeRequestId: "req", turnStartedAt: start }, messages });

test("active turn outranks queue; waiting and terminal facts outrank both", () => {
  const active = { ...source(), queuedMessages: ["next"] };
  assert.equal(computeRunningPhase(active), "executing");
  assert.equal(computeRunningPhase({ ...active, permissionBlocked: true }), "waiting");
  assert.equal(computeRunningPhase({ permissionBlocked: true, queuedMessages: ["next"] }), "waiting");
  assert.equal(projectRunningStatus({ ...active, status: "stopped" }).label, "已停止");
  assert.equal(projectRunningStatus({ ...active, status: "failed" }).label, "执行失败");
  assert.equal(runningStatusText({ ...active, status: "stopped" }, now), "已停止");
  assert.equal(runningStatusText({ ...active, archived: true }, now), "");
  assert.equal(runningStatusText({ queuedMessages: ["next"], turnStartedAt: start }, now), "已接收 · 排队中");
});

test("tool name/kind are factual; arguments, descriptions and labels never enter status", () => {
  const text = runningStatusText(source(assistant(tool())), now);
  assert.ok(text.includes("正在使用工具 · 运行命令 · Bash"));
  assert.ok(!text.includes("SECRET"));
  assert.ok(!runningStatusText(source(assistant(tool("t", "echo SECRET /tmp/file"))), now).includes("SECRET"));
});

test("results retire only their matching tool, including out of order and errors", () => {
  const result: ContentBlock = { type: "tool_result", tool_use_id: "b", content: "", is_error: true };
  assert.equal(projectRunningStatus(source(assistant(tool("a"), tool("b")), assistant(result))).toolId, "a");
  assert.equal(projectRunningStatus(source(assistant(result), assistant(tool("b")))).stage, "executing");
  assert.equal(projectRunningStatus(source({ ...assistant(tool()), completedAt: start })).stage, "tool");
  assert.equal(projectRunningStatus(source(assistant(tool("a"), tool("b")),
    { role: "user", requestId: "req", content: [result] })).toolId, "a");
});

test("output/thinking use block enums, never body words; tool completion does not revive old text", () => {
  assert.equal(projectRunningStatus(source(assistant({ type: "text", text: "失败、已完成、正在调用Bash" }))).stage, "output");
  assert.equal(projectRunningStatus(source(assistant({ type: "thinking", thinking: "done" }))).stage, "thinking");
  assert.equal(projectRunningStatus(source(assistant({ type: "text", text: "old" }, tool(), { type: "tool_result", tool_use_id: "t", content: "done" }))).stage, "executing");
  assert.equal(projectRunningStatus({ ...source(assistant(tool())), structuredState: { inFlight: true, phase: "background" } }).stage, "background");
});

test("old requests, foreign sessions, subagents and missing evidence fall back to generic execution", () => {
  assert.equal(projectRunningStatus(source({ ...assistant(tool()), requestId: "old" })).stage, "executing");
  assert.equal(projectRunningStatus(source({ ...assistant(tool()), author: { id: "x", name: "x", sessionId: "other" } })).stage, "executing");
  assert.equal(projectRunningStatus(source(assistant({ ...tool(), __subagent: { taskId: "child" } }))).stage, "executing");
  assert.equal(projectRunningStatus(source({ ...assistant(tool()), requestId: undefined })).stage, "executing");
  assert.equal(projectRunningStatus({ ...source(assistant(tool())), status: "running" }, true).stage, "executing");
  assert.equal(projectRunningStatus(source(assistant(tool()), { role: "user", requestId: "new", content: [{ type: "text", text: "new request" }] })).stage, "executing");
});

test("bare PTY cannot produce execution or silence; explicit pending question is waiting", () => {
  assert.equal(silenceNotice({ status: "running", lastActivityAt: start }, now), null);
  assert.equal(runningStatusText({ status: "running", lastActivityAt: start }, now), "");
  const question: ContentBlock = { type: "tool_use", id: "q", name: "AskUserQuestion", input: {}, semantic: { kind: "question_request", questions: [] } };
  assert.equal(projectRunningStatus(source(assistant(question))).stage, "waiting");
  assert.equal(projectRunningStatus(source({ ...assistant(question), completedAt: start })).stage, "waiting");
  assert.equal(projectRunningStatus(source({ ...assistant(question), completedAt: start },
    { role: "user", requestId: "req", content: [{ type: "tool_result", tool_use_id: "q", content: "answered" }] })).stage, "executing");
});
