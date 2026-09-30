import assert from "node:assert/strict";
import test from "node:test";
import { mergeBlockWindowedMessages, mergeWindowedMessages } from "../src/web-ui/browser/message-reconciliation.js";
import { ChatRenderCache } from "../src/web-ui/browser/chat-render-cache.js";
import { blockWindowMessagesForTransport, truncateMessagesForTransport } from "../src/message-truncator.js";
import { createRealtimeRenderHarness, createRealtimeSessionHarness, jsonValue, textTurn } from "./helpers/realtime-refresh-harness.js";

const texts = (turn: any) => turn.content.map((block: any) => block.text);
const blocks = (...values: string[]) => ({ role: "assistant", content: values.map(text => ({ type: "text", text })) });

test("R03: uncertain complete first-turn snapshots retain the body volume guard", () => {
  const local = { messages: [textTurn("a complete old answer")], messageOffset: 0, messageTotal: 1,
    leadingBlockOffset: 0, leadingBlockTotal: 1 };
  const result = mergeBlockWindowedMessages(local, [textTurn("short")], 0, 1, 0, 1);
  assert.equal(result.messages[0].content[0].text, "a complete old answer");
  assert.equal(result.leadingBlockOffset, 0);
});

test("R03: a proven-new complete first turn may shorten its text and block sequence", () => {
  const local = { messages: [blocks("old-long-first", "old-second", "old-last")], messageOffset: 0,
    messageTotal: 1, leadingBlockOffset: 0, leadingBlockTotal: 3 };
  const result = mergeBlockWindowedMessages(local, [blocks("new")], 0, 1, 0, 1, "latest");
  assert.deepEqual(texts(result.messages[0]), ["new"]);
  assert.equal(result.leadingBlockOffset, 0); assert.equal(result.leadingBlockTotal, 1);
});

test("R03: latest partial block ranges keep cached prefixes and accept shorter overlap", () => {
  const local = { messages: [blocks("prefix", "old-long-second", "old-long-last")], messageOffset: 4,
    messageTotal: 5, leadingBlockOffset: 0, leadingBlockTotal: 3 };
  const result = mergeBlockWindowedMessages(local, [blocks("new")], 4, 5, 2, 3, "latest");
  assert.deepEqual(texts(result.messages[0]), ["prefix", "old-long-second", "new"]);
  assert.equal(result.messageOffset, 4); assert.equal(result.leadingBlockOffset, 0);
});

test("R03: rolling 60-block windows preserve paged turns and all loaded first-turn blocks", () => {
  const old = Array.from({ length: 65 }, (_, i) => `block-${i}`);
  const local = { messages: [textTurn("paged prompt", "user"), blocks(...old)], messageOffset: 10,
    messageTotal: 12, leadingBlockOffset: 0, leadingBlockTotal: 1 };
  const incoming = [...old.slice(6), "new-last"];
  const result = mergeBlockWindowedMessages(local, [blocks(...incoming)], 11, 12, 6, 66, "latest");
  assert.equal(result.messageOffset, 10); assert.equal(result.messages[0], local.messages[0]);
  assert.deepEqual(texts(result.messages[1]), [...old.slice(0, 6), ...incoming]);
  assert.equal(result.leadingBlockOffset, 0); assert.equal(result.leadingBlockTotal, 1);
});

test("R03: block-window gaps never manufacture a complete cached turn", () => {
  const local = { messages: [blocks("prefix")], messageOffset: 4, messageTotal: 5,
    leadingBlockOffset: 0, leadingBlockTotal: 1 };
  const result = mergeBlockWindowedMessages(local, [blocks("last")], 4, 5, 4, 5, "latest");
  assert.deepEqual(texts(result.messages[0]), ["last"]);
  assert.equal(result.leadingBlockOffset, 4); assert.equal(result.leadingBlockTotal, 5);
});

test("R03/R05: latest full snapshots can remove an empty assistant or clear the body", () => {
  const local = { messages: [textTurn("q", "user"), { role: "assistant", content: [] }], messageOffset: 0, messageTotal: 2 };
  assert.deepEqual(mergeWindowedMessages(local, [local.messages[0]], 0, 1, "latest").messages, [local.messages[0]]);
  assert.equal(mergeWindowedMessages(local, [], 0, 0, "latest").messages.length, 0);
  assert.deepEqual(mergeWindowedMessages(local, [], 0, 0).messages, local.messages);
});

for (const status of ["exited", "error", "stopped"]) {
  test(`R05: a ${status} status final body rebuilds the selected projection`, () => {
    const h = createRealtimeSessionHarness();
    h.state.sessions = [{ id: "A", sessionKind: "structured", messages: [textTurn("older longer")], messageOffset: 0, messageTotal: 1 }];
    h.state.currentMessages = h.state.sessions[0].messages;
    const final = textTurn("new", "assistant", { completedAt: "2026-09-30T00:02:00Z" });
    h.send({ type: "status", sessionId: "A", data: { status, messages: [final], messageOffset: 0,
      messageTotal: 1, structuredState: { inFlight: false }, queuedMessages: [], permissionBlocked: false } });
    assert.deepEqual(jsonValue(h.state.currentMessages), [final]); assert.equal(h.errors.length, 0);
  });
}

test("R03/R04: duplicate and older socket sequence frames cannot regress a short latest body", () => {
  const h = createRealtimeSessionHarness(); h.state.sessions = [{ id: "A", sessionKind: "structured", messages: [] }];
  h.send({ type: "init", sessionId: "A", seq: 1, data: { id: "A", messages: [textTurn("old-long")], messageOffset: 0, messageTotal: 1 } });
  const frame = { type: "output", sessionId: "A", seq: 2, data: { incremental: true, messageCount: 1,
    lastMessage: textTurn("new"), queuedMessages: [], permissionBlocked: false } };
  h.send(frame); h.send({ ...frame, data: { ...frame.data, lastMessage: textTurn("duplicate-old-long"), queuedMessages: ["old"] } });
  h.send({ ...frame, seq: 1 });
  h.send({ type: "init", sessionId: "A", seq: 1, data: { id: "A", messages: [textTurn("old init longer")],
    messageOffset: 0, messageTotal: 1, queuedMessages: ["old"], permissionBlocked: true } });
  assert.equal(h.state.sessions[0].permissionBlocked, false);
  assert.equal(h.state.currentMessages[0].content[0].text, "new"); assert.equal(h.state.sessions[0].queuedMessages.length, 0);
});

test("R03: a delayed shorter HTTP response cannot regress a newer long final body", async () => {
  const h = createRealtimeSessionHarness(); h.state.sessions = [{ id: "A", sessionKind: "structured", messages: [] }];
  const read = h.engine.loadOutput("A");
  const latest = textTurn("new longer final answer", "assistant", { completedAt: "2026-09-30T00:03:00Z" });
  h.send({ type: "ended", sessionId: "A", data: { messages: [latest], messageOffset: 0,
    messageTotal: 1, status: "exited", structuredState: { inFlight: false }, queuedMessages: [], permissionBlocked: false } });
  h.respond(0, { id: "A", sessionKind: "structured", messages: [textTurn("old")], messageOffset: 0,
    messageTotal: 1, status: "running", structuredState: { inFlight: true }, queuedMessages: ["old"], permissionBlocked: true });
  await read;
  assert.deepEqual(jsonValue(h.state.currentMessages), [latest]);
  assert.equal(h.state.sessions[0].status, "exited"); assert.equal(h.state.sessions[0].permissionBlocked, false);
  assert.equal(h.state.sessions[0].queuedMessages.length, 0);
});

test("R03: HTTP ABA and a superseded response cannot overwrite the newest A view", async () => {
  const h = createRealtimeSessionHarness();
  h.state.sessions = ["A", "B"].map(id => ({ id, sessionKind: "structured", messages: [] }));
  const first = h.engine.loadOutput("A"); h.state.selectedId = "B";
  const second = h.engine.loadOutput("B"); h.state.selectedId = "A";
  const third = h.engine.loadOutput("A");
  h.respond(2, { id: "A", messages: [textTurn("new A")] }); await third;
  h.respond(0, { id: "A", messages: [textTurn("old A much longer")] });
  h.respond(1, { id: "B", messages: [textTurn("B")] }); await Promise.all([first, second]);
  assert.equal(h.state.currentMessages[0].content[0].text, "new A");
});

for (const type of ["init", "output", "ended"]) {
  test(`R03/N2-Web: ${type} accepts growing text despite normal tool-result truncation`, async () => {
    const h = createRealtimeSessionHarness();
    const mixed = (text: string): any => ({ role: "assistant", content: [
      { type: "tool_use", id: "read-fixture", name: "Read", input: { file_path: "fixture.txt" } },
      { type: "tool_result", tool_use_id: "read-fixture", content: "x".repeat(1_000) },
      { type: "text", text },
    ] });
    const prior = [textTurn("fixture question", "user"), ...truncateMessagesForTransport([mixed("start")], {}, 0)];
    const fresh = blockWindowMessagesForTransport([prior[0], mixed("start" + "n".repeat(45))], {}, 60);
    assert.equal((prior[1].content[1] as any).content.length, 1_000);
    assert.equal((fresh.messages[1].content[1] as any).content.length, 101);
    h.state.sessions = [{ id: "A", sessionKind: "structured", messages: prior,
      messageOffset: 0, messageTotal: 2, leadingBlockOffset: 0, leadingBlockTotal: 1 }];
    const read = h.engine.loadOutput("A");
    h.send({ type, sessionId: "A", seq: 1, data: { id: "A", ...fresh, status: "idle",
      structuredState: { inFlight: false }, queuedMessages: [], permissionBlocked: false } });
    assert.equal(h.state.currentMessages[1].content[2].text.length, 50);
    h.respond(0, { id: "A", sessionKind: "structured", messages: prior, messageOffset: 0,
      messageTotal: 2, leadingBlockOffset: 0, leadingBlockTotal: 1, structuredState: { inFlight: true } });
    await read;
    assert.equal(h.state.currentMessages[1].content[2].text.length, 50);
    assert.equal(h.state.sessions[0].structuredState.inFlight, false);
  });
}

test("R03: a push without cursors protects the entire message window against old HTTP", async () => {
  const h = createRealtimeSessionHarness(); h.state.sessions = [{ id: "A", sessionKind: "structured", messages: [] }];
  const read = h.engine.loadOutput("A");
  h.send({ type: "init", sessionId: "A", seq: 1, data: { id: "A", messages: [textTurn("new")], permissionBlocked: false } });
  h.respond(0, { id: "A", messages: [textTurn("older much longer")], messageOffset: 20,
    messageTotal: 21, leadingBlockOffset: 4, leadingBlockTotal: 5,
    permissionBlocked: true, pendingEscalation: { id: "stale" } }); await read;
  const session = h.state.sessions[0]; assert.equal(session.messageOffset, 0);
  assert.equal(session.messageTotal, 1); assert.equal(session.leadingBlockOffset, 0);
  assert.equal(session.permissionBlocked, false); assert.equal(session.pendingEscalation, undefined);
  assert.equal(session.messages[0].content[0].text, "new");
});

test("R01: nested in-place edits are detected without relying on object identity", () => {
  const h = createRealtimeRenderHarness();
  const message = { role: "assistant", content: [{ type: "tool_use", id: "tool", input: { nested: { value: "AAAA" } } }] };
  h.setMessages([message]); h.chat.doRenderChat(false); message.content[0].input.nested.value = "BBBB";
  h.chat.doRenderChat(false); assert.match(h.bodyAt(0), /BBBB/);
});

test("R01/R02: child Agent Run revisions repaint the older dispatch anchor", () => {
  const h = createRealtimeRenderHarness();
  const meta = { taskId: "child", agentType: "Explore", taskDescription: "fixture" };
  const turns = [{ role: "assistant", content: [{ type: "tool_use", id: "child", name: "Task", input: { subagent_type: "Explore" }, __subagent: meta }] },
    ...Array.from({ length: 7 }, () => textTurn("middle")),
    { role: "assistant", content: [{ type: "thinking", thinking: "AAAA", __subagent: meta }] }];
  h.setMessages(turns); h.chat.doRenderChat(false); h.rendered.length = 0;
  turns[8].content[0] = { type: "thinking", thinking: "BBBB", __subagent: meta } as any;
  h.chat.doRenderChat(false); assert.ok(h.rendered.includes(0));
});

test("grouping consumers repaint when only the preceding author's identity changes", () => {
  const h = createRealtimeRenderHarness();
  const turns = [textTurn("first", "assistant", { author: { id: "author", name: "fixture" } }),
    textTurn("next", "assistant", { author: { id: "author", name: "fixture" } })];
  h.setMessages(turns); h.chat.doRenderChat(false); assert.match(h.bodyAt(1), /"grouped":true/);
  turns[0] = textTurn("first", "assistant", { author: { id: "different", name: "fixture" } });
  h.chat.doRenderChat(false); assert.match(h.bodyAt(1), /"grouped":false/);
});

test("empty then restored identical content invalidates the prior painted cache", () => {
  const h = createRealtimeRenderHarness(); const turns = [textTurn("same")];
  h.setMessages(turns); h.chat.doRenderChat(false); h.setMessages([]); h.chat.doRenderChat(false);
  h.setMessages(turns); h.chat.doRenderChat(false); assert.match(h.bodyAt(0), /same/);
});

test("R06: failure to schedule a frame releases pending and permits the next update", () => {
  const h = createRealtimeRenderHarness(); h.setMessages([textTurn("body")]); h.failNextFrameSchedule();
  h.chat.renderChat(); assert.equal(h.state.renderPending, false); assert.equal(h.errors.length, 1);
  h.chat.renderChat(); h.flush(); assert.match(h.bodyAt(0), /body/);
});

test("cache generations reject obsolete commits and failed plans remain dirty", () => {
  const cache = new ChatRenderCache(); const first = cache.prepare("A", [textTurn("old")], () => [], {});
  cache.commit(first); const failed = cache.prepare("A", [textTurn("new")], () => [], {});
  assert.deepEqual(cache.prepare("A", [textTurn("new")], () => [], {}).changedIndices, [0]);
  cache.reset(); cache.commit(failed);
  assert.equal(cache.prepare("B", [textTurn("new")], () => [], {}).structureChanged, true);
});
