import assert from "node:assert/strict";
import test from "node:test";

import { buildDirectoryTree, normalizeSessionDirectory } from "../src/session-directory-tree.js";
import { buildSessionDirectoryTree } from "../src/server-session-routes.js";
import type { SessionSnapshot } from "../src/types.js";

function session(id: string, cwd: string, startedAt: string): SessionSnapshot {
  return {
    id,
    sessionSource: "interactive",
    sessionKind: "structured",
    provider: "claude",
    command: "claude",
    cwd,
    mode: "assist",
    status: "idle",
    exitCode: null,
    startedAt,
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    messages: [],
    queuedMessages: [],
    structuredState: null,
    title: id,
  };
}

test("directory tree normalizes duplicate paths and counts descendants", () => {
  const tree = buildDirectoryTree([
    { entry: "root", cwd: "/workspace/project/", sortTimestamp: 10 },
    { entry: "same", cwd: "/workspace/project", sortTimestamp: 20 },
    { entry: "child", cwd: "/workspace/project/packages/app", sortTimestamp: 30 },
  ]);

  assert.equal(tree.totalSessions, 3);
  assert.equal(tree.directoryCount, 2);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].path, "/workspace/project");
  assert.equal(tree.roots[0].directCount, 2);
  assert.equal(tree.roots[0].totalCount, 3);
  assert.deepEqual(tree.roots[0].entries, ["same", "root"]);
  assert.equal(tree.roots[0].children[0].path, "/workspace/project/packages/app");
  assert.equal(tree.roots[0].children[0].totalCount, 1);
});

test("directory tree keeps unknown cwd synthetic and non-launchable", () => {
  const tree = buildDirectoryTree([
    { entry: "known", cwd: "/workspace", sortTimestamp: 1 },
    { entry: "unknown", cwd: "  ", sortTimestamp: 2 },
  ]);

  assert.equal(tree.directoryCount, 1);
  assert.equal(tree.roots.at(-1)?.synthetic, true);
  assert.equal(tree.roots.at(-1)?.path, "");
  assert.equal(tree.roots.at(-1)?.name, "未知目录");
});

test("directory normalization accepts Windows paths independent of test host", () => {
  assert.equal(normalizeSessionDirectory("C:\\work\\wand\\"), "C:\\work\\wand");
});

test("session directory response includes managed entries and stable revision", () => {
  const sessions = [
    session("new", "/workspace/wand", "2026-08-06T12:00:00.000Z"),
    session("old", "/workspace/wand", "2026-08-06T11:00:00.000Z"),
  ];
  const first = buildSessionDirectoryTree(sessions, [], [], new Set());
  const second = buildSessionDirectoryTree(sessions, [], [], new Set());

  assert.equal(first.roots[0].path, "/workspace/wand");
  assert.equal(first.roots[0].directCount, 2);
  assert.equal(first.revision, second.revision);
  assert.match(first.revision, /^[A-Za-z0-9_-]+$/);
});
