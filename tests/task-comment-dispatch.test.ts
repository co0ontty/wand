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
import { normalizeTaskCommentInstruction, projectTaskComment, taskCommentPrompt } from "../src/task-comment-dispatch.js";
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
  const fixedCreatedAt = "2026-10-19T00:00:00.000Z";
  const insertFixedTime = (commentId: string, commentTaskId: string, text: string): void => {
    const db = (storage as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    db.prepare("INSERT INTO wand_task_comments(id, task_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(commentId, commentTaskId, "fixture", text, fixedCreatedAt);
  };
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
    await post(task.id, { requestId: "page-001", body: "page one" });
    await post(task.id, { requestId: "page-002", body: "page two" });
    await post(task.id, { requestId: "page-003", body: "page three" });
    const tieTask = storage.createWandTask({ title: "cursor tie" });
    insertFixedTime("cursor-a", tieTask.id, "tie a");
    insertFixedTime("cursor-b", tieTask.id, "tie b");
    insertFixedTime("cursor-c", tieTask.id, "tie c");
    insertFixedTime("cursor-other", other.id, "foreign tie");
    const pageOne = await (await fetch(`${url}/api/wand-tasks/${task.id}/comments?limit=2`)).json() as { comments: WandTaskComment[]; totalCount: number; nextCursor: string | null };
    assert.equal(pageOne.totalCount, 5);
    assert.equal(pageOne.comments.length, 2);
    assert.ok(pageOne.nextCursor);
    const pageTwo = await (await fetch(`${url}/api/wand-tasks/${task.id}/comments?limit=2&before=${encodeURIComponent(pageOne.nextCursor!)}`)).json() as { comments: WandTaskComment[]; totalCount: number; nextCursor: string | null };
    assert.equal(pageTwo.totalCount, 5);
    assert.equal(pageTwo.comments.length, 2);
    const paged = [...pageTwo.comments, ...pageOne.comments];
    const pagedIds = new Set(paged.map(comment => comment.id));
    assert.equal(pagedIds.size, 4, "adjacent pages must not repeat a comment");
    const tiedPage = storage.listWandTaskCommentsPage(tieTask.id, { limit: 2 });
    assert.deepEqual(tiedPage.comments.map(comment => comment.id), ["cursor-b", "cursor-c"], "same-time cursor ties are deterministic by ID");
    const tiedOlder = storage.listWandTaskCommentsPage(tieTask.id, { limit: 2, before: tiedPage.nextCursor });
    assert.ok(tiedOlder.comments.some(comment => comment.id === "cursor-a"), "older tied IDs remain reachable through the cursor");
    const allTied = [...tiedOlder.comments, ...tiedPage.comments].filter(comment => comment.createdAt === fixedCreatedAt);
    assert.deepEqual(allTied.map(comment => comment.id), ["cursor-a", "cursor-b", "cursor-c"]);
    assert.deepEqual(paged.map(comment => comment.createdAt), [...paged.map(comment => comment.createdAt)].sort(), "cursor pages preserve chronological order");
    assert.equal(pageTwo.totalCount, 5, "totals remain stable across cursor pages");
    assert.ok(pageTwo.nextCursor);
    const foreignCursor = await fetch(`${url}/api/wand-tasks/${other.id}/comments?limit=2&before=${encodeURIComponent(pageOne.nextCursor!)}`);
    assert.equal(foreignCursor.status, 200);
    const foreignPage = await foreignCursor.json() as { comments: WandTaskComment[]; totalCount: number };
    assert.ok(foreignPage.comments.every(comment => comment.taskId === other.id));
    assert.equal(foreignPage.totalCount, 1, "cursor pagination remains scoped to the target task");
    assert.deepEqual(foreignPage.comments.map(comment => comment.id), ["cursor-other"]);
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
    const foreignStatusComment = storage.createTaskCommentIntent({ taskId: other.id, requestId: "foreign-status", signature: "foreign-status",
      body: "foreign status comment", instruction: "foreign status comment", sourceCommentId: null,
      employeeId: employee.id, employeeName: employee.name, taskVersion: other.updatedAt });
    const sourceResponse = await fetch(`${url}/api/wand-tasks/${task.id}/comments/${ordinary.id}/source`);
    assert.equal(sourceResponse.headers.get("cache-control"), "no-store");
    const exactSource = await sourceResponse.json() as { comment: WandTaskComment };
    assert.equal(exactSource.comment.id, ordinary.id);
    assert.equal(exactSource.comment.body, ordinary.body);
    assert.equal("dispatch" in exactSource.comment, false, "source lookup returns only comment context");
    assert.equal((await fetch(`${url}/api/wand-tasks/missing-task/comments/${ordinary.id}/source`)).status, 404);
    for (const sourceId of [foreignStatusComment.id, "missing"]) {
      const absent = await fetch(`${url}/api/wand-tasks/${task.id}/comments/${sourceId}/source`).then(response => response.json());
      assert.deepEqual(absent, { comment: null }, "source lookup never exposes another task's comment");
    }
    const statusRefresh = await fetch(`${url}/api/wand-tasks/${task.id}/comments/status?ids=${encodeURIComponent(`${first.id},${foreignStatusComment.id},missing`)}`)
      .then(response => response.json()) as { comments: Array<{ id: string; dispatch: { status?: string } | null }> };
    assert.deepEqual(statusRefresh.comments.map(comment => comment.id), [first.id], "status refresh returns only existing comments owned by the requested task");
    assert.equal(statusRefresh.comments[0]?.dispatch?.status, "stopped", "status refresh uses the canonical live/frozen projection");
    assert.ok(!JSON.stringify(statusRefresh).includes(first.body), "status refresh does not resend comment bodies");
    assert.equal((await fetch(`${url}/api/wand-tasks/${task.id}/comments/status`)).status, 400, "status refresh requires a bounded non-empty ID list");
    assert.equal((await fetch(`${url}/api/wand-tasks/${task.id}/comments/status?ids=${Array.from({ length: 101 }, (_, index) => `c${index}`).join(",")}`)).status, 400,
      "status refresh refuses requests beyond its bounded ID limit");
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

test("duplicate employee mention prefix is removed only for new persisted instruction", () => {
  assert.equal(normalizeTaskCommentInstruction("@A @A please do this", "A"), "please do this");
  assert.equal(normalizeTaskCommentInstruction("@A and the literal @A later", "A"), "and the literal @A later");
  assert.equal(normalizeTaskCommentInstruction("@B do this", "A"), "@B do this");
  assert.equal(normalizeTaskCommentInstruction("ordinary comment", null), "ordinary comment");
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

test("comment result freezes its original turn, remains bounded, and rejects rewritten history", async () => {
  const { registerTaskCommentRoutes } = await import("../src/task-comment-dispatch.js");
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-comment-result-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root };
  const task = storage.createWandTask({ title: "result" });
  const employee = storage.ensureDefaultSiliconEmployee();
  const comment = storage.createTaskCommentIntent({ taskId: task.id, requestId: "result-request", signature: "sig", body: "@employee do A",
    instruction: "do A", sourceCommentId: null, employeeId: employee.id, employeeName: employee.name, taskVersion: task.updatedAt });
  const manager = new StructuredSessionManager(storage, config);
  const session = manager.createSession({ cwd: root, provider: "claude", mode: "default", employeeId: employee.id,
    sessionSource: "automation", automationId: `wand-task-comment:${comment.id}`, workspaceTaskId: task.workspaceTaskId! });
  storage.updateTaskCommentDispatch(comment.id, "accepted", session.id);
  const toolCall = { type: "tool_use" as const, id: "tool-A", name: "Read", input: { file_path: "/private/a", contents: "输入🙂".repeat(7000) } };
  const toolOutput = { type: "tool_result" as const, tool_use_id: "tool-A", content: `PRIVATE TOOL OUTPUT${"x".repeat(9000)}终` };
  const firstUser = { role: "user" as const, requestId: "round-A", createdAt: new Date().toISOString(), content: [{ type: "text" as const, text: "PRIVATE A" }, toolCall] };
  const overflowBlocks: import("../src/types.js").ContentBlock[] = Array.from({ length: 4_000 }, (_, index) => ({ type: "text" as const, text: `OVERFLOW-${index}-` + "z".repeat(12_000) }));
  overflowBlocks[2] = { type: "text", text: `OVERFLOW-2-${"💾".repeat(3_000)}` };
  overflowBlocks[2] = { ...overflowBlocks[2]!, __subagent: { taskId: `subagent-${"s".repeat(200_000)}`, taskDescription: "metadata".repeat(100_000) } };
  const firstAssistant = { role: "assistant" as const, requestId: "round-A", messageId: `assistant-${"💾".repeat(100_000)}`, content: [{ type: "text" as const, text: "RESULT A" }, toolOutput, ...overflowBlocks] };
  const running = { ...session, messages: [firstUser], status: "running", structuredState: { ...session.structuredState!, activeRequestId: "round-A", inFlight: true } };
  storage.saveSession(running);
  storage.recordTaskCommentSessionEvent({ sessionId: session.id, type: "output", data: { ...running, messages: running.messages } } as never);
  assert.equal(storage.getWandTaskComment(comment.id)?.dispatch?.resultAnchor?.requestId, "round-A");

  const activeApp = express();
  registerTaskCommentRoutes(activeApp, { storage, config, sessions: { get: () => running } as never });
  activeApp.use(jsonErrorHandler);
  const activeServer = createServer(activeApp); await new Promise<void>(resolve => activeServer.listen(0, "127.0.0.1", resolve));
  try {
    const active = await fetch(`http://127.0.0.1:${(activeServer.address() as { port: number }).port}/api/wand-tasks/${task.id}/comments/${comment.id}/result`);
    assert.equal((await active.json() as { reason: string }).reason, "still_running");
  } finally { await new Promise<void>(resolve => activeServer.close(() => resolve())); }
  const rewrittenBeforeFreeze = { ...running, messages: [{ ...firstUser, content: [{ type: "text" as const, text: "PRIVATE A rewritten" }] }, firstAssistant], status: "idle", structuredState: { ...running.structuredState!, activeRequestId: null, inFlight: false, lastError: null } };
  storage.saveSession(rewrittenBeforeFreeze);
  storage.recordTaskCommentSessionEvent({ sessionId: session.id, type: "ended", data: { ...rewrittenBeforeFreeze, messages: rewrittenBeforeFreeze.messages } } as never);
  assert.equal(storage.getWandTaskComment(comment.id)?.dispatch?.resultAnchor?.endIndex, null,
    "terminal event must not freeze if the original user message identity changed");
  const firstDone = { ...running, messages: [firstUser, firstAssistant], status: "idle", structuredState: { ...running.structuredState!, activeRequestId: null, inFlight: false, lastError: null } };
  storage.saveSession(firstDone);
  storage.recordTaskCommentSessionEvent({ sessionId: session.id, type: "ended", data: { ...firstDone, messages: firstDone.messages, terminalRequestId: "round-A", turnOutcome: "done" } } as never);
  assert.equal(storage.getWandTaskComment(comment.id)?.dispatch?.resultAnchor?.endIndex, 2);
  const activeFollowup = { ...firstDone, messages: [firstUser, firstAssistant, { role: "user" as const, requestId: "round-B", content: [{ type: "text" as const, text: "PRIVATE B" }] }],
    status: "running", structuredState: { ...firstDone.structuredState!, activeRequestId: "round-B", inFlight: true, lastError: null } };
  storage.saveSession(activeFollowup);
  storage.recordTaskCommentSessionEvent({ sessionId: session.id, type: "output", data: activeFollowup } as never);
  assert.equal(storage.getWandTaskComment(comment.id)?.dispatch?.status, "done", "persisted runtime projection cannot overwrite a frozen comment outcome");
  const failedFollowup = { ...activeFollowup, status: "idle", structuredState: { ...activeFollowup.structuredState, activeRequestId: null, inFlight: false, lastError: "later failure" } };
  storage.saveSession(failedFollowup);
  storage.recordTaskCommentSessionEvent({ sessionId: session.id, type: "ended", data: failedFollowup } as never);
  assert.equal(storage.getWandTaskComment(comment.id)?.dispatch?.status, "done", "later terminal failures cannot overwrite a frozen comment outcome");
  const secondUser = { role: "user" as const, requestId: "round-B", createdAt: new Date().toISOString(), content: [{ type: "text" as const, text: "PRIVATE B" }] };
  const secondAssistant = { role: "assistant" as const, requestId: "round-B", messageId: "assistant-B", content: [{ type: "text" as const, text: "RESULT B" }] };
  const secondDone = { ...firstDone, messages: [firstUser, firstAssistant, secondUser, secondAssistant] };
  storage.saveSession(secondDone);
  storage.recordTaskCommentSessionEvent({ sessionId: session.id, type: "ended", data: { ...secondDone, messages: secondDone.messages } } as never);

  const app = express();
  registerTaskCommentRoutes(app, { storage, config, sessions: { get: () => secondDone } as never });
  app.use(jsonErrorHandler);
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/wand-tasks/${task.id}/comments/${comment.id}/result`;
  try {
    const response = await fetch(endpoint);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const responseText = await response.text();
    assert.ok(Buffer.byteLength(responseText, "utf8") <= 256 * 1024, "raw initial response bytes stay within hard budget");
    const result = JSON.parse(responseText) as { available: boolean; messages?: Array<{ content: Array<{ text?: string; input?: object }>; blockOffset: number; blockTotal: number }>; truncatedBlocks?: Array<{ turnOffset: number; blockIndex: number }>; total?: number };
    assert.equal(result.available, true); assert.equal(result.total, 2);
    const text = JSON.stringify(result.messages);
    assert.ok(text.includes("PRIVATE A") && text.includes("RESULT A"));
    assert.ok(!text.includes("PRIVATE B") && !text.includes("RESULT B"), "later turns must not leak into the original comment result");
    assert.ok(text.length <= 256 * 1024 + 4096, "the per-page transport JSON remains bounded independently of turn count");
    assert.ok(text.includes("RESULT A") && !text.includes("x".repeat(9000)), "large tool payload must not ride in the turn response");
    assert.ok(result.truncatedBlocks?.some(block => block.turnOffset === 0 && block.blockIndex === 1), "large tool input has a scoped restoration handle");
    assert.ok(result.truncatedBlocks?.some(block => block.turnOffset === 1 && block.blockIndex === 1), "transport-truncated tool output keeps its original content-block index");
    assert.equal(result.messages?.[1]?.blockOffset, 0);
    assert.equal(result.messages?.[1]?.blockTotal, firstAssistant.content.length);
    assert.ok(result.truncatedBlocks?.some(block => block.turnOffset === 1 && block.blockIndex === 2), "a returned truncated block has a restoration handle");
    assert.equal(result.messages?.[1]?.content.length, 30, "the initial page exposes only the remaining bounded portion of this turn");
    const responseJsonBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    assert.ok(responseJsonBytes <= 256 * 1024, `serialized response including envelope stays within the hard budget (${responseJsonBytes} bytes)`);

    const blockWindowUrl = `${endpoint}/blocks/1`;
    const assistantWindow = result.messages?.[1];
    assert.ok(assistantWindow);
    const allWindowedBlocks: Array<{ type: string; text?: string }> = [...assistantWindow.content];
    assistantWindow.content.forEach((block, index) => {
      const source = firstAssistant.content[index]!;
      assert.equal(block.type, source.type, `initial window block ${index} retains its source type`);
      if (source.type === "text" && block.type === "text") assert.equal(block.text, source.text.slice(0, 512), `initial block ${index} retains its source text`);
    });
    let nextBlockOffset = assistantWindow.content.length;
    const blockTotal = assistantWindow.blockTotal;
    while (nextBlockOffset < blockTotal) {
      const pageResponse = await fetch(`${blockWindowUrl}?offset=${nextBlockOffset}&limit=32`);
      assert.equal(pageResponse.headers.get("cache-control"), "no-store");
      const pageText = await pageResponse.text();
      assert.ok(Buffer.byteLength(pageText, "utf8") <= 256 * 1024, "raw continuation response bytes stay within hard budget");
      const page = JSON.parse(pageText) as { turnOffset: number; blocks: Array<{ blockIndex: number; block: { type: string; text?: string }; truncated: boolean }>; blockOffset: number; blockTotal: number };
      assert.equal(page.turnOffset, 1);
      assert.equal(page.blockOffset, nextBlockOffset);
      assert.equal(page.blockTotal, blockTotal);
      const pageBytes = Buffer.byteLength(pageText, "utf8");
      assert.ok(pageBytes <= 256 * 1024, `serialized block-window page stays bounded (${pageBytes} bytes)`);
      assert.ok(page.blocks.length > 0, "each non-final block-window page advances");
      page.blocks.forEach((entry, localIndex) => {
        const absoluteIndex = page.blockOffset + localIndex;
        const source = firstAssistant.content[absoluteIndex]!;
        assert.equal(entry.blockIndex, absoluteIndex, `window block ${absoluteIndex} preserves absolute coordinate`);
        assert.equal(entry.block.type, source.type, `window block ${absoluteIndex} retains its source type`);
        if (source.type === "text" && entry.block.type === "text") assert.equal(entry.block.text, source.text.slice(0, 512), `window block ${absoluteIndex} retains its source preview`);
        assert.equal(entry.truncated, absoluteIndex !== 0 && absoluteIndex !== 1, `window block ${absoluteIndex} exposes whether full content requires restoration`);
      });
      allWindowedBlocks.push(...page.blocks.map(entry => entry.block));
      nextBlockOffset += page.blocks.length;
    }
    assert.equal(allWindowedBlocks.length, blockTotal, "all source block coordinates are enumerated exactly once");
    for (const index of [0, 31, 32, 2048, blockTotal - 1]) {
      const restored = await fetch(`${endpoint}/block/1/${index}`).then(value => value.json()) as { blockJsonBase64: string; offset: number; total: number };
      const bytes = Buffer.from(restored.blockJsonBase64, "base64");
      assert.deepEqual(JSON.parse(bytes.toString("utf8")), firstAssistant.content[index]);
    }
    assert.equal((await fetch(`${endpoint}/blocks/1?offset=${blockTotal + 1}`)).status, 400, "out-of-range block windows fail closed");

    const withTool = { ...firstDone, messages: [firstUser, firstAssistant, secondUser, secondAssistant] };
    const toolApp = express();
    registerTaskCommentRoutes(toolApp, { storage, config, sessions: { get: () => withTool } as never });
    toolApp.use(jsonErrorHandler);
    const toolServer = createServer(toolApp); await new Promise<void>(resolve => toolServer.listen(0, "127.0.0.1", resolve));
    try {
      const toolUrl = `http://127.0.0.1:${(toolServer.address() as { port: number }).port}/api/wand-tasks/${task.id}/comments/${comment.id}/result/tool-content/tool-A`;
      const blockEndpoint = `http://127.0.0.1:${(toolServer.address() as { port: number }).port}/api/wand-tasks/${task.id}/comments/${comment.id}/result`;
      const toolResponse = await fetch(toolUrl);
      assert.equal(toolResponse.headers.get("cache-control"), "no-store");
      const initialToolPage = await toolResponse.json() as { input?: object; inputJsonBase64: string; inputOffset: number; inputTotal: number; contentJsonBase64: string; offset: number; total: number; limit: number };
      assert.ok(initialToolPage.limit <= 16 * 4096);
      assert.ok(Buffer.from(initialToolPage.contentJsonBase64, "base64").length <= 16 * 4096);
      assert.ok(Buffer.from(initialToolPage.inputJsonBase64, "base64").length <= 16 * 1024);
      const decodeJsonPages = async (url: string, key: "contentJsonBase64" | "inputJsonBase64", start = 0): Promise<string> => {
        const chunks: Buffer[] = [];
        let offset = start, total = key === "inputJsonBase64" ? initialToolPage.inputTotal : initialToolPage.total;
        do {
          const page = await fetch(`${url}?offset=${key === "contentJsonBase64" ? offset : 0}&inputOffset=${key === "inputJsonBase64" ? offset : 0}`).then(response => response.json()) as typeof initialToolPage;
          const chunk = Buffer.from(page[key], "base64"); chunks.push(chunk);
          offset = (key === "inputJsonBase64" ? page.inputOffset : page.offset) + chunk.length;
          total = key === "inputJsonBase64" ? page.inputTotal : page.total;
        } while (offset < total);
        return Buffer.concat(chunks).toString("utf8");
      };
      const contentJson = await decodeJsonPages(toolUrl, "contentJsonBase64");
      assert.equal(JSON.parse(contentJson), `PRIVATE TOOL OUTPUT${"x".repeat(9000)}终`);
      const inputJson = await decodeJsonPages(toolUrl, "inputJsonBase64");
      assert.equal(JSON.parse(inputJson).contents, "输入🙂".repeat(7000));
      const base = toolUrl;
      const first = await fetch(`${base}?offset=0&limit=1`).then(response => response.json()) as { contentJsonBase64: string; offset: number; total: number; limit: number };
      const next = await fetch(`${base}?offset=${first.limit}&limit=1`).then(response => response.json()) as { contentJsonBase64: string; offset: number; total: number; limit: number };
      assert.ok(Buffer.from(first.contentJsonBase64, "base64").length <= 4096);
      assert.equal(next.offset, first.limit); assert.ok(Buffer.from(next.contentJsonBase64, "base64").length <= 4096);
      assert.notEqual(first.contentJsonBase64, next.contentJsonBase64, "tool result content can be retrieved in bounded pages");
      const blockUrl = `${blockEndpoint}/block/0/1`;
      const blockResponse = await fetch(blockUrl);
      assert.equal(blockResponse.headers.get("cache-control"), "no-store");
      const blockPage = await blockResponse.json() as { blockJsonBase64: string; offset: number; total: number; limit: number };
      assert.ok(Buffer.from(blockPage.blockJsonBase64, "base64").length <= 16 * 4096);
      const blockBytes = [Buffer.from(blockPage.blockJsonBase64, "base64")];
      let blockOffset = blockPage.offset + blockBytes[0]!.length;
      while (blockOffset < blockPage.total) {
        const page = await fetch(`${blockUrl}?offset=${blockOffset}`).then(response => response.json()) as typeof blockPage;
        const bytes = Buffer.from(page.blockJsonBase64, "base64"); blockBytes.push(bytes); blockOffset += bytes.length;
      }
      assert.deepEqual(JSON.parse(Buffer.concat(blockBytes).toString("utf8")), toolCall);
      assert.equal((await fetch(`${endpoint}/block/2/0`)).status, 404, "blocks outside the anchored range are rejected");
      const outside = await fetch(toolUrl.replace("tool-A", "tool-B"));
      assert.equal(outside.status, 404, "a tool outside this comment's frozen range must not be visible");
      const otherTask = await fetch(toolUrl.replace(`/wand-tasks/${task.id}/`, `/wand-tasks/${storage.createWandTask({ title: "other result" }).id}/`));
      assert.equal(otherTask.status, 404, "comment lookup must remain task-scoped");
    } finally { await new Promise<void>(resolve => toolServer.close(() => resolve())); }

    const rewritten = { ...secondDone, messages: [{ ...firstUser, content: [{ type: "text" as const, text: "PRIVATE A rewritten" }] }, firstAssistant, secondUser, secondAssistant] };
    const app2 = express();
    registerTaskCommentRoutes(app2, { storage, config, sessions: { get: () => rewritten } as never });
    app2.use(jsonErrorHandler);
    const server2 = createServer(app2); await new Promise<void>(resolve => server2.listen(0, "127.0.0.1", resolve));
    try {
      const invalidBase = `http://127.0.0.1:${(server2.address() as { port: number }).port}/api/wand-tasks/${task.id}/comments/${comment.id}/result`;
      const invalid = await fetch(invalidBase);
      assert.equal((await invalid.json() as { available: boolean }).available, false, "rewritten/compacted range fails closed");
      const invalidBlock = await fetch(`${invalidBase}/block/0/1`);
      assert.equal((await invalidBlock.json() as { available: boolean }).available, false, "rewritten transcript blocks fail closed too");
    } finally { await new Promise<void>(resolve => server2.close(() => resolve())); }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); manager.dispose(); storage.close(); }
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
  const frozenComment: WandTaskComment = { ...comment, dispatch: { ...comment.dispatch!, resultAnchor: {
    requestId: "request-A", startFingerprint: "start", fingerprint: "range", startIndex: 0, endIndex: 2, outcome: "done",
  } } };
  live = { status: "running", permissionBlocked: false, pendingEscalation: null, structuredState: { inFlight: true, lastError: null } };
  assert.equal(projectTaskComment(deps, frozenComment).dispatch?.status, "done", "a completed comment stays completed while the shared session runs another request");
  live = { status: "idle", permissionBlocked: false, pendingEscalation: { requestId: "later-approval" }, structuredState: { inFlight: false, lastError: null } };
  assert.equal(projectTaskComment(deps, frozenComment).dispatch?.status, "done", "later approvals cannot alter the frozen comment outcome");
  live = { status: "idle", permissionBlocked: false, pendingEscalation: null, structuredState: { inFlight: false, lastError: "later provider failure" } };
  assert.equal(projectTaskComment(deps, frozenComment).dispatch?.status, "done", "later failures cannot alter the frozen comment outcome");
  live.structuredState.lastError = null;
  assert.equal(projectTaskComment(deps, comment).dispatch?.status, "idle", "legacy comments without anchors retain live status projection");
});
