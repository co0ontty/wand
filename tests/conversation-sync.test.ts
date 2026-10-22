import assert from "node:assert/strict";
import test from "node:test";
import { conversationHarness } from "./helpers/conversation-harness.js";
import { mergeConversationSync } from "../src/conversation-sync-contract.js";
import { ConversationSynchronizer } from "../src/conversation-sync.js";
import type { ConversationDetail } from "../src/conversation-types.js";

test("conversation sync pages, unchanged repairs and late edits preserve the anchored window", async t => {
  const h = conversationHarness(t); const id = await h.group();
  for (let n = 0; n < 150; n++) h.storage.appendConversationEvent(id, { messageId: "m" + String(n).padStart(3, "0"),
    role: "user", createdAt: new Date(1700000000000 + n).toISOString(), content: [{ type: "text", text: "message " + n }] });
  const a = h.service.sync(id, {}); assert.equal(a.messages?.length, 40); assert.equal(a.history.total, 150);
  let view = mergeConversationSync(null, a); assert.equal(view.messages[0].messageId, "m110");
  const b = h.service.sync(id, { since: a.history.revision, from: a.history.from! });
  assert.equal(b.unchanged, true); assert.ok(JSON.stringify(b).length < 400);
  const c = h.service.sync(id, { since: a.history.revision, from: a.history.from!, older: true });
  assert.equal(c.messages?.length, 40); view = mergeConversationSync(view, c);
  assert.equal(view.messages.length, 80); assert.equal(view.messages[0].messageId, "m070");
  h.storage.appendConversationEvent(id, { messageId: "new", role: "user", createdAt: new Date(1700000000500).toISOString(), content: [{ type: "text", text: "new" }] });
  const d = h.service.sync(id, { since: c.history.revision, from: c.history.from! });
  assert.deepEqual(d.messages?.map(m => m.messageId), ["new"]); view = mergeConversationSync(view, d);
  assert.equal(view.messages.length, 81);
  const reset = h.service.sync(id, { since: "expired", from: d.history.from! });
  assert.equal(reset.reset, true); assert.equal(reset.messages?.length, 81);
  assert.deepEqual(mergeConversationSync(view, reset).messages, view.messages);
});

test("edits, deletes (including anchor), equal timestamps and reset are deterministic", () => {
  let turns = ["a", "b", "c", "d"].map(messageId => ({ messageId, role: "user" as const, createdAt: "same",
    content: [{ type: "text" as const, text: messageId }] }));
  const read = (_id: string, select: (messages: typeof turns) => typeof turns) =>
    ({ id: "x", messages: select(turns), runDetails: [] } as unknown as ConversationDetail);
  const sync = new ConversationSynchronizer(read);
  const a = sync.sync("x", { limit: 3 }); let view = mergeConversationSync(null, a);
  assert.deepEqual(view.messages.map(m => m.messageId), ["b", "c", "d"]);
  turns = turns.filter(m => m.messageId !== "b").map(m => m.messageId === "c" ? { ...m, content: [{ type: "text", text: "edited" }] } : m);
  const b = sync.sync("x", { from: a.history.from!, since: a.history.revision });
  view = mergeConversationSync(view, b);
  assert.deepEqual(view.messages.map(m => m.messageId), ["c", "d"]); assert.equal(b.messages?.length, 1);
  const older = sync.sync("x", { from: b.history.from!, since: b.history.revision, older: true });
  assert.deepEqual(mergeConversationSync(view, older).messages.map(m => m.messageId), ["a", "c", "d"]);
  assert.throws(() => mergeConversationSync(null, b), /缺少|不一致/);
});
