import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { defaultConfig } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { projectTaskComment, taskCommentPrompt } from "../src/task-comment-dispatch.js";
import { parseSystemCliCommand } from "../src/system-cli.js";
import type { WandTaskComment } from "../src/task-types.js";
import { commentRequestIdentity, settleCommentRequest } from "../src/web-ui/react/issues/task-comment-composer.js";
import { withCommentRequestStorage } from "./helpers/comment-request-storage.js";

test("comment dispatch: stable identity, ordinary comments, durable one-shot intents and lightweight handoffs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-comment-dispatch-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root };
  const manager = new StructuredSessionManager(storage, config);
  const registry = new SessionRegistry({ getOwned: () => null, getOwnedSlim: () => null } as never, manager, storage);
  const sent: Array<{ id: string; prompt: string }> = [];
  let uncertain = false;
  manager.sendMessage = ((id: string, prompt: string) => {
    const bound = storage.listWandTasks().flatMap(task => storage.listWandTaskComments(task.id)).find(comment => comment.dispatch?.sessionId === id);
    assert.equal(bound?.dispatch?.state, "pending", "session creation alone must not claim delivery before send");
    sent.push({ id, prompt }); if (uncertain) throw new Error("connection lost"); return Promise.resolve();
  }) as typeof manager.sendMessage;
  const app = express(); app.use(express.json());
  registerTaskRoutes(app, { storage, config, structured: manager, sessions: registry, generateTitle: async () => "test title" });
  app.use(jsonErrorHandler);
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const task = storage.createWandTask({ title: "test", description: "SECRET_OLD_DESCRIPTION" });
  const other = storage.createWandTask({ title: "other" });
  const employee = storage.ensureDefaultSiliconEmployee();
  const post = (taskId: string, body: object) => fetch(`${url}/api/wand-tasks/${taskId}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const read = async (response: Response) => (await response.json() as { comment: WandTaskComment }).comment;
  try {
    const ordinary = await read(await post(task.id, { requestId: "ordinary-001", body: "@赛博虎妞 ```@员工``` is only text" }));
    assert.equal(sent.length, 0); assert.equal(ordinary.dispatch, null);
    const request = { requestId: "employee-001", body: "write this round", employeeId: employee.id, sourceCommentId: ordinary.id };
    const [a, b] = await Promise.all([post(task.id, request), post(task.id, request)]);
    const first = await read(a), duplicate = await read(b);
    assert.equal(first.id, duplicate.id); assert.equal(sent.length, 1);
    assert.equal(first.dispatch?.employeeId, employee.id); assert.equal(first.dispatch?.sessionId, sent[0]!.id);
    assert.ok(sent[0]!.prompt.includes(`Task ID: ${task.id}`));
    assert.ok(sent[0]!.prompt.includes(`Source comment ID: ${ordinary.id}`));
    assert.ok(!sent[0]!.prompt.includes("SECRET_OLD_DESCRIPTION")); assert.ok(!sent[0]!.prompt.includes(ordinary.body));
    storage.recordTaskCommentSessionEvent({ sessionId: sent[0]!.id, type: "ended", data: { status: "idle", turnOutcome: "stopped" } } as never);
    const stopped = await (await fetch(`${url}/api/wand-tasks/${task.id}/comments`)).json() as { comments: WandTaskComment[] };
    assert.equal(stopped.comments.find(c => c.id === first.id)?.dispatch?.status, "stopped");
    assert.equal((await post(task.id, { ...request, body: "changed" })).status, 409);
    assert.equal((await post(other.id, { ...request, requestId: "wrong-source" })).status, 400);
    assert.equal((await post(task.id, { requestId: "wrong-employee", body: "test", employeeId: employee.name })).status, 400);
    storage.saveSiliconEmployee({ ...employee, id: "archived-employee", systemKey: undefined, tags: [], name: "archived", archivedAt: new Date().toISOString() });
    assert.equal((await post(task.id, { requestId: "archived-employee", body: "test", employeeId: "archived-employee" })).status, 400);
    uncertain = true;
    const unknown = await read(await post(task.id, { ...request, requestId: "unknown-001", sourceCommentId: first.id }));
    assert.equal(unknown.dispatch?.state, "unknown");
    await post(task.id, { ...request, requestId: "unknown-001", sourceCommentId: first.id });
    assert.equal(sent.length, 2);
    await withCommentRequestStorage(async () => {
      const snapshot = { body: "unknown received with 201", employeeId: employee.id, sourceCommentId: first.id, revision: 1 };
      const originalIdentity = await commentRequestIdentity(task.id, snapshot);
      const request = { requestId: originalIdentity.requestId, body: snapshot.body, employeeId: employee.id, sourceCommentId: first.id };
      const firstResponse = await post(task.id, request);
      assert.equal(firstResponse.status, 201);
      const saved = await read(firstResponse);
      assert.equal(saved.dispatch?.state, "unknown");
      settleCommentRequest(originalIdentity, saved);
      const startsAfterUnknown = sent.length;
      const refreshed = await commentRequestIdentity(task.id, { ...snapshot, revision: 0 });
      assert.equal(refreshed.requestId, originalIdentity.requestId);
      assert.equal((await read(await post(task.id, { ...request, requestId: refreshed.requestId }))).id, saved.id);
      assert.equal(sent.length, startsAfterUnknown, "201 unknown plus refresh cannot restart execution");
      uncertain = false;
      const newDraft = { ...snapshot, body: "separate new instruction", revision: 2 };
      const newIdentity = await commentRequestIdentity(task.id, newDraft);
      assert.notEqual(newIdentity.requestId, originalIdentity.requestId);
      settleCommentRequest(newIdentity, await read(await post(task.id, { ...request, requestId: newIdentity.requestId, body: newDraft.body })));
      const returned = await commentRequestIdentity(task.id, { ...snapshot, revision: 3 });
      assert.equal(returned.requestId, originalIdentity.requestId, "new accepted text must not erase an older unknown mapping");
      assert.equal((await read(await post(task.id, { ...request, requestId: returned.requestId }))).id, saved.id);
      assert.equal(sent.length, startsAfterUnknown + 1, "only the distinct new instruction starts a new session");
    });
    const pending = storage.createTaskCommentIntent({ taskId: task.id, requestId: "crashed-001", signature: "manual", body: "test", instruction: "test", sourceCommentId: null, employeeId: employee.id, employeeName: employee.name, taskVersion: task.updatedAt });
    const list = await (await fetch(`${url}/api/wand-tasks/${task.id}/comments`)).json() as { comments: WandTaskComment[] };
    assert.equal(list.comments.find(c => c.id === pending.id)?.dispatch?.status, "unknown");
    assert.equal((await post(task.id, { requestId: "ordinary-002", body: "not blocked" })).status, 201);
    const context = await (await fetch(`${url}/api/wand-tasks/${task.id}/context?commentId=${first.id}`)).json() as { task: { description: string }; source: WandTaskComment; references: object[] };
    assert.equal(context.task.description, "SECRET_OLD_DESCRIPTION"); assert.equal(context.source.id, first.id);
    assert.ok(!JSON.stringify(context.references).includes(ordinary.body));
    assert.equal((await fetch(`${url}/api/wand-tasks/${other.id}/context?commentId=${first.id}`)).status, 400);
    const command = await parseSystemCliCommand("task:context", [task.id, first.id]);
    let target = "";
    await command({ get: async (route: string) => { target = route; return {} as never; } } as never);
    assert.equal(target, `/api/wand-tasks/${task.id}/context?commentId=${first.id}`);
    assert.equal(storage.getWandTask(task.id)?.acceptance?.acceptedAt ?? null, null);
    uncertain = false;
    const legacy = await fetch(`${url}/api/wand-tasks/${other.id}/dispatch`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "legacy-creation", subject: { type: "employee", id: employee.id }, prompt: "legacy first round" }) });
    assert.equal(legacy.status, 202);
    const legacyResult = await legacy.json() as { comment: WandTaskComment };
    assert.equal(legacyResult.comment.taskId, other.id);
    assert.ok(sent.at(-1)!.prompt.includes(`Comment ID: ${legacyResult.comment.id}`));
    assert.ok(sent.at(-1)!.prompt.endsWith("legacy first round"));
    storage.saveSiliconEmployee({ ...employee, id: "unavailable-sdk", systemKey: undefined, tags: [], agents: [{ provider: "pi", engine: "sdk", model: "fixture", mode: "default", kind: "structured", thinkingEffort: "off" }] });
    let checks = 0;
    manager.resolveNewSessionPiEngine = async () => { checks++; throw new Error("pure capability resolution rejected"); };
    const preflightRequest = { requestId: "preflight-sdk-001", body: "do not start", employeeId: "unavailable-sdk" };
    const preflight = await read(await post(task.id, preflightRequest));
    assert.equal(preflight.dispatch?.state, "failed"); assert.equal(preflight.dispatch?.sessionId, null);
    assert.match(preflight.dispatch?.error ?? "", /未创建会话或发送输入/);
    await post(task.id, preflightRequest); assert.equal(checks, 1, "an explicit failed receipt is durable, not automatically rerun");
    const cliPreflight = await fetch(`${url}/api/wand-tasks/${task.id}/dispatch`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "cli-preflight-sdk-001", prompt: "explicit CLI override", agent: { provider: "pi", engine: "sdk", model: "fixture", mode: "default", kind: "structured", thinkingEffort: "off" } }) });
    assert.equal(cliPreflight.status, 400, "explicit preflight failure remains a known refusal in the compatibility CLI route");
    assert.equal(checks, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); manager.dispose(); storage.close(); }
});

test("first and subsequent prompt builders carry references and only this round's instruction", () => {
  const prompt = taskCommentPrompt({ taskId: "task", commentId: "comment", sourceCommentId: null, taskVersion: "v1", instruction: "only instruction" });
  assert.ok(prompt.includes("Source comment ID: none")); assert.ok(prompt.endsWith("only instruction"));
  assert.ok(prompt.includes("wand task:context task comment"));
});


test("pending intent survives storage reopen and route replay never starts a second execution", async () => {
  const { createHash } = await import("node:crypto");
  const { registerTaskCommentRoutes } = await import("../src/task-comment-dispatch.js");
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-comment-reopen-"));
  const filename = path.join(root, "wand.db");
  let storage = new WandStorage(filename);
  const task = storage.createWandTask({ title: "durable" });
  const employee = storage.ensureDefaultSiliconEmployee();
  const request = { requestId: "durable-request", body: "only instruction", employeeId: employee.id };
  const signature = createHash("sha256").update(JSON.stringify({ instruction: request.body, employeeId: employee.id, sourceCommentId: null })).digest("hex");
  const original = storage.createTaskCommentIntent({ taskId: task.id, requestId: request.requestId, signature,
    instruction: request.body, body: request.body, sourceCommentId: null, employeeId: employee.id, employeeName: employee.name, taskVersion: task.updatedAt });
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root });
  const orphan = manager.createSession({ cwd: root, provider: "claude", mode: "default", employeeId: employee.id,
    sessionSource: "automation", automationId: `wand-task-comment:${original.id}`, workspaceTaskId: task.workspaceTaskId! });
  manager.dispose();
  storage.close(); storage = new WandStorage(filename);
  let launches = 0;
  const app = express(); app.use(express.json());
  registerTaskCommentRoutes(app, { storage, config: defaultConfig(), structured: { createSession() { launches++; throw Error("must not replay"); } } as never });
  app.use(jsonErrorHandler);
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/wand-tasks/${task.id}/comments`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    const result = await response.json() as { comment: WandTaskComment; replayed: boolean };
    assert.equal(result.comment.id, original.id); assert.equal(result.comment.dispatch?.status, "unknown");
    assert.equal(result.replayed, true); assert.equal(launches, 0);
    assert.equal(result.comment.dispatch?.sessionId, orphan.id, "create/bind crash gap remains exactly locatable without restarting it");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); storage.close(); }
});

test("live approval blocks take precedence over in-flight, failures and unknown stay distinct", () => {
  let live = { status: "running", permissionBlocked: true, pendingEscalation: null as unknown, structuredState: { inFlight: true, lastError: null as string | null } };
  const deps = { storage: { getSessionSlim: () => null }, sessions: { ownerOf: () => "structured", getSlim: () => live } } as never;
  const comment: WandTaskComment = { id: "c", taskId: "t", authorName: "用户", body: "本轮", createdAt: "now",
    dispatch: { employeeId: "stable", employeeName: "员工", state: "accepted", sessionId: "exact", error: null } };
  assert.equal(projectTaskComment(deps, comment).dispatch?.status, "blocked");
  live = { status: "running", permissionBlocked: false, pendingEscalation: { requestId: "actual-approval" }, structuredState: { inFlight: true, lastError: null } };
  assert.equal(projectTaskComment(deps, comment).dispatch?.status, "blocked");
  live = { status: "idle", permissionBlocked: false, pendingEscalation: null, structuredState: { inFlight: false, lastError: "provider failure" } };
  assert.equal(projectTaskComment(deps, comment).dispatch?.status, "failed");
  assert.equal(projectTaskComment(deps, { ...comment, dispatch: { ...comment.dispatch!, state: "unknown" } }).dispatch?.status, "unknown");
  const history = { storage: { getSessionSlim: () => ({ status: "idle" }) }, sessions: { ownerOf: () => "storage" } } as never;
  assert.equal(projectTaskComment(history, comment).dispatch?.status, "history");
  assert.equal(projectTaskComment(history, { ...comment, dispatch: { ...comment.dispatch!, status: "stopped" } }).dispatch?.status, "stopped");
  live.structuredState.lastError = null;
  assert.equal(projectTaskComment(deps, comment).dispatch?.status, "idle", "idle is a runtime fact, not task acceptance");
});
