import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { ensureDatabaseFile, WandStorage } from "../src/storage.js";

function tempDatabase(t: TestContext, prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "wand.db");
}

function createLegacyWandTasksTable(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE wand_tasks (
      id TEXT PRIMARY KEY,
      identifier TEXT,
      workspace_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'none',
      labels_json TEXT NOT NULL DEFAULT '[]',
      due_date TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      agent_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO wand_tasks (id, identifier, title, created_at, updated_at)
    VALUES ('legacy-task', 'TASK-1', '旧任务', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  db.close();
}

function columnNames(dbPath: string, table: string): string[] {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  db.close();
  return rows.map((row) => row.name);
}

test("legacy wand_tasks without workspace_task_id can be opened and queried", (t) => {
  const dbPath = tempDatabase(t, "wand-legacy-tasks-");
  createLegacyWandTasksTable(dbPath);

  const storage = new WandStorage(dbPath);
  t.after(() => storage.close());

  const tasks = storage.listWandTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, "legacy-task");
  assert.equal(tasks[0]?.workspaceTaskId, null);
  assert.ok(columnNames(dbPath, "wand_tasks").includes("workspace_task_id"));
});

test("ensureDatabaseFile migrates legacy wand_tasks before creating the workspace_task index", (t) => {
  const dbPath = tempDatabase(t, "wand-legacy-tasks-init-");
  createLegacyWandTasksTable(dbPath);

  assert.equal(ensureDatabaseFile(dbPath), false);
  assert.ok(columnNames(dbPath, "wand_tasks").includes("workspace_task_id"));

  const storage = new WandStorage(dbPath);
  t.after(() => storage.close());
  assert.equal(storage.listWandTasks()[0]?.title, "旧任务");
});
