import test from "node:test";
import assert from "node:assert/strict";
import { ComposerStore } from "../src/web-ui/browser/composer.js";
import { conversationDraftKey } from "../src/web-ui/react/conversations/state.js";

function fixture() {
  const persisted = new Map<string, string>();
  const store = new ComposerStore({ storage: () => ({ get length() { return persisted.size; }, key: i => [...persisted.keys()][i] ?? null,
    getItem: k => persisted.get(k) ?? null, setItem: (k, v) => { persisted.set(k, v); }, removeItem: k => { persisted.delete(k); } }),
    isUnloading: () => false, disposeAttachment: () => {} });
  return { store, persisted };
}

test("logical conversation drafts survive session polling and are isolated by task/run target", () => {
  const { store } = fixture();
  const talk = conversationDraftKey("group-a", null);
  const run = conversationDraftKey("group-a", { taskId: "task-a", runId: "run-a" });
  store.edit(talk, { text: "普通沟通草稿" }); store.edit(run, { text: "明确任务回复" });
  store.retain(new Set());
  assert.equal(store.read(talk).text, "普通沟通草稿"); assert.equal(store.read(run).text, "明确任务回复");
  assert.notEqual(run, conversationDraftKey("group-a", { taskId: "task-b", runId: "run-b" }));
});

test("adopting an unaddressed draft is revision-bound and never overwrites a recipient", () => {
  const { store } = fixture(); const pending = conversationDraftKey("", null), peer = conversationDraftKey("dm_e-a", null);
  store.edit(pending, { text: "待选择员工" }); const revision = store.read(pending).revision;
  store.edit(peer, { text: "已有私聊草稿" }); assert.equal(store.transfer(pending, peer, revision), false);
  store.edit(peer, { clear: true }); store.edit(pending, { text: "新输入" });
  assert.equal(store.transfer(pending, peer, revision), false);
  assert.equal(store.transfer(pending, peer, store.read(pending).revision), true);
  assert.equal(store.read(peer).text, "新输入"); assert.equal(store.read(pending).text, "");
});

test("unknown submission does not splice into a newer conversation draft; explicit recovery remains in owner", async () => {
  const { store, persisted } = fixture(); const key = conversationDraftKey("group-a", null);
  store.edit(key, { text: "old" });
  let reject!: (reason: unknown) => void;
  const sending = store.submit(key, "old", () => new Promise((_resolve, fail) => { reject = fail; }));
  await Promise.resolve(); store.edit(key, { text: "new" }); reject({ __wandAmbiguousDelivery: true });
  await assert.rejects(sending);
  assert.equal(store.read(key).text, "new"); assert.equal(store.read(key).recovery?.text, "old");
  assert.equal(persisted.get(`wand-draft-${key}`), "new");
  store.edit(key, { forgetRecovery: true }); assert.equal(store.read(key).text, "new");
});

test("GET receipt acknowledgement cannot clear input changed after the unconfirmed capture", async () => {
  const { store, persisted } = fixture(); const key = conversationDraftKey("dm_e-a", null);
  store.edit(key, { text: "unknown" });
  await assert.rejects(store.submit(key, "unknown", async () => { throw { __wandAmbiguousDelivery: true }; }));
  const revision = store.read(key).revision;
  assert.equal(persisted.has(`wand-draft-${key}`), false);
  store.edit(key, { text: "newer" }); assert.equal(store.edit(key, { acknowledgeRevision: revision }), false);
  assert.equal(store.read(key).text, "newer");
});

test("deleting a conversation clears every target draft and rejects late recovery without touching another conversation", async () => {
  const { store, persisted } = fixture(); const key = conversationDraftKey("group-a", null);
  const prefix = key.slice(0, key.indexOf("group-a") + "group-a".length) + ":";
  const unopened = conversationDraftKey("group-a", { taskId: "old-task", runId: "old-run" });
  const other = conversationDraftKey("group-b", null);
  store.edit(key, { text: "pending" }); store.edit(other, { text: "keep" });
  persisted.set(`wand-draft-${unopened}`, "not loaded this time");
  let reject!: (error: Error) => void;
  const sending = store.submit(key, "pending", () => new Promise((_, fail) => { reject = fail; }));
  await Promise.resolve(); store.discardScope(prefix);
  reject(new Error("late failure")); await assert.rejects(sending);
  assert.equal(store.read(key).text, ""); assert.equal(store.read(unopened).text, "");
  assert.equal(store.read(other).text, "keep"); assert.equal(persisted.has(`wand-draft-${unopened}`), false);
});
