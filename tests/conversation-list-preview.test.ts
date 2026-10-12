import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { employeeConversationId } from "../src/conversation-types.js";
import { conversationHarness } from "./helpers/conversation-harness.js";

test("DM list previews omit the peer signature without changing message text or history", async t => {
  const h = conversationHarness(t), dm = employeeConversationId("e_test_1");
  await h.service.prepare(dm, randomUUID());
  assert.equal(h.service.detail(dm).preview, "还没有消息");
  const text = "员工 1：这是正文，不是摘要的署名。" + "完整内容".repeat(50);
  h.storage.appendConversationEvent(dm, { role: "assistant", createdAt: new Date().toISOString(),
    author: { id: "e_test_1", name: "员工 1" }, content: [{ type: "text", text }] });
  const stored = JSON.stringify(h.storage.conversationEvents(dm));
  assert.equal(h.service.detail(dm).preview, text.slice(0, 160));
  const employee = h.storage.getSiliconEmployee("e_test_1")!;
  h.storage.saveSiliconEmployee({ ...employee, name: "改名后的伙伴" });
  const summary = h.service.list().find(item => item.id === dm)!;
  assert.equal(summary.title, "改名后的伙伴");
  assert.equal(summary.preview, text.slice(0, 160));
  assert.equal(JSON.stringify(h.storage.conversationEvents(dm)), stored);
});

test("DM independent-session reply previews also omit the redundant peer name", async t => {
  const h = conversationHarness(t), dm = employeeConversationId("e_test_1");
  await h.service.send(dm, randomUUID(), "测试消息", null);
  const detail = h.service.detail(dm);
  assert.equal(detail.preview, detail.messages.at(-1)!.sessionPreview!.text.slice(0, 160));
  assert.doesNotMatch(detail.preview, /^员工 1：/);
});

test("own messages retain the self signature and group messages retain their author", async t => {
  const h = conversationHarness(t), dm = employeeConversationId("e_test_1");
  h.config.userProfile = { name: "测试用户" };
  await h.service.prepare(dm, randomUUID());
  const group = await h.group();
  assert.equal(h.service.detail(group).preview, "群已建立，尚未派任务");
  for (const id of [dm, group]) {
    h.storage.appendConversationEvent(id, { role: "user", createdAt: "2099-01-01T00:00:00Z", content: [{ type: "text", text: "自己的消息" }] });
    assert.equal(h.service.detail(id).preview, "测试用户：自己的消息");
  }
  h.storage.appendConversationEvent(group, { role: "assistant", createdAt: "2099-01-02T00:00:00Z",
    author: { id: "e_test_1", name: "员工 1" }, content: [{ type: "text", text: "群聊回复" }] });
  assert.equal(h.service.detail(group).preview, "员工 1：群聊回复");
  h.storage.appendConversationEvent(group, { role: "assistant", createdAt: "2099-01-03T00:00:00Z",
    content: [{ type: "text", text: "系统消息" }] });
  assert.equal(h.service.detail(group).preview, "系统：系统消息");
});
