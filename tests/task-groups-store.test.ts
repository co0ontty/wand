import assert from "node:assert/strict";
import test from "node:test";
import { createTaskGroupsStore } from "../src/web-ui/react/workspaces/task-groups-store.js";
import type { TaskDirectoryGroup } from "../src/web-ui/react/workspaces/types.js";

type Page = { groups: TaskDirectoryGroup[]; revision?: string; unchanged: boolean };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function fixture(id = "loose"): TaskDirectoryGroup[] {
  return [{ workspaceId: "project", workspaceName: "项目", workspaceCwd: "/project", tasks: [], standaloneSessions: [{ id }] }];
}
function harness() {
  const reads: Array<{ revision?: string; result: ReturnType<typeof deferred<Page>> }> = [];
  const polls = new Map<number, () => void>();
  const changes = new Set<() => void>();
  let nextTimer = 0;
  const delays: number[] = [];
  const store = createTaskGroupsStore({
    listTaskGroups(revision) { const result = deferred<Page>(); reads.push({ revision, result }); return result.promise; },
  }, {
    subscribeChanges(listener) { changes.add(listener); return () => { changes.delete(listener); }; },
    setInterval(listener, delay) { delays.push(delay); const id = ++nextTimer; polls.set(id, listener); return id as unknown as ReturnType<typeof setInterval>; },
    clearInterval(timer) { polls.delete(timer as unknown as number); },
  });
  return { store, reads, polls, changes, delays,
    poll: () => { for (const listener of polls.values()) listener(); },
    mutate: () => { for (const listener of changes) listener(); },
    respond: (index: number, groups = fixture(), revision = "r1", unchanged = false) => { reads[index].result.resolve({ groups, revision, unchanged }); },
  };
}

test("sidebar and tabs share one initial read, 6s poll and mutation subscription", async () => {
  const h = harness();
  let notified = 0;
  const first = h.store.subscribe(() => { notified++; });
  const second = h.store.subscribe(() => { notified++; });
  await tick();
  assert.equal(h.reads.length, 1);
  assert.deepEqual(h.delays, [6_000]);
  assert.equal(h.changes.size, 1);
  h.poll(); h.poll();
  await tick();
  assert.equal(h.reads.length, 1, "a poll joins a pending read without scheduling another");
  h.respond(0); await tick();
  assert.equal(h.store.getSnapshot().loading, false);
  assert.equal(h.store.getSnapshot().groups[0].standaloneSessions[0].id, "loose");
  assert.ok(notified >= 2);
  first();
  assert.equal(h.polls.size, 1);
  assert.equal(h.changes.size, 1);
  second();
  assert.equal(h.polls.size, 0);
  assert.equal(h.changes.size, 0);
});

test("mutations and concurrent explicit refreshes coalesce into a read started after invalidation", async () => {
  const h = harness();
  const unsubscribe = h.store.subscribe(() => {});
  await tick();
  const refresh = h.store.reload();
  assert.equal(h.store.reload(), refresh);
  h.mutate(); h.mutate();
  assert.equal(h.reads.length, 1);
  h.respond(0, fixture("old"), "r1"); await tick();
  assert.equal(h.reads.length, 2);
  assert.equal(h.reads[1].revision, "r1");
  assert.equal(h.store.getSnapshot().loading, true);
  h.respond(1, fixture("new"), "r2"); await refresh;
  assert.equal(h.reads.length, 2);
  assert.equal(h.store.getSnapshot().groups[0].standaloneSessions[0].id, "new");
  assert.equal(h.store.getSnapshot().loading, false);
  unsubscribe();
});

test("invalidation during the trailing read is not lost", async () => {
  const h = harness();
  const unsubscribe = h.store.subscribe(() => {});
  await tick();
  h.mutate(); h.respond(0); await tick();
  h.mutate(); h.respond(1, fixture("intermediate"), "r2"); await tick();
  assert.equal(h.reads.length, 3);
  h.respond(2, fixture("latest"), "r3"); await tick();
  assert.equal(h.store.getSnapshot().groups[0].standaloneSessions[0].id, "latest");
  unsubscribe();
});

test("revision unchanged keeps directory identity and archive splitting happens on changed data only", async () => {
  const h = harness();
  const unsubscribe = h.store.subscribe(() => {});
  await tick();
  const groups = fixture();
  groups[0].standaloneSessions.push({ id: "archived", archived: true });
  h.respond(0, groups, "r1"); await tick();
  const cached = h.store.getSnapshot().groups;
  assert.deepEqual(cached[0].standaloneSessions.map(session => session.id), ["loose"]);
  assert.deepEqual(cached[0].archivedSessions?.map(session => session.id), ["archived"]);
  h.poll(); await tick();
  assert.equal(h.reads[1].revision, "r1");
  h.respond(1, [], "r1", true); await tick();
  assert.equal(h.store.getSnapshot().groups, cached);
  assert.equal(h.store.getSnapshot().groups[0].archivedSessions?.length, 1);
  unsubscribe();
});

test("errors keep the successful directory and safe retry clears the error", async () => {
  const h = harness();
  const unsubscribe = h.store.subscribe(() => {});
  await tick(); h.respond(0); await tick();
  const cached = h.store.getSnapshot().groups;
  const failure = h.store.reload(); await tick();
  h.reads[1].result.reject(new Error("HTTP 503 /private/config token=secret")); await failure;
  assert.equal(h.store.getSnapshot().groups, cached);
  assert.equal(h.store.getSnapshot().loading, false);
  assert.equal(h.store.getSnapshot().error, "HTTP 503 [路径] [凭据已隐藏]");
  const retry = h.store.reload(); await tick();
  h.respond(2, [], "r1", true); await retry;
  assert.equal(h.store.getSnapshot().groups, cached);
  assert.equal(h.store.getSnapshot().error, "");
  unsubscribe();
});

test("last unsubscribe discards cached identity, revision and late receipts before a new subscriber", async () => {
  const h = harness();
  const first = h.store.subscribe(() => {});
  await tick(); h.respond(0); await tick();
  h.poll(); await tick();
  assert.equal(h.reads[1].revision, "r1");
  first();
  assert.deepEqual(h.store.getSnapshot(), { groups: [], loading: true, error: "" });
  const second = h.store.subscribe(() => {}); await tick();
  assert.equal(h.reads[2].revision, undefined);
  h.respond(2, fixture("new-login"), "r2"); await tick();
  h.respond(1, fixture("late-old-login"), "old"); await tick();
  assert.equal(h.store.getSnapshot().groups[0].standaloneSessions[0].id, "new-login");
  second();
});

test("a failed first read distinguishes error from an empty successful directory", async () => {
  const h = harness();
  const unsubscribe = h.store.subscribe(() => {}); await tick();
  h.reads[0].result.reject(new Error("Failed to fetch")); await tick();
  assert.equal(h.store.getSnapshot().error, "无法加载任务列表。");
  assert.equal(h.store.getSnapshot().loading, false);
  const retry = h.store.reload(); await tick(); h.respond(1, []); await retry;
  assert.deepEqual(h.store.getSnapshot(), { groups: [], loading: false, error: "" });
  unsubscribe();
});

test("a synchronous observer refresh joins the pending read and unmount before scheduling avoids IO", async () => {
  const h = harness();
  let refreshed = false;
  const unsubscribe = h.store.subscribe(() => {
    if (h.store.getSnapshot().loading && !refreshed) { refreshed = true; void h.store.reload(); }
  });
  await tick(); h.respond(0); await tick();
  assert.equal(h.reads.length, 2, "refresh from the changed-data notification queues one trailing read");
  h.respond(1); await tick();
  refreshed = false;
  const reload = h.store.reload(); await tick();
  assert.equal(h.reads.length, 3, "the loading notification cannot start a concurrent read");
  h.respond(2); await reload;
  assert.equal(h.reads.length, 3, "invalidation before IO begins is covered by that read");
  unsubscribe();
  const immediate = harness();
  const stop = immediate.store.subscribe(() => {}); stop(); await tick();
  assert.equal(immediate.reads.length, 0);
});
