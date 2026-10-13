import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultIssueAgent } from "../src/web-ui/react/issues/task-board-agent.js";
import { parseIssueAssignment, readIssueAssignment, resolveIssueAssignment, writeIssueAssignment } from "../src/web-ui/react/issues/task-board-assignment.js";
import type { TaskExecutionSubject, WandTaskAgent } from "../src/task-types.js";

const defaults = createDefaultIssueAgent();
const sdk: WandTaskAgent = { provider: "pi", model: "test/model", thinkingEffort: "deep", mode: "managed", kind: "structured", engine: "sdk" };
const recent = { agent: sdk, subject: { type: "cli", id: "pi" } as TaskExecutionSubject };
const available = { employees: [{ id: "employee" }], teams: [{ id: "team" }] };

test("recent assignments preserve the whole execution choice without changing task defaults", () => {
  assert.deepEqual(parseIssueAssignment(recent), recent);
  assert.deepEqual(resolveIssueAssignment({}, recent, defaults, available), recent);
  assert.deepEqual(resolveIssueAssignment({}, null, defaults, available), { agent: defaults, subject: { type: "cli", id: "claude" } });
  assert.equal(defaults.provider, "claude");
});

test("task-specific CLI, employee and team assignments take precedence", () => {
  const codex = createDefaultIssueAgent("codex");
  assert.deepEqual(resolveIssueAssignment({ agent: codex }, recent, defaults, available), { agent: codex, subject: { type: "cli", id: "codex" } });
  for (const subject of [{ type: "employee", id: "employee" }, { type: "team", id: "team" }] as TaskExecutionSubject[]) {
    assert.deepEqual(resolveIssueAssignment({ executionSubject: subject }, recent, defaults, available).subject, subject);
  }
  assert.deepEqual(resolveIssueAssignment({ executionSubject: { type: "cli", id: "codex" } }, recent, defaults, available), { agent: codex, subject: { type: "cli", id: "codex" } });
});

test("employee and team choices are remembered by stable ID rather than name", () => {
  for (const subject of [{ type: "employee", id: "employee" }, { type: "team", id: "team" }] as TaskExecutionSubject[]) {
    const selection = { agent: sdk, subject };
    assert.deepEqual(parseIssueAssignment(selection), selection);
    assert.deepEqual(resolveIssueAssignment({}, selection, defaults, available), selection);
  }
});

test("deleted or archived subjects fall back, but a loading catalog does not discard IDs", () => {
  for (const type of ["employee", "team"] as const) {
    const selection = { agent: sdk, subject: { type, id: type } };
    assert.deepEqual(resolveIssueAssignment({}, selection, defaults, { employees: null, teams: null }), selection);
    assert.deepEqual(resolveIssueAssignment({}, selection, defaults, { employees: [], teams: [] }), { agent: defaults, subject: { type: "cli", id: "claude" } });
  }
  assert.equal(resolveIssueAssignment({}, { agent: sdk, subject: { type: "employee", id: "employee" } }, defaults, { ...available, employees: [{ id: "employee", archivedAt: "2026-01-01" }] }).subject.type, "cli");
});

test("invalid recent preferences are rejected instead of mixing provider and engine", () => {
  for (const value of [null, [], {}, { ...recent, subject: { type: "cli", id: "codex" } }, { ...recent, subject: { type: "employee", id: " " } }, { ...recent, agent: { ...sdk, model: null } }, { ...recent, agent: { ...sdk, provider: "codex" } }, { ...recent, agent: { ...sdk, kind: "pty" } }]) {
    assert.equal(parseIssueAssignment(value), null);
  }
  assert.deepEqual(parseIssueAssignment({ ...recent, ignored: "not persisted", agent: { ...sdk, ignored: "not persisted" }, subject: { ...recent.subject, ignored: "not persisted" } }), recent);
});

test("legacy choices normalize mode and kind while retaining CLI identity", () => {
  const selection = parseIssueAssignment({ agent: { provider: "codex", model: " model ", thinkingEffort: "off", mode: "managed" }, subject: { type: "cli", id: "codex" } });
  assert.deepEqual(selection, { agent: { provider: "codex", model: "model", thinkingEffort: "off", mode: "full-access", kind: "structured" }, subject: { type: "cli", id: "codex" } });
});

function withStorage(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }, run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
  try { run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("local preference survives host recreation and malformed stored JSON is safe", () => {
  const values = new Map<string, string>();
  withStorage({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } }, () => {
    assert.equal(readIssueAssignment(), null);
    writeIssueAssignment(recent);
    assert.deepEqual(readIssueAssignment(), recent);
    assert.equal(values.size, 1);
    const key = [...values.keys()][0]!;
    values.set(key, "not json"); assert.equal(readIssueAssignment(), null);
    values.set(key, '{"agent":{"provider":"pi"},"subject":{"type":"cli","id":"pi"}}');
    assert.equal(readIssueAssignment(), null);
  });
});

test("unavailable localStorage and server-side rendering remain usable", () => {
  assert.equal(readIssueAssignment(), null);
  assert.doesNotThrow(() => writeIssueAssignment(recent));
  withStorage({ getItem: () => { throw Error("blocked storage"); }, setItem: () => { throw Error("quota exceeded"); } }, () => {
    assert.equal(readIssueAssignment(), null);
    assert.doesNotThrow(() => writeIssueAssignment(recent));
  });
});
