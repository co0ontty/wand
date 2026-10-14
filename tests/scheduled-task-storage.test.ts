import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WandStorage } from "../src/storage.js";
import type { ScheduledTask, ScheduledTaskRun } from "../src/scheduled-task-types.js";

test("two storage owners atomically claim an occurrence, preserve captured input and advance only once", t => {
  const root = mkdtempSync(join(tmpdir(), "wand-schedule-storage-"));
  const first = new WandStorage(join(root, "wand.db"));
  const second = new WandStorage(join(root, "wand.db"));
  t.after(() => { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); });
  const task: ScheduledTask = { id: "schedule-test", creationFingerprint: "test", title: "帖子", employeeId: "employee-test",
    prompt: "  保留帖子原文\n", schedule: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" }, enabled: true,
    nextRunAt: "2026-10-11T01:00:00.000Z", revision: 1, createdAt: "2026-10-10T01:00:00.000Z",
    updatedAt: "2026-10-10T01:00:00.000Z", cancelledAt: null };
  assert.equal(first.createScheduledTask(task), true);
  assert.equal(second.createScheduledTask(task), false);
  const stale = second.getScheduledTask(task.id)!;
  const run: ScheduledTaskRun = { id: "run-test", taskId: task.id, requestId: "schedule:run-test", employeeId: task.employeeId,
    prompt: task.prompt, scheduledAt: task.nextRunAt!, claimedAt: "2026-10-11T01:00:05.000Z",
    executionFinishedAt: null, state: "claimed", receipt: null, error: null };
  assert.equal(first.claimScheduledTaskRun(task, run, "2026-10-12T01:00:00.000Z"), true);
  assert.equal(second.claimScheduledTaskRun(stale, run, "2026-10-12T01:00:00.000Z"), false);
  assert.equal(second.updateScheduledTask({ ...stale, prompt: "触发前的旧编辑", revision: 2 }, 1), false);
  assert.equal(second.getScheduledTask(task.id)!.nextRunAt, "2026-10-12T01:00:00.000Z");
  assert.equal(first.listScheduledTaskRuns(task.id).length, 1);
  assert.equal(first.listOpenScheduledTaskRuns(task.id)[0]!.prompt, "  保留帖子原文\n");
  first.saveScheduledTaskRun({ ...run, state: "unknown", executionFinishedAt: "2026-10-11T01:01:00.000Z" });
  assert.equal(second.listOpenScheduledTaskRuns(task.id).length, 0);
  const current = second.getScheduledTask(task.id)!;
  assert.equal(second.updateScheduledTask({ ...current, enabled: false, revision: current.revision + 1 }, current.revision), true);
  assert.equal(first.updateScheduledTask({ ...current, prompt: "旧客户端覆盖", revision: current.revision + 1 }, current.revision), false);
  assert.equal(first.getScheduledTask(task.id)!.prompt, task.prompt);
  assert.equal(first.claimScheduledTaskRun(current, { ...run, id: "late-run", scheduledAt: current.nextRunAt! }, null), false);
});

test("single occurrence advances to disabled and cancellation preserves execution history", t => {
  const root = mkdtempSync(join(tmpdir(), "wand-schedule-once-"));
  const storage = new WandStorage(join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const task: ScheduledTask = { id: "schedule-once", creationFingerprint: "test", title: "单次", employeeId: "employee-test", prompt: "定时执行",
    schedule: { kind: "once", runAt: "2026-10-11T01:00:00.000Z" }, enabled: true, nextRunAt: "2026-10-11T01:00:00.000Z",
    revision: 1, createdAt: "2026-10-10T01:00:00.000Z", updatedAt: "2026-10-10T01:00:00.000Z", cancelledAt: null };
  storage.createScheduledTask(task);
  storage.claimScheduledTaskRun(task, { id: "run-once", taskId: task.id, requestId: "schedule:run-once", employeeId: task.employeeId,
    prompt: task.prompt, scheduledAt: task.nextRunAt!, claimedAt: task.nextRunAt!, executionFinishedAt: null,
    state: "claimed", receipt: null, error: null }, null);
  assert.equal(storage.getScheduledTask(task.id)!.enabled, false);
  assert.equal(storage.getScheduledTask(task.id)!.nextRunAt, null);
  const executed = storage.getScheduledTask(task.id)!;
  storage.updateScheduledTask({ ...executed, revision: executed.revision + 1, cancelledAt: "2026-10-12T00:00:00.000Z" }, executed.revision);
  assert.equal(storage.listScheduledTasks().length, 0);
  assert.equal(storage.listScheduledTasks(true).length, 1);
  assert.equal(storage.listScheduledTaskRuns(task.id).length, 1);
});
