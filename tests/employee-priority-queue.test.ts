import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { TaskExecutionQueue } from "../src/task-execution-queue.js";
import { toSessionDetailDTO } from "../src/session-transport.js";
import type { StructuredRunnerAdapter, StructuredRunnerExecution } from "../src/structured-runner.js";
import type { SiliconEmployee } from "../src/employee-types.js";
import type { WandTask, WandTaskPriority } from "../src/task-types.js";

class DeferredRunner implements StructuredRunnerAdapter {
  starts: Array<{ id: string; prompt: string }> = [];
  releases: Array<() => void> = [];
  failures = new Set<number>();
  start(context: Parameters<StructuredRunnerAdapter["start"]>[0]): StructuredRunnerExecution {
    this.starts.push({ id: context.session.id, prompt: context.prompt });
    const index = this.starts.length - 1;
    const completion = new Promise<Awaited<StructuredRunnerExecution["completion"]>>(resolve => {
      this.releases.push(() => resolve({ state: { blocks: [], result: this.failures.has(index) ? "" : "ok" },
        exitCode: this.failures.has(index) ? 1 : 0,
        signal: null, stderr: this.failures.has(index) ? "deliberate runner failure" : "", primaryError: null }));
    });
    return { args: [], spawnedAt: new Date().toISOString(), pid: null, completion, interrupt: () => {} };
  }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("queue did not reach the expected state");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

function harness(t: TestContext, limit = 1) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-priority-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root };
  const runner = new DeferredRunner();
  const now = new Date().toISOString();
  const employee: SiliconEmployee = { id: "e_priority", name: "优先级员工", duty: "", prompt: "", avatar: "",
    agents: [{ provider: "claude", kind: "structured", model: "default", mode: "assist", thinkingEffort: "off" }],
    maxConcurrentTasks: limit, createdAt: now, updatedAt: now };
  storage.saveSiliconEmployee(employee);
  const manager = new StructuredSessionManager(storage, config, null, { claudeCli: runner });
  const queue = new TaskExecutionQueue({ storage, config, structured: manager, processes: null });
  manager.setEmployeeInputAdmission({ canStart: (session, scheduling) => queue.canStartSession(session, scheduling), schedule: () => {} });
  t.after(async () => {
    queue.dispose();
    manager.dispose();
    for (const release of runner.releases) release();
    // 本轮 prompt 记录在 setImmediate 写入，关闭数据库前等待它收尾。
    await new Promise<void>(resolve => setImmediate(resolve));
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  function session(task?: WandTask, employeeId = employee.id) {
    const created = manager.createSession({ cwd: root, provider: "claude", mode: "assist", employeeId,
      workspaceTaskId: task?.workspaceTaskId ?? undefined });
    manager.setSessionTopic(created.id, "测试", "测试");
    return created;
  }
  function task(priority: WandTaskPriority) { return storage.createWandTask({ title: `priority ${priority}`, priority }); }
  function submit(task: WandTask, instruction: string) {
    return queue.submit({ taskId: task.id, employeeId: employee.id, employeeName: employee.name,
      requestId: instruction, signature: instruction, body: instruction, instruction, sourceCommentId: null,
      taskVersion: task.updatedAt, referencedTaskIds: [], agent: employee.agents[0]! });
  }
  async function release(index: number) {
    runner.releases[index]!();
    await until(() => !manager.get(runner.starts[index]!.id)?.structuredState?.inFlight);
    await new Promise<void>(resolve => setImmediate(resolve));
    await queue.drain(employee.id);
  }
  return { storage, manager, queue, employee, runner, session, task, submit, release };
}

test("manual messages share the employee cap and outrank urgent task dispatches without preemption", async t => {
  const h = harness(t);
  const busy = h.session(h.task("low"));
  const first = h.manager.sendMessage(busy.id, "already running", { source: "user" });
  await until(() => h.runner.starts.length === 1);
  const urgent = await h.submit(h.task("urgent"), "urgent task");
  const manual = h.session(); // Sessions without a task must also consume a slot.
  const result = await h.manager.sendMessage(manual.id, "manual input", { source: "user" });
  assert.equal(urgent.dispatch?.state, "queued");
  assert.deepEqual(result.queuedMessages, ["manual input"]);
  assert.equal(h.runner.starts.length, 1, "manual input must not preempt or bypass the cap");
  await h.release(0);
  await first;
  await until(() => h.runner.starts.length === 2);
  assert.equal(h.runner.starts[1]!.prompt, "manual input");
  assert.equal(h.storage.getWandTaskComment(urgent.id)?.dispatch?.state, "queued");
  await h.release(1);
  await until(() => h.runner.starts.length === 3);
  assert.match(h.runner.starts[2]!.prompt, /urgent task/);
});

test("task queues use live panel priorities and FIFO ties", async t => {
  const h = harness(t);
  const busy = h.session(h.task("low"));
  void h.manager.sendMessage(busy.id, "blocking");
  await until(() => h.runner.starts.length === 1);
  const first = h.task("low"), promoted = h.task("none");
  const queued = [
    await h.submit(first, "fifo first"),
    await h.submit(h.task("medium"), "medium task"),
    await h.submit(h.task("high"), "high task"),
    await h.submit(promoted, "promoted task"),
    await h.submit(h.task("low"), "fifo second"),
    await h.submit(h.task("none"), "none task"),
  ];
  h.storage.updateWandTask(promoted.id, { priority: "urgent" });
  // Equal-priority comments keep insertion order, not random UUID order.
  const list = h.storage.listQueuedTaskCommentDispatches(h.employee.id, 20);
  assert.deepEqual(list.map(item => item.commentId), [queued[3]!.id, queued[2]!.id, queued[1]!.id, queued[0]!.id, queued[4]!.id, queued[5]!.id]);
  await h.release(0);
  await until(() => h.runner.starts.length === 2);
  assert.match(h.runner.starts[1]!.prompt, /promoted task/);
  for (const [index, expected] of [[1, "high task"], [2, "medium task"], [3, "fifo first"], [4, "fifo second"], [5, "none task"]] as const) {
    await h.release(index);
    await until(() => h.runner.starts.length === index + 2);
    assert.match(h.runner.starts[index + 1]!.prompt, new RegExp(expected));
  }
});

test("a newly submitted urgent task is compared before draining older low-priority work", async t => {
  const h = harness(t);
  const busy = h.session(h.task("low"));
  void h.manager.sendMessage(busy.id, "blocking");
  await until(() => h.runner.starts.length === 1);
  const low = await h.submit(h.task("low"), "old low task");
  h.runner.releases[0]!();
  await until(() => !h.manager.get(busy.id)?.structuredState?.inFlight);
  const urgent = await h.submit(h.task("urgent"), "new urgent task");
  assert.equal(urgent.dispatch?.state, "accepted");
  assert.equal(h.storage.getWandTaskComment(low.id)?.dispatch?.state, "queued");
  await until(() => h.runner.starts.length === 2);
  assert.match(h.runner.starts[1]!.prompt, /new urgent task/);
});

test("full queues still admit follow-ups for an occupied task instead of head-of-line blocking", async t => {
  const h = harness(t);
  const occupied = h.task("low"), busy = h.session(occupied);
  void h.manager.sendMessage(busy.id, "blocking");
  await until(() => h.runner.starts.length === 1);
  const urgent = await h.submit(h.task("urgent"), "unrelated urgent");
  const followup = await h.submit(occupied, "same task follow-up");
  assert.equal(urgent.dispatch?.state, "queued");
  assert.equal(followup.dispatch?.state, "accepted");
  await until(() => h.runner.starts.length === 2);
});

test("queue metadata follows edit, reorder, delete and clear, and persists without wire changes", async t => {
  const h = harness(t);
  const busy = h.session();
  void h.manager.sendMessage(busy.id, "blocking");
  await until(() => h.runner.starts.length === 1);
  const pending = h.session();
  await h.manager.sendMessage(pending.id, "task input");
  await h.manager.sendMessage(pending.id, "manual input", { source: "user" });
  assert.deepEqual(h.storage.getSession(pending.id)?.queuedInputScheduling?.map(item => item.source), ["task", "user"]);
  const dto = toSessionDetailDTO(h.manager.get(pending.id)!);
  assert.deepEqual(dto.queuedMessages, ["task input", "manual input"]);
  assert.ok(!("queuedInputScheduling" in dto), "scheduling is server-owned, not a new client protocol");
  h.manager.reorderQueuedMessages(pending.id, [1, 0]);
  h.manager.editQueuedMessage(pending.id, 0, "manual input", "edited manual");
  assert.deepEqual(h.storage.getSession(pending.id)?.queuedInputScheduling?.map(item => item.source), ["user", "task"]);
  h.manager.deleteQueuedMessage(pending.id, 1, "task input");
  assert.deepEqual(h.storage.getSession(pending.id)?.queuedInputScheduling?.map(item => item.source), ["user"]);
  h.manager.clearQueuedMessages(pending.id);
  assert.deepEqual(h.storage.getSession(pending.id)?.queuedInputScheduling, []);
  await h.release(0);
  assert.equal(h.runner.starts.length, 1, "deleted/cleared items never start");
});

test("user queued inputs leapfrog automated inputs in the same idle session", async t => {
  const h = harness(t);
  const busy = h.session();
  void h.manager.sendMessage(busy.id, "blocking");
  await until(() => h.runner.starts.length === 1);
  const pending = h.session();
  await h.manager.sendMessage(pending.id, "automated queued");
  await h.manager.sendMessage(pending.id, "user queued", { source: "user" });
  await h.release(0);
  await until(() => h.runner.starts.length === 2);
  assert.equal(h.runner.starts[1]!.prompt, "user queued");
  assert.deepEqual(h.manager.get(pending.id)?.queuedMessages, ["automated queued"]);
});

test("multiple free slots fill without awaiting model completion and employees remain independent", async t => {
  const h = harness(t, 2);
  const busy1 = h.session(), busy2 = h.session();
  void h.manager.sendMessage(busy1.id, "blocking 1");
  void h.manager.sendMessage(busy2.id, "blocking 2");
  await until(() => h.runner.starts.length === 2);
  const pending1 = h.session(), pending2 = h.session();
  await h.manager.sendMessage(pending1.id, "pending 1", { source: "user" });
  await h.manager.sendMessage(pending2.id, "pending 2", { source: "user" });
  const otherEmployee = { ...h.employee, id: "e_other" };
  h.storage.saveSiliconEmployee(otherEmployee);
  void h.manager.sendMessage(h.session(undefined, otherEmployee.id).id, "other employee", { source: "user" });
  await until(() => h.runner.starts.length === 3);
  h.runner.releases[0]!(); h.runner.releases[1]!();
  await until(() => !h.manager.get(busy1.id)?.structuredState?.inFlight && !h.manager.get(busy2.id)?.structuredState?.inFlight);
  await h.queue.drain(h.employee.id);
  await until(() => h.runner.starts.length === 5);
  assert.deepEqual(h.runner.starts.slice(3).map(item => item.prompt), ["pending 1", "pending 2"]);
});

test("explicit reordering remains effective within the same priority tier", async t => {
  const h = harness(t);
  void h.manager.sendMessage(h.session().id, "blocking");
  await until(() => h.runner.starts.length === 1);
  const pending = h.session();
  await h.manager.sendMessage(pending.id, "first user", { source: "user" });
  await h.manager.sendMessage(pending.id, "second user", { source: "user" });
  h.manager.reorderQueuedMessages(pending.id, [1, 0]);
  await h.release(0);
  await until(() => h.runner.starts.length === 2);
  assert.equal(h.runner.starts[1]!.prompt, "second user");
});

test("team request correlation survives the in-memory employee queue and stays out of persistence", async t => {
  const h = harness(t);
  void h.manager.sendMessage(h.session().id, "blocking");
  await until(() => h.runner.starts.length === 1);
  const team = h.manager.createSession({ cwd: h.storage.directory(), provider: "claude", mode: "assist",
    employeeId: h.employee.id, automationId: "ai-team:queue-correlation" });
  h.manager.setSessionTopic(team.id, "测试", "测试");
  const requests: string[] = [];
  await h.manager.sendMessage(team.id, "team queued", { teamRequestStarted: (_, id) => requests.push(id) });
  assert.deepEqual(requests, [], "a queued input has not started a request");
  assert.equal(h.storage.getSession(team.id)?.queuedInputScheduling?.[0]?.teamRequestStarted, undefined);
  await h.release(0);
  await until(() => h.runner.starts.length === 2);
  assert.deepEqual(requests, [h.manager.get(team.id)!.structuredState!.activeRequestId]);
});

test("failed queued execution releases its slot without replaying the failed input", async t => {
  const h = harness(t);
  void h.manager.sendMessage(h.session().id, "blocking");
  await until(() => h.runner.starts.length === 1);
  const failing = h.session(), next = h.session();
  await h.manager.sendMessage(failing.id, "will fail", { source: "user" });
  await h.manager.sendMessage(next.id, "next input", { source: "user" });
  h.runner.failures.add(1);
  await h.release(0);
  await until(() => h.runner.starts.length === 2);
  await h.release(1);
  await until(() => h.runner.starts.length === 3);
  assert.equal(h.runner.starts[2]!.prompt, "next input");
  assert.equal(h.runner.starts.filter(item => item.prompt === "will fail").length, 1);
  assert.deepEqual(h.manager.get(failing.id)?.queuedMessages, []);
});

test("simultaneous manual and task submissions use one ordered employee gate", async t => {
  const h = harness(t);
  void h.manager.sendMessage(h.session().id, "blocking");
  await until(() => h.runner.starts.length === 1);
  const low = h.task("low"), urgent = h.task("urgent"), manual = h.session();
  await Promise.all([
    h.submit(low, "simultaneous low"),
    h.manager.sendMessage(manual.id, "simultaneous user", { source: "user" }),
    h.submit(urgent, "simultaneous urgent"),
  ]);
  assert.equal(h.runner.starts.length, 1);
  await h.release(0);
  await until(() => h.runner.starts.length === 2);
  assert.equal(h.runner.starts[1]!.prompt, "simultaneous user");
  await h.release(1);
  await until(() => h.runner.starts.length === 3);
  assert.match(h.runner.starts[2]!.prompt, /simultaneous urgent/);
});

test("cancelled queued execution releases its reservation after the runner acknowledges exit", async t => {
  const h = harness(t);
  void h.manager.sendMessage(h.session().id, "blocking");
  await until(() => h.runner.starts.length === 1);
  const cancelled = h.session(), next = h.session();
  await h.manager.sendMessage(cancelled.id, "will stop", { source: "user" });
  await h.manager.sendMessage(next.id, "after stop", { source: "user" });
  await h.release(0);
  await until(() => h.runner.starts.length === 2);
  h.manager.stop(cancelled.id);
  h.runner.releases[1]!();
  await new Promise<void>(resolve => setImmediate(resolve));
  await h.queue.drain(h.employee.id);
  await until(() => h.runner.starts.length === 3);
  assert.equal(h.runner.starts[2]!.prompt, "after stop");
  assert.equal(h.runner.starts.filter(item => item.prompt === "will stop").length, 1);
});

test("restart restores user priority and drains both queue kinds without replaying the old running turn", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-priority-restart-"));
  const db = path.join(root, "wand.db"), config = { ...defaultConfig(), defaultCwd: root };
  let storage = new WandStorage(db);
  let runner = new DeferredRunner();
  let manager = new StructuredSessionManager(storage, config, null, { claudeCli: runner });
  let queue = new TaskExecutionQueue({ storage, config, structured: manager, processes: null });
  const wire = () => manager.setEmployeeInputAdmission({ canStart: (session, scheduling) => queue.canStartSession(session, scheduling), schedule: () => {} });
  wire();
  const now = new Date().toISOString();
  const employee: SiliconEmployee = { id: "e_restart", name: "重启员工", duty: "", prompt: "", avatar: "", maxConcurrentTasks: 1,
    agents: [{ provider: "claude", kind: "structured", model: "default", mode: "assist", thinkingEffort: "off" }], createdAt: now, updatedAt: now };
  storage.saveSiliconEmployee(employee);
  t.after(async () => {
    queue.dispose(); manager.dispose();
    for (const release of runner.releases) release();
    await new Promise<void>(resolve => setImmediate(resolve));
    storage.close(); rmSync(root, { recursive: true, force: true });
  });
  const busy = manager.createSession({ cwd: root, mode: "assist", provider: "claude", employeeId: employee.id });
  manager.setSessionTopic(busy.id, "测试", "测试");
  void manager.sendMessage(busy.id, "old running input");
  await until(() => runner.starts.length === 1);
  const task = storage.createWandTask({ title: "紧急任务", priority: "urgent" });
  const comment = await queue.submit({ taskId: task.id, employeeId: employee.id, employeeName: employee.name,
    requestId: "restart-task", signature: "restart-task", instruction: "urgent persisted", body: "urgent persisted",
    sourceCommentId: null, taskVersion: task.updatedAt, referencedTaskIds: [], agent: employee.agents[0]! });
  const manual = manager.createSession({ cwd: root, mode: "assist", provider: "claude", employeeId: employee.id });
  manager.setSessionTopic(manual.id, "测试", "测试");
  await manager.sendMessage(manual.id, "manual persisted", { source: "user" });
  queue.dispose(); manager.dispose();
  runner.releases[0]!();
  await new Promise<void>(resolve => setImmediate(resolve));
  storage.close();
  storage = new WandStorage(db); runner = new DeferredRunner();
  manager = new StructuredSessionManager(storage, config, null, { claudeCli: runner });
  queue = new TaskExecutionQueue({ storage, config, structured: manager, processes: null });
  wire();
  assert.equal(manager.get(manual.id)?.queuedInputScheduling?.[0]?.source, "user");
  await queue.drainAll();
  await until(() => runner.starts.length === 1);
  assert.equal(runner.starts[0]!.prompt, "manual persisted");
  assert.equal(storage.getWandTaskComment(comment.id)?.dispatch?.state, "queued");
  runner.releases[0]!();
  await until(() => !manager.get(manual.id)?.structuredState?.inFlight);
  await new Promise<void>(resolve => setImmediate(resolve));
  await queue.drainAll();
  await until(() => runner.starts.length === 2);
  assert.match(runner.starts[1]!.prompt, /urgent persisted/);
  assert.ok(!runner.starts.some(item => item.prompt === "old running input"));
});
