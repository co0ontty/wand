import assert from "node:assert/strict";
import test from "node:test";

const storageKey = "wand-conversations-local-owner-v1";
type LocalStorage = Pick<Storage, "getItem" | "setItem">;
let importRevision = 0;

async function freshState(): Promise<typeof import("../src/web-ui/react/conversations/state.js")> {
  return import(`../src/web-ui/react/conversations/state.js?filter-test=${++importRevision}`);
}

async function withStorage(storage: LocalStorage | undefined, run: () => Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try { await run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

function memoryStorage(initial: string | null = null): LocalStorage & { values: Map<string, string>; writes: string[] } {
  const values = new Map(initial === null ? [] : [[storageKey, initial]]);
  const writes: string[] = [];
  return { values, writes, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); writes.push(key); } };
}

test("conversation archive filter defaults to all without overwriting legacy preferences", async () => {
  const legacy = { selectedId: "dm_existing", mode: "tasks", filters: { "list-query": "保留搜索" }, scrolls: { dm_existing: 42 } };
  const storage = memoryStorage(JSON.stringify(legacy));
  await withStorage(storage, async () => {
    const { conversationUi } = await freshState();
    assert.equal(conversationUi.getSnapshot().listFilter, "all");
    assert.equal(conversationUi.getSnapshot().selectedId, legacy.selectedId);
    assert.equal(conversationUi.getSnapshot().filters["list-query"], "保留搜索");
    assert.equal(conversationUi.getSnapshot().scrolls.dm_existing, 42);
    assert.deepEqual(storage.writes, [], "reading must not migrate or erase stored state");
  });
});

test("each archive tier survives a new page and unrelated conversation changes", async () => {
  const storage = memoryStorage();
  await withStorage(storage, async () => {
    const { conversationUi } = await freshState();
    conversationUi.select("dm_existing");
    conversationUi.filter("list-query", "保留搜索");
    conversationUi.target("dm_existing", { taskId: "task", runId: "run" });
    let notifications = 0;
    const unsubscribe = conversationUi.subscribe(() => { notifications++; });
    for (const filter of ["active", "archived", "all"] as const) {
      conversationUi.listFilter(filter);
      assert.equal(conversationUi.getSnapshot().listFilter, filter);
      conversationUi.mode("tasks");
      conversationUi.mode("chats");
      conversationUi.scroll("dm_existing", 84);
      const reloaded = (await freshState()).conversationUi.getSnapshot();
      assert.equal(reloaded.listFilter, filter);
      assert.equal(reloaded.selectedId, "dm_existing");
      assert.equal(reloaded.filters["list-query"], "保留搜索");
      assert.deepEqual(reloaded.targets.dm_existing, { taskId: "task", runId: "run" });
      assert.equal(reloaded.scrolls.dm_existing, 84);
    }
    assert.equal(notifications, 12);
    unsubscribe();
    conversationUi.listFilter("active");
    assert.equal(notifications, 12);
    assert.deepEqual([...storage.values.keys()], [storageKey], "reuse the existing conversation state owner");
  });
});

test("invalid stored archive tiers fall back without losing sibling state", async () => {
  for (const value of [null, "", "ACTIVE", "deleted", 0, {}, ["active"]]) {
    const storage = memoryStorage(JSON.stringify({ listFilter: value, selectedId: "dm_existing" }));
    await withStorage(storage, async () => {
      const { conversationUi } = await freshState();
      assert.equal(conversationUi.getSnapshot().listFilter, "all");
      assert.equal(conversationUi.getSnapshot().selectedId, "dm_existing");
      assert.deepEqual(storage.writes, []);
    });
  }
});

test("malformed JSON and non-object conversation snapshots remain safe", async () => {
  for (const value of ["not json", "null", "[]", "123", '"active"']) {
    await withStorage(memoryStorage(value), async () => {
      const { conversationUi } = await freshState();
      assert.equal(conversationUi.getSnapshot().listFilter, "all");
      conversationUi.listFilter("active");
      assert.equal((await freshState()).conversationUi.getSnapshot().listFilter, "active");
    });
  }
});

test("blocked or unavailable localStorage does not prevent in-page filtering", async () => {
  for (const storage of [undefined, { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("quota"); } }]) {
    await withStorage(storage, async () => {
      const { conversationUi } = await freshState();
      assert.equal(conversationUi.getSnapshot().listFilter, "all");
      conversationUi.listFilter("active");
      conversationUi.select("dm_existing");
      assert.equal(conversationUi.getSnapshot().listFilter, "active");
      assert.equal(conversationUi.getSnapshot().selectedId, "dm_existing");
    });
  }
});

test("activity filter persists independently of archive tiers and search", async () => {
  const storage = memoryStorage();
  await withStorage(storage, async () => {
    const { conversationUi } = await freshState();
    assert.equal(conversationUi.getSnapshot().activityOnly, false);
    conversationUi.activityOnly(true);
    conversationUi.listFilter("archived");
    conversationUi.filter("list-query", "保留搜索");
    const restored = (await freshState()).conversationUi;
    assert.equal(restored.getSnapshot().activityOnly, true);
    assert.equal(restored.getSnapshot().listFilter, "archived");
    assert.equal(restored.getSnapshot().filters["list-query"], "保留搜索");
    restored.activityOnly(false);
    assert.equal(restored.getSnapshot().listFilter, "archived");
  });
});

test("archive filter updates accept only the three known tiers", async () => {
  await withStorage(memoryStorage(), async () => {
    const { conversationUi } = await freshState();
    conversationUi.listFilter("archived");
    conversationUi.listFilter("unexpected");
    assert.equal(conversationUi.getSnapshot().listFilter, "all");
  });
});
