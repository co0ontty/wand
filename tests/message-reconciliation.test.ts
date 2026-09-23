import assert from "node:assert/strict";
import test from "node:test";

import { mergeAssistantTurn, mergeBlockWindowedMessages, mergeIncrementalWindowedTurn, mergeWindowedMessages } from "../src/web-ui/browser/message-reconciliation.js";

function turn(role: "user" | "assistant", text: string, usage?: { output_tokens: number }) {
  return {
    role,
    content: [{ type: "text", text }],
    ...(usage ? { usage } : {}),
  };
}

test("block windows preserve loaded prefixes and never skip a partially loaded turn", () => {
  const full = [turn("assistant", "block-0"), turn("assistant", "block-1"), turn("assistant", "block-2")];
  const asBlocks = (entries: typeof full) => ({ role: "assistant", content: entries.map((x) => x.content[0]) });
  const first = mergeBlockWindowedMessages(null, [asBlocks(full.slice(2))], 0, 1, 2, 3);
  assert.equal(first.leadingBlockOffset, 2);
  const paged = { ...first, messages: [asBlocks(full.slice(1))], leadingBlockOffset: 1 };
  const refreshed = mergeBlockWindowedMessages(paged, [asBlocks(full.slice(2))], 0, 1, 2, 3);
  assert.deepEqual(refreshed.messages[0].content.map((x: { text: string }) => x.text), ["block-1", "block-2"]);
  assert.equal(refreshed.leadingBlockOffset, 1);
  const advanced = mergeBlockWindowedMessages(refreshed, [asBlocks(full.slice(2)), turn("user", "next")], 0, 2, 2, 3);
  assert.equal(advanced.leadingBlockOffset, 1);
  assert.equal(advanced.messages.length, 2);
  const shifted = mergeBlockWindowedMessages(advanced, [asBlocks(full.slice(1))], 1, 3, 1, 3);
  assert.equal(shifted.messageOffset, 1);
  assert.equal(shifted.leadingBlockOffset, 1);
  const cached = { messages: [turn("user", "old"), asBlocks(full.slice(0, 2))],
    messageOffset: 0, messageTotal: 2, leadingBlockOffset: 0, leadingBlockTotal: 1 };
  const grown = mergeBlockWindowedMessages(cached, [asBlocks(full.slice(1))], 1, 2, 1, 3);
  assert.equal(grown.messageOffset, 0, "a rolling block window must not discard older loaded turns");
  assert.deepEqual(grown.messages[1].content.map((x: { text: string }) => x.text),
    ["block-0", "block-1", "block-2"]);
});

test("a complete block window replaces a larger partial tail without claiming missing blocks", () => {
  const partial = { role: "assistant", content: [{ type: "text", text: "x".repeat(1_000) }] };
  const complete = { role: "assistant", content: [
    { type: "text", text: "first" }, { type: "text", text: "last" },
  ] };
  const merged = mergeBlockWindowedMessages({ messages: [partial], messageOffset: 0,
    messageTotal: 1, leadingBlockOffset: 1, leadingBlockTotal: 2 }, [complete], 0, 1, 0, 2);
  assert.equal(merged.leadingBlockOffset, 0);
  assert.deepEqual(merged.messages[0].content, complete.content);
  assert.deepEqual(mergeIncrementalWindowedTurn(partial, complete, 1, 2), complete);
  assert.deepEqual(mergeIncrementalWindowedTurn(partial,
    { ...complete, content: complete.content.slice(1) }, 1, 2).content, partial.content);
});

test("stale snapshots cannot erase the latest assistant response", () => {
  const local = {
    messages: [turn("user", "Question"), turn("assistant", "Complete latest response")],
    messageOffset: 8,
    messageTotal: 10,
  };
  const stale = mergeWindowedMessages(local, [turn("user", "Question")], 8, 9);

  assert.deepEqual(stale, local);
});

test("shorter assistant snapshots retain streamed content and accept final usage", () => {
  const local = turn("assistant", "A complete streamed answer");
  const merged = mergeAssistantTurn(local, turn("assistant", "A partial", { output_tokens: 42 }));

  assert.equal(merged.content[0].text, "A complete streamed answer");
  assert.deepEqual(merged.usage, { output_tokens: 42 });
});

test("newer windows preserve paged prefixes and complete local assistant turns", () => {
  const local = {
    messages: [
      turn("user", "Older prompt"),
      turn("assistant", "Older answer"),
      turn("user", "Latest prompt"),
      turn("assistant", "Complete latest response"),
    ],
    messageOffset: 0,
    messageTotal: 4,
  };
  const incoming = [
    turn("user", "Latest prompt"),
    turn("assistant", "Partial latest"),
    turn("user", "New prompt"),
  ];
  const merged = mergeWindowedMessages(local, incoming, 2, 5);

  assert.equal(merged.messageOffset, 0);
  assert.equal(merged.messageTotal, 5);
  assert.deepEqual(merged.messages.map((message) => message.content[0].text), [
    "Older prompt",
    "Older answer",
    "Latest prompt",
    "Complete latest response",
    "New prompt",
  ]);
});

test("more complete assistant snapshots replace earlier streamed content", () => {
  const local = {
    messages: [turn("assistant", "Partial response")],
    messageOffset: 4,
    messageTotal: 5,
  };
  const merged = mergeWindowedMessages(local, [turn("assistant", "Complete final response")], 4, 5);

  assert.equal(merged.messages[0].content[0].text, "Complete final response");
});
