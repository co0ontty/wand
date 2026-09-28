import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { WandStorage } from "../src/storage.js";
import type { SessionSnapshot } from "../src/types.js";

function database(t: TestContext): { storage: WandStorage; dbPath: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wand-task-records-"));
  const dbPath = path.join(directory, "wand.db");
  const storage = new WandStorage(dbPath);
  t.after(() => {
    try { storage.close(); } catch { /* A migration test may have reopened this database. */ }
    rmSync(directory, { recursive: true, force: true });
  });
  return { storage, dbPath };
}

function snapshot(id: string, workspaceTaskId?: string): SessionSnapshot {
  return {
    id, sessionKind: "pty", provider: "codex", command: "codex", cwd: "/tmp/original-cwd",
    mode: "full-access", status: "running", exitCode: null,
    startedAt: "2026-09-28T00:00:00.000Z", endedAt: null,
    output: "original terminal history", archived: false, archivedAt: null,
    claudeSessionId: null, workspaceTaskId,
  };
}

function legacyMutation(dbPath: string, action: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(dbPath);
  try { action(db); } finally { db.close(); }
}

test("either task creation entry point immediately returns both compatible projections", (t) => {
  const { storage } = database(t);
  const project = storage.createWorkspace({ name: "Project", cwd: "/tmp/project" });
  const sidebar = storage.createWorkspaceTask({
    workspaceId: project.id, name: "Same name", board: { description: "sidebar details" },
  });
  const card = storage.getWandTaskByWorkspaceTaskId(sidebar.id)!;
  const board = storage.createWandTask({ workspaceId: project.id, title: "Same name" });
  assert.notEqual(card.id, board.id);
  assert.notEqual(sidebar.id, board.workspaceTaskId);
  assert.equal(card.description, "sidebar details");
  assert.equal(card.status, "todo");
  assert.equal(storage.getWorkspaceTask(board.workspaceTaskId!)?.name, board.title);
  assert.equal(storage.listWorkspaceTasks(project.id).length, 2);
  assert.equal(card.milestoneId, storage.findDefaultWandMilestone()?.id);
});

test("one metadata writer changes both DTOs and task fingerprints while preserving container data", (t) => {
  const { storage, dbPath } = database(t);
  const project = storage.createWorkspace({ name: "Project", cwd: "/tmp/project" });
  const task = storage.createWorkspaceTask({
    workspaceId: project.id, name: "Original", cwd: "/tmp/mounted",
    worktree: { path: "/tmp/worktree", branch: "feature" },
  });
  const card = storage.getWandTaskByWorkspaceTaskId(task.id)!;
  const fingerprint = storage.tasksAggregateFingerprint();
  storage.updateWandTask(card.id, { title: "Renamed", status: "archived" });
  assert.notEqual(storage.tasksAggregateFingerprint(), fingerprint);
  assert.equal(storage.getWorkspaceTask(task.id)?.name, "Renamed");
  assert.equal(storage.getWorkspaceTask(task.id)?.status, "done");
  assert.equal(storage.getWorkspaceTask(task.id)?.cwd, "/tmp/mounted");
  assert.deepEqual(storage.getWorkspaceTask(task.id)?.worktree, task.worktree);
  // Old columns remain for schema compatibility but have stopped being a second writer.
  legacyMutation(dbPath, (db) => {
    const old = db.prepare("SELECT name, status FROM workspace_tasks WHERE id = ?").get(task.id);
    assert.equal(old?.name, "Original");
    assert.equal(old?.status, "active");
  });
  storage.updateWorkspaceTask(task.id, { status: "done" });
  assert.equal(storage.getWandTask(card.id)?.status, "archived");
  storage.updateWorkspaceTask(task.id, { name: "User name", status: "active" });
  assert.equal(storage.getWandTask(card.id)?.titleSource, "user");
  assert.equal(storage.getWandTask(card.id)?.status, "doing");
});

test("canonical NULL does not restore a stale container milestone and reads do not mutate it", (t) => {
  const { storage, dbPath } = database(t);
  const project = storage.createWorkspace({ name: "Project", cwd: "/tmp/project" });
  const iteration = storage.createWandMilestone({ name: "Old iteration" });
  const task = storage.createWorkspaceTask({ workspaceId: project.id, name: "Task", milestoneId: iteration.id });
  const card = storage.getWandTaskByWorkspaceTaskId(task.id)!;
  legacyMutation(dbPath, (db) => {
    db.prepare("UPDATE wand_tasks SET milestone_id = NULL WHERE id = ?").run(card.id);
  });
  assert.equal(storage.getWorkspaceTask(task.id)?.milestoneId, null);
  assert.equal(storage.listWorkspaceTasks(project.id)[0]?.milestoneId, null);
  assert.equal(storage.getWandTask(card.id)?.milestoneId, null);
  storage.updateWorkspaceTask(task.id, { milestoneId: null });
  assert.equal(storage.getWandTask(card.id)?.milestoneId, storage.findDefaultWandMilestone()?.id);
});

test("session creation and movement use persisted membership without list-driven repair", (t) => {
  const { storage } = database(t);
  const firstProject = storage.createWorkspace({ name: "First", cwd: "/tmp/first" });
  const secondProject = storage.createWorkspace({ name: "Second", cwd: "/tmp/second" });
  const source = storage.createWorkspaceTask({ workspaceId: firstProject.id, name: "Source" });
  const target = storage.createWorkspaceTask({ workspaceId: secondProject.id, name: "Target" });
  const sourceCard = storage.getWandTaskByWorkspaceTaskId(source.id)!;
  const targetCard = storage.getWandTaskByWorkspaceTaskId(target.id)!;
  const old = snapshot("live-session", source.id);
  storage.saveSession(old);
  assert.equal(storage.getWandTask(sourceCard.id)?.status, "doing");
  assert.equal(storage.getWandTask(sourceCard.id)?.agent?.kind, "pty");
  assert.equal(storage.getSessionWorkspace(old.id)?.workspaceId, firstProject.id);
  storage.bindWandTaskSession(targetCard.id, old.id);
  storage.saveSession(old);
  assert.equal(storage.getSession(old.id)?.cwd, old.cwd);
  assert.equal(storage.getSession(old.id)?.output, old.output);
  assert.equal(storage.getSession(old.id)?.status, "running");
  assert.equal(storage.getSessionWorkspace(old.id)?.workspaceId, secondProject.id);
  assert.deepEqual(storage.listWandTaskSessionIds(sourceCard.id), []);
  assert.deepEqual(storage.listWandTaskSessionIds(targetCard.id), [old.id]);
  storage.updateWandTask(targetCard.id, { status: "todo" });
  storage.bindWandTaskSession(targetCard.id, old.id);
  storage.saveSession(old);
  assert.equal(storage.getWandTask(targetCard.id)?.status, "todo");
});

test("invalid movement rolls back ownership and layout, including after SQLite reopen", (t) => {
  const { storage, dbPath } = database(t);
  const project = storage.createWorkspace({ name: "Project", cwd: "/tmp/project" });
  const task = storage.createWorkspaceTask({ workspaceId: project.id, name: "Task" });
  const session = snapshot("live", task.id);
  storage.saveSession(session);
  storage.saveWorkspaceTaskLayout(task.id, {
    type: "windows", activeWindowId: "main", windows: [{ id: "main", activeTabId: "live",
      layout: { type: "pane", tabs: [{ id: "live", kind: "session", sessionId: session.id }], active: 0 },
    }],
  });
  const layout = storage.getWorkspaceTask(task.id)?.layout;
  assert.throws(() => storage.moveSessionToWorkspaceTask(session.id, "missing"), /目标任务/);
  storage.close();
  const reopened = new WandStorage(dbPath);
  t.after(() => reopened.close());
  assert.equal(reopened.getSessionWorkspace(session.id)?.workspaceTaskId, task.id);
  assert.deepEqual(reopened.getWorkspaceTask(task.id)?.layout, layout);
  assert.equal(reopened.getWorkspaceTask(task.id)?.layoutRevision, 1);
});

test("deleted containers leave archived history and reopening cannot recreate them", (t) => {
  const { storage, dbPath } = database(t);
  const project = storage.createWorkspace({ name: "Project", cwd: "/tmp/project" });
  const task = storage.createWorkspaceTask({ workspaceId: project.id, name: "Task" });
  const card = storage.getWandTaskByWorkspaceTaskId(task.id)!;
  storage.saveSession(snapshot("live", task.id));
  storage.deleteWorkspaceTask(task.id);
  assert.equal(storage.getWandTask(card.id)?.status, "archived");
  assert.equal(storage.getWandTask(card.id)?.workspaceTaskId, null);
  assert.equal(storage.getSessionWorkspace("live")?.workspaceTaskId, undefined);
  assert.deepEqual(storage.listWandTaskSessionIds(card.id), ["live"]);
  storage.close();
  const reopened = new WandStorage(dbPath);
  t.after(() => reopened.close());
  assert.equal(reopened.getWorkspaceTask(task.id), null);
  assert.equal(reopened.getWandTask(card.id)?.workspaceTaskId, null);
});

test("legacy reconciliation is idempotent, preserves NULL iterations and ignores unrelated titles", (t) => {
  const { storage, dbPath } = database(t);
  const project = storage.createWorkspace({ name: "Project", cwd: "/tmp/project" });
  const container = storage.createWorkspaceTask({ workspaceId: project.id, name: "Same name" });
  const oldCard = storage.getWandTaskByWorkspaceTaskId(container.id)!;
  const session = snapshot("legacy-session", container.id);
  storage.saveSession(session);
  storage.close();
  legacyMutation(dbPath, (db) => {
    db.exec("DELETE FROM app_config WHERE key = 'pref:taskRecordsVersion'");
    db.prepare("DELETE FROM wand_tasks WHERE id = ?").run(oldCard.id);
    db.prepare("UPDATE workspace_tasks SET milestone_id = NULL WHERE id = ?").run(container.id);
    db.prepare(`INSERT INTO wand_tasks (id, title, status, created_at, updated_at)
      VALUES ('archived-orphan', 'Same name', 'archived', '2020', '2020')`).run();
  });
  const migrated = new WandStorage(dbPath);
  const linked = migrated.getWandTaskByWorkspaceTaskId(container.id)!;
  assert.equal(linked.milestoneId, null);
  assert.deepEqual(migrated.listWandTaskSessionIds(linked.id), [session.id]);
  assert.equal(migrated.getWandTask("archived-orphan")?.workspaceTaskId, null);
  const ids = migrated.listWandTasks().map((card) => card.id);
  migrated.close();
  const reopened = new WandStorage(dbPath);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.listWandTasks().map((card) => card.id), ids);
  assert.equal(reopened.getWorkspaceTask(container.id)?.milestoneId, null);
  assert.equal(reopened.listWorkspaceTasks(project.id).length, 1);
});

test("legacy duplicate card links choose updated time then row order without duplicating containers", (t) => {
  const { storage, dbPath } = database(t);
  const project = storage.createWorkspace({ name: "Project", cwd: "/tmp/project" });
  const container = storage.createWorkspaceTask({ workspaceId: project.id, name: "Old" });
  legacyMutation(dbPath, (db) => {
    for (const [id, title] of [["newer", "Newer"], ["tie", "Tie wins"]]) {
      db.prepare(`INSERT INTO wand_tasks (id, workspace_id, workspace_task_id, title, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'todo', '2099', '2099')`).run(id, project.id, container.id, title);
    }
  });
  assert.equal(storage.getWandTaskByWorkspaceTaskId(container.id)?.id, "tie");
  assert.equal(storage.getWorkspaceTask(container.id)?.name, "Tie wins");
  assert.equal(storage.listWorkspaceTasks(project.id).length, 1);
});


test("changing a project's task iteration cannot attach a foreign project's milestone", (t) => {
  const { storage } = database(t);
  const first = storage.createWorkspace({ name: "First", cwd: "/tmp/first" });
  const second = storage.createWorkspace({ name: "Second", cwd: "/tmp/second" });
  const milestone = storage.createWandMilestone({ name: "Foreign", workspaceId: second.id });
  const task = storage.createWorkspaceTask({ workspaceId: first.id, name: "Task" });
  storage.updateWorkspaceTask(task.id, { milestoneId: milestone.id });
  assert.equal(storage.getWorkspaceTask(task.id)?.milestoneId, storage.findDefaultWandMilestone()?.id);
  const card = storage.getWandTaskByWorkspaceTaskId(task.id)!;
  storage.updateWandTask(card.id, { workspaceId: second.id, milestoneId: milestone.id });
  assert.equal(storage.getWorkspaceTask(task.id)?.milestoneId, milestone.id);
  assert.equal(storage.listWorkspaceTasks(first.id).length, 0);
  assert.equal(storage.listWorkspaceTasks(second.id).length, 1);
});


test("restoring a detached archived card creates its container on the write, not a later read", (t) => {
  const { storage } = database(t);
  const card = storage.createWandTask({ title: "Task" });
  const oldContainerId = card.workspaceTaskId!;
  storage.deleteWorkspaceTask(oldContainerId);
  assert.equal(storage.getWandTask(card.id)?.workspaceTaskId, null);
  const restored = storage.updateWandTask(card.id, { status: "todo" })!;
  assert.ok(restored.workspaceTaskId);
  assert.notEqual(restored.workspaceTaskId, oldContainerId);
  assert.equal(storage.getWorkspaceTask(restored.workspaceTaskId!)?.status, "active");
  assert.equal(storage.listWandTasks().length, 1);
});
