import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeController, knowledgeDraftDirty } from "../src/web-ui/react/knowledge/controller.js";
import { knowledgeRepository, type KnowledgeDocument, type KnowledgeLibrary } from "../src/web-ui/react/knowledge/repository.js";

const document = (ownerId = "a", id = "d1", revision = 1): KnowledgeDocument => ({ id, scope: "personal", ownerId, revision,
  title: `文档 ${id}`, content: "已保存的正文", folder: "约定", createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z" });
const library = (ownerId = "a", entries = [document(ownerId)]): KnowledgeLibrary => ({ scope: "personal", ownerId, ownerName: ownerId, readOnly: false, entries, total: entries.length, limit: 200 });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; }
function setup(overrides: Partial<typeof knowledgeRepository> = {}) {
  const repository: typeof knowledgeRepository = { ...knowledgeRepository,
    owners: async () => ({ employees: [{ id: "a", name: "甲" }, { id: "b", name: "乙" }], projects: [] }),
    list: async namespace => library(namespace.ownerId), save: async (namespace, input, existing) => ({ ...document(namespace.ownerId, existing?.id ?? "new", (existing?.revision ?? 0) + 1), ...input }),
    remove: async () => {}, clearPersonal: async () => {}, ...overrides };
  const routes: Array<Record<string, string | null>> = [];
  const controller = new KnowledgeController(repository, patch => routes.push(patch));
  controller.open("personal", "a");
  return { controller, repository, routes };
}

test("late namespace reads cannot reveal another employee's documents", async () => {
  const first = deferred<KnowledgeLibrary>();
  const { controller } = setup({ list: namespace => namespace.ownerId === "a" ? first.promise : Promise.resolve(library("b")) });
  const a = controller.load(); await Promise.resolve();
  controller.open("personal", "b"); await controller.load();
  first.resolve(library("a")); await a;
  assert.equal(controller.getSnapshot().library?.ownerId, "b");
  assert.equal(controller.getSnapshot().library?.entries[0]?.ownerId, "b");
});

test("refreshing and leaving the page preserve a new unsaved draft", async () => {
  const { controller } = setup(); await controller.load();
  controller.edit(); controller.change({ title: "新知识", content: "草稿" });
  await controller.load();
  assert.equal(controller.getSnapshot().selectedId, "");
  assert.equal(controller.getSnapshot().draft?.content, "草稿");
  controller.close(); controller.open(); await controller.load();
  assert.equal(controller.getSnapshot().draft?.content, "草稿");
  assert.equal(controller.hasDrafts(), true);
  controller.discard(); assert.equal(controller.hasDrafts(), false);
});

test("revision conflicts retain input and need an explicit review before rebasing", async () => {
  let version = 1;
  const { controller } = setup({ list: async () => library("a", [document("a", "d1", version)]), save: async () => { throw Object.assign(new Error("文档已更新"), { status: 409 }); } });
  await controller.load(); controller.edit(controller.getSnapshot().library!.entries[0]); controller.change({ content: "我的修改" });
  await controller.save();
  assert.equal(controller.getSnapshot().draft?.content, "我的修改");
  assert.equal(controller.getSnapshot().conflict, true);
  version = 2; await controller.load();
  assert.equal(controller.getSnapshot().draft?.revision, 1);
  controller.acceptLatestRevision();
  assert.equal(controller.getSnapshot().draft?.revision, 2);
  assert.equal(controller.getSnapshot().draft?.content, "我的修改");
  assert.equal(knowledgeDraftDirty(controller.getSnapshot().draft), true);
});

test("unknown save results retain the draft and never automatically resend", async () => {
  let attempts = 0;
  const { controller } = setup({ save: async () => { attempts++; throw Object.assign(new Error("网络中断"), { status: 0 }); } });
  await controller.load(); controller.edit(); controller.change({ title: "新知识", content: "未确认送达" }); await controller.save();
  assert.equal(attempts, 1); assert.equal(controller.getSnapshot().draft?.content, "未确认送达");
  assert.equal(controller.getSnapshot().busy, false);
});

test("saving a new document turns later edits into revisioned PATCH requests", async () => {
  const calls: Array<{ id: string; revision: number } | undefined> = [];
  const { controller } = setup({ save: async (namespace, input, existing) => { calls.push(existing); return { ...document(namespace.ownerId, "new", existing ? 2 : 1), ...input }; } });
  await controller.load(); controller.edit(); controller.change({ title: "新知识", content: "内容" }); await controller.save();
  const saved = controller.getSnapshot().library!.entries[0]!;
  controller.edit(saved); controller.change({ content: "修改后的内容" }); await controller.save();
  assert.deepEqual(calls, [undefined, { id: "new", revision: 1 }]);
  assert.equal(controller.getSnapshot().library!.entries.filter(entry => entry.id === "new").length, 1);
  assert.equal(controller.hasDrafts(), false);
});

test("late save receipts do not change another employee's selection", async () => {
  const saved = deferred<KnowledgeDocument>();
  const { controller } = setup({ save: () => saved.promise });
  await controller.load(); controller.edit(); controller.change({ title: "甲", content: "甲的内容" }); const pending = controller.save();
  controller.open("personal", "b"); await controller.load();
  saved.resolve({ ...document("a", "new"), title: "甲", content: "甲的内容" }); await pending;
  assert.equal(controller.getSnapshot().ownerId, "b"); assert.equal(controller.getSnapshot().selectedId, "d1");
  assert.equal(controller.getSnapshot().draft, null); assert.equal(controller.hasDrafts(), false);
});

test("late delete receipts cannot discard the next document's draft", async () => {
  const removed = deferred<void>();
  const { controller } = setup({ list: async () => library("a", [document("a", "d1"), document("a", "d2")]), remove: () => removed.promise });
  await controller.load(); const pending = controller.remove(document());
  // Browser history can still restore another document while a mutation is pending.
  controller.restore(true, "personal", "a", "d2");
  removed.resolve(); await pending;
  assert.equal(controller.getSnapshot().selectedId, "d2");
});

test("read-only project libraries never allow adding or editing", async () => {
  const { controller } = setup({ list: async () => ({ ...library(), readOnly: true }) });
  await controller.load(); controller.edit(); assert.equal(controller.getSnapshot().draft, null);
});

test("a removed library owner clears its old documents while retaining an unsaved draft", async () => {
  let removed = false;
  const { controller } = setup({ owners: async () => ({ employees: removed ? [] : [{ id: "a", name: "甲" }], projects: [] }) });
  await controller.load(); controller.edit(controller.getSnapshot().library!.entries[0]); controller.change({ content: "尚未保存的修改" });
  removed = true; await controller.load();
  assert.equal(controller.getSnapshot().library, null);
  assert.equal(controller.getSnapshot().draft?.content, "尚未保存的修改");
  assert.match(controller.getSnapshot().error, /已不可用/);
  assert.equal(controller.getSnapshot().loading, false);
});

test("a confirmed deletion stays removed even if the subsequent refresh fails", async () => {
  let reads = 0;
  const { controller } = setup({ owners: async () => {
    if (++reads > 1) throw new Error("网络中断");
    return { employees: [{ id: "a", name: "甲" }], projects: [] };
  } });
  await controller.load(); await controller.remove(document());
  assert.deepEqual(controller.getSnapshot().library?.entries, []);
  assert.equal(controller.getSnapshot().library?.total, 0);
  assert.equal(controller.getSnapshot().draft, null);
  assert.match(controller.getSnapshot().error, /网络中断/);
});

test("owner removal between discovery and listing clears stale content and blocks writes", async () => {
  let removed = false, writes = 0;
  const { controller } = setup({ list: async () => {
    if (removed) throw Object.assign(new Error("知识库不存在"), { status: 404 });
    return library();
  }, save: async () => { writes++; return document(); } });
  await controller.load(); controller.edit(controller.getSnapshot().library!.entries[0]); controller.change({ content: "保留这份草稿" });
  removed = true; await controller.load(); await controller.save();
  assert.equal(controller.getSnapshot().library, null);
  assert.equal(controller.getSnapshot().draft?.content, "保留这份草稿");
  assert.equal(writes, 0);
});

test("required-field validation preserves input and clears once both fields are corrected", async () => {
  let writes = 0;
  const { controller } = setup({ save: async () => { writes++; return document(); } });
  await controller.load(); controller.edit(); controller.change({ title: "有标题", content: " " }); await controller.save();
  assert.equal(controller.getSnapshot().validationFailed, true);
  assert.equal(controller.getSnapshot().draft?.title, "有标题");
  assert.equal(controller.getSnapshot().draft?.content, " ");
  assert.equal(writes, 0);
  controller.change({ content: "补充正文" });
  assert.equal(controller.getSnapshot().validationFailed, false);
  assert.equal(controller.getSnapshot().error, "");
});
