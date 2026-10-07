import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyCoreAgentEvent } from "../src/core-runner.js";
import { applyPiEvent } from "../src/structured-pi-adapter.js";
import type { StructuredRunnerAdapter, StructuredRunnerTurnState } from "../src/structured-runner.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";
import { defaultConfig } from "../src/config.js";
import { toSessionDetailDTO } from "../src/session-transport.js";
import { formatThinkingElapsed } from "../src/web-ui/browser/tool-activity.js";

const start = "2026-10-06T05:00:00.000Z";
const later = "2026-10-06T05:01:00.000Z";
const thinkingEvent = (type: string, content?: string) => ({
  type: "message_update", assistantMessageEvent: { type, content },
});
const turn = (): StructuredRunnerTurnState => ({ blocks: [], result: "", sessionId: null });

test("Pi reasoning boundaries keep one timed live placeholder and update its activity", () => {
  const state = turn();
  applyPiEvent(state, thinkingEvent("thinking_start"), start);
  // 进行中那一轮只有占位，边界到达后仍带着首次观察时间。
  applyPiEvent(state, thinkingEvent("thinking_end", ""), later);
  applyPiEvent(state, thinkingEvent("thinking_start"), later);
  assert.deepEqual(state.blocks, [{ type: "thinking", thinking: "", occurredAt: later, lastActivityAt: later }]);
  assert.equal(state.phase, "responding");
  assert.equal(state.result, "");
  applyPiEvent(state, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "visible thought" } }, later);
  assert.equal(state.blocks.length, 1);
  assert.equal(state.blocks[0].type === "thinking" && state.blocks[0].thinking, "visible thought");
  applyPiEvent(state, { type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {} });
  applyPiEvent(state, { type: "tool_execution_end", toolCallId: "read-1", result: "done" });
  applyPiEvent(state, thinkingEvent("thinking_start"), later);
  assert.deepEqual(state.blocks.at(-1), { type: "thinking", thinking: "", occurredAt: later, lastActivityAt: later });
  applyPiEvent(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "reply" } }, later);
  assert.deepEqual(state.blocks.at(-1), { type: "text", text: "reply" });
});

test("a reasoning round that never produces text leaves no entry behind", () => {
  const state = turn();
  applyPiEvent(state, thinkingEvent("thinking_start"), start);
  applyPiEvent(state, thinkingEvent("thinking_end", ""), later);
  // 只发了边界、正文始终为空：它不是一轮思考，时间线上不该有一条永远读不到内容的条目。
  assert.deepEqual(state.blocks, []);
  // 下一轮真正写出正文时才是第一条轮次，且不继承上一轮的时间。
  applyPiEvent(state, thinkingEvent("thinking_start"), later);
  applyPiEvent(state, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "real" } }, later);
  assert.equal(state.blocks.length, 1);
  assert.equal(state.blocks[0].type === "thinking" && state.blocks[0].thinking, "real");
  // 消息结束时正文里没有思考内容，同样不留下空占位。
  applyPiEvent(state, { type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop",
  } }, later);
  assert.deepEqual(state.blocks.map(block => block.type), ["thinking", "text"]);
  applyPiEvent(state, thinkingEvent("thinking_start"), later);
  applyPiEvent(state, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "more" }] } }, later);
  assert.deepEqual(state.blocks.map(block => block.type), ["thinking", "text"]);
});

test("Pi fills a streaming placeholder from the complete message instead of dropping it", () => {
  const state = turn();
  applyPiEvent(state, thinkingEvent("thinking_start"), start);
  applyPiEvent(state, { type: "message_end", message: {
    role: "assistant", content: [{ type: "thinking", thinking: "只有完整消息里有正文" }], stopReason: "stop",
  } }, later);
  assert.deepEqual(state.blocks, [
    { type: "thinking", thinking: "只有完整消息里有正文", occurredAt: start, lastActivityAt: start },
  ]);
  // 流式增量只到一半时，更长的完整正文为准。
  const partial = turn();
  applyPiEvent(partial, thinkingEvent("thinking_start"), start);
  applyPiEvent(partial, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "半截" } }, later);
  applyPiEvent(partial, { type: "message_end", message: {
    role: "assistant", content: [{ type: "thinking", thinking: "半截但完整的这一轮推理正文" }], stopReason: "stop",
  } }, later);
  assert.equal(partial.blocks.length, 1);
  assert.equal(partial.blocks[0].type === "thinking" && partial.blocks[0].thinking, "半截但完整的这一轮推理正文");
});

test("Core reasoning boundaries also publish activity without visible reasoning text", () => {
  const state = turn();
  applyCoreAgentEvent(state, thinkingEvent("thinking_start"));
  applyCoreAgentEvent(state, thinkingEvent("thinking_end", ""));
  assert.deepEqual(state.blocks, [], "an empty Core round is not an entry either");
  applyCoreAgentEvent(state, thinkingEvent("thinking_start"));
  applyCoreAgentEvent(state, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "visible reasoning" } });
  const block = state.blocks.at(-1);
  assert.equal(state.blocks.length, 1);
  assert.equal(block?.type, "thinking");
  if (block?.type !== "thinking") return;
  assert.equal(block.thinking, "visible reasoning");
  assert.ok(Number.isFinite(Date.parse(block.occurredAt!)));
  assert.ok(Number.isFinite(Date.parse(block.lastActivityAt!)));
});

test("Pi historical replay does not invent a recent reasoning timestamp", () => {
  const state = turn();
  applyPiEvent(state, thinkingEvent("thinking_start"));
  applyPiEvent(state, thinkingEvent("thinking_end", ""));
  assert.deepEqual(state.blocks, []);
});

test("reasoning elapsed distinguishes silence from total duration without claiming failure", () => {
  const now = Date.parse("2026-10-06T05:02:00.000Z");
  assert.equal(formatThinkingElapsed(start, "2026-10-06T05:01:01.000Z", now), "思考 02:00");
  assert.equal(formatThinkingElapsed(start, later, now), "思考 02:00 · 01:00无新进展");
  assert.equal(formatThinkingElapsed(start, undefined, now), "思考 02:00");
  assert.equal(formatThinkingElapsed("invalid", later, now), "");
  assert.equal(formatThinkingElapsed(start, later, Date.parse(start) - 1000), "思考 00:00");
});

test("Pi empty thinking reaches live DTO and storage; completion clears live activity", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-thinking-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const state = turn();
  let publish: (() => void) | undefined;
  let finish: (() => void) | undefined;
  const runner: StructuredRunnerAdapter = {
    start(_context, observer) {
      const completion = new Promise<Awaited<ReturnType<StructuredRunnerAdapter["start"]>["completion"]>>(resolve => {
        publish = () => { applyPiEvent(state, thinkingEvent("thinking_start"), start); observer.onUpdate(state); };
        finish = () => resolve({ state, exitCode: 0, signal: null, stderr: "", primaryError: null });
      });
      return { args: [], pid: null, spawnedAt: start, completion, interrupt() { finish?.(); } };
    },
  };
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root }, null, { pi: runner });
  t.after(() => { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  const session = manager.createSession({ cwd: root, mode: "assist", provider: "pi" });
  manager.setSessionTopic(session.id, "test", "test");
  const pending = manager.sendMessage(session.id, "explicit test double");
  await Promise.resolve();
  assert.ok(publish);
  publish();
  const live = manager.get(session.id)!;
  assert.equal(live.structuredState?.inFlight, true);
  assert.equal(toSessionDetailDTO(live, { messages: live.messages }).messages?.at(-1)?.content.at(-1)?.type, "thinking");
  assert.deepEqual(live.messages?.at(-1)?.content.at(-1), state.blocks.at(-1));
  finish!();
  const finished = await pending;
  assert.equal(finished.structuredState?.inFlight, false);
  assert.deepEqual(storage.getSession(session.id)?.messages?.at(-1)?.content.at(-1), state.blocks.at(-1));
});
