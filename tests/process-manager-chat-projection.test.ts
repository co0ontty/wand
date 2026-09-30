import assert from "node:assert/strict";
import test from "node:test";
import { ClaudePtyBridge } from "../src/claude-pty-bridge.js";
import { ProcessManager } from "../src/process-manager.js";
import type { ConversationTurn, ProcessEvent, SessionEvent } from "../src/types.js";

function harness(t: test.TestContext) {
  const initial: ConversationTurn[] = [
    { role: "user", content: [{ type: "text", text: "old prompt" }] },
    { role: "assistant", content: [{ type: "text", text: "a much longer older answer" }] },
  ];
  const bridge = new ClaudePtyBridge({ sessionId: "fixture", initialMessages: initial, isClaudeCommand: true });
  const events: ProcessEvent[] = [];
  // Exercise the real bridge -> ProcessManager projection without spawning a CLI.
  const manager = Object.assign(Object.create(ProcessManager.prototype), {
    config: { cardDefaults: {} }, emitEvent: (event: ProcessEvent) => events.push(structuredClone(event)), persist: () => {},
  }) as any;
  const record = { id: "fixture", status: "running", output: "", ptyBridge: bridge, pendingEscalation: null,
    ptyPermissionBlocked: false, ptyBusy: false, rememberedEscalationScopes: new Set(), rememberedEscalationTargets: new Set() };
  bridge.on("event", (event: SessionEvent) => manager.handleBridgeEvent(record, event));
  t.after(() => { bridge.onExit(0); bridge.removeAllListeners(); });
  return { bridge, events, record, outputs: () => events.filter(e => e.type === "output" && !(e.data as any)?.chunk) };
}

test("N1/R04: PTY new round publishes full user+assistant sequence while the process is running", (t) => {
  const h = harness(t); h.bridge.onUserInput("second prompt");
  const data = h.outputs().at(-1)?.data as any;
  assert.equal(data.incremental, undefined); assert.equal(data.messages.length, 4);
  assert.equal(data.messages[1].content[0].text, "a much longer older answer");
  assert.equal(data.messages[2].content[0].text, "second prompt"); assert.equal(h.record.status, "running");
});

test("PTY ordinary token revisions remain incremental after a sequence boundary", (t) => {
  const h = harness(t); h.bridge.onUserInput("second prompt");
  (h.bridge as any).chatState.buffer = "new short reply";
  (h.bridge as any).updateAssistantContent();
  const data = h.outputs().at(-1)?.data as any;
  assert.equal(data.incremental, true); assert.equal(data.messageCount, 4); assert.equal(data.lastMessage.content[0].text, "new short reply");
});

test("N1: turn completion converges with a full payload even when the PTY process remains running", (t) => {
  const h = harness(t); h.bridge.onUserInput("second prompt");
  (h.bridge as any).chatState.buffer = "new short reply";
  (h.bridge as any).finalizeResponse();
  const data = h.outputs().at(-1)?.data as any;
  assert.equal(data.incremental, undefined); assert.equal(data.isResponding, false);
  assert.equal(data.messages.length, 4); assert.ok(data.messages[3].completedAt); assert.equal(h.record.status, "running");
});

test("PTY completion removing an empty placeholder publishes the actual turn count", (t) => {
  const h = harness(t); h.bridge.onUserInput("second prompt"); (h.bridge as any).finalizeResponse();
  const data = h.outputs().at(-1)?.data as any;
  assert.equal(data.incremental, undefined); assert.equal(data.messages.length, 3); assert.equal(data.messages[2].role, "user");
});

test("a next input disarms the previous round's scheduled token callback", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(t); h.bridge.onUserInput("second prompt");
  (h.bridge as any).lastChatEmitAt = Date.now(); (h.bridge as any).chatState.buffer = "second reply";
  (h.bridge as any).updateAssistantContent(); h.bridge.onUserInput("third prompt");
  const count = h.events.length; t.mock.timers.tick(100);
  assert.equal(h.events.length, count, "an old deadline must not publish the new round early");
  assert.equal((h.outputs().at(-1)?.data as any).messages.length, 6);
});

test("a scheduled token callback cannot publish responding=true after completion", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness(t); h.bridge.onUserInput("second prompt");
  (h.bridge as any).lastChatEmitAt = Date.now(); (h.bridge as any).chatState.buffer = "reply";
  (h.bridge as any).updateAssistantContent(); (h.bridge as any).finalizeResponse();
  const count = h.events.length; t.mock.timers.tick(100);
  assert.equal(h.events.length, count, "a completed turn must not be reopened by an old throttle callback");
});
