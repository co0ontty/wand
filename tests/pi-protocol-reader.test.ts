import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { MAX_PROTOCOL_LINE_BYTES } from "../src/bounded-process-output.js";
import { PiProtocolReader } from "../src/pi-protocol-reader.js";
import { projectPiProtocolEvent } from "../src/pi-event-projection.js";
import { PiRunner } from "../src/structured-pi-adapter.js";
import type { SessionSnapshot } from "../src/types.js";

const assistant = (text = "最终答复🙂", stopReason = "stop") => ({ role: "assistant", model: "fixture",
  content: [{ type: "text", text }], stopReason, usage: { input: 123, output: 7, cost: { total: 0 } },
  ...(stopReason === "error" ? { errorMessage: text } : {}) });
const large = "x".repeat(MAX_PROTOCOL_LINE_BYTES + 123);

function read(raw: string, chunk = 16381): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const reader = new PiProtocolReader((line) => events.push(JSON.parse(line)));
  for (let offset = 0; offset < raw.length; offset += chunk) reader.push(raw.slice(offset, offset + chunk));
  reader.finish();
  return events;
}

function runner() {
  let kills = 0;
  const child = Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new PassThrough(), kill() { kills++; child.emit("close", 0, null); return true; } });
  const pi = new PiRunner((() => child as unknown as ChildProcess) as typeof spawn);
  const session = { id: "large-pi", provider: "pi", cwd: process.cwd(), claudeSessionId: null } as SessionSnapshot;
  const run = pi.start({ session, prompt: "fixture only", env: {} }, { isActive: () => true, onUpdate() {} });
  return { child, run, kills: () => kills };
}

// The latest Pi turn_end contains context in addition to message/toolResults.
// Context is an authoritative CLI snapshot, not new assistant/tool output.
test("Pi turn_end discards >8 MiB context/toolResults but keeps the complete assistant and following event", () => {
  const event = { context: { messages: [{ role: "toolResult", content: [{ type: "image", data: large }] }] },
    toolResults: [{ content: large }], message: assistant(), type: "turn_end" };
  const events = read(JSON.stringify(event) + "\r\n" + JSON.stringify({ type: "session_shutdown" }));
  assert.deepEqual(events, [{ message: assistant(), type: "turn_end" }, { type: "session_shutdown" }]);
  assert.ok(JSON.stringify(events).length < 1024);
});

test("Pi agent_end streams a single huge tool member even with role/type after its payload", () => {
  const messages = [{ content: [{ type: "text", text: large }], role: "toolResult" }, assistant("earlier"), assistant()];
  assert.deepEqual(read(JSON.stringify({ messages, type: "agent_end" })), [{ messages: [assistant()], type: "agent_end" }]);
});

test("agent_end memory is per-message, not cumulative assistant history", () => {
  const messages = Array.from({ length: 25 }, (_, i) => assistant(String(i) + "x".repeat(400_000)));
  const events = read(JSON.stringify({ type: "agent_end", messages }));
  assert.deepEqual((events[0].messages as unknown[]), [messages.at(-1)]);
});

test("projection works across every syntax/escape boundary and does not guess types inside nested JSON", () => {
  const message = assistant('中\n文\\"🙂\u0001');
  const raw = JSON.stringify({ context: { type: "agent_end", messages: [assistant("not the reply")] },
    messages: [{ role: "toolResult", content: "ignored" }, message], type: "agent_end" });
  assert.deepEqual(read(raw, 1), [{ messages: [message], type: "agent_end" }]);
  assert.deepEqual(read(" \n" + JSON.stringify({ type: "turn_end", message }) + "\n\n", 1), [{ type: "turn_end", message }]);
});

test("retained Pi events preserve JSON types, tool arguments and inline images", () => {
  const event = { type: "tool_execution_end", toolCallId: "tool", isError: true,
    result: { content: [{ type: "image", data: "AAA=", mimeType: "image/png" }], details: {
      count: -1.5e-10, enabled: true, empty: null, list: [false, 0, ""], __proto__: null } } };
  const parsed = read(JSON.stringify(event), 1)[0];
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(event)));
  const prototype = read('{"type":"tool_execution_start","args":{"__proto__":{"polluted":true}}}', 1)[0];
  assert.equal(Object.prototype.hasOwnProperty.call(prototype.args, "__proto__"), true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("truncated/malformed ignored histories cannot turn into a successful completed event", () => {
  for (const raw of [
    '{"type":"agent_end","messages":[' + JSON.stringify(assistant()) + ',{"role":"toolResult","content":"' + large,
    '{"type":"turn_end","message":' + JSON.stringify(assistant()) + ',"context":{"data":"' + large + '\\q"}}',
    '{"type":"turn_end","context":[1,],"message":' + JSON.stringify(assistant()) + '}',
    '{"type":"agent_end","messages":[]}garbage',
  ]) {
    let published = 0;
    const reader = new PiProtocolReader(() => published++);
    assert.throws(() => { reader.push(raw); reader.finish(); });
    assert.equal(published, 0, "only a fully validated event crosses the reducer boundary");
  }
});

test("only the incomplete first record of an explicitly truncated replay may be ignored", () => {
  const lines: string[] = [];
  const reader = new PiProtocolReader((line) => lines.push(line), { truncatedHead: true });
  reader.push('{"type":"tool_execution_start","toolCa\n');
  reader.push(JSON.stringify({ type: "message_end", message: assistant("terminal refusal", "error") }) + "\n");
  assert.equal(lines.length, 1);
  assert.equal((JSON.parse(lines[0]).message as Record<string, unknown>).errorMessage, "terminal refusal");
  assert.throws(() => { reader.push('{"type":"turn_end","context":'); reader.finish(); });
  const complete = new PiProtocolReader((line) => lines.push(line), { truncatedHead: true });
  complete.push(JSON.stringify({ type: "message_end", message: assistant("first refusal", "error") }) + "\n");
  complete.finish();
  assert.equal((JSON.parse(lines.at(-1)!).message as Record<string, unknown>).errorMessage, "first refusal");
});

test("bounded non-JSON stdout remains diagnostic noise and does not masquerade as a safe refusal", () => {
  const lines: string[] = [];
  const reader = new PiProtocolReader((line) => lines.push(line));
  reader.push('extension diagnostic\n{"type":"session","id":"next"}\n');
  reader.finish();
  assert.deepEqual(lines, ["extension diagnostic", '{"type":"session","id":"next"}']);
  assert.throws(() => read(large), /8 MiB/);
});

test("genuine huge assistant/tool payloads, giant keys and deep ignored contexts remain bounded", () => {
  assert.throws(() => read(JSON.stringify({ type: "agent_end", messages: [assistant(large)] })), /8 MiB/);
  assert.throws(() => read(JSON.stringify({ type: "message_end", message: assistant(large) })), /8 MiB/);
  assert.throws(() => read(JSON.stringify({ type: "tool_execution_end", result: { content: large } })), /8 MiB/);
  assert.throws(() => read(JSON.stringify({ type: "turn_end", context: { ["a".repeat(2000)]: 1 } })), /属性名/);
  assert.throws(() => read('{"type":"turn_end","context":' + '['.repeat(130) + '0' + ']'.repeat(130) + '}'), /深度/);
  assert.throws(() => read(JSON.stringify({ type: "unknown_future_event", context: large })), /非汇总事件/);
});

test("native source projection removes cumulative histories before serialization, without losing final errors", () => {
  const event = { type: "agent_end", messages: [{ role: "toolResult", content: large }, assistant(), assistant("late error", "error")],
    context: { messages: large }, entries: [large] };
  assert.deepEqual(projectPiProtocolEvent(event), { type: "agent_end", messages: [assistant("late error", "error")] });
  assert.deepEqual(projectPiProtocolEvent({ type: "turn_end", message: assistant(), context: large, toolResults: [large] }),
    { type: "turn_end", message: assistant() });
});

test("PiRunner accepts huge redundant summaries through its actual file/pump path with split UTF-8", async () => {
  const f = runner();
  const message = assistant();
  const bytes = Buffer.from(JSON.stringify({ type: "session", id: "native-id" }) + "\n"
    + JSON.stringify({ type: "turn_end", message, context: { data: large } }) + "\n"
    + JSON.stringify({ type: "agent_end", messages: [{ role: "toolResult", content: large }, message] }));
  for (let offset = 0; offset < bytes.length; offset += 16381) f.child.stdout.emit("data", bytes.subarray(offset, offset + 16381));
  f.child.emit("close", 0, null);
  const result = await f.run.completion;
  assert.equal(result.exitCode, 0);
  assert.equal(result.primaryError, null);
  assert.equal(result.state.result, message.content[0].text);
  assert.equal(result.state.sessionId, "native-id");
  assert.equal(result.state.usage?.inputTokens, 123);
  assert.equal(f.kills(), 0);
});

test("summary-only failures and final errors survive oversized history and exit code zero", async () => {
  const f = runner();
  f.child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "agent_end", messages: [assistant(),
    { role: "toolResult", content: large }, assistant("final provider error", "error")] }) + "\n"));
  f.child.emit("close", 0, null);
  const result = await f.run.completion;
  assert.equal(result.primaryError, "final provider error");
  assert.equal(result.rejection, undefined, "completed content is evidence of progress, not a safe pre-execution refusal");
});

test("malformed/oversized real payload stops once even with synchronous close and never reports input rejected", async () => {
  for (const raw of [JSON.stringify({ type: "message_end", message: assistant(large) }) + "\n",
    '{"type":"turn_end","message":' + JSON.stringify(assistant()) + ',"context":"' + large]) {
    const f = runner();
    f.child.stdout.emit("data", Buffer.from(raw));
    f.child.emit("close", 0, null);
    const result = await f.run.completion;
    assert.equal(result.exitCode, 1);
    assert.equal(result.retryForbidden, true);
    assert.equal(result.failure?.delivery, "unknown");
    assert.notEqual(result.inputAccepted, false);
    assert.equal(f.kills(), 1);
  }
});
