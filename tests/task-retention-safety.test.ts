import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { AiTeamRun } from "../src/ai-team-types.js";
import { runRetentionSweep } from "../src/retention.js";
import type { SessionRegistry } from "../src/session-registry.js";
import { WandStorage } from "../src/storage.js";
import type { WandTask, WandTaskStatus } from "../src/task-types.js";
import type { TaskRetentionSettings } from "../src/task-retention.js";
import type { SessionSnapshot } from "../src/types.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-01-20T00:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const accepted = { evidence: "fixture delivery evidence", blocker: "", acceptedAt: iso(NOW - 20 * DAY) };
const policy = (patch: Partial<TaskRetentionSettings> = {}): TaskRetentionSettings => ({
  autoArchiveEnabled: true, autoArchiveDays: 7, autoDeleteEnabled: true, autoDeleteDays: 7, ...patch,
});

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-retention-safety-"));
  const storage = new WandStorage(path.join(dir, "wand.db"));
  const db = new DatabaseSync(storage.databasePath());
  const current = new Map<string, SessionSnapshot>();
  const stopped: string[] = [], deleted: string[] = [];
  t.after(() => { db.close(); storage.close(); rmSync(dir, { recursive: true, force: true }); });
  const age = (task: WandTask, days = 8): void => {
    db.prepare("UPDATE wand_tasks SET updated_at = ? WHERE id = ?").run(iso(NOW - days * DAY), task.id);
  };
  const task = (status: WandTaskStatus, isAccepted = false, parentTaskId?: string): WandTask => {
    const value = storage.createWandTask({ title: "fixture " + status, status, parentTaskId,
      acceptance: isAccepted ? accepted : null });
    age(value);
    if (status === "archived") db.prepare("UPDATE wand_tasks SET archived_at = ? WHERE id = ?").run(iso(NOW - 8 * DAY), value.id);
    return value;
  };
  const session = (id: string, owner?: WandTask, patch: Partial<SessionSnapshot> = {}): SessionSnapshot => {
    const value: SessionSnapshot = { id, sessionKind: "pty", command: "fixture", cwd: dir, mode: "default",
      status: "exited", exitCode: 0, startedAt: iso(NOW - 20 * DAY), endedAt: iso(NOW - 20 * DAY),
      output: "fixture history", archived: true, archivedAt: iso(NOW - 10 * DAY), claudeSessionId: null,
      ...(owner?.workspaceTaskId ? { workspaceTaskId: owner.workspaceTaskId } : {}), ...patch };
    storage.saveSession(value); current.set(id, value); return value;
  };
  const registry = {
    listSlim: () => [...current.values()].map(s => ({ ...s })),
    setArchived: (id: string, archived: boolean) => {
      const value = current.get(id)!;
      value.archived = archived; value.archivedAt = archived ? iso(NOW) : null; storage.saveSession(value);
      return { ...value };
    },
    stop: (id: string) => { stopped.push(id); return null; },
    delete: (id: string) => { deleted.push(id); current.delete(id); storage.deleteSession(id); return null; },
  } as unknown as SessionRegistry;
  const sweep = (settings = policy(), now = NOW) => runRetentionSweep({ storage, sessions: registry, taskRetention: settings }, now);
  const run = (id: string, owner: WandTask | undefined, chatSessionId: string, status: AiTeamRun["status"] = "done") => {
    const at = iso(NOW - 20 * DAY);
    const value: AiTeamRun = { id, teamId: "fixture-team", team: { id: "fixture-team", name: "fixture", description: "",
      instructions: "", members: [], requirePlanApproval: false, maxSteps: 3, createdAt: at, updatedAt: at },
      taskId: owner?.id ?? "dangling-fixture-task", objective: "fixture", cwd: dir, status, statusDetail: "", stepsUsed: 0,
      stepLimit: 3, formatRetries: 0, planApproved: true, chatSessionId, pendingNotes: [], createdAt: at, updatedAt: at };
    storage.saveAiTeamRun(value); return value;
  };
  const archive = (value: WandTask, days = 8): void => {
    storage.updateWandTask(value.id, { status: "archived" });
    db.prepare("UPDATE wand_tasks SET archived_at = ? WHERE id = ?").run(iso(NOW - days * DAY), value.id);
  };
  return { storage, db, task, age, session, run, archive, sweep, current, stopped, deleted };
}

for (const status of ["backlog", "todo", "doing", "done", "archived"] as const) {
  test(`unaccepted ${status} task and history survive both retention windows`, t => {
    const f = fixture(t), task = f.task(status);
    assert.equal(f.sweep().archivedTasks, 0);
    assert.equal(f.storage.getWandTask(task.id)?.status, status);
    f.session("history", task);
    f.session("idle", task, { archived: false, archivedAt: null });
    f.age(task); // Session binding promotes backlog/todo and refreshes activity; retention must still see an idle card.
    assert.deepEqual(f.sweep(), { archivedTasks: 0, purgedTasks: 0, archivedSessions: 0, purgedSessions: 0, purgedTeamRuns: 0 });
    assert.equal(f.storage.getWandTask(task.id)?.status === "archived", status === "archived");
    assert.equal(f.current.get("idle")?.archived, false);
    assert.ok(f.storage.getSessionSlim("history"));
  });
}

for (const status of ["backlog", "todo", "doing"] as const) {
  test(`acceptance alone cannot close a reopened ${status} task`, t => {
    const f = fixture(t), task = f.task(status, true);
    assert.equal(f.sweep().archivedTasks, 0);
    assert.equal(f.storage.getWandTask(task.id)?.status, status);
    f.session("history", task); f.age(task);
    assert.equal(f.sweep().purgedSessions, 0);
    assert.notEqual(f.storage.getWandTask(task.id)?.status, "archived");
    assert.ok(f.storage.getSessionSlim("history"));
  });
}

test("accepted done task archives without changing acceptance or configured windows", t => {
  const f = fixture(t), task = f.task("done", true), settings = policy();
  const before = structuredClone(settings);
  const result = f.sweep(settings);
  assert.equal(result.archivedTasks, 1); assert.equal(result.purgedTasks, 0);
  assert.equal(f.storage.getWandTask(task.id)?.status, "archived");
  assert.deepEqual(f.storage.getWandTask(task.id)?.acceptance, accepted);
  assert.deepEqual(settings, before);
});

test("current accepted archive and associated history purge only after the task grace window", t => {
  const f = fixture(t), task = f.task("archived", true);
  f.session("history", task);
  f.db.prepare("UPDATE wand_tasks SET archived_at = ? WHERE id = ?").run(iso(NOW - 7 * DAY), task.id);
  assert.equal(f.sweep(policy(), NOW - 1).purgedSessions, 0);
  assert.ok(f.storage.getWandTask(task.id));
  const result = f.sweep();
  assert.equal(result.purgedTasks, 1); assert.equal(result.purgedSessions, 1);
  assert.equal(f.storage.getWandTask(task.id), null);
});

test("new acceptance starts a full grace window even when archivedAt is old", t => {
  const f = fixture(t), task = f.task("archived", true);
  f.db.prepare("UPDATE wand_tasks SET acceptance_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...accepted, acceptedAt: iso(NOW - DAY) }), task.id);
  f.session("history", task);
  assert.equal(f.sweep().purgedTasks, 0); assert.equal(f.deleted.length, 0);
  assert.equal(f.sweep(policy(), NOW + 6 * DAY).purgedTasks, 1);
});

for (const [autoArchiveEnabled, autoDeleteEnabled] of [[false, false], [false, true], [true, false], [true, true]]) {
  test(`accepted task respects independent switches archive=${autoArchiveEnabled} delete=${autoDeleteEnabled}`, t => {
    const f = fixture(t), done = f.task("done", true), archived = f.task("archived", true);
    const result = f.sweep(policy({ autoArchiveEnabled, autoDeleteEnabled }));
    assert.equal(result.archivedTasks, autoArchiveEnabled ? 1 : 0);
    assert.equal(result.purgedTasks, autoDeleteEnabled ? 1 : 0);
    assert.equal(f.storage.getWandTask(done.id)?.status, autoArchiveEnabled ? "archived" : "done");
    assert.equal(f.storage.getWandTask(archived.id) === null, autoDeleteEnabled);
  });
}

test("doing parent protects an accepted archived child and both histories", t => {
  const f = fixture(t), parent = f.task("doing"), child = f.task("archived", true, parent.id);
  f.session("parent", parent); f.session("child", child);
  assert.equal(f.sweep().purgedTasks, 0); assert.equal(f.deleted.length, 0);
  assert.equal(f.storage.getWandTask(child.id)?.parentTaskId, parent.id);
});

test("accepted child can archive before parent acceptance but its history remains protected", t => {
  const f = fixture(t), parent = f.task("doing"), child = f.task("done", true, parent.id);
  f.session("child", child); f.age(child);
  assert.equal(f.sweep().archivedTasks, 1);
  assert.equal(f.storage.getWandTask(child.id)?.status, "archived");
  assert.equal(f.deleted.length, 0);
});

test("unaccepted child protects even a stale accepted parent from auto-archive", t => {
  const f = fixture(t), parent = f.task("done"), child = f.task("doing", false, parent.id);
  // Historical inconsistency: do not turn it into authorization to close the goal.
  f.db.prepare("UPDATE wand_tasks SET acceptance_json = ? WHERE id = ?").run(JSON.stringify(accepted), parent.id);
  f.session("parent", parent);
  assert.equal(f.sweep().archivedTasks, 0); assert.equal(f.deleted.length, 0);
  assert.equal(f.storage.getWandTask(child.id)?.parentTaskId, parent.id);
});

test("busy descendant protects accepted parent archive and every family history", t => {
  const f = fixture(t), parent = f.task("done"), child = f.task("done", true, parent.id);
  f.storage.updateWandTask(parent.id, { acceptance: accepted }); f.age(parent);
  f.session("busy", child, { status: "running", endedAt: null, archived: false, archivedAt: null, ptyBusy: true });
  f.session("parent-history", parent);
  assert.equal(f.sweep().archivedTasks, 0); assert.equal(f.deleted.length, 0);
});

test("fully accepted family keeps links until every archive has reached its grace window", t => {
  const f = fixture(t), parent = f.task("done"), child = f.task("done", true, parent.id);
  f.storage.updateWandTask(parent.id, { acceptance: accepted });
  f.archive(child, 8); f.archive(parent, 6); f.session("child-history", child);
  assert.equal(f.sweep().purgedTasks, 0);
  assert.equal(f.storage.getWandTask(child.id)?.parentTaskId, parent.id);
  const result = f.sweep(policy(), NOW + DAY);
  assert.equal(result.purgedTasks, 2); assert.equal(result.purgedSessions, 1);
});

test("queued dispatch protects an accepted done card without cancelling the intent", t => {
  const f = fixture(t), task = f.task("done", true);
  const comment = f.storage.createTaskCommentIntent({ taskId: task.id, requestId: "fixture-queued", signature: "fixture",
    body: "fixture", instruction: "fixture", sourceCommentId: null, employeeId: "fixture-employee",
    employeeName: "fixture", taskVersion: task.updatedAt, queued: true });
  assert.equal(f.sweep().archivedTasks, 0);
  assert.equal(f.storage.getWandTaskComment(comment.id)?.dispatch?.state, "queued");
});

for (const status of ["running", "awaiting_approval", "waiting_user"] as const) {
  test(`active ${status} team run and its unbound sessions cannot be cleaned`, t => {
    const f = fixture(t); f.session("chat"); f.run("run", undefined, "chat", status);
    assert.equal(f.sweep().purgedTeamRuns, 0); assert.equal(f.deleted.length, 0);
    assert.ok(f.storage.getAiTeamRun("run"));
  });
}

for (const useContainerId of [false, true]) {
  test(`unaccepted task protects terminal team chat linked by ${useContainerId ? "container" : "card"} ID`, t => {
    const f = fixture(t), task = f.task("backlog"); f.session("chat");
    const run = f.run("run", task, "chat");
    if (useContainerId) f.storage.saveAiTeamRun({ ...run, taskId: task.workspaceTaskId! });
    assert.equal(f.sweep().purgedTeamRuns, 0); assert.equal(f.deleted.length, 0);
  });
}

test("shared team session protection is independent of run listing order", t => {
  const f = fixture(t), task = f.task("doing"); f.session("shared");
  f.run("protected", task, "shared"); f.run("otherwise-unbound", undefined, "shared");
  assert.equal(f.sweep().purgedTeamRuns, 0); assert.equal(f.deleted.length, 0);
  assert.ok(f.storage.getAiTeamRun("otherwise-unbound"));
});

test("terminal unbound team deletes each session once, not once per sweep phase", t => {
  const f = fixture(t); f.session("chat"); f.run("run", undefined, "chat");
  const result = f.sweep();
  assert.equal(result.purgedTeamRuns, 1); assert.equal(result.purgedSessions, 1);
  assert.deepEqual(f.deleted, ["chat"]);
});

test("an accepted pre-policy archive is retained until a new archive transition opts in", t => {
  const f = fixture(t), task = f.task("archived", true);
  f.db.prepare("UPDATE wand_tasks SET retention_archive_version = NULL WHERE id = ?").run(task.id);
  f.session("history", task);
  assert.equal(f.sweep().purgedTasks, 0);
  assert.equal(f.deleted.length, 0);
  assert.equal(f.storage.getWandTask(task.id)?.status, "archived");
});

test("standalone sessions retain the original archive/delete behavior", t => {
  const f = fixture(t); f.session("old"); f.session("idle", undefined, { archived: false, archivedAt: null });
  const result = f.sweep(); assert.equal(result.purgedSessions, 1); assert.equal(result.archivedSessions, 1);
});

for (const corrupt of ["missing-parent", "cycle", "invalid-acceptance"]) {
  test(`ambiguous ${corrupt} task history is retained without repairing production facts`, t => {
    const f = fixture(t), task = f.task("archived", true);
    if (corrupt === "missing-parent") f.db.prepare("UPDATE wand_tasks SET parent_task_id = 'missing' WHERE id = ?").run(task.id);
    if (corrupt === "cycle") f.db.prepare("UPDATE wand_tasks SET parent_task_id = id WHERE id = ?").run(task.id);
    if (corrupt === "invalid-acceptance") f.db.prepare("UPDATE wand_tasks SET acceptance_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...accepted, acceptedAt: "invalid" }), task.id);
    f.session("history", task);
    assert.equal(f.sweep().purgedTasks, 0); assert.equal(f.deleted.length, 0);
  });
}
