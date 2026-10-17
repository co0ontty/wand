import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { WandStorage } from "../src/storage.js";
import { systemAiSessions } from "../src/system-ai-session-recorder.js";
import { AiCallTraceError, isSystemAiCall, SYSTEM_AI_CALL_PREFIX } from "../src/system-ai-call.js";
import { callConfiguredAiText } from "../src/ai-text-runner.js";
import { SessionRegistry } from "../src/session-registry.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { ProcessManager } from "../src/process-manager.js";
import type { WandConfig } from "../src/types.js";
import { parseSessionCreationOrigin } from "../src/session-request.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { CoreTurnTracker } from "../src/core-turn-tracker.js";
import { organizeSelectedByTitle } from "../src/task-title-organize-service.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-system-ai-"));
  const db = path.join(root, "wand.db");
  const storage = new WandStorage(db);
  const employee = storage.ensureSystemSiliconEmployee({ provider: "pi" });
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, db, storage, employee, recorder: systemAiSessions(storage) };
}
const text = (session: ReturnType<WandStorage["getSession"]>) => (session?.messages ?? []).flatMap(turn => turn.content.map(block => block.type === "text" ? block.text : "")).join("\n");

test("real call trace has stable ops attribution, canonical employee link, input/output and final business outcome", t => {
  const f = fixture(t);
  const call = f.recorder.forEmployee(f.employee, "source-session").start("task-organize", { system: "只判断，不执行任务", prompt: "业务输入" }, f.root);
  let session = f.storage.getSession(call.sessionId)!;
  assert.equal(session.employeeId, "e_wand_ops"); assert.equal(session.employeeName, "勤劳的初二");
  assert.equal(isSystemAiCall(session), true); assert.equal(session.sessionSource, "automation");
  assert.equal(session.workspaceTaskId, undefined); assert.equal(f.storage.listWandTasks().length, 0);
  assert.equal(f.storage.employeeConversationForSession(call.sessionId), "dm_e_wand_ops");
  assert.equal(session.messages?.[0]?.author?.id, "system");
  call.candidateStarted({ provider: "pi", engine: "sdk", model: "unit/model" });
  call.candidateSucceeded('{"tasks":[],"sessions":[]}', { tasks: [], sessions: [] });
  call.complete();
  f.recorder.appendOutcome(call.sessionId, "实际任务归类结果", { categorizedTasks: [], movedSessions: [], skippedTasks: 2 });
  session = f.storage.getSession(call.sessionId)!;
  assert.equal(session.status, "exited"); assert.ok(session.endedAt);
  assert.equal(session.structuredState?.engine, "core"); assert.equal(session.structuredState?.inFlight, false);
  assert.equal(session.claudeSessionId, null, "never invent a native resumable ID");
  assert.match(text(session), /业务输入/); assert.match(text(session), /模型输出/); assert.match(text(session), /skippedTasks/);
  assert.equal(f.storage.conversationEvents("dm_e_wand_ops").filter(turn => turn.sessionLink?.sessionId === session.id).length, 1);
});

test("sensitive system inputs are bounded/redacted; git and memory input preserve only hash/size", t => {
  const f = fixture(t), previous = process.env.WAND_TRACE_TEST_SECRET;
  const fake = "unit-test-secret-not-a-real-credential";
  process.env.WAND_TRACE_TEST_SECRET = fake;
  try {
    const call = f.recorder.forEmployee(f.employee).start("prompt-optimize", { system: f.employee.prompt + "\n业务规则", prompt: `Bearer ${fake}\npassword=fixture-password\n普通文字` }, f.root);
    call.candidateStarted({ provider: "pi", engine: "cli", model: "fixture-model" });
    call.candidateFailed({ provider: "pi" }, new Error(fake), "execution"); call.fail(new Error(fake));
    const stored = f.storage.getSession(call.sessionId)!;
    assert.ok(!JSON.stringify(stored).includes(fake)); assert.ok(!text(stored).includes("fixture-password"));
    assert.match(text(stored), /已脱敏/); assert.ok(!text(stored).includes(f.employee.prompt));
    const git = f.recorder.forEmployee(f.employee).start("git-commit", { system: "生成提交说明", prompt: "private source diff with arbitrary credentials" }, f.root);
    git.fail(new Error("upstream original error: HTTP 403 model unavailable; Bearer fixture-secret-abc123"));
    assert.match(text(f.storage.getSession(git.sessionId)), /SHA256/);
    assert.doesNotMatch(text(f.storage.getSession(git.sessionId)), /arbitrary credentials|fixture-secret-abc123/);
    assert.match(text(f.storage.getSession(git.sessionId)), /upstream original error: HTTP 403 model unavailable/);
    assert.match(text(f.storage.getSession(git.sessionId)), /原始错误（凭据已脱敏）/);
  } finally { if (previous === undefined) delete process.env.WAND_TRACE_TEST_SECRET; else process.env.WAND_TRACE_TEST_SECRET = previous; }
});

test("one configured call creates one record across actual fake-CLI attempts; malformed output is logged as a failed attempt", async t => {
  const f = fixture(t), previousPath = process.env.PATH, previousDisable = process.env.WAND_SHELL_ENV_DISABLE, previousCounter = process.env.WAND_TRACE_COUNTER;
  const counter = path.join(f.root, "calls");
  const pi = path.join(f.root, "pi");
  writeFileSync(pi, `#!/bin/sh\nprintf 'called\\n' >> "$WAND_TRACE_COUNTER"\ncase "$*" in\n *invalid-model*) printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"not-json"}]}}';;\n *) printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"ok\\":true}"}]}}';;\nesac\n`);
  chmodSync(pi, 0o755);
  process.env.PATH = f.root + path.delimiter + previousPath; process.env.WAND_SHELL_ENV_DISABLE = "1"; process.env.WAND_TRACE_COUNTER = counter;
  try {
    const ids: string[] = [];
    const result = await callConfiguredAiText({ system: "只输出JSON", prompt: "unit input" }, f.root, "中文", {
      provider: "pi", cliCandidates: [{ provider: "pi", model: "unit-trace-invalid-model" }, { provider: "pi", model: "unit-trace-valid-model" }],
      purpose: "task-organize", traceFactory: f.recorder.forEmployee(f.employee), onCallSessionCreated: id => ids.push(id),
    }, raw => JSON.parse(raw));
    assert.deepEqual(result, { ok: true }); assert.equal(ids.length, 1);
    assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 2);
    const session = f.storage.getSession(ids[0]!)!;
    assert.equal(session.selectedModel, "unit-trace-valid-model"); assert.equal(session.status, "exited");
    assert.match(text(session), /结果校验失败/); assert.match(text(session), /尝试了 2 个候选/);
    assert.equal(f.storage.loadSessionsSlim().length, 1);
    writeFileSync(counter, "");
    const factory = f.recorder.forEmployee(f.employee);
    await assert.rejects(callConfiguredAiText({ system: "只输出JSON", prompt: "unit logging failure" }, f.root, "中文", {
      provider: "pi", cliCandidates: [{ provider: "pi", model: "unit-trace-valid-model" }, { provider: "pi", model: "unit-trace-another-valid-model" }],
      traceFactory: { start: (purpose, request, cwd) => ({ ...factory.start(purpose, request, cwd), candidateSucceeded: () => { throw new AiCallTraceError(); } }) },
    }, raw => JSON.parse(raw)), AiCallTraceError);
    assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 1, "journal failure is not a model refusal and cannot replay another paid candidate");
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousDisable === undefined) delete process.env.WAND_SHELL_ENV_DISABLE; else process.env.WAND_SHELL_ENV_DISABLE = previousDisable;
    if (previousCounter === undefined) delete process.env.WAND_TRACE_COUNTER; else process.env.WAND_TRACE_COUNTER = previousCounter;
  }
});

test("empty configured chains retain a failed request without executing or silently changing providers", async t => {
  const f = fixture(t), ids: string[] = [];
  await assert.rejects(callConfiguredAiText({ system: "判断", prompt: "配置为空" }, f.root, "中文", {
    provider: "pi", employeeChannelOnly: true, cliCandidates: [], traceFactory: f.recorder.forEmployee(f.employee),
    onCallSessionCreated: id => ids.push(id),
  }), /没有可用的执行候选/);
  assert.equal(ids.length, 1);
  const session = f.storage.getSession(ids[0]!)!;
  assert.equal(session.status, "failed"); assert.equal(session.provider, undefined);
  assert.doesNotMatch(text(session), /开始尝试/); assert.match(text(session), /AI_FALLBACK_FAILED/);
});

test("restart turns an old running system call into unknown/interrupted history, never a live structured owner", t => {
  const f = fixture(t);
  const call = f.recorder.forEmployee(f.employee).start("session-title", { system: "标题", prompt: "输入" }, f.root);
  call.candidateStarted({ provider: "pi", engine: "sdk", model: "fixture/model" }); call.complete();
  const before = f.storage.getSession(call.sessionId)!;
  f.storage.saveSession({ ...before, status: "running", endedAt: null, structuredState: { ...before.structuredState!, inFlight: true } });
  const config = { defaultProvider: "pi", defaultCwd: f.root, defaultMode: "default", commands: [] } as unknown as WandConfig;
  f.recorder.recoverInterrupted(); // The server recovers its own one-shot records before creating execution managers.
  const manager = new StructuredSessionManager(f.storage, config);
  t.after(() => manager.dispose());
  assert.equal(manager.get(call.sessionId), null);
  const recovered = f.storage.getSession(call.sessionId)!;
  assert.equal(recovered.status, "failed"); assert.match(text(recovered), /结果未知；未自动重试/);
  assert.equal(recovered.structuredState?.inFlight, false);
});

test("system calls never become business tasks or classifier input, and deletion is authoritative", async t => {
  const f = fixture(t);
  const workspace = f.storage.createWorkspace({ name: "Project", cwd: f.root });
  const task = f.storage.createWorkspaceTask({ workspaceId: workspace.id, name: "系统调用 · 任务归类判断", board: { titleSource: "auto" } });
  const call = f.recorder.forEmployee(f.employee).start("task-organize", { system: "判断", prompt: "输入" }, f.root);
  assert.throws(() => f.storage.moveSessionToWorkspaceTask(call.sessionId, task.id), /不能绑定/);
  const result = await organizeSelectedByTitle(f.storage, { taskIds: [task.id], sessionIds: [call.sessionId] });
  assert.deepEqual(result.movedSessions, []);
  f.storage.deleteSession(call.sessionId); call.complete(); f.recorder.appendOutcome(call.sessionId, "late", {});
  assert.equal(f.storage.getSession(call.sessionId), null, "no late record resurrection");
  assert.throws(() => parseSessionCreationOrigin({ automationId: SYSTEM_AI_CALL_PREFIX + "forged" }), /保留命名空间/);
});

test("server rejects send/model/mode/resume and active deletion, while completed records remain readable/archivable/deletable", async t => {
  const f = fixture(t), call = f.recorder.forEmployee(f.employee).start("prompt-optimize", { system: "优化", prompt: "输入" }, f.root);
  const config = { defaultProvider: "pi", defaultCwd: f.root, defaultMode: "default", commands: [] } as unknown as WandConfig;
  const structured = new StructuredSessionManager(f.storage, config);
  const processes = { getOwned: () => null, getOwnedSlim: () => null, get: () => null, listSlim: () => [] } as unknown as ProcessManager;
  const sessions = new SessionRegistry(processes, structured, f.storage);
  const app = express(); app.use(express.json()); registerSessionRoutes(app, { storage: f.storage, config, structured, processes, sessions, defaultMode: "default" }); app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); structured.dispose(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [method, suffix] of [["POST", "/input"], ["POST", "/model"], ["POST", "/mode"], ["POST", "/resume"], ["POST", "/stop"], ["DELETE", ""]]) {
    assert.equal((await fetch(`${origin}/api/sessions/${call.sessionId}${suffix}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify({ input: "must not run", model: "new", mode: "full-access" }) : undefined })).status, 409);
  }
  assert.equal((await fetch(`${origin}/api/structured-sessions/${call.sessionId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "must not run" }) })).status, 409);
  call.complete();
  const read = await fetch(`${origin}/api/sessions/${call.sessionId}?format=chat`); assert.equal(read.status, 200);
  assert.equal((await read.json()).automationId.startsWith(SYSTEM_AI_CALL_PREFIX), true);
  assert.equal((await fetch(`${origin}/api/sessions/${call.sessionId}/archive`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${origin}/api/sessions/${call.sessionId}`, { method: "DELETE" })).status, 200);
  assert.equal(f.storage.getSession(call.sessionId), null);
});

test("SDK system calls participate in Core drain admission without reclassifying CLI work as Core", () => {
  const release = CoreTurnTracker.beginSystemCallDrain();
  assert.throws(() => CoreTurnTracker.startTurn("system-fixture", true), /排空 Core/);
  const ordinary = CoreTurnTracker.startTurn("ordinary"); CoreTurnTracker.endTurn(ordinary);
  release(); release();
  const token = CoreTurnTracker.startTurn("system-fixture", true);
  assert.ok(CoreTurnTracker.getActiveTurnIds().includes("system-fixture"));
  CoreTurnTracker.endTurn(token);
});
