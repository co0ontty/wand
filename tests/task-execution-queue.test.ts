import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { defaultConfig } from "../src/config.js";
import type { SiliconEmployee } from "../src/employee-types.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { parseMaxConcurrentTasks } from "../src/server-employee-routes.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import { WandStorage } from "../src/storage.js";
import { TaskExecutionQueue, type EmployeeTaskCommentSubmission } from "../src/task-execution-queue.js";
import type { WandTask } from "../src/task-types.js";

interface Harness {
  storage: WandStorage;
  employee: SiliconEmployee;
  queue: TaskExecutionQueue;
  sent: Array<{ id: string; prompt: string }>;
  created: string[];
  running: Map<string, { employeeId: string; workspaceTaskId: string }>;
  sessions: { listSlim: () => Array<Record<string, unknown>>; getSlim: () => null; ownerOf: () => null };
  submit(task: WandTask, requestId: string, instruction: string): Promise<import("../src/task-types.js").WandTaskComment>;
  endTurn(sessionId: string): void;
  close(): void;
}

function harness(limit: number | null, root?: string): Harness {
  const directory = root ?? mkdtempSync(path.join(os.tmpdir(), "wand-execution-queue-"));
  const storage = new WandStorage(path.join(directory, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: directory };
  const sent: Array<{ id: string; prompt: string }> = [];
  const created: string[] = [];
  const running = new Map<string, { employeeId: string; workspaceTaskId: string }>();
  let counter = 0;
  const structured = {
    createSession(options: { cwd?: string; provider?: string; mode?: string; employeeId?: string; workspaceTaskId?: string }) {
      const id = `queue-session-${++counter}`;
      const employeeId = options.employeeId ?? "";
      const workspaceTaskId = options.workspaceTaskId ?? "";
      storage.saveSession({
        id, sessionKind: "structured", sessionSource: "automation", provider: options.provider ?? "pi",
        runner: "pi-cli-json", command: "pi", cwd: options.cwd ?? directory, mode: options.mode ?? "default",
        status: "running", exitCode: null, startedAt: new Date().toISOString(), endedAt: null, output: "",
        archived: false, archivedAt: null, claudeSessionId: null, employeeId, workspaceTaskId,
      });
      created.push(id);
      running.set(id, { employeeId, workspaceTaskId });
      return storage.getSession(id)!;
    },
    sendMessage(id: string, prompt: string) { sent.push({ id, prompt }); return Promise.resolve(); },
  };
  const now = new Date().toISOString();
  const employee: SiliconEmployee = {
    id: `e_queue_${Math.random().toString(36).slice(2)}`, name: "并发员工", duty: "", prompt: "", avatar: "", tags: [],
    agents: [{ provider: "pi", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" }],
    maxConcurrentTasks: limit, createdAt: now, updatedAt: now,
  };
  storage.saveSiliconEmployee(employee);
  const sessions = {
    listSlim: () => [...running].map(([id, meta]) => ({ id, ...meta, structuredState: { inFlight: true } })),
    getSlim: () => null,
    ownerOf: () => null,
  };
  const queue = new TaskExecutionQueue({
    storage, config, structured: structured as never, processes: null,
    sessions: sessions as never,
  });
  return {
    storage, employee, queue, sent, created, running, sessions,
    async submit(task, requestId, instruction) {
      const current = storage.getSiliconEmployee(employee.id)!;
      const submission: EmployeeTaskCommentSubmission = {
        taskId: task.id, employeeId: current.id, employeeName: current.name,
        requestId, signature: requestId, body: `@${current.name} ${instruction}`, instruction,
        sourceCommentId: null, taskVersion: task.updatedAt, referencedTaskIds: [], agent: current.agents[0]!,
      };
      return queue.submit(submission);
    },
    endTurn(sessionId) { running.delete(sessionId); },
    close() { storage.close(); },
  };
}

function makeTask(storage: WandStorage, title: string): WandTask {
  return storage.createWandTask({ title });
}

test("employee concurrency setting defaults to 2, persists, and rejects invalid limits", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-concurrency-setting-"));
  let storage = new WandStorage(path.join(root, "wand.db"));
  const now = new Date().toISOString();
  const employee: SiliconEmployee = {
    id: "e_concurrency", name: "并发设置", duty: "", prompt: "", avatar: "",
    agents: [{ provider: "pi", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" }],
    createdAt: now, updatedAt: now,
  };
  storage.saveSiliconEmployee(employee);
  assert.equal(storage.getSiliconEmployee(employee.id)?.maxConcurrentTasks, 2, "missing value uses the default limit");
  storage.saveSiliconEmployee({ ...employee, maxConcurrentTasks: 3 });
  assert.equal(storage.getSiliconEmployee(employee.id)?.maxConcurrentTasks, 3);
  for (const invalid of [0, 101, 1.5, -1]) {
    assert.throws(() => storage.saveSiliconEmployee({ ...employee, maxConcurrentTasks: invalid }), /1 到 100/);
  }
  storage.close();
  storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => storage.close());
  assert.equal(storage.getSiliconEmployee(employee.id)?.maxConcurrentTasks, 3, "setting survives reopen");
  const existing = storage.getSiliconEmployee(employee.id)!;
  assert.equal(parseMaxConcurrentTasks(undefined, existing), 3, "omitted PUT field preserves the current limit");
  assert.equal(parseMaxConcurrentTasks(null, existing), 2, "explicit null restores the default limit");
  assert.throws(() => parseMaxConcurrentTasks(0, existing), /1 到 100/);
});

test("holding queued intents survives recovery and never interrupts or replays running work", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-queue-hold-"));
  const h = harness(1, root);
  const runningTask = makeTask(h.storage, "running");
  const active = await h.submit(runningTask, "hold-running", "keep running");
  const heldTask = makeTask(h.storage, "held");
  const held = await h.submit(heldTask, "hold-waiting", "preserve instruction");
  const ids = h.storage.pauseQueuedTaskComments();
  assert.deepEqual(ids, [held.id]);
  assert.equal(h.storage.getWandTaskComment(active.id)?.dispatch?.state, "accepted");
  assert.equal(h.running.size, 1);
  assert.equal(h.storage.claimQueuedTaskComment(held.id), false, "another connection cannot claim held work");
  h.endTurn(h.created[0]!);
  await h.queue.drainAll();
  assert.equal(h.created.length, 1);
  h.queue.dispose(); h.close();
  const recovered = harness(1, root);
  t.after(() => { recovered.queue.dispose(); recovered.close(); });
  await recovered.queue.drainAll();
  assert.equal(recovered.created.length, 0, "startup must not resume a hold");
  assert.equal(recovered.storage.getWandTaskComment(held.id)?.dispatch?.state, "paused");
  assert.equal(recovered.storage.getWandTaskComment(held.id)?.instruction, "preserve instruction");
  assert.equal(recovered.storage.resumePausedTaskComments([held.id, held.id, active.id]), 1);
  await recovered.queue.drainAll();
  assert.equal(recovered.created.length, 1);
  assert.equal(recovered.sent[0]?.prompt.includes("preserve instruction"), true);
});

test("reaching the employee limit queues dispatches, keeps tasks active, and drains FIFO", async (t) => {
  const h = harness(1);
  t.after(() => h.close());
  const runningTask = makeTask(h.storage, "先跑的任务");
  h.running.set("already-running", { employeeId: h.employee.id, workspaceTaskId: runningTask.workspaceTaskId! });
  const first = makeTask(h.storage, "排队的任务一");
  const second = makeTask(h.storage, "排队的任务二");
  const firstComment = await h.submit(first, "queue-first", "first queued instruction");
  assert.equal(firstComment.dispatch?.state, "queued");
  assert.equal(h.created.length, 0, "queued dispatch must not create a session");
  assert.equal(h.storage.getWandTask(first.id)?.status, "doing", "queued work stays in the active task list");
  assert.equal(h.storage.countQueuedTaskCommentDispatchesForTask(first.id), 1);
  const secondComment = await h.submit(second, "queue-second", "second queued instruction");
  assert.equal(secondComment.dispatch?.state, "queued");

  h.running.delete("already-running");
  await h.queue.drain(h.employee.id);
  assert.equal(h.storage.getWandTaskComment(firstComment.id)?.dispatch?.state, "accepted");
  assert.equal(h.storage.getWandTaskComment(secondComment.id)?.dispatch?.state, "queued", "limit still blocks the second task");
  assert.equal(h.sent.length, 1);
  assert.ok(h.sent[0]!.prompt.includes("first queued instruction"));

  h.endTurn(h.sent[0]!.id);
  await h.queue.drain(h.employee.id);
  assert.equal(h.storage.getWandTaskComment(secondComment.id)?.dispatch?.state, "accepted");
  assert.equal(h.sent.length, 2);
  assert.ok(h.sent[1]!.prompt.includes("second queued instruction"), "queue drains oldest first");
  assert.equal(h.storage.countQueuedTaskCommentDispatchesForEmployee(h.employee.id), 0);
});

test("a task already occupying a slot can dispatch again without queueing behind itself", async (t) => {
  const h = harness(1);
  t.after(() => h.close());
  const task = makeTask(h.storage, "同一任务追加派发");
  h.running.set("same-task-running", { employeeId: h.employee.id, workspaceTaskId: task.workspaceTaskId! });
  const comment = await h.submit(task, "same-task", "continue this task");
  assert.equal(comment.dispatch?.state, "accepted");
  assert.equal(h.created.length, 1);
  assert.ok(h.sent[0]!.prompt.includes("continue this task"));
});

test("employees without an explicit limit run two tasks and queue the third", async (t) => {
  const h = harness(null);
  t.after(() => h.close());
  for (const index of [1, 2]) {
    const runningTask = makeTask(h.storage, `默认槽位 ${index}`);
    h.running.set(`default-running-${index}`, { employeeId: h.employee.id, workspaceTaskId: runningTask.workspaceTaskId! });
  }
  const third = makeTask(h.storage, "默认上限之外");
  const comment = await h.submit(third, "default-limit", "wait for a slot");
  assert.equal(comment.dispatch?.state, "queued");
  assert.equal(h.created.length, 0);
  assert.equal(h.storage.getWandTask(third.id)?.status, "doing");
  assert.equal(h.storage.countQueuedTaskCommentDispatchesForEmployee(h.employee.id), 1);
});

test("queued rows survive restart and drain after recovery", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-execution-queue-restart-"));
  const first = harness(1, root);
  const runningTask = makeTask(first.storage, "重启前的运行任务");
  first.running.set("restart-running", { employeeId: first.employee.id, workspaceTaskId: runningTask.workspaceTaskId! });
  const queuedTask = makeTask(first.storage, "重启后继续");
  const comment = await first.submit(queuedTask, "restart-queue", "persisted instruction");
  assert.equal(comment.dispatch?.state, "queued");
  first.storage.close();

  const second = harness(1, root);
  t.after(() => second.close());
  assert.equal(second.storage.getWandTaskComment(comment.id)?.dispatch?.state, "queued", "queue is persisted, not memory-only");
  await second.queue.drainAll();
  assert.equal(second.storage.getWandTaskComment(comment.id)?.dispatch?.state, "accepted");
  assert.equal(second.created.length, 1);
  assert.ok(second.sent[0]!.prompt.includes("persisted instruction"));
});

test("closing a task or archiving its employee cancels queued dispatches without starting them", async (t) => {
  const h = harness(1);
  t.after(() => h.close());
  const runningTask = makeTask(h.storage, "占用槽位");
  h.running.set("blocking", { employeeId: h.employee.id, workspaceTaskId: runningTask.workspaceTaskId! });
  const closing = makeTask(h.storage, "关闭任务");
  const closingComment = await h.submit(closing, "cancel-close", "should be cancelled");
  assert.equal(closingComment.dispatch?.state, "queued");
  h.storage.updateWandTask(closing.id, { status: "done" });
  assert.equal(h.storage.getWandTaskComment(closingComment.id)?.dispatch?.state, "failed");
  assert.match(h.storage.getWandTaskComment(closingComment.id)?.dispatch?.error ?? "", /任务已关闭/);

  const archived = makeTask(h.storage, "归档员工");
  const archivedComment = await h.submit(archived, "cancel-archive", "should be cancelled too");
  assert.equal(archivedComment.dispatch?.state, "queued");
  h.storage.archiveSiliconEmployee(h.employee.id);
  assert.equal(h.storage.getWandTaskComment(archivedComment.id)?.dispatch?.state, "failed");
  assert.match(h.storage.getWandTaskComment(archivedComment.id)?.dispatch?.error ?? "", /员工已归档/);

  await h.queue.drainAll();
  assert.equal(h.created.length, 0, "cancelled queue rows never create sessions");
});

test("HTTP dispatch reports queued without a session and the task list exposes the queued count", async (t) => {
  const h = harness(1);
  const app = express();
  app.use(express.json());
  registerTaskRoutes(app, {
    storage: h.storage, config: { ...defaultConfig(), defaultCwd: h.storage.directory() },
    structured: {} as never, sessions: h.sessions as never, executionQueue: h.queue,
  });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    h.close();
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const runningTask = makeTask(h.storage, "HTTP 占位任务");
  h.running.set("http-blocking", { employeeId: h.employee.id, workspaceTaskId: runningTask.workspaceTaskId! });
  const task = makeTask(h.storage, "HTTP 排队任务");
  const response = await fetch(`${url}/api/wand-tasks/${task.id}/dispatch`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: "http-queued-001", subject: { type: "employee", id: h.employee.id }, prompt: "queued over HTTP" }),
  });
  assert.equal(response.status, 202);
  const receipt = await response.json() as { queued: boolean; session: unknown; comment: { dispatch?: { state?: string } } };
  assert.equal(receipt.queued, true);
  assert.equal(receipt.session, null);
  assert.equal(receipt.comment.dispatch?.state, "queued");
  assert.equal(h.storage.getWandTask(task.id)?.status, "doing");

  const listed = await fetch(`${url}/api/wand-tasks`).then(value => value.json()) as Array<{ id: string; queuedCommentCount?: number }>;
  assert.equal(listed.find(item => item.id === task.id)?.queuedCommentCount, 1);
  assert.equal(listed.find(item => item.id === runningTask.id)?.queuedCommentCount ?? 0, 0);

  const comments = await fetch(`${url}/api/wand-tasks/${task.id}/comments`).then(value => value.json()) as
    { comments: Array<{ id: string; dispatch?: { state?: string; status?: string } }> };
  assert.equal(comments.comments[0]?.dispatch?.state, "queued");
  assert.equal(comments.comments[0]?.dispatch?.status, "queued", "queued projection does not fall through to unavailable/history");
});
