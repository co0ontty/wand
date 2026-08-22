import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDirectoryTree, normalizeSessionDirectory } from "../src/session-directory-tree.js";
import { buildSessionDirectoryTree } from "../src/server-session-routes.js";
import { WandStorage } from "../src/storage.js";
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
  const first = buildSessionDirectoryTree(sessions);
  const second = buildSessionDirectoryTree(sessions);

  assert.equal(first.roots[0].path, "/workspace/wand");
  assert.equal(first.roots[0].directCount, 2);
  assert.equal(first.revision, second.revision);
  assert.match(first.revision, /^[A-Za-z0-9_-]+$/);
});

test("custom workspace names are exposed without replacing filesystem names", () => {
  const sources = [{ entry: "leaf", cwd: "/workspace/projects/wand", sortTimestamp: 10 }];
  const tree = buildDirectoryTree(
    sources,
    "未知目录",
    new Map([["/workspace/projects", "核心工作区"]]),
  );

  assert.equal(tree.roots[0].path, "/workspace/projects");
  assert.equal(tree.roots[0].name, "/workspace/projects");
  assert.equal(tree.roots[0].customName, "核心工作区");
  assert.equal(tree.roots[0].children[0].path, "/workspace/projects/wand");

  const reset = buildDirectoryTree(sources);
  assert.equal(reset.roots[0].path, "/workspace/projects/wand");
  assert.equal(reset.roots[0].children.length, 0);
});

test("session directory revision changes when a visible workspace name changes", () => {
  const sessions = [session("named", "/workspace/wand", "2026-08-06T12:00:00.000Z")];
  const unnamed = buildSessionDirectoryTree(sessions);
  const named = buildSessionDirectoryTree(
    sessions,
    new Map([["/workspace/wand", "Wand 工作区"]]),
  );
  const repeated = buildSessionDirectoryTree(
    sessions,
    new Map([["/workspace/wand", "Wand 工作区"]]),
  );

  assert.equal(named.roots[0].customName, "Wand 工作区");
  assert.equal(named.revision, unnamed.revision);
  assert.notEqual(named.treeRevision, unnamed.treeRevision);
  assert.equal(named.treeRevision, repeated.treeRevision);
});

test("workspace names persist independently of session rows", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-directory-names-"));
  const dbPath = path.join(root, "wand.db");
  try {
    const writer = new WandStorage(dbPath);
    writer.setSessionDirectoryName("/workspace/wand/", "  Wand 工作区  ");
    writer.close();

    const reader = new WandStorage(dbPath);
    assert.deepEqual(
      [...reader.listSessionDirectoryNames()],
      [["/workspace/wand", "Wand 工作区"]],
    );
    reader.setSessionDirectoryName("/workspace/wand", null);
    assert.equal(reader.listSessionDirectoryNames().size, 0);
    reader.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
