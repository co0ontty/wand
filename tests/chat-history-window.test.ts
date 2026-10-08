import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatHistoryPrefetchGate, chatHistoryBufferRemaining, chatHistoryRootMargin,
  needsChatHistoryBuffer, CHAT_HISTORY_BYTE_BUDGET, CHAT_HISTORY_BLOCK_BUDGET } from "../src/web-ui/chat-history-window.js";
import { blockWindowMessagesForTransport, messageWindowByteBudget, contentTransportBytes } from "../src/message-truncator.js";
import type { ConversationTurn, ContentBlock } from "../src/types.js";

test("history buffer is measured in screens in a reversed chat scroller", () => {
  const geometry = { scrollHeight: 3200, clientHeight: 800, scrollTop: 0 };
  assert.equal(chatHistoryBufferRemaining(geometry), 2400);
  assert.equal(needsChatHistoryBuffer(geometry), false);
  assert.equal(needsChatHistoryBuffer({ ...geometry, scrollTop: -900 }), true);
  assert.equal(needsChatHistoryBuffer({ ...geometry, scrollTop: 900 }), true);
  assert.equal(needsChatHistoryBuffer({ ...geometry, clientHeight: 0 }), false);
  assert.equal(chatHistoryBufferRemaining({ ...geometry, scrollTop: -9999 }), 0);
  assert.equal(chatHistoryRootMargin(800), "1600px 0px 0px 0px");
  assert.equal(chatHistoryRootMargin(400), "800px 0px 0px 0px");
});

test("prefetch continues with progressing cursors even before short or folded pages grow the viewport", () => {
  const gate = new ChatHistoryPrefetchGate();
  const emptyViewport = { scrollHeight: 600, clientHeight: 600, scrollTop: 0 };
  for (const cursor of ["server:7:48", "server:7:36", "server:7:24", "server:7:12", "server:7:0", "server:6:0"]) {
    assert.equal(needsChatHistoryBuffer(emptyViewport), true);
    assert.equal(gate.canAttempt("A:1", cursor), true, "cursor progress matters even when height is unchanged");
    gate.attempted("A:1", cursor);
    assert.equal(gate.canAttempt("A:1", cursor), false, "same cursor may not spin on an empty/failed response");
  }
  assert.equal(gate.canAttempt("A:1", "server:6:0", true), true, "explicit retry stays available");
  assert.equal(gate.canAttempt("B:1", "server:6:0"), true);
  assert.equal(gate.canAttempt("A:2", "server:6:0"), true);
});

test("small transport pages preserve offsets and narrow the legacy byte budget", () => {
  assert.equal(messageWindowByteBudget(CHAT_HISTORY_BYTE_BUDGET), CHAT_HISTORY_BYTE_BUDGET);
  assert.equal(messageWindowByteBudget("98304"), CHAT_HISTORY_BYTE_BUDGET);
  assert.equal(messageWindowByteBudget(1), 16 * 1024);
  for (const value of [undefined, "invalid", -1, 0, Number.NaN, 10 ** 12]) {
    assert.equal(messageWindowByteBudget(value), 1024 * 1024);
  }
  const turns: ConversationTurn[] = Array.from({ length: 100 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `message-${i}` }],
  }));
  const page = blockWindowMessagesForTransport(turns, {}, CHAT_HISTORY_BLOCK_BUDGET, CHAT_HISTORY_BYTE_BUDGET);
  assert.equal(page.messages.length, 12);
  assert.equal(page.messageOffset, 88);
  assert.equal(page.messageTotal, 100);
});

test("a long turn is split by visible blocks, not fetched as one huge message", () => {
  const content: ContentBlock[] = Array.from({ length: 100 }, (_, i) => ({ type: "text", text: `block-${i}` }));
  const page = blockWindowMessagesForTransport([{ role: "assistant", content }], {}, 12, CHAT_HISTORY_BYTE_BUDGET);
  assert.equal(page.messages.length, 1);
  assert.equal(page.leadingBlockOffset, 88);
  assert.equal(page.leadingBlockTotal, 100);
  assert.equal(page.messages[0].content.length, 12);
});

test("small-page opt-in does not absorb an entire huge folded tool run", () => {
  const content: ContentBlock[] = Array.from({ length: 400 }, (_, i) => [
    { type: "tool_use", id: `tool-${i}`, name: "Bash", input: { command: "x".repeat(1200) } },
    { type: "tool_result", tool_use_id: `tool-${i}`, content: "result" },
  ] as ContentBlock[]).flat();
  const page = blockWindowMessagesForTransport([{ role: "assistant", content }], {}, 12, CHAT_HISTORY_BYTE_BUDGET, true);
  assert.ok(page.leadingBlockOffset > 0);
  const head = page.messages[0].content[0];
  assert.equal(head.type, "tool_use", "no orphan result at the page boundary");
  assert.ok(contentTransportBytes(page.messages[0].content, {}) < CHAT_HISTORY_BYTE_BUDGET + 4096);
});
