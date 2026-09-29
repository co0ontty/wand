import assert from "node:assert/strict";
import test from "node:test";
import { ComposerQueueClock, ComposerStore, type ComposerAttachment } from "../src/web-ui/browser/composer.js";

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(saved: Record<string, string> = {}) {
  const data = new Map(Object.entries(saved));
  const disposed: ComposerAttachment[] = [];
  let unloading = false;
  const store = new ComposerStore({
    storage: () => ({
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => { data.set(key, value); },
      removeItem: (key) => { data.delete(key); },
    }),
    isUnloading: () => unloading,
    disposeAttachment: (item) => { disposed.push(item); },
  });
  return { store, data, disposed, unload: (value: boolean) => { unloading = value; } };
}

const image = (name: string): ComposerAttachment => ({
  name, size: 3, previewUrl: "blob:" + name,
  file: new File(["png"], name, { type: "image/png", lastModified: 100 }),
});

test("composer hydrates per-session drafts and keeps attachment ownership out of render snapshots", () => {
  const h = harness({ "wand-draft-A": "saved A", "wand-draft-B": "saved B" });
  const attachment = image("a.png");
  h.store.edit("A", { addAttachment: attachment });
  const snapshot = h.store.read("A");
  (snapshot.attachments as ComposerAttachment[]).pop();
  assert.equal(h.store.read("A").text, "saved A");
  assert.deepEqual(h.store.read("A").attachments, [attachment]);
  assert.equal(h.store.read("B").text, "saved B");
  assert.deepEqual(h.store.read("B").attachments, []);
});

test("composer subscribers see session edits and synchronous submit clearing", async () => {
  const h = harness();
  const seen: string[] = [];
  const unsubscribe = h.store.subscribe(() => seen.push(h.store.read("A").text));
  h.store.edit("A", { text: "准备发送" });
  await h.store.submit("A", "准备发送", async () => "ok");
  unsubscribe();
  h.store.edit("A", { text: "下一条" });
  assert.deepEqual(seen, ["准备发送", ""]);
});

test("submit captures and clears synchronously, deduplicates gestures, and leaves the next draft alone", async () => {
  const h = harness();
  const attachment = image("a.png");
  h.store.edit("A", { text: "first" });
  h.store.edit("A", { addAttachment: attachment });
  const response = deferred<string>();
  let deliveries = 0;
  let captured: unknown;
  const request = h.store.submit("A", "first", (payload) => {
    deliveries += 1;
    captured = payload;
    return response.promise;
  });
  assert.equal(h.store.read("A").text, "");
  assert.deepEqual(h.store.read("A").attachments, []);
  assert.equal(h.data.has("wand-draft-A"), false);
  assert.equal(deliveries, 0, "delivery starts after the synchronous capture");
  assert.equal(h.store.pendingSubmission("A", { text: "first", attachments: [attachment] }), request);
  h.store.edit("A", { text: "second" });
  const laterImage = image("b.png");
  h.store.edit("A", { addAttachment: laterImage });
  await Promise.resolve();
  assert.deepEqual(captured, { text: "first", attachments: [attachment] });
  response.resolve("accepted");
  assert.equal(await request, "accepted");
  assert.equal(h.store.read("A").text, "second");
  assert.deepEqual(h.store.read("A").attachments, [laterImage]);
  assert.deepEqual(h.disposed, [attachment]);
  assert.equal(h.store.pendingSubmission("A", { text: "first", attachments: [attachment] }), null);
});

test("duplicate plain-text submissions reuse delivery while a distinct draft can proceed", async () => {
  const h = harness();
  const response = deferred<void>();
  let deliveries = 0;
  const first = h.store.submit("A", "same", () => { deliveries += 1; return response.promise; });
  const duplicate = h.store.submit("A", "same", () => { deliveries += 1; return Promise.resolve(); });
  assert.equal(duplicate, first);
  await h.store.submit("A", "new", async () => { deliveries += 1; });
  assert.equal(deliveries, 2);
  response.resolve();
  await first;
});

test("failed delivery restores captured text and attachments beside the newer draft without crossing sessions", async () => {
  const h = harness();
  const firstImage = image("first.png");
  h.store.edit("A", { addAttachment: firstImage });
  const response = deferred<void>();
  const request = h.store.submit("A", "failed", () => response.promise);
  h.store.edit("A", { text: "newer" });
  const newImage = image("new.png");
  h.store.edit("A", { addAttachment: newImage });
  h.store.edit("B", { text: "other" });
  response.reject(Object.assign(new Error("invalid input"), { httpStatus: 400 }));
  await assert.rejects(request, /invalid input/);
  assert.equal(h.store.read("A").text, "failed\nnewer");
  assert.deepEqual(h.store.read("A").attachments, [firstImage, newImage]);
  assert.equal(h.data.get("wand-draft-A"), "failed\nnewer");
  assert.equal(h.store.read("B").text, "other");
  assert.deepEqual(h.disposed, []);
});

test("ambiguous delivery remains memory-only across switches and unload; editing makes it durable again", async () => {
  const h = harness();
  await assert.rejects(h.store.submit("A", "maybe sent", async () => { throw new Error("Failed to fetch"); }));
  assert.equal(h.store.read("A").memoryOnly, true);
  h.store.edit("A", { preserve: h.store.read("A").text });
  h.unload(true);
  h.store.edit("A", { preserve: h.store.read("A").text });
  assert.equal(h.data.has("wand-draft-A"), false);
  assert.equal(h.store.read("A").text, "maybe sent");
  h.unload(false);
  h.store.edit("A", { text: "edited" });
  assert.equal(h.store.read("A").memoryOnly, false);
  assert.equal(h.data.get("wand-draft-A"), "edited");
});

test("implicit unload writes are skipped, definite rejection persists, and clearing prevents resurrection", async () => {
  const h = harness({ "wand-draft-A": "old" });
  h.unload(true);
  h.store.edit("A", { text: "unload" });
  assert.equal(h.data.get("wand-draft-A"), "old");
  await assert.rejects(h.store.submit("A", "rejected", async () => {
    throw Object.assign(new Error("server rejected"), { httpStatus: 400 });
  }));
  assert.equal(h.data.get("wand-draft-A"), "rejected");
  h.store.edit("A", { clear: true });
  assert.equal(h.data.has("wand-draft-A"), false);
  assert.equal(h.store.read("A").text, "");
});

test("late prompt optimization only replaces the unchanged owning draft", () => {
  const h = harness();
  h.store.edit("A", { text: "original" });
  const revision = h.store.read("A").revision;
  h.store.edit("A", { preserve: "original" });
  assert.equal(h.store.edit("A", { text: "optimized", expectedRevision: revision }), true);
  const stale = h.store.read("A").revision;
  h.store.edit("A", { text: "new edit" });
  h.store.edit("B", { text: "other" });
  assert.equal(h.store.edit("A", { text: "late", expectedRevision: stale }), false);
  assert.equal(h.store.read("A").text, "new edit");
  assert.equal(h.store.read("B").text, "other");
  h.store.edit("A", { clear: true });
  assert.equal(h.store.edit("A", { text: "late", expectedRevision: stale }), false);
});

test("draft transformations are invalidated by attachment edits and deleted/recreated session identities", () => {
  const h = harness();
  h.store.edit("A", { text: "prompt" });
  const revision = h.store.read("A").revision;
  h.store.edit("A", { addAttachment: image("context.png") });
  assert.equal(h.store.edit("A", { text: "stale", expectedRevision: revision }), false);
  const attached = h.store.read("A").revision;
  h.store.edit("A", { removeAttachment: 0 });
  assert.equal(h.store.edit("A", { text: "stale", expectedRevision: attached }), false);
  const beforeDelete = h.store.read("A").revision;
  h.store.retain(new Set());
  assert.equal(h.store.edit("A", { text: "stale", expectedRevision: beforeDelete }), false);
  h.store.edit("A", { text: "new incarnation" });
  assert.equal(h.store.edit("A", { text: "stale", expectedRevision: beforeDelete }), false);
  assert.equal(h.store.read("A").text, "new incarnation");
});

test("ambiguous late failure preserves new text without persisting either the uncertain capture or merged draft", async () => {
  const h = harness();
  const response = deferred<void>();
  const request = h.store.submit("A", "uncertain", () => response.promise);
  h.store.edit("A", { text: "new draft" });
  response.reject(new Error("Failed to fetch"));
  await assert.rejects(request);
  assert.equal(h.store.read("A").text, "uncertain\nnew draft");
  assert.equal(h.store.read("A").memoryOnly, true);
  assert.equal(h.data.has("wand-draft-A"), false);
});

test("deleted sessions are not recreated by pending failure; captured and newly added previews are released once", async () => {
  const h = harness();
  const captured = image("captured.png");
  const newer = image("newer.png");
  h.store.edit("A", { addAttachment: captured });
  const response = deferred<void>();
  const request = h.store.submit("A", "deleted payload", () => response.promise);
  h.store.edit("A", { text: "new draft" });
  h.store.edit("A", { addAttachment: newer });
  h.store.retain(new Set());
  assert.deepEqual(h.disposed, [newer]);
  response.reject(Object.assign(new Error("rejected"), { httpStatus: 400 }));
  await assert.rejects(request);
  assert.deepEqual(h.disposed, [newer, captured]);
  assert.equal(h.data.has("wand-draft-A"), false);
  assert.equal(h.store.read("A").text, "");
  assert.deepEqual(h.store.read("A").attachments, []);
});

test("removal and authoritative session pruning release only abandoned attachment previews", async () => {
  const h = harness();
  const pending = image("pending.png");
  const removed = image("removed.png");
  h.store.edit("A", { addAttachment: pending });
  h.store.edit("B", { addAttachment: removed });
  h.store.edit("B", { removeAttachment: 0 });
  const response = deferred<void>();
  const request = h.store.submit("A", "sending", () => response.promise);
  h.store.retain(new Set());
  assert.deepEqual(h.disposed, [removed]);
  response.resolve();
  await request;
  assert.deepEqual(h.disposed, [removed, pending]);
});

test("unavailable browser storage does not prevent drafting, delivery, or recovery", async () => {
  const store = new ComposerStore({
    storage: () => { throw new Error("unavailable"); },
    isUnloading: () => false,
    disposeAttachment: () => {},
  });
  store.edit("A", { text: "draft" });
  assert.equal(store.read("A").text, "draft");
  await assert.rejects(store.submit("A", "draft", async () => { throw new Error("Failed to fetch"); }));
  assert.equal(store.read("A").text, "draft");
  assert.equal(store.read("A").memoryOnly, true);
});

test("queue HTTP responses cannot overwrite newer local or WS state; unrelated sessions stay independent", () => {
  const clock = new ComposerQueueClock();
  const first = clock.advance("A", "local");
  clock.advance("B", "server");
  assert.deepEqual(clock.filter({ id: "A", queuedMessages: ["first"] }, "A", first),
    { id: "A", queuedMessages: ["first"] });
  clock.advance("A", "local");
  assert.deepEqual(clock.filter({ id: "A", queuedMessages: ["old"], status: "running" }, "A", first),
    { id: "A", status: "running" });
  const second = clock.read("A");
  clock.advance("A", "server");
  assert.deepEqual(clock.filter({ queuedMessages: ["old"], status: "idle" }, "A", second), { status: "idle" });
});

test("append rejection removes only its item while preserving concurrent submissions and queue order", () => {
  const clock = new ComposerQueueClock();
  const first = clock.advance("A", "local");
  clock.advance("A", "local");
  assert.deepEqual(clock.rollback("A", ["first", "second", "third"], [], first,
    { text: "first", index: 0 }), ["second", "third"]);
  const mutation = clock.advance("A", "local");
  clock.advance("A", "server");
  assert.equal(clock.rollback("A", ["server"], [], mutation, { text: "server", index: 0 }), null);
});

test("destructive queue rollback cannot restore a stale full queue after another edit or server acknowledgement", () => {
  const clock = new ComposerQueueClock();
  const deleted = clock.advance("A", "local");
  clock.advance("A", "local");
  assert.equal(clock.rollback("A", ["newer"], ["deleted", "old"], deleted), null);
  const cleared = clock.advance("A", "local");
  clock.advance("A", "server");
  assert.equal(clock.rollback("A", [], ["old"], cleared), null);
  const failed = clock.advance("A", "local");
  assert.deepEqual(clock.rollback("A", [], ["first", "second"], failed), ["first", "second"]);
});
