import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";
import { createFeedbackReport, encryptFeedback, FeedbackReceiver, FeedbackReporter, type FeedbackReport } from "../src/feedback.js";
import { WandStorage } from "../src/storage.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import { registerFeedbackAdminRoutes, registerFeedbackIngress } from "../src/server-feedback-routes.js";
import { jsonErrorHandler } from "../src/express-async.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-feedback-tasks-"));
  const database = path.join(root, "wand.db");
  const storage = new WandStorage(database);
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const keyFile = path.join(root, "private.pem");
  writeFileSync(keyFile, keys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const receiver = new FeedbackReceiver(root, keyFile, {
    accept: (report, envelope) => storage.ingestFeedback(report, envelope), latest: taskId => storage.latestFeedbackEnvelopes(taskId),
  });
  return { root, database, storage, receiver };
}
function errorReport(username = "自定义小王", feature: FeedbackReport["feature"] = "app_update") {
  return { ...createFeedbackReport("update_failed", "4.99.0", new Error("raw-error-report-sensitive-content")), username, feature };
}

test("first collected error creates the exact named task; same function adds a real comment across users/platforms", t => {
  const { storage, receiver } = fixture(t);
  const first = errorReport();
  const a = encryptFeedback(first, keys.publicKey);
  assert.equal(receiver.accept(a), "stored");
  const tasks = storage.listWandTasks(); assert.equal(tasks.length, 1);
  const task = tasks[0]!;
  assert.equal(task.title, "【自定义小王】-【应用更新】");
  assert.equal(task.titleSource, "user"); assert.equal(task.status, "todo"); assert.equal(task.agent, null);
  assert.match(task.description, new RegExp(first.id));
  assert.doesNotMatch(task.description, /raw-error-report-sensitive-content/);
  assert.deepEqual(storage.listWandTaskComments(task.id), []);
  const next = { ...errorReport("另一个小李"), source: "ios" as const, clientVersion: "4.98.0" };
  assert.equal(receiver.accept(encryptFeedback(next, keys.publicKey)), "stored");
  assert.equal(storage.listWandTasks().length, 1);
  assert.equal(storage.getWandTask(task.id)!.title, "【自定义小王】-【应用更新】");
  const comments = storage.listWandTaskComments(task.id);
  assert.equal(comments.length, 1);
  assert.equal(comments[0]!.authorName, "另一个小李");
  assert.equal(comments[0]!.body, "【另一个小李】也遇到了相同的问题。");
  assert.equal(receiver.latest(task.id).length, 2);
});

test("event retries are idempotent and a genuinely new report by the same name appends once", t => {
  const { receiver, storage } = fixture(t);
  const first = encryptFeedback(errorReport(), keys.publicKey);
  receiver.accept(first);
  const second = encryptFeedback(errorReport(), keys.publicKey);
  assert.equal(receiver.accept(second), "stored");
  assert.equal(receiver.accept(second), "duplicate");
  assert.equal(receiver.accept(first), "duplicate");
  const task = storage.listWandTasks()[0]!;
  assert.equal(storage.listWandTaskComments(task.id).length, 1);
  assert.equal(storage.latestFeedbackEnvelopes().length, 2);
});

test("separate functions create separate tasks, independent of error text and username", t => {
  const { receiver, storage } = fixture(t);
  receiver.accept(encryptFeedback(errorReport("小王", "app_update"), keys.publicKey));
  receiver.accept(encryptFeedback(errorReport("小王", "sessions"), keys.publicKey));
  assert.deepEqual(new Set(storage.listWandTasks().map(task => task.title)), new Set(["【小王】-【应用更新】", "【小王】-【会话】"]));
});

test("receipt, task/comment and ciphertext rollback together when the projection fails", t => {
  const { receiver, storage } = fixture(t);
  const original = storage.createWandTask;
  storage.createWandTask = input => { original.call(storage, input); throw new Error("injected persistence failure"); };
  const envelope = encryptFeedback(errorReport(), keys.publicKey);
  assert.throws(() => receiver.accept(envelope), /storage unavailable/);
  assert.equal(storage.listWandTasks().length, 0);
  assert.equal(storage.latestFeedbackEnvelopes().length, 0);
  storage.createWandTask = original;
  assert.equal(receiver.accept(envelope), "stored", "same report can retry after rollback");
  assert.equal(storage.listWandTasks().length, 1);
});

test("two storage connections and a receiver restart reuse the persistent feature association", t => {
  const { receiver, storage, database } = fixture(t);
  receiver.accept(encryptFeedback(errorReport(), keys.publicKey));
  const second = new WandStorage(database);
  t.after(() => second.close());
  const r = errorReport("来自另一连接");
  assert.equal(second.ingestFeedback(r, encryptFeedback(r, keys.publicKey)), "stored");
  assert.equal(storage.listWandTasks().length, 1);
  assert.equal(storage.listWandTaskComments(storage.listWandTasks()[0]!.id).length, 1);
});

test("manual rename/completion/archive is preserved; explicit deletion only allows a new report to create a fresh task", t => {
  const { receiver, storage } = fixture(t);
  const originalEnvelope = encryptFeedback(errorReport(), keys.publicKey);
  receiver.accept(originalEnvelope);
  const id = storage.listWandTasks()[0]!.id;
  storage.updateWandTask(id, { title: "人工改名", status: "archived" });
  receiver.accept(encryptFeedback(errorReport("小李"), keys.publicKey));
  assert.equal(storage.getWandTask(id)!.title, "人工改名");
  assert.equal(storage.getWandTask(id)!.status, "archived");
  storage.deleteWandTask(id);
  assert.equal(receiver.accept(originalEnvelope), "duplicate");
  assert.equal(storage.listWandTasks().length, 0);
  receiver.accept(encryptFeedback(errorReport("新报告小张"), keys.publicKey));
  assert.equal(storage.listWandTasks()[0]!.title, "【新报告小张】-【应用更新】");
});

test("encrypted reports do not duplicate raw messages/stacks in task metadata or SQLite plaintext", t => {
  const { receiver, storage, database } = fixture(t);
  receiver.accept(encryptFeedback(errorReport(), keys.publicKey));
  assert.equal(receiver.latest()[0]!.report.error.message, "raw-error-report-sensitive-content");
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const row = db.prepare("SELECT envelope_json FROM feedback_reports").get() as { envelope_json: string };
    assert.doesNotMatch(row.envelope_json, /raw-error-report-sensitive-content/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM feedback_task_features").get() as { n: number }).n, 1);
  } finally { db.close(); }
  assert.doesNotMatch(JSON.stringify(storage.listWandTasks()), /raw-error-report-sensitive-content/);
  assert.equal(readFileSync(database).includes(Buffer.from("raw-error-report-sensitive-content")), false);
});

test("username is sampled from the originating Wand custom personal name and changes take effect for new reports", async t => {
  const { receiver, root, storage } = fixture(t);
  let name = "我设置的名字";
  const reporter = new FeedbackReporter({ configDir: root, version: "4.99.0", env: {}, username: () => name, fetch: async (_url, init) => {
    if (!init?.method) return Response.json(receiver.publicInfo());
    receiver.accept(JSON.parse(String(init.body))); return new Response(null, { status: 202 });
  } });
  t.after(() => reporter.stop());
  const payload = { schema: 1 as const, source: "android" as const, event: "update_failed" as const, feature: "app_update" as const, version: "4.99.0", error: { name: "Error", message: "original failure" } };
  reporter.captureClient(payload); await reporter.flush();
  assert.equal(storage.listWandTasks()[0]!.title, "【我设置的名字】-【应用更新】");
  name = "我后来改的名字";
  reporter.captureClient(payload); await reporter.flush();
  const comments = storage.listWandTaskComments(storage.listWandTasks()[0]!.id);
  assert.equal(comments[0]!.body, "【我后来改的名字】也遇到了相同的问题。");
  assert.equal(receiver.latest()[0]!.report.username, "我后来改的名字");
});

test("collection HTTP commit and comment endpoint expose persisted tasks/comments, with admin-only log access", async t => {
  const { receiver, storage } = fixture(t);
  const app = express(); registerFeedbackIngress(app, receiver);
  registerTaskRoutes(app, { storage, generateTitle: async () => { assert.fail("feedback titles must not call a model"); } });
  registerFeedbackAdminRoutes(app, receiver, (_req, res) => { res.sendStatus(403); });
  app.use(jsonErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (r: FeedbackReport) => fetch(`${base}/api/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(encryptFeedback(r, keys.publicKey)) });
  assert.equal((await post(errorReport())).status, 202);
  assert.equal((await post(errorReport("小李"))).status, 202);
  const task = storage.listWandTasks()[0]!;
  const response = await fetch(`${base}/api/wand-tasks/${task.id}/comments`);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).comments[0].body, "【小李】也遇到了相同的问题。");
  assert.equal((await fetch(`${base}/api/wand-tasks/${randomUUID()}/comments`)).status, 404);
  assert.equal((await fetch(`${base}/api/feedback/reports?taskId=${task.id}`)).status, 403);
});
