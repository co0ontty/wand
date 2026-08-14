import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import {
  attachUnboundSessionsToWorkspace,
  backfillSessionWorkspaces,
  ensureWorkspaceForCwd,
  findWorkspaceByCwd,
  normalizeProjectCwd,
  projectCwdForSession,
  resolveWorkspaceIdForNewSession,
} from "../src/workspace-binding.js";

test("normalizeProjectCwd treats trailing separators as the same directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-project-cwd-"));
  try {
    assert.equal(normalizeProjectCwd(`${root}${path.sep}`), normalizeProjectCwd(root));
    assert.equal(projectCwdForSession({
      cwd: "/tmp/repo/.wand-worktrees/task-a",
      worktree: { repoRoot: "/tmp/repo", path: "/tmp/repo/.wand-worktrees/task-a", branch: "task-a" },
    }), normalizeProjectCwd("/tmp/repo"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureWorkspaceForCwd reuses the project for the same directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-ensure-workspace-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  try {
    const first = ensureWorkspaceForCwd(storage, root, { name: "Acme" });
    const second = ensureWorkspaceForCwd(storage, `${root}${path.sep}`);
    assert.equal(second.id, first.id);
    assert.equal(second.name, "Acme");
    assert.equal(findWorkspaceByCwd(storage, root)?.id, first.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new sessions without an explicit workspace join or create the project for that cwd", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-bind-new-session-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const existing = storage.createWorkspace({ name: "Bind", cwd: root });
  try {
    const joined = resolveWorkspaceIdForNewSession(storage, root);
    assert.equal(joined, existing.id);

    const other = mkdtempSync(path.join(root, "other-"));
    const createdId = resolveWorkspaceIdForNewSession(storage, other);
    const created = storage.getWorkspace(createdId ?? "");
    assert.ok(created);
    assert.equal(normalizeProjectCwd(created.cwd), normalizeProjectCwd(other));
    assert.equal(created.name, path.basename(other));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backfill attaches unbound sessions and creates missing projects", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-backfill-workspace-"));
  const other = mkdtempSync(path.join(os.tmpdir(), "wand-backfill-other-"));
  const config = { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" as const };
  const storage = new WandStorage(path.join(root, "wand.db"));
  const manager = new StructuredSessionManager(storage, config);
  try {
    const existing = storage.createWorkspace({ name: "Existing", cwd: root });
    const boundLater = manager.createSession({ cwd: root, mode: config.defaultMode });
    const needsProject = manager.createSession({ cwd: other, mode: config.defaultMode });
    const already = manager.createSession({ cwd: root, mode: config.defaultMode, workspaceId: existing.id });

    assert.equal(storage.getSession(boundLater.id)?.workspaceId, undefined);
    const result = backfillSessionWorkspaces(storage);
    assert.equal(result.bound, 2);
    assert.equal(result.created, 1);
    assert.equal(storage.getSession(boundLater.id)?.workspaceId, existing.id);
    assert.equal(storage.getSession(already.id)?.workspaceId, existing.id);
    const created = findWorkspaceByCwd(storage, other);
    assert.ok(created);
    assert.equal(storage.getSession(needsProject.id)?.workspaceId, created.id);
  } finally {
    manager.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("creating a project absorbs unbound sessions in that directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-absorb-workspace-"));
  const config = { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" as const };
  const storage = new WandStorage(path.join(root, "wand.db"));
  const manager = new StructuredSessionManager(storage, config);
  try {
    const session = manager.createSession({ cwd: root, mode: config.defaultMode });
    const workspace = storage.createWorkspace({ name: "Absorb", cwd: root });
    assert.equal(attachUnboundSessionsToWorkspace(storage, workspace), 1);
    assert.equal(storage.getSession(session.id)?.workspaceId, workspace.id);
    assert.equal(attachUnboundSessionsToWorkspace(storage, workspace), 0);
  } finally {
    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
