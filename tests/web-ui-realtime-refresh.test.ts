import assert from "node:assert/strict";
import test from "node:test";
import { createRealtimeRenderHarness, createRealtimeSessionHarness, jsonValue, textTurn } from "./helpers/realtime-refresh-harness.js";

for (const [name, initial, revised] of [
  ["text", { type: "text", text: "AAAA" }, { type: "text", text: "BBBB" }],
  ["thinking", { type: "thinking", thinking: "AAAA" }, { type: "thinking", thinking: "BBBB" }],
  ["tool input", { type: "tool_use", id: "tool", input: { nested: { path: "AAAA" } } }, { type: "tool_use", id: "tool", input: { nested: { path: "BBBB" } } }],
  ["nested result", { type: "tool_result", tool_use_id: "tool", content: [{ type: "text", text: "AAAA" }] }, { type: "tool_result", tool_use_id: "tool", content: [{ type: "text", text: "BBBB" }] }],
] as const) {
  test(`R01: equal-length ${name} revision updates the existing row`, () => {
    const h = createRealtimeRenderHarness();
    h.setMessages([{ role: "assistant", content: [initial] }]); h.chat.doRenderChat(false);
    const writes = h.fullWrites(); h.rendered.length = 0;
    h.setMessages([{ role: "assistant", content: [revised] }]); h.chat.doRenderChat(false);
    assert.match(h.bodyAt(0), /BBBB/);
    assert.equal(h.fullWrites(), writes, "must update a row, not replace the entire history");
    assert.deepEqual(h.rendered, [0]);
  });
}

for (const together of [false, true]) {
  test(`R02: a turn beyond the last four updates${together ? " together with the tail" : " alone"}`, () => {
    const h = createRealtimeRenderHarness(); const turns = Array.from({ length: 12 }, (_, i) => textTurn(`row-${i}`));
    h.setMessages(turns); h.chat.doRenderChat(false); const writes = h.fullWrites();
    const next = turns.slice(); next[0] = textTurn("older-now-correct"); if (together) next[11] = textTurn("tail-now-correct");
    h.setMessages(next); h.chat.doRenderChat(false); h.chat.doRenderChat(false);
    assert.match(h.bodyAt(0), /older-now-correct/);
    if (together) assert.match(h.bodyAt(11), /tail-now-correct/);
    assert.equal(h.fullWrites(), writes);
  });
}

test("R01/R02: equal additions and removals cannot cancel semantic changes", () => {
  const h = createRealtimeRenderHarness(); h.setMessages([textTurn("aaaa"), textTurn("bb")]); h.chat.doRenderChat(false);
  h.setMessages([textTurn("a"), textTurn("bbbbb")]); h.chat.doRenderChat(false);
  assert.match(h.bodyAt(0), /"text":"a"/); assert.match(h.bodyAt(1), /bbbbb/);
});

test("completion, errors and equal-sum usage values invalidate the affected row", () => {
  const h = createRealtimeRenderHarness(); h.setMessages([textTurn("done", "assistant", { usage: { inputTokens: 2, outputTokens: 3 } })]); h.chat.doRenderChat(false);
  h.setMessages([textTurn("done", "assistant", { completedAt: "2026-09-30T00:01:00Z", error: "failed", usage: { inputTokens: 3, outputTokens: 2 } })]);
  h.chat.doRenderChat(false); assert.match(h.bodyAt(0), /00:01:00Z/); assert.match(h.bodyAt(0), /failed/); assert.match(h.bodyAt(0), /"inputTokens":3/);
});

test("a changed earlier usage updates the last assistant cumulative usage in the round", () => {
  const h = createRealtimeRenderHarness(); const old = [textTurn("q", "user"), textTurn("a", "assistant", { usage: { outputTokens: 2 } }), ...Array.from({ length: 8 }, () => textTurn("tail"))];
  h.setMessages(old); h.chat.doRenderChat(false); const next = old.slice(); next[1] = textTurn("a", "assistant", { usage: { outputTokens: 7 } });
  h.setMessages(next); h.chat.doRenderChat(false); assert.match(h.bodyAt(9), /"outputTokens":7/);
});

test("a cross-turn tool result revision updates its older tool-use row", () => {
  const h = createRealtimeRenderHarness(); const old = [{ role: "assistant", content: [{ type: "tool_use", id: "tool", name: "Read", input: { path: "fixture" } }] },
    ...Array.from({ length: 8 }, () => textTurn("middle")), { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: [{ type: "text", text: "AAAA" }] }] }];
  h.setMessages(old); h.chat.doRenderChat(false); const next = old.slice(); next[9] = { ...old[9], content: [{ type: "tool_result", tool_use_id: "tool", content: [{ type: "text", text: "BBBB" }] }] };
  h.setMessages(next); h.chat.doRenderChat(false); assert.match(h.bodyAt(0), /BBBB/);
});

test("R06: RAF failure releases pending, reports the error and allows a later render", () => {
  const h = createRealtimeRenderHarness(); h.setMessages([textTurn("first")]); h.failNextWrite(); h.chat.renderChat(); h.flush();
  assert.equal(h.state.renderPending, false); assert.equal(h.errors.length, 1);
  h.chat.renderChat(); h.flush(); assert.match(h.bodyAt(0), /first/);
});

test("R06: synchronous failure also releases pending without adding UI feedback", () => {
  const h = createRealtimeRenderHarness(); h.setMessages([textTurn("first")]); h.failNextWrite();
  try { h.chat.renderChat(true); } catch { /* old code throws: pending assertion still fails */ }
  assert.equal(h.state.renderPending, false); assert.equal(h.errors.length, 1);
  h.chat.renderChat(); h.flush(); assert.match(h.bodyAt(0), /first/);
});

test("a failed partial render does not commit a signature or suppress the retry", () => {
  const h = createRealtimeRenderHarness(); h.setMessages([textTurn("old")]); h.chat.doRenderChat(false);
  h.setMessages([textTurn("a revised longer body")]); h.failNextWrite();
  assert.throws(() => h.chat.doRenderChat(false), /injected/);
  h.chat.doRenderChat(false); assert.match(h.bodyAt(0), /a revised longer body/);
});

test("R06: a partially mutated DOM is repainted even if the next state equals the old cache", () => {
  const h = createRealtimeRenderHarness(); const original = [textTurn("old first"), textTurn("old second")];
  h.setMessages(original); h.chat.doRenderChat(false);
  h.setMessages([textTurn("new first"), textTurn("new second")]); h.failReplacementAfter(1);
  h.chat.renderChat(); h.flush();
  assert.equal(h.state.renderPending, false); assert.equal(h.errors.length, 1);
  assert.ok(h.bodyAt(0).includes("new first"), "the failure occurred after one DOM mutation");
  h.setMessages(original); h.chat.renderChat(); h.flush();
  assert.ok(h.bodyAt(0).includes("old first")); assert.ok(h.bodyAt(1).includes("old second"));
});

test("R06: a failed post-write phase cannot leave the empty-state cache valid", () => {
  const h = createRealtimeRenderHarness(); h.setMessages([]); h.chat.doRenderChat(false);
  h.setMessages([textTurn("failed paint")]); h.failNextPostWrite();
  h.chat.renderChat(true); assert.equal(h.errors.length, 1);
  assert.ok(h.bodyAt(0).includes("failed paint"), "the full DOM write preceded the failure");
  h.setMessages([]); h.chat.renderChat(true);
  assert.equal(h.bodyAt(0), ""); assert.equal(h.state.renderPending, false);
});

test("R06: old A callbacks cannot draw B or release B's pending frame", () => {
  const h = createRealtimeRenderHarness(); h.setMessages([textTurn("A")]); h.chat.renderChat(); const old = h.frames.shift()!;
  h.state.selectedId = "B"; h.render.resetChatRenderCache(); h.setMessages([textTurn("B")]); h.chat.renderChat();
  old(); assert.equal(h.state.renderPending, true); assert.equal(h.rendered.length, 0);
  h.flush(); assert.match(h.bodyAt(0), /B/); assert.equal(h.state.renderPending, false);
});

test("R06: A-B-A does not resurrect an old A frame", () => {
  const h = createRealtimeRenderHarness(); h.setMessages([textTurn("old A")]); h.chat.renderChat(); const old = h.frames.shift()!;
  h.state.selectedId = "B"; h.render.resetChatRenderCache(); h.state.selectedId = "A"; h.render.resetChatRenderCache();
  h.setMessages([textTurn("new A")]); h.chat.renderChat(); old(); assert.equal(h.rendered.length, 0); h.flush(); assert.match(h.bodyAt(0), /new A/);
});

for (const offset of [0, 40]) {
  test(`R04: same-role count+2 requests one resync without fabricating turns (offset ${offset})`, () => {
    const h = createRealtimeSessionHarness(); const turns = [textTurn("q1", "user"), textTurn("a much longer older answer")];
    h.state.sessions = [{ id: "A", sessionKind: "structured", messages: turns, messageOffset: offset, messageTotal: offset + 2 }];
    const frame = { type: "output", sessionId: "A", seq: 1, data: { incremental: true, messageCount: offset + 4, lastMessage: textTurn("new") } };
    h.send(frame); h.send({ ...frame, seq: 2 });
    assert.equal(h.resyncs().length, 1); assert.deepEqual(jsonValue(h.state.sessions[0].messages), turns);
    assert.equal(h.state.sessions[0].messageTotal, offset + 2);
    h.send({ type: "init", sessionId: "A", seq: 3, data: { id: "A", sessionKind: "structured", messages: [...turns, textTurn("q2", "user"), textTurn("new")], messageOffset: offset, messageTotal: offset + 4 } });
    assert.equal(h.state.sessions[0].messages.length, 4); assert.equal(h.state.currentMessages.length, 4);
  });
}

test("R04: count+1 appends even when both tails are assistants", () => {
  const h = createRealtimeSessionHarness(); h.state.sessions = [{ id: "A", sessionKind: "structured", messages: [textTurn("old")], messageOffset: 5, messageTotal: 6 }];
  h.send({ type: "output", sessionId: "A", seq: 1, data: { incremental: true, messageCount: 7, lastMessage: textTurn("new") } });
  assert.deepEqual(jsonValue(h.state.sessions[0].messages.map((m: any) => m.content[0].text)), ["old", "new"]);
});

for (const kind of ["output", "ended"]) {
  test(`R03/R05: ordered ${kind} accepts a short final revision and projects it`, () => {
    const h = createRealtimeSessionHarness(); h.state.sessions = [{ id: "A", sessionKind: "structured", messages: [textTurn("old longer answer")], messageOffset: 0, messageTotal: 1 }];
    h.state.currentMessages = h.state.sessions[0].messages;
    const final = textTurn("new", "assistant", { completedAt: "2026-09-30T00:01:00Z", usage: { outputTokens: 7 } });
    h.send({ type: kind, sessionId: "A", seq: 1, data: { messages: [final], messageOffset: 0, messageTotal: 1, status: "exited", structuredState: { inFlight: false }, queuedMessages: [] } });
    assert.deepEqual(jsonValue(h.state.sessions[0].messages[0]), final);
    assert.deepEqual(jsonValue(h.state.currentMessages[0]), final);
  });
}

test("R03: an uncontested HTTP detail can accept a shorter authoritative revision", async () => {
  const h = createRealtimeSessionHarness(); h.state.sessions = [{ id: "A", sessionKind: "structured", messages: [textTurn("old longer")], messageOffset: 0, messageTotal: 1 }];
  const read = h.engine.loadOutput("A"); h.respond(0, { id: "A", sessionKind: "structured", messages: [textTurn("new")], messageOffset: 0, messageTotal: 1 }); await read;
  assert.equal(h.state.currentMessages[0].content[0].text, "new");
});

test("R03: HTTP started before a live push cannot restore old body, cursor, state, queue or permissions", async () => {
  const h = createRealtimeSessionHarness(); h.state.sessions = [{ id: "A", sessionKind: "structured", messages: [textTurn("before")], messageOffset: 0, messageTotal: 1 }];
  const read = h.engine.loadOutput("A");
  h.send({ type: "output", sessionId: "A", seq: 1, data: { messages: [textTurn("new")], messageOffset: 0, messageTotal: 1, leadingBlockOffset: 0, leadingBlockTotal: 1, structuredState: { inFlight: false }, queuedMessages: [], permissionBlocked: false } });
  h.send({ type: "status", sessionId: "A", data: { status: "exited", permissionBlocked: false, queuedMessages: [] } });
  h.respond(0, { id: "A", sessionKind: "structured", messages: [textTurn("stale much longer")], messageOffset: 0, messageTotal: 1, leadingBlockOffset: 1, leadingBlockTotal: 2, status: "running", structuredState: { inFlight: true }, queuedMessages: ["stale"], permissionBlocked: true }); await read;
  const s = h.state.sessions[0]; assert.equal(s.messages[0].content[0].text, "new"); assert.equal(s.status, "exited"); assert.equal(s.structuredState.inFlight, false);
  assert.equal(s.leadingBlockOffset, 0); assert.equal(s.permissionBlocked, false); assert.equal(s.queuedMessages.length, 0);
});

test("obsolete socket frames cannot overwrite new socket content, status or queue", () => {
  const h = createRealtimeSessionHarness(); h.state.sessions = [{ id: "A", sessionKind: "structured", messages: [] }]; const obsolete = h.socket.onmessage!;
  h.ws.forceReconnectWebSocket("test"); const replacement = h.sockets[1]; replacement.readyState = 1; replacement.onopen!();
  h.send({ type: "init", sessionId: "A", seq: 1, data: { id: "A", messages: [textTurn("current")], status: "idle", queuedMessages: [] } }, replacement);
  obsolete({ data: JSON.stringify({ type: "output", sessionId: "A", seq: 99, data: { messages: [textTurn("obsolete longer")], queuedMessages: ["old"] } }) });
  assert.equal(h.state.sessions[0].messages[0].content[0].text, "current"); assert.equal(h.state.sessions[0].queuedMessages.length, 0);
});
