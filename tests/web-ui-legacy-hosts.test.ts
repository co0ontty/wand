import assert from "node:assert/strict";
import test from "node:test";

import {
  LegacyChatHost,
  LegacyComposerHost,
  LegacyHost,
  LegacyTerminalHost,
  type LegacyComposerEvents,
  type LegacyComposerSelection,
  type LegacyHostSlot,
  type LegacySyncContext,
} from "../src/web-ui/react/shell/index.js";

class FakeSlot implements LegacyHostSlot {
  readonly childNodes: unknown[] = [];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("LegacyHost requires an empty React slot, mounts idempotently, and rejects slot switching", () => {
  const calls: string[] = [];
  const host = new LegacyHost<FakeSlot>("TestHost", {
    mount(slot) {
      calls.push("mount");
      slot.childNodes.push({ owner: "legacy" });
    },
    unmount() {
      calls.push("unmount");
    },
  });
  const slot = new FakeSlot();
  const otherSlot = new FakeSlot();

  const first = host.mount(slot);
  const second = host.mount(slot);
  assert.equal(first.generation, second.generation);
  assert.deepEqual(calls, ["mount"]);
  assert.throws(() => host.mount(otherSlot), /cannot switch to a different slot/);

  host.unmount(slot);
  host.unmount(slot);
  assert.deepEqual(calls, ["mount", "unmount"]);
  const remounted = host.mount(slot);
  assert.ok(remounted.generation > first.generation);
  assert.deepEqual(calls, ["mount", "unmount", "mount"]);
  assert.equal(host.isCurrent(first), false);
  assert.equal(host.isCurrent(remounted), true);

  host.dispose();
  assert.throws(() => host.mount(slot), /has been disposed/);

  const occupied = new FakeSlot();
  occupied.childNodes.push({ owner: "react" });
  const occupiedHost = new LegacyHost("OccupiedHost", { mount() {} });
  assert.throws(() => occupiedHost.mount(occupied), /requires an empty React slot/);
});

test("LegacyTerminalHost preserves #output identity and drops stale epochs", async () => {
  const slot = new FakeSlot();
  const output = { id: "output" };
  const pending = new Map<string, Deferred<string>>();
  const commits: Array<{ output: typeof output; payload: string; sessionId: string }> = [];
  const host = new LegacyTerminalHost<FakeSlot, typeof output, string>({
    mount(target) {
      if (target.childNodes.length === 0) target.childNodes.push(output);
    },
    findOutput(target) {
      return target.childNodes.find((node) => node === output) as typeof output | undefined ?? null;
    },
    load(sessionId) {
      const task = deferred<string>();
      pending.set(sessionId, task);
      return task.promise;
    },
    commit(committedOutput, payload, context) {
      commits.push({ output: committedOutput, payload, sessionId: context.sessionId });
    },
  });

  host.mount(slot);
  const firstOutput = host.output;
  const first = host.sync("session-a");
  const second = host.sync("session-b");
  pending.get("session-a")?.resolve("old");
  assert.equal((await first).status, "stale");
  pending.get("session-b")?.resolve("new");
  assert.equal((await second).status, "applied");
  assert.strictEqual(host.output, firstOutput);
  assert.deepEqual(commits, [{ output, payload: "new", sessionId: "session-b" }]);

  const beforeUnmount = host.sync("session-c");
  host.unmount(slot);
  host.mount(slot);
  pending.get("session-c")?.resolve("late generation");
  assert.equal((await beforeUnmount).status, "stale");
  assert.strictEqual(host.output, firstOutput);
  host.dispose();
});

test("LegacyTerminalHost detects replacement of the legacy #output node", async () => {
  const slot = new FakeSlot();
  const original = { id: "output", generation: 1 };
  const replacement = { id: "output", generation: 2 };
  const task = deferred<string>();
  let current = original;
  const host = new LegacyTerminalHost<FakeSlot, typeof original, string>({
    mount(target) {
      target.childNodes.push(original);
    },
    findOutput() {
      return current;
    },
    load() {
      return task.promise;
    },
    commit() {},
  });

  host.mount(slot);
  const syncing = host.sync("session-a");
  current = replacement;
  task.resolve("payload");
  await assert.rejects(syncing, /preserve #output identity/);
  host.dispose();
});

test("LegacyChatHost applies only the latest async epoch and active generation", async () => {
  const slot = new FakeSlot();
  const pending = new Map<string, Deferred<string>>();
  const commits: string[] = [];
  const host = new LegacyChatHost<FakeSlot, string>({
    mount(target) {
      if (target.childNodes.length === 0) target.childNodes.push({ id: "chat-output" });
    },
    load(sessionId) {
      const task = deferred<string>();
      pending.set(sessionId, task);
      return task.promise;
    },
    commit(_slot, payload, context) {
      commits.push(`${context.sessionId}:${payload}`);
    },
  });

  host.mount(slot);
  const first = host.sync("chat-a");
  const second = host.sync("chat-b");
  pending.get("chat-b")?.resolve("new");
  assert.equal((await second).status, "applied");
  pending.get("chat-a")?.resolve("old");
  assert.equal((await first).status, "stale");

  const detached = host.sync("chat-c");
  host.unmount(slot);
  pending.get("chat-c")?.resolve("detached");
  assert.equal((await detached).status, "stale");
  assert.deepEqual(commits, ["chat-b:new"]);
  host.dispose();
});

test("LegacyComposerHost guards draft, selection, and IME writes by session", async () => {
  const slot = new FakeSlot();
  const pending = new Map<string, Deferred<string>>();
  const applied: string[] = [];
  const activated: string[] = [];
  const drafts: Array<[string, string]> = [];
  const selections: Array<[string, LegacyComposerSelection]> = [];
  const composing: Array<[string, boolean]> = [];
  let events: LegacyComposerEvents | null = null;
  const host = new LegacyComposerHost<FakeSlot, string>({
    mount(target, nextEvents) {
      events = nextEvents;
      target.childNodes.push({ id: "input-box" });
    },
    activateSession(_slot, sessionId) {
      activated.push(sessionId);
    },
    loadSession(sessionId) {
      const task = deferred<string>();
      pending.set(sessionId, task);
      return task.promise;
    },
    applySession(_slot, payload, context) {
      applied.push(`${context.sessionId}:${payload}`);
    },
    saveDraft(sessionId, draft) {
      drafts.push([sessionId, draft]);
    },
    saveSelection(sessionId, selection) {
      selections.push([sessionId, selection]);
    },
    setComposing(sessionId, active) {
      composing.push([sessionId, active]);
    },
  });

  host.mount(slot);
  const sessionA = host.sync("session-a");
  const sessionB = host.sync("session-b");
  assert.deepEqual(activated, ["session-a", "session-b"]);
  assert.equal(events?.draftChanged("session-a", "stale draft"), false);
  assert.equal(events?.selectionChanged("session-a", { start: 1, end: 1 }), false);
  assert.equal(events?.compositionStarted("session-a"), null);

  assert.equal(events?.draftChanged("session-b", "current draft"), true);
  assert.equal(events?.selectionChanged("session-b", { start: 2, end: 3, direction: "forward" }), true);
  const oldIme = events?.compositionStarted("session-b");
  assert.ok(oldIme);

  const sessionC = host.sync("session-c");
  assert.equal(events?.compositionEnded(oldIme!, "must not cross sessions"), false);
  assert.equal(events?.draftChanged("session-b", "late input"), false);
  assert.deepEqual(composing, [["session-b", true], ["session-b", false]]);

  pending.get("session-a")?.resolve("old-a");
  pending.get("session-b")?.resolve("old-b");
  assert.equal((await sessionA).status, "stale");
  assert.equal((await sessionB).status, "stale");
  pending.get("session-c")?.resolve("current-c");
  assert.equal((await sessionC).status, "applied");

  const currentIme = events?.compositionStarted("session-c");
  assert.ok(currentIme);
  assert.equal(events?.compositionEnded(
    currentIme!,
    "完成输入",
    { start: 4, end: 4, direction: "none" },
  ), true);

  assert.deepEqual(applied, ["session-c:current-c"]);
  assert.deepEqual(drafts, [
    ["session-b", "current draft"],
    ["session-c", "完成输入"],
  ]);
  assert.deepEqual(selections, [
    ["session-b", { start: 2, end: 3, direction: "forward" }],
    ["session-c", { start: 4, end: 4, direction: "none" }],
  ]);
  assert.deepEqual(composing, [
    ["session-b", true],
    ["session-b", false],
    ["session-c", true],
    ["session-c", false],
  ]);
  host.dispose();
});

test("sync contexts expose a live guard to injected ports", async () => {
  const slot = new FakeSlot();
  const task = deferred<string>();
  let captured: LegacySyncContext | null = null;
  const host = new LegacyChatHost<FakeSlot, string>({
    mount() {},
    load(_sessionId, context) {
      captured = context;
      return task.promise;
    },
    commit() {},
  });

  host.mount(slot);
  const syncing = host.sync("guarded");
  assert.equal(captured?.isCurrent(), true);
  host.unmount(slot);
  assert.equal(captured?.isCurrent(), false);
  task.resolve("ignored");
  assert.equal((await syncing).status, "stale");
  host.dispose();
});
