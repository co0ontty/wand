import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { RETENTION_ARCHIVED_MS, RETENTION_IDLE_MS, runRetentionSweep } from "../src/retention.js";
import type { SessionRegistry } from "../src/session-registry.js";
import { WandStorage } from "../src/storage.js";
import type { SessionSnapshot } from "../src/types.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-01-20T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function database(t: TestContext): { storage: WandStorage; dbPath: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wand-retention-"));
  const dbPath = path.join(directory, "wand.db");
  const storage = new WandStorage(dbPath);
  t.after(() => {
    try { storage.close(); } catch { /* ignore */ }
    rmSync(directory, { recursive: true, force: true });
  });
  return { storage, dbPath };
}

function snapshot(id: string, patch: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id,
    sessionKind: "pty",
    provider: "codex",
    command: "codex",
    cwd: "/tmp/project",
    mode: "full-access",
    status: "exited",
    exitCode: 0,
    startedAt: iso(NOW - 8 * DAY),
    endedAt: iso(NOW - 8 * DAY),
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    ...patch,
  };
}

function fakeRegistry(initial: readonly SessionSnapshot[]): {
  registry: SessionRegistry;
  current: Map<string, SessionSnapshot>;
  deleted: string[];
} {
  const current = new Map(initial.map((session) => [session.id, { ...session }]));
  const deleted: string[] = [];
  const registry = {
    listSlim: () => [...current.values()].map((session) => ({ ...session })),
    setArchived: (id: string, archived: boolean) => {
      const session = current.get(id);
      if (!session) return null;
      session.archived = archived;
      session.archivedAt = archived ? iso(NOW) : null;
      return { ...session };
    },
    delete: (id: string) => {
      const session = current.get(id) ?? null;
      current.delete(id);
      deleted.push(id);
      return session;
    },
  } as unknown as SessionRegistry;
  return { registry, current, deleted };
}

function backdate(dbPath: string, sql: string, ...params: Array<string | number | null>): void {
  const db = new DatabaseSync(dbPath);
  try { db.prepare(sql).run(...params); } finally { db.close(); }
}

test("sessions idle for seven days auto-archive, then get purged seven days later", (t) => {
  const { storage } = database(t);
  const idle = snapshot("idle"); // ended 8 days ago
  const recent = snapshot("recent", { endedAt: iso(NOW - 60 * 60 * 1000) });
  const running = snapshot("running", { status: "running", endedAt: null, startedAt: iso(NOW - 30 * DAY) });
  const archivedOld = snapshot("archived-old", { archived: true, archivedAt: iso(NOW - RETENTION_ARCHIVED_MS - DAY) });
  const archivedNew = snapshot("archived-new", { archived: true, archivedAt: iso(NOW - DAY) });
  const { registry, current, deleted } = fakeRegistry([idle, recent, running, archivedOld, archivedNew]);

  const result = runRetentionSweep({ storage, sessions: registry }, NOW);

  assert.equal(result.archivedSessions, 1, "only the idle, non-running session is archived");
  assert.equal(result.purgedSessions, 1, "only the long-archived session is purged");
  assert.deepEqual(deleted, ["archived-old"]);
  assert.equal(current.get("idle")?.archived, true);
  assert.equal(current.get("recent")?.archived, false);
  assert.equal(current.get("running")?.archived, false);
  assert.equal(current.get("archived-new")?.archived, true);
});

test("tasks idle for seven days auto-archive, then get purged seven days later", (t) => {
  const { storage, dbPath } = database(t);
  const project = storage.createWorkspace({ name: "Project", cwd: "/tmp/project" });
  const idle = storage.createWandTask({ workspaceId: project.id, title: "Idle" });
  const recent = storage.createWandTask({ workspaceId: project.id, title: "Recent" });
  const busy = storage.createWandTask({ workspaceId: project.id, title: "Busy" });
  const archivedOld = storage.createWandTask({ workspaceId: project.id, title: "Old archive" });
  const { registry } = fakeRegistry([
    snapshot("busy-session", { workspaceTaskId: busy.workspaceTaskId ?? undefined, status: "running", endedAt: null }),
  ]);

  backdate(dbPath, "UPDATE wand_tasks SET updated_at = ? WHERE id = ?", iso(NOW - RETENTION_IDLE_MS - DAY), idle.id);
  backdate(dbPath, "UPDATE wand_tasks SET updated_at = ? WHERE id = ?", iso(NOW - 60 * 60 * 1000), recent.id);
  backdate(dbPath, "UPDATE wand_tasks SET updated_at = ? WHERE id = ?", iso(NOW - RETENTION_IDLE_MS - DAY), busy.id);
  storage.updateWandTask(archivedOld.id, { status: "archived" });
  backdate(
    dbPath,
    "UPDATE wand_tasks SET archived_at = ? WHERE id = ?",
    iso(NOW - RETENTION_ARCHIVED_MS - DAY),
    archivedOld.id,
  );

  const result = runRetentionSweep({ storage, sessions: registry }, NOW);

  assert.equal(result.archivedTasks, 1, "the idle task is archived");
  assert.equal(result.purgedTasks, 1, "the long-archived task is purged");
  assert.equal(storage.getWandTask(idle.id)?.status, "archived");
  assert.ok(storage.getWandTask(idle.id)?.archivedAt, "archive time is stamped so the 7-day window can start");
  assert.equal(storage.getWandTask(recent.id)?.status, "todo", "recent activity keeps the task open");
  assert.equal(storage.getWandTask(busy.id)?.status, "todo", "a running session protects its task");
  assert.equal(storage.getWandTask(archivedOld.id), null, "the long-archived task is gone");
});

test("a legacy archived row without a timestamp starts its window instead of being deleted", (t) => {
  const { storage, dbPath } = database(t);
  const project = storage.createWorkspace({ name: "Project", cwd: "/tmp/project" });
  const task = storage.createWandTask({ workspaceId: project.id, title: "Legacy archive" });
  storage.updateWandTask(task.id, { status: "archived" });
  backdate(dbPath, "UPDATE wand_tasks SET archived_at = NULL WHERE id = ?", task.id);

  const result = runRetentionSweep({ storage, sessions: fakeRegistry([]).registry }, NOW);

  assert.equal(result.purgedTasks, 0, "a missing timestamp must not delete immediately");
  assert.ok(storage.getWandTask(task.id)?.archivedAt, "the sweep backfills the archive time");
  assert.notEqual(storage.getWandTask(task.id), null);
});

test("session and task retention share the same window constants", () => {
  assert.equal(RETENTION_IDLE_MS, 7 * DAY);
  assert.equal(RETENTION_ARCHIVED_MS, 7 * DAY);
});
