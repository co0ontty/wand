import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionListPage } from "../src/server-session-routes.js";
import type { SessionSnapshot } from "../src/types.js";

function session(id: string, startedAt: string, claudeSessionId: string | null = null): SessionSnapshot {
  return {
    id,
    sessionSource: "interactive",
    sessionKind: "structured",
    provider: "claude",
    command: "claude",
    cwd: "/workspace",
    mode: "assist",
    status: "idle",
    exitCode: null,
    startedAt,
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId,
    messages: [],
    queuedMessages: [],
    structuredState: null,
    title: id,
  };
}

test("session list page contains only Wand-managed sessions in timestamp order", () => {
  const page = buildSessionListPage([
    session("older", "2026-07-18T10:00:00.000Z"),
    session("newer", "2026-07-18T12:00:00.000Z", "provider-session"),
  ], 0, 40);

  assert.equal(page.total, 2);
  assert.deepEqual(page.entries.map((entry) => entry.key), [
    "session-newer",
    "session-older",
  ]);
  assert.ok(page.entries.every((entry) => entry.type === "managed"));
});

test("session list page clamps offsets and limits the returned window", () => {
  const entries = [
    session("new", "2026-07-18T12:00:00.000Z"),
    session("old", "2026-07-18T11:00:00.000Z"),
  ];
  const firstPage = buildSessionListPage(entries, 0, 1);
  const page = buildSessionListPage(entries, 1, 1);

  assert.equal(page.total, 2);
  assert.equal(page.offset, 1);
  assert.deepEqual(page.entries.map((entry) => entry.key), ["session-old"]);
  assert.equal(page.revision, firstPage.revision);
  assert.match(page.revision, /^[A-Za-z0-9_-]+$/);

  const changed = buildSessionListPage(
    [session("newer", "2026-07-18T13:00:00.000Z"), ...entries],
    0,
    1,
  );
  assert.notEqual(changed.revision, firstPage.revision);
});
