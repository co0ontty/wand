import assert from "node:assert/strict";
import test from "node:test";

import { mergeAssistantTurn, mergeWindowedMessages } from "../src/web-ui/browser/message-reconciliation.js";

function turn(role: "user" | "assistant", text: string, usage?: { output_tokens: number }) {
  return {
    role,
    content: [{ type: "text", text }],
    ...(usage ? { usage } : {}),
  };
}

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
