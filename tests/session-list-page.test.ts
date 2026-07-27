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

function history(
  claudeSessionId: string,
  mtimeMs: number,
  provider: "claude" | "codex" | "opencode" | "qoder" = "claude",
) {
  return {
    claudeSessionId,
    cwd: "/workspace",
    firstUserMessage: "question",
    timestamp: new Date(mtimeMs).toISOString(),
    mtimeMs,
    hasConversation: true,
    managedByWand: false,
    ...(provider === "claude" ? {} : { provider }),
  };
}

test("session list page mixes sorted entries and excludes managed or hidden history", () => {
  const managed = session("managed", "2026-07-18T12:00:00.000Z", "managed-history");
  const page = buildSessionListPage(
    [managed, session("older", "2026-07-18T10:00:00.000Z")],
    [
      history("managed-history", Date.parse("2026-07-18T13:00:00.000Z")),
      history("hidden", Date.parse("2026-07-18T11:00:00.000Z")),
      history("visible", Date.parse("2026-07-18T09:00:00.000Z")),
    ],
    [history("codex-visible", Date.parse("2026-07-18T11:30:00.000Z"), "codex")],
    new Set(["hidden"]),
    0,
    40,
  );

  assert.equal(page.total, 4);
  assert.deepEqual(page.entries.map((entry) => entry.key), [
    "session-managed",
    "recoverable-codex-codex-visible",
    "session-older",
    "recoverable-claude-visible",
  ]);
});

test("session list page clamps offsets and limits the returned window", () => {
  const entries = [
    session("new", "2026-07-18T12:00:00.000Z"),
    session("old", "2026-07-18T11:00:00.000Z"),
  ];
  const firstPage = buildSessionListPage(entries, [], [], new Set(), 0, 1);
  const page = buildSessionListPage(entries, [], [], new Set(), 1, 1);

  assert.equal(page.total, 2);
  assert.equal(page.offset, 1);
  assert.deepEqual(page.entries.map((entry) => entry.key), ["session-old"]);
  assert.equal(page.revision, firstPage.revision);
  assert.match(page.revision, /^[A-Za-z0-9_-]+$/);

  const changed = buildSessionListPage(
    [session("newer", "2026-07-18T13:00:00.000Z"), ...entries],
    [],
    [],
    new Set(),
    0,
    1,
  );
  assert.notEqual(changed.revision, firstPage.revision);
});

test("session list page includes recoverable OpenCode and Qoder provider histories", () => {
  const page = buildSessionListPage(
    [],
    [],
    [],
    new Set(),
    0,
    40,
    [history("ses_external", Date.parse("2026-07-20T12:00:00.000Z"), "opencode")],
    [history("qs_external", Date.parse("2026-07-20T11:00:00.000Z"), "qoder")],
  );

  assert.deepEqual(page.entries.map((entry) => entry.key), [
    "recoverable-opencode-ses_external",
    "recoverable-qoder-qs_external",
  ]);
  assert.deepEqual(page.entries.map((entry) => (
    entry.type === "recoverable" ? entry.history.provider : null
  )), ["opencode", "qoder"]);
});
