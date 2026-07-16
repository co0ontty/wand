import assert from "node:assert/strict";
import test from "node:test";

import {
  LegacyUiAdapter,
  MemoryUiAdapter,
  type UiAction,
  type UiSnapshotData,
} from "../src/web-ui/react/shell/ui-store.js";

function fixture(overrides: Partial<UiSnapshotData> = {}): UiSnapshotData {
  return {
    auth: { phase: "authenticated" },
    viewport: { mobile: false, online: true, embedTerminal: false, nativeInput: false },
    capabilities: { backToNative: false, switchServer: false },
    layout: {
      sessionsDrawerOpen: true,
      sidebarPinned: true,
      sidebarCollapsed: false,
      sidebarAnchored: true,
      sessionsBackdropVisible: false,
      filePanelOpen: false,
      filePanelBackdropVisible: false,
      topbarMoreOpen: false,
      currentView: "chat",
    },
    selected: {
      id: "session-1",
      source: "wand",
      provider: "claude",
      kind: "structured",
      title: "Migration",
      description: "Move shell state behind a store",
      cwd: "/workspace",
      status: "idle",
      statusLabel: "Ready",
      active: true,
      selected: true,
      resumable: false,
      permissionBlocked: false,
      inFlight: false,
    },
    sidebar: {
      interactiveCount: 1,
      totalCount: 1,
      manageMode: false,
      selectedCount: 0,
      groups: [{
        kind: "wand",
        label: "Sessions",
        expanded: true,
        entries: [],
      }],
    },
    topbar: {
      title: "Migration",
      description: "Move shell state behind a store",
      statusLabel: "Ready",
      statusTone: "idle",
      cwd: "/workspace",
      currentTask: "",
      git: { branch: "main", modifiedCount: 0, clean: true },
    },
    legacyVisibility: { terminal: false, chat: true, blank: false, composer: true },
    ...overrides,
  };
}

async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("getSnapshot caches identity and isolates snapshots from mutable legacy input", () => {
  const input = fixture() as UiSnapshotData & { terminalOutput?: string };
  input.terminalOutput = "must not cross the shell seam";
  const adapter = new MemoryUiAdapter(input);
  const first = adapter.getSnapshot();

  assert.strictEqual(adapter.getSnapshot(), first);
  assert.equal(first.revision, 0);
  assert.equal(first.topbar.title, "Migration");
  assert.equal("terminalOutput" in first, false);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.topbar));

  input.topbar = { ...input.topbar, title: "Mutated outside" };
  assert.equal(first.topbar.title, "Migration");
  assert.throws(() => {
    (first.topbar as { title: string }).title = "Mutated through snapshot";
  }, TypeError);

  const next = fixture({ topbar: { ...input.topbar, title: "Published" } });
  adapter.setSnapshot(next, { sync: true });
  assert.notStrictEqual(adapter.getSnapshot(), first);
  assert.equal(adapter.getSnapshot().revision, 1);
  assert.equal(adapter.getSnapshot().topbar.title, "Published");
  adapter.dispose();
});

test("subscriptions notify from a stable snapshot and unsubscription is idempotent", () => {
  const adapter = new MemoryUiAdapter(fixture());
  const seen: number[] = [];
  const unsubscribe = adapter.subscribe(() => seen.push(adapter.getSnapshot().revision));

  adapter.setSnapshot(fixture({ auth: { phase: "anonymous" } }), { sync: true });
  unsubscribe();
  unsubscribe();
  adapter.setSnapshot(fixture({ auth: { phase: "booting" } }), { sync: true });

  assert.deepEqual(seen, [1]);
  assert.strictEqual(adapter.getSnapshot(), adapter.getSnapshot());
  adapter.dispose();
});

test("legacy invalidations batch in a microtask and sync publish cancels queued work", async () => {
  let current = fixture();
  let reads = 0;
  let notifyLegacy: ((reason?: string) => void) | null = null;
  const adapter = new LegacyUiAdapter({
    readSnapshot: () => {
      reads += 1;
      return current;
    },
    applyAction: () => {},
    subscribeLegacy: (listener) => {
      notifyLegacy = listener;
      return () => { notifyLegacy = null; };
    },
    batchMs: 0,
  });
  let notifications = 0;
  adapter.subscribe(() => { notifications += 1; });

  current = fixture({ auth: { phase: "anonymous" } });
  notifyLegacy?.("auth");
  notifyLegacy?.("auth");
  notifyLegacy?.("layout");
  assert.equal(reads, 1);
  assert.equal(notifications, 0);

  await nextMicrotask();
  assert.equal(reads, 2);
  assert.equal(notifications, 1);
  assert.equal(adapter.getSnapshot().auth.phase, "anonymous");

  current = fixture({ auth: { phase: "booting" } });
  notifyLegacy?.("auth");
  adapter.publish({ sync: true, reason: "test" });
  assert.equal(reads, 3);
  await nextMicrotask();
  assert.equal(reads, 3);
  assert.equal(notifications, 2);
  adapter.dispose();
});

test("timer batching supports the full 0-200ms configuration range", async () => {
  assert.throws(() => new MemoryUiAdapter(fixture(), { batchMs: -1 }), RangeError);
  assert.throws(() => new MemoryUiAdapter(fixture(), { batchMs: 201 }), RangeError);
  const upperBound = new MemoryUiAdapter(fixture(), { batchMs: 200 });
  upperBound.dispose();

  let notifyLegacy: (() => void) | null = null;
  let reads = 0;
  const adapter = new LegacyUiAdapter({
    readSnapshot: () => {
      reads += 1;
      return fixture();
    },
    applyAction: () => {},
    subscribeLegacy: (listener) => {
      notifyLegacy = listener;
      return () => {};
    },
    batchMs: 5,
  });
  const notified = new Promise<void>((resolve) => adapter.subscribe(resolve));
  notifyLegacy?.();
  notifyLegacy?.();
  await notified;

  assert.equal(reads, 2);
  assert.equal(adapter.getSnapshot().revision, 1);
  adapter.dispose();
});

test("dispatch routes discriminated actions, refreshes state, and preserves promise errors", async () => {
  let current = fixture();
  const actions: UiAction[] = [];
  const failure = new Error("action failed");
  const adapter = new LegacyUiAdapter({
    readSnapshot: () => current,
    applyAction: (action) => {
      actions.push(action);
      if (action.type === "layout.drawer.toggle") {
        current = fixture({
          layout: { ...current.layout, sessionsDrawerOpen: !current.layout.sessionsDrawerOpen },
        });
        return;
      }
      if (action.type === "layout.files.refresh") {
        return Promise.resolve().then(() => {
          current = fixture({ layout: { ...current.layout, filePanelOpen: true } });
        });
      }
      return Promise.reject(failure);
    },
    subscribeLegacy: () => () => {},
  });

  adapter.dispatch({ type: "layout.drawer.toggle" });
  assert.equal(adapter.getSnapshot().layout.sessionsDrawerOpen, false);
  assert.equal(adapter.getSnapshot().revision, 1);

  await adapter.dispatch({ type: "layout.files.refresh" });
  assert.equal(adapter.getSnapshot().layout.filePanelOpen, true);
  assert.equal(adapter.getSnapshot().revision, 3);

  await assert.rejects(adapter.dispatch({ type: "auth.logout" }), failure);
  assert.equal(adapter.getSnapshot().revision, 5);
  assert.deepEqual(actions.map((action) => action.type), [
    "layout.drawer.toggle",
    "layout.files.refresh",
    "auth.logout",
  ]);
  adapter.dispose();
});

test("memory adapter keeps an isolated action log", () => {
  const adapter = new MemoryUiAdapter(fixture());
  const action: UiAction = { type: "session.select", id: "session-2" };
  adapter.dispatch(action);
  action.id = "mutated-outside";

  assert.deepEqual(adapter.actionLog, [{ type: "session.select", id: "session-2" }]);
  assert.ok(Object.isFrozen(adapter.actionLog[0]));
  assert.equal(adapter.getSnapshot().revision, 1);
  adapter.clearActionLog();
  assert.deepEqual(adapter.actionLog, []);
  adapter.dispose();
});

test("dispose cancels queued publication, unsubscribes legacy events, and makes publish inert", async () => {
  let notifyLegacy: (() => void) | null = null;
  let reads = 0;
  let unsubscribes = 0;
  let notifications = 0;
  const adapter = new LegacyUiAdapter({
    readSnapshot: () => {
      reads += 1;
      return fixture();
    },
    applyAction: () => {},
    subscribeLegacy: (listener) => {
      notifyLegacy = listener;
      return () => {
        unsubscribes += 1;
        notifyLegacy = null;
      };
    },
  });
  adapter.subscribe(() => { notifications += 1; });
  notifyLegacy?.();
  adapter.dispose();
  adapter.dispose();
  adapter.publish({ sync: true });
  await nextMicrotask();

  assert.equal(unsubscribes, 1);
  assert.equal(reads, 1);
  assert.equal(notifications, 0);
  assert.throws(() => adapter.dispatch({ type: "nav.home" }), /disposed/);
});
