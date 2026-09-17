import assert from "node:assert/strict";
import test from "node:test";
import { HttpResponseError } from "../src/web-ui/react/http-adapter.js";
import { createTaskDetailStore } from "../src/web-ui/react/workspaces/task-detail-store.js";
import { createTaskLayoutController } from "../src/web-ui/react/workspaces/task-layout-controller.js";
import type { TaskWindowLayout, WorkspaceTaskDetail } from "../src/web-ui/react/workspaces/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const layout = (id: string): TaskWindowLayout => ({ type: "windows", activeWindowId: id, windows: [] });
const detail = (id: string, revision = 1): WorkspaceTaskDetail => ({
  id, workspaceId: "workspace", name: id, cwd: `/${id}`, status: "active", worktree: null,
  createdAt: "2026-01-01", lastOpenedAt: null, layout: layout(id), layoutRevision: revision,
  sessions: [{ id: `${id}-session`, cwd: `/${id}` }],
});

test("task detail subscribers share a poll and never expose another task while loading or failed", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const requests: Array<{ id: string; result: ReturnType<typeof deferred<WorkspaceTaskDetail>> }> = [];
  const store = createTaskDetailStore({ getTask: (id) => {
    const result = deferred<WorkspaceTaskDetail>(); requests.push({ id, result }); return result.promise;
  } });
  const offA = store.subscribe("A", () => {});
  const offSplit = store.subscribe("A", () => {});
  assert.equal(requests.length, 1);
  requests[0].result.resolve(detail("A")); await tick();
  assert.equal(store.getSnapshot("A")?.cwd, "/A");
  offSplit();
  t.mock.timers.tick(4000);
  assert.equal(requests.length, 2, "remaining tab subscriber keeps exactly one poll");
  offA();
  const offB = store.subscribe("B", () => {});
  assert.equal(store.getSnapshot("B"), null);
  requests[1].result.resolve(detail("A"));
  requests[2].result.reject(new Error("B failed")); await tick();
  assert.equal(store.getSnapshot("B"), null);
  assert.equal(store.getSnapshot("A"), null, "late A response cannot resurrect released entry");
  t.mock.timers.tick(4000);
  assert.equal(requests.length, 4);
  const split = detail("B");
  split.layout = { type: "windows", activeWindowId: "split", windows: [{
    id: "split", layout: { type: "split", dir: "h", ratio: 0.5, children: [
      { type: "pane", tabs: [{ id: "b1", kind: "session", sessionId: "B-session" }], active: 0 },
      { type: "pane", tabs: [], active: 0 },
    ] },
  }] };
  requests[3].result.resolve(split); await tick();
  assert.deepEqual(store.getSnapshot("B")?.layout, split.layout);
  offB(); t.mock.timers.tick(8000);
  assert.equal(requests.length, 4, "last unsubscribe stops polling");
});

test("task detail rejects wrong response identity and deduplicates an opener with subscribers", async () => {
  const pending = deferred<WorkspaceTaskDetail>();
  let reads = 0;
  const store = createTaskDetailStore({ getTask: () => { reads++; return pending.promise; } });
  const opening = store.load("A");
  const off = store.subscribe("A", () => {});
  assert.equal(reads, 1);
  pending.resolve(detail("B"));
  await assert.rejects(opening, /任务/);
  assert.equal(store.getSnapshot("A"), null);
  off();
});

function savesHarness() {
  const writes: Array<{ id: string; layout: TaskWindowLayout | null; revision?: number; result: ReturnType<typeof deferred<{ layout: TaskWindowLayout | null; layoutRevision: number }>> }> = [];
  const reads: Array<{ id: string; result: ReturnType<typeof deferred<WorkspaceTaskDetail>> }> = [];
  const errors: string[] = [];
  const restored: string[] = [];
  let active = "A";
  const controller = createTaskLayoutController({
    getTask: (id) => { const result = deferred<WorkspaceTaskDetail>(); reads.push({ id, result }); return result.promise; },
    saveTaskLayout: (id, value, revision) => {
      const result = deferred<{ layout: TaskWindowLayout | null; layoutRevision: number }>();
      writes.push({ id, layout: value, revision, result }); return result.promise;
    },
  }, {
    onSaved: () => {},
    onError: (id) => errors.push(id),
    onRestore: (id, value) => { if (active === id) restored.push(`${id}:${value.layoutRevision}`); },
  });
  controller.remember("A", 1); controller.remember("B", 10);
  return { controller, writes, reads, errors, restored, select: (id: string) => { active = id; } };
}

test("layout writes serialize per task, coalesce pending edits, and read the latest revision at send time", async () => {
  const h = savesHarness();
  const first = h.controller.save("A", layout("first"));
  const middle = h.controller.save("A", layout("middle"));
  const latest = h.controller.save("A", layout("latest"));
  assert.equal(await middle, "superseded");
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].revision, 1);
  h.writes[0].result.resolve({ layout: layout("first"), layoutRevision: 2 }); await tick();
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].revision, 2);
  assert.deepEqual(h.writes[1].layout, layout("latest"));
  h.writes[1].result.resolve({ layout: layout("latest"), layoutRevision: 3 });
  assert.equal(await first, "saved"); assert.equal(await latest, "saved");
  await h.controller.flush("A");
});

test("409 cancels stale queued writes, settles callers, surfaces error and restores remote layout without retry", async () => {
  const h = savesHarness();
  const first = h.controller.save("A", layout("first"));
  const queued = h.controller.save("A", layout("queued"));
  h.writes[0].result.reject(new HttpResponseError("布局已被其他端更新", 409)); await tick();
  assert.equal(await queued, "failed");
  assert.deepEqual(h.errors, ["A"]);
  h.reads[0].result.resolve(detail("A", 8));
  assert.equal(await first, "failed"); await h.controller.flush("A");
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.restored, ["A:8"]);
});

test("background reconciliation after moving a session quietly restores the new layout", async () => {
  const h = savesHarness();
  const automatic = h.controller.save("A", layout("old-session"), { automatic: true });
  h.writes[0].result.reject(new HttpResponseError("moved session", 409)); await tick();
  h.reads[0].result.resolve(detail("A", 4));
  assert.equal(await automatic, "failed");
  await h.controller.flush("A");
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.restored, ["A:4"]);
  assert.equal(h.controller.canSaveAutomatically("A"), true);
});

test("failure recovery cannot overwrite new edits or another task; new generation still saves", async () => {
  const h = savesHarness();
  const failed = h.controller.save("A", layout("failed"));
  h.writes[0].result.reject(new Error("offline")); await tick();
  const fresh = h.controller.save("A", layout("fresh"));
  h.select("B");
  const other = h.controller.save("B", layout("other"));
  assert.equal(h.writes[1].id, "B");
  assert.equal(h.writes[1].revision, 10);
  h.reads[0].result.resolve(detail("A", 9)); await tick();
  assert.deepEqual(h.restored, [], "late recovery cannot overwrite a new edit");
  assert.equal(h.writes[2].id, "A");
  assert.equal(h.writes[2].revision, 9);
  h.writes[2].result.resolve({ layout: layout("fresh"), layoutRevision: 10 });
  h.writes[1].result.resolve({ layout: layout("other"), layoutRevision: 11 });
  assert.equal(await failed, "failed"); assert.equal(await fresh, "saved"); assert.equal(await other, "saved");
});

test("same-task edits made during recovery survive the late authoritative response", async () => {
  const h = savesHarness();
  const failed = h.controller.save("A", layout("failed"));
  h.writes[0].result.reject(new HttpResponseError("remote conflict", 409)); await tick();
  const fresh = h.controller.save("A", layout("fresh-draft"));
  h.reads[0].result.resolve(detail("A", 6)); await tick();
  assert.deepEqual(h.restored, [], "new draft must not be replaced by late recovery");
  assert.deepEqual(h.writes[1].layout, layout("fresh-draft"));
  assert.equal(h.writes[1].revision, 6);
  h.writes[1].result.resolve({ layout: layout("fresh-draft"), layoutRevision: 7 });
  assert.equal(await failed, "failed"); assert.equal(await fresh, "saved");
});

test("mutation reload invalidates an older poll without losing subscribers", async () => {
  const requests: Array<ReturnType<typeof deferred<WorkspaceTaskDetail>>> = [];
  const store = createTaskDetailStore({ getTask: () => {
    const request = deferred<WorkspaceTaskDetail>(); requests.push(request); return request.promise;
  } });
  const off = store.subscribe("A", () => {});
  const fresh = store.reload("A");
  requests[1].resolve(detail("A", 5)); await fresh;
  requests[0].resolve(detail("A", 1)); await tick();
  assert.equal(store.getSnapshot("A")?.layoutRevision, 5);
  off();
});

test("failure suppresses automatic poll/restoration writes until an explicit save succeeds", async () => {
  const h = savesHarness();
  const failed = h.controller.save("A", layout("failed"));
  h.writes[0].result.reject(new HttpResponseError("conflict", 409)); await tick();
  const polled = h.controller.save("A", layout("poll-added-session"), { automatic: true });
  h.reads[0].result.resolve(detail("A", 8));
  assert.equal(await failed, "failed");
  assert.deepEqual(h.restored, ["A:8"], "automatic work must not advance the user edit epoch");
  assert.equal(await polled, "failed");
  h.controller.remember("A", 8);
  assert.equal(await h.controller.save("A", layout("restoration"), { automatic: true }), "failed");
  assert.equal(h.writes.length, 1);
  const explicit = h.controller.save("A", layout("user-edit"));
  h.writes[1].result.resolve({ layout: layout("user-edit"), layoutRevision: 9 });
  assert.equal(await explicit, "saved");
  const automatic = h.controller.save("A", layout("reconcile"), { automatic: true }); await tick();
  h.writes[2].result.resolve({ layout: layout("reconcile"), layoutRevision: 10 });
  assert.equal(await automatic, "saved");
});

test("failed resync settles save, and the next explicit edit reloads revision before writing", async () => {
  const h = savesHarness();
  const failed = h.controller.save("A", layout("failed"));
  h.writes[0].result.reject(new Error("offline")); await tick();
  h.reads[0].result.reject(new Error("still offline"));
  assert.equal(await failed, "failed");
  const retry = h.controller.save("A", layout("retry")); await tick();
  assert.equal(h.writes.length, 1);
  h.reads[1].result.resolve(detail("A", 20)); await tick();
  assert.equal(h.writes[1].revision, 20);
  h.writes[1].result.resolve({ layout: layout("retry"), layoutRevision: 21 });
  assert.equal(await retry, "saved");
});
