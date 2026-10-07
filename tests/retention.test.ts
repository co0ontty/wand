import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { createRetentionSweep, isRetentionBusy, RETENTION_ARCHIVED_MS, RETENTION_IDLE_MS, runRetentionSweep } from "../src/retention.js";
import { taskRetentionWindows, type TaskRetentionSettings } from "../src/task-retention.js";
import type { SessionRegistry } from "../src/session-registry.js";
import type { AiTeam, AiTeamRun } from "../src/ai-team-types.js";
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
    stop: (id: string) => {
      const session = current.get(id);
      if (!session || session.status !== "running") return session ? { ...session } : null;
      session.status = "stopped";
      session.endedAt = iso(NOW);
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

test("an idle PTY shell is not treated as in-progress work", (t) => {
  const { storage } = database(t);
  const shell = snapshot("idle-zsh", {
    status: "running",
    endedAt: null,
    startedAt: iso(NOW - 8 * DAY),
    ptyBusy: false,
    command: "/bin/zsh",
  });
  const busy = snapshot("busy-pty", {
    status: "running",
    endedAt: null,
    startedAt: iso(NOW - 8 * DAY),
    ptyBusy: true,
  });
  const { registry, current } = fakeRegistry([shell, busy]);

  assert.equal(isRetentionBusy(shell), false);
  assert.equal(isRetentionBusy(busy), true);
  const result = runRetentionSweep({ storage, sessions: registry }, NOW);

  assert.equal(result.archivedSessions, 1);
  assert.equal(current.get("idle-zsh")?.status, "stopped");
  assert.equal(current.get("idle-zsh")?.archived, true);
  assert.equal(current.get("busy-pty")?.archived, false);
  assert.equal(current.get("busy-pty")?.status, "running");
});

test("sessions idle for seven days auto-archive, then get purged seven days later", (t) => {
  const { storage } = database(t);
  const idle = snapshot("idle"); // ended 8 days ago
  const recent = snapshot("recent", { endedAt: iso(NOW - 60 * 60 * 1000) });
  const running = snapshot("running", {
    status: "running", endedAt: null, startedAt: iso(NOW - 30 * DAY), ptyBusy: true,
  });
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
    snapshot("busy-session", {
      workspaceTaskId: busy.workspaceTaskId ?? undefined,
      status: "running",
      endedAt: null,
      ptyBusy: true,
    }),
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

test("default task retention matches the fixed session window", () => {
  assert.equal(RETENTION_IDLE_MS, 7 * DAY);
  assert.equal(RETENTION_ARCHIVED_MS, 7 * DAY);
  assert.deepEqual(taskRetentionWindows(undefined), { idleMs: RETENTION_IDLE_MS, archivedMs: RETENTION_ARCHIVED_MS });
});

function taskPolicy(patch: Partial<TaskRetentionSettings>): TaskRetentionSettings {
  return {
    autoArchiveEnabled: true,
    autoArchiveDays: 7,
    autoDeleteEnabled: true,
    autoDeleteDays: 7,
    ...patch,
  };
}

test("task retention windows also apply to idle sessions", (t) => {
  const { storage, dbPath } = database(t);
  const project = storage.createWorkspace({ name: "Project", cwd: "/tmp/project" });
  const idle = storage.createWandTask({ workspaceId: project.id, title: "Idle" });
  const recent = storage.createWandTask({ workspaceId: project.id, title: "Recent" });
  const archivedOld = storage.createWandTask({ workspaceId: project.id, title: "Old archive" });
  const archivedNew = storage.createWandTask({ workspaceId: project.id, title: "New archive" });
  const idleSession = snapshot("idle-session");
  const { registry, current } = fakeRegistry([idleSession]);

  backdate(dbPath, "UPDATE wand_tasks SET updated_at = ? WHERE id = ?", iso(NOW - 2 * DAY), idle.id);
  backdate(dbPath, "UPDATE wand_tasks SET updated_at = ? WHERE id = ?", iso(NOW - 12 * 60 * 60 * 1000), recent.id);
  storage.updateWandTask(archivedOld.id, { status: "archived" });
  storage.updateWandTask(archivedNew.id, { status: "archived" });
  backdate(dbPath, "UPDATE wand_tasks SET archived_at = ? WHERE id = ?", iso(NOW - 3 * DAY), archivedOld.id);
  backdate(dbPath, "UPDATE wand_tasks SET archived_at = ? WHERE id = ?", iso(NOW - DAY), archivedNew.id);

  const result = runRetentionSweep({
    storage,
    sessions: registry,
    taskRetention: taskPolicy({ autoArchiveDays: 1, autoDeleteDays: 2 }),
  }, NOW);

  assert.equal(result.archivedTasks, 1);
  assert.equal(result.purgedTasks, 1);
  assert.equal(storage.getWandTask(idle.id)?.status, "archived");
  assert.equal(storage.getWandTask(recent.id)?.status, "todo");
  assert.equal(storage.getWandTask(archivedOld.id), null);
  assert.equal(storage.getWandTask(archivedNew.id)?.status, "archived");
  assert.equal(result.archivedSessions, 1, "sessions use the same window as tasks");
  assert.equal(current.get("idle-session")?.archived, true);
});

test("disabled task retention leaves idle and archived tasks alone", (t) => {
  const { storage, dbPath } = database(t);
  const project = storage.createWorkspace({ name: "Project", cwd: "/tmp/project" });
  const idle = storage.createWandTask({ workspaceId: project.id, title: "Idle" });
  const archived = storage.createWandTask({ workspaceId: project.id, title: "Archived" });
  backdate(dbPath, "UPDATE wand_tasks SET updated_at = ? WHERE id = ?", iso(NOW - 30 * DAY), idle.id);
  storage.updateWandTask(archived.id, { status: "archived" });
  backdate(dbPath, "UPDATE wand_tasks SET archived_at = ? WHERE id = ?", iso(NOW - 30 * DAY), archived.id);

  const result = runRetentionSweep({
    storage,
    sessions: fakeRegistry([]).registry,
    taskRetention: taskPolicy({ autoArchiveEnabled: false, autoDeleteEnabled: false }),
  }, NOW);

  assert.equal(result.archivedTasks, 0);
  assert.equal(result.purgedTasks, 0);
  assert.equal(storage.getWandTask(idle.id)?.status, "todo");
  assert.equal(storage.getWandTask(archived.id)?.status, "archived");
  assert.equal(storage.getWandTask(archived.id)?.archivedAt, iso(NOW - 30 * DAY));
});

test("a fresh retention sweep reads the task window at call time", (t) => {
  const { storage, dbPath } = database(t);
  const project = storage.createWorkspace({ name: "Project", cwd: "/tmp/project" });
  const idle = storage.createWandTask({ workspaceId: project.id, title: "Idle" });
  backdate(dbPath, "UPDATE wand_tasks SET updated_at = ? WHERE id = ?", iso(NOW - 2 * DAY), idle.id);
  let policy = taskPolicy({ autoArchiveEnabled: false });
  const sweep = createRetentionSweep({
    storage,
    sessions: fakeRegistry([]).registry,
    taskRetention: () => policy,
  });

  assert.equal(sweep().archivedTasks, 0);
  assert.equal(storage.getWandTask(idle.id)?.status, "todo");
  policy = taskPolicy({ autoArchiveDays: 1 });
  assert.equal(sweep().archivedTasks, 1);
  assert.equal(storage.getWandTask(idle.id)?.status, "archived");
});

test("turning task auto-delete back on does not immediately purge a legacy archive", (t) => {
  const { storage, dbPath } = database(t);
  const project = storage.createWorkspace({ name: "Project", cwd: "/tmp/project" });
  const task = storage.createWandTask({ workspaceId: project.id, title: "Legacy archive" });
  storage.updateWandTask(task.id, { status: "archived" });
  backdate(dbPath, "UPDATE wand_tasks SET archived_at = NULL WHERE id = ?", task.id);

  const result = runRetentionSweep({
    storage,
    sessions: fakeRegistry([]).registry,
    taskRetention: taskPolicy({ autoDeleteDays: 1 }),
  }, NOW);

  assert.equal(result.purgedTasks, 0);
  assert.ok(storage.getWandTask(task.id)?.archivedAt);
});

function teamRun(id: string, status: AiTeamRun["status"], updatedAt: string, chatSessionId: string | null): AiTeamRun {
  const team: AiTeam = {
    id: "team-1",
    name: "开发四人组",
    description: "",
    instructions: "",
    members: [],
    requirePlanApproval: false,
    maxSteps: 30,
    createdAt: updatedAt,
    updatedAt,
  };
  return {
    id,
    teamId: team.id,
    team,
    taskId: "task-1",
    objective: "旧团队任务",
    cwd: "/tmp",
    status,
    statusDetail: "",
    stepsUsed: 1,
    stepLimit: 30,
    formatRetries: 0,
    planApproved: true,
    chatSessionId,
    pendingNotes: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

test("team runs idle for several days are removed with their sessions, running runs stay", (t) => {
  const { storage } = database(t);
  const oldAt = iso(NOW - 4 * DAY);
  const recentAt = iso(NOW - DAY);
  storage.saveAiTeamRun(teamRun("old-stopped", "stopped", oldAt, "old-chat"));
  storage.saveAiTeamRun(teamRun("old-waiting", "waiting_user", oldAt, "waiting-chat"));
  storage.saveAiTeamRun(teamRun("recent", "done", recentAt, "recent-chat"));
  storage.saveAiTeamRun(teamRun("live", "running", oldAt, "live-chat"));
  const { registry, current, deleted } = fakeRegistry([
    snapshot("old-chat", { endedAt: oldAt, startedAt: oldAt }),
    snapshot("waiting-chat", { endedAt: oldAt, startedAt: oldAt }),
    snapshot("recent-chat", { endedAt: recentAt, startedAt: recentAt }),
    snapshot("live-chat", { status: "running", endedAt: null, startedAt: oldAt, ptyBusy: true }),
  ]);

  const result = runRetentionSweep({
    storage,
    sessions: registry,
    taskRetention: taskPolicy({ autoArchiveDays: 1, autoDeleteDays: 3 }),
  }, NOW);

  assert.equal(result.purgedTeamRuns, 2);
  assert.equal(storage.getAiTeamRun("old-stopped"), null);
  assert.equal(storage.getAiTeamRun("old-waiting"), null);
  assert.equal(storage.getAiTeamRun("recent")?.status, "done");
  assert.equal(storage.getAiTeamRun("live")?.status, "running");
  assert.equal(deleted.includes("old-chat"), true);
  assert.equal(deleted.includes("waiting-chat"), true);
  assert.equal(deleted.includes("live-chat"), false);
  assert.equal(current.get("recent-chat")?.archived, true, "a one-day-old team chat is archived, not deleted");
  assert.equal(current.get("live-chat")?.archived, false);
});
