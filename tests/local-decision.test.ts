import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import express, { type RequestHandler } from "express";
import { DecisionService } from "../src/decision-service.js";
import { DecisionExpertService } from "../src/decision-expert-service.js";
import { decisionExpertDefinition } from "../src/decision-expert-employee.js";
import { defaultConfig } from "../src/config.js";
import { assessDecisionHardware } from "../src/decision-hardware.js";
import { parseDecisionRequest, parseDecisionResult, DecisionError, type DecisionResult } from "../src/decision-types.js";
import { callDecisionService } from "../src/decision-client.js";
import { registerDecisionRoutes } from "../src/server-decision-routes.js";
import { WandStorage } from "../src/storage.js";
import type { SessionSnapshot } from "../src/types.js";
import { withDecisionAccess } from "../src/decision-runner.js";
import { installDecisionSkill } from "../src/decision-skill.js";
import { buildChildEnv } from "../src/env-utils.js";
import { defaultPiSessionSettings } from "../src/pi-session-settings.js";
import type { StructuredRunnerAdapter, StructuredRunnerContext, StructuredRunnerResult } from "../src/structured-runner.js";

const input = { state: "synthetic", questions: {
  route: { type: "choice", instructions: "Choose", criteria: { a: "first", b: "second" } },
  urgency: { type: "score", instructions: "Rate", criteria: ["low", "high"] },
  known: { type: "noul", instructions: "Is it known?" },
} };
const parsed = () => parseDecisionRequest(input);
const session = (id: string): SessionSnapshot => ({ id, command: "pi", provider: "pi", sessionKind: "structured",
  cwd: "/tmp", mode: "default", status: "idle", exitCode: null, startedAt: new Date().toISOString(),
  endedAt: null, output: "", archived: false, archivedAt: null, claudeSessionId: null });
function setup(t: { after(fn: () => void): void }, timeoutMs = 2000) {
  const root = mkdtempSync(join(tmpdir(), "wand-decision-"));
  const storage = new WandStorage(join(root, "wand.db"));
  storage.saveSession(session("test"));
  const service = new DecisionService({ enabled: true, pythonPath: process.execPath, modelPath: root },
    { workerPath: resolve("tests/fixtures/decision-worker.mjs"), timeoutMs, idleMs: 1000, supported: () => true });
  t.after(() => { service.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  return { service, storage, root };
}

test("decision contract accepts bounded primitives and rejects executable/unknown knobs", () => {
  assert.equal(Object.keys(parsed().questions).length, 3);
  for (const value of [{ ...input, model: "remote" }, { ...input, state: null }, { ...input, questions: {} },
    { ...input, questions: { q: { type: "choice", instructions: "pick", criteria: ["same", "same"] } } },
    { ...input, questions: { q: { type: "noul", instructions: "test", criteria: { execute: "true" } } } },
    { ...input, questions: { q: { type: "choice", instructions: "pick", criteria: Array.from({ length: 9 }, (_, i) => String(i)) } } }]) {
    assert.throws(() => parseDecisionRequest(value), DecisionError);
  }
  const mutable = structuredClone(input);
  const accepted = parseDecisionRequest(mutable);
  mutable.questions.route.criteria.a = "changed";
  assert.equal((accepted.questions.route!.criteria as Record<string, string>).a, "first");
  assert.throws(() => parseDecisionRequest({ ...input, state: "x".repeat(16001) }));
});

test("one worker serves all primitives and rejects bad outputs", async (t) => {
  const { service } = setup(t);
  const [a, b] = await Promise.all([service.evaluate(input, "a"), service.evaluate(input, "b")]);
  assert.equal(a.answers.route!.choice, "a");
  assert.equal(b.answers.known!.noul, 0.7);
  assert.equal(service.status().completed, 2);
  assert.equal(a.experimental, true);
  assert.throws(() => parseDecisionResult({ ...a, usage: { ...a.usage, truncated: true } }, parsed()));
  assert.throws(() => parseDecisionResult({ ...a, answers: { ...a.answers, route: { ...a.answers.route, choice: "invented" } } }, parsed()));
  await assert.rejects(service.evaluate({ ...input, state: "bad" }, "a"), /协议|无效/);
});

test("context limits fail visibly without poisoning the next request", async (t) => {
  const { service } = setup(t);
  await assert.rejects(service.evaluate({ ...input, state: "context" }, "a"), (error: unknown) => error instanceof DecisionError && error.code === "CONTEXT_LIMIT");
  assert.equal((await service.evaluate(input, "a")).answers.route!.choice, "a");
});

test("bounded queue and absolute deadline terminate an unresponsive worker", async (t) => {
  const { service } = setup(t, 200);
  const pending = Array.from({ length: 8 }, () => service.evaluate({ ...input, state: "stall" }, "a").catch((error) => error));
  assert.throws(() => service.evaluate(input, "a"), (error: unknown) => error instanceof DecisionError && error.code === "BUSY");
  const errors = await Promise.all(pending);
  assert.ok(errors.every((error) => error instanceof DecisionError));
  assert.equal(service.status().queued, 0);
  assert.ok(["stopped", "stopping"].includes(service.status().state));
});

test("cancellation, crash and shutdown never leave pending promises", async (t) => {
  const { service } = setup(t);
  const abort = new AbortController();
  const pending = service.evaluate({ ...input, state: "stall" }, "a", abort.signal);
  abort.abort();
  await assert.rejects(pending, /取消/);
  service.dispose();
  assert.throws(() => service.evaluate(input, "a"), /未启用|关闭|环境/);
  const other = setup(t).service;
  await assert.rejects(other.evaluate({ ...input, state: "crash" }, "b"), /退出/);
});

test("inference capabilities are per session, hashed, renewable, expiring and explicitly revocable", (t) => {
  const { storage, root } = setup(t);
  const token = storage.issueDecisionAccess("test", 1000);
  assert.equal(storage.resolveDecisionAccess(token, 1001), "test");
  const reopened = new WandStorage(join(root, "wand.db"));
  try { assert.equal(reopened.resolveDecisionAccess(token, 1001), "test"); } finally { reopened.close(); }
  assert.equal(storage.resolveDecisionAccess(token, 1000 + 6 * 60 * 60 * 1000), null);
  const next = storage.issueDecisionAccess("test", 2000);
  assert.equal(storage.resolveDecisionAccess(token, 2001), null);
  storage.revokeDecisionAccess(next);
  assert.equal(storage.resolveDecisionAccess(next, 2001), null);
  assert.throws(() => storage.issueDecisionAccess("missing"));
});

test("runner capability is transient, replaces inherited credentials and revokes on completion/failure", async (t) => {
  const { storage } = setup(t);
  let received!: StructuredRunnerContext;
  let finish!: (result: StructuredRunnerResult) => void;
  const runner: StructuredRunnerAdapter = { start(context) {
    received = context;
    return { args: [], pid: null, spawnedAt: new Date().toISOString(), interrupt() {},
      completion: new Promise((resolve) => { finish = resolve; }) };
  } };
  const wrapper = withDecisionAccess(runner, storage, () => ({ url: "http://127.0.0.1:8443" }));
  const context = { session: session("test"), prompt: "request", env: { WAND_DECISION_TOKEN: "inherited" } };
  const observer = { isActive: () => true, onUpdate() {} };
  const execution = wrapper.start(context, observer);
  const token = received.env.WAND_DECISION_TOKEN!;
  assert.notEqual(token, "inherited");
  assert.equal(storage.resolveDecisionAccess(token), "test");
  assert.equal(context.env.WAND_DECISION_TOKEN, "inherited");
  assert.ok(!JSON.stringify(received.session).includes(token));
  assert.ok(!JSON.stringify(storage.loadSessions()).includes(token));
  finish({ state: { blocks: [], result: "ok", sessionId: null }, exitCode: 0, signal: null, stderr: "", primaryError: null });
  await execution.completion;
  assert.equal(storage.resolveDecisionAccess(token), null);
  let failedToken = "";
  const failed = withDecisionAccess({ start(ctx) { failedToken = ctx.env.WAND_DECISION_TOKEN!; throw new Error("spawn"); } }, storage, () => ({ url: "http://127.0.0.1:8443" }));
  assert.throws(() => failed.start(context, observer), /spawn/);
  assert.equal(storage.resolveDecisionAccess(failedToken), null);
  const disabled = withDecisionAccess(runner, storage, () => null).start(context, observer);
  assert.equal(received.env.WAND_DECISION_TOKEN, undefined);
  finish({ state: { blocks: [], result: "ok", sessionId: null }, exitCode: 0, signal: null, stderr: "", primaryError: null });
  await disabled.completion;
  const original = process.env.WAND_DECISION_TOKEN;
  process.env.WAND_DECISION_TOKEN = "inherited";
  try { assert.equal(buildChildEnv(true).WAND_DECISION_TOKEN, undefined); }
  finally { if (original === undefined) delete process.env.WAND_DECISION_TOKEN; else process.env.WAND_DECISION_TOKEN = original; }
});

test("Pi sessions can switch off the per-turn decision capability without touching other providers", async (t) => {
  const { storage } = setup(t);
  let received!: StructuredRunnerContext;
  const runner: StructuredRunnerAdapter = { start(context) {
    received = context;
    return { args: [], pid: null, spawnedAt: new Date().toISOString(), interrupt() {},
      completion: new Promise((resolve) => { void resolve; }) };
  } };
  const wrapper = withDecisionAccess(runner, storage, () => ({ url: "http://127.0.0.1:8443" }));
  const observer = { isActive: () => true, onUpdate() {} };
  const base = session("pi-off");
  storage.saveSession(base);
  const settings = defaultPiSessionSettings();
  // 关掉开关：不注入凭据，也不追加运行时提示。
  const off = wrapper.start({ session: { ...base, piSettings: { ...settings, localDecision: false } }, prompt: "x", env: {} }, observer);
  assert.equal(received.env.WAND_DECISION_TOKEN, undefined);
  assert.equal(received.session.runtimeSystemPrompt, undefined);
  void off;
  // 打开（默认）：仍然拿到本轮可撤销能力。
  received = undefined as unknown as StructuredRunnerContext;
  const on = wrapper.start({ session: { ...base, id: "test", piSettings: { ...settings, localDecision: true } }, prompt: "x", env: {} }, observer);
  const token = received.env.WAND_DECISION_TOKEN;
  assert.ok(token, "enabled Pi session must still receive a capability token");
  assert.match(received.session.runtimeSystemPrompt ?? "", /本地判断工具/);
  storage.revokeDecisionAccess(token!);
  void on;
});

test("managed skill installation is shared, idempotent and preserves user edits and foreign skills", async (t) => {
  const { root } = setup(t);
  const home = join(root, "home");
  const config = join(root, "config");
  const first = await installDecisionSkill(config, undefined, home);
  assert.equal(first.installed.length, 3);
  assert.equal(new Set(first.installed.map((file) => realpathSync(file))).size, 1);
  assert.deepEqual(first.changed.sort(), ["SKILL.md", "scripts/decide.mjs"]);
  assert.equal(first.linked.length, 3);
  const reinstalled = await installDecisionSkill(config, undefined, home);
  assert.deepEqual(reinstalled.installed, first.installed);
  assert.deepEqual(reinstalled.changed, []);
  assert.deepEqual(reinstalled.linked, []);
  const skill = join(config, "skills/wand-decision/SKILL.md");
  writeFileSync(skill, readFileSync(skill, "utf8") + "\nUSER EDIT\n");
  await assert.rejects(installDecisionSkill(config, undefined, home), /用户修改/);
  assert.match(readFileSync(skill, "utf8"), /USER EDIT/);
  const other = join(root, "other-home/.agents/skills/wand-decision");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "SKILL.md"), "foreign");
  await assert.rejects(installDecisionSkill(join(root, "other-config"), ["pi"], join(root, "other-home")), /同名/);
  assert.equal(readFileSync(join(other, "SKILL.md"), "utf8"), "foreign");
});

test("decision HTTP route and client complete the backup after the real local worker stalls", async (t) => {
  const { service: local, storage } = setup(t);
  let backupCalls = 0;
  const decisions = new DecisionExpertService({ employee: () => decisionExpertDefinition("test"), local,
    config: defaultConfig(), timeoutMs: 40,
    hardware: () => assessDecisionHardware({ platform: "darwin", arch: "arm64", memoryBytes: 16 * 1024 ** 3,
      availableBytes: 1024 ** 3, cpuCount: 8, metal: true }),
    free: { status: () => ({ configured: true, modelCount: 1 }) as any, resolveForCall: async () => { throw Error("no network"); } },
    generate: async (_agent, request) => {
      backupCalls++; assert.equal(request.state, "stall");
      return { model: "synthetic/backup", inputTokens: 9000, outputTokens: 120,
        answers: { route: { type: "choice", choice: "a", probabilities: { a: .8, b: .2 } },
          urgency: { type: "score", score: 1, probabilities: { "0": .2, "1": .8 } },
          known: { type: "noul", noul: .7 } } };
    } });
  const app = express(); app.use(express.json());
  registerDecisionRoutes(app, { storage, decisions, requireAuth: (_req, res) => { res.sendStatus(401); },
    requireSessions: (_req, _res, next) => next() });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { WAND_DECISION_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    WAND_DECISION_TOKEN: storage.issueDecisionAccess("test") };
  const result = await callDecisionService(parseDecisionRequest({ ...input, state: "stall" }), env) as DecisionResult;
  assert.equal(result.runtime, "decision-expert"); assert.equal(result.model, "synthetic/backup");
  assert.equal(result.executor?.candidate, 1); assert.equal(result.executor?.source, "free-group");
  assert.equal(result.usage.output_tokens, 120); assert.equal(backupCalls, 1);
  assert.equal(local.status().queued, 0); assert.equal(decisions.status().queued, 0);
});

test("decision HTTP client preserves backup identity, output usage and server failure codes", async (t) => {
  const remote = {
    model: "synthetic/backup", runtime: "decision-expert", experimental: true,
    answers: { route: { type: "choice", choice: "a", probabilities: { a: .8, b: .2 } },
      urgency: { type: "score", score: 1, probabilities: { "0": .2, "1": .8 } },
      known: { type: "noul", noul: .7 } },
    usage: { input_tokens: 9000, output_tokens: 120, truncated: false },
    executor: { employeeId: "e_wand_decision_expert", candidate: 1, source: "free-group" },
  };
  let body: unknown = remote, status = 200;
  const server = createServer((req, res) => {
    req.resume(); res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { WAND_DECISION_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    WAND_DECISION_TOKEN: `wd_${"a".repeat(43)}` };
  const result = await callDecisionService(parsed(), env) as typeof remote;
  assert.equal(result.model, remote.model); assert.equal(result.runtime, "decision-expert");
  assert.equal(result.usage.output_tokens, 120); assert.deepEqual(result.executor, remote.executor);
  for (const invalid of [{ ...remote, runtime: "made-up" }, { ...remote, executor: { ...remote.executor, candidate: 4 } },
    { ...remote, answers: {} }, { ...remote, runtime: "laya-mlx" }]) {
    body = invalid;
    await assert.rejects(callDecisionService(parsed(), env), (error: any) => error.code === "INVALID_RESULT");
  }
  status = 504; body = { code: "TIMEOUT", error: "PRIVATE-UPSTREAM-DETAIL" };
  await assert.rejects(callDecisionService(parsed(), env), (error: any) => {
    assert.equal(error.code, "TIMEOUT"); assert.ok(!error.message.includes("PRIVATE-UPSTREAM-DETAIL")); return true;
  });
});

test("HTTP capability is inference-only; unauthenticated/expired calls fail, CLI makes real HTTP calls", async (t) => {
  const { service, storage } = setup(t);
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  const requireAuth: RequestHandler = (req, res, next) => {
    if (req.headers.authorization === "Bearer admin") next();
    else res.status(401).json({ error: "Unauthorized" });
  };
  registerDecisionRoutes(app, { decisions: service, storage, requireAuth, requireSessions: (_req, _res, next) => next() });
  app.get("/api/sessions", requireAuth, (_req, res) => res.json([]));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await fetch(`${origin}/api/decisions/status`)).status, 401);
  const token = storage.issueDecisionAccess("test");
  const env = { WAND_DECISION_URL: origin, WAND_DECISION_TOKEN: token };
  const result = await callDecisionService(parsed(), env) as { experimental: boolean };
  assert.equal(result.experimental, true);
  assert.equal((await fetch(`${origin}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  const status = await callDecisionService(null, env) as Record<string, unknown>;
  assert.equal(status.completed, 1);
  assert.equal(status.pythonPath, undefined);
  storage.revokeDecisionAccess(token);
  await assert.rejects(callDecisionService(parsed(), env), /401/);
  await assert.rejects(callDecisionService(parsed(), { ...env, WAND_DECISION_URL: "http://example.com" }), /HTTPS/);
  await assert.rejects(callDecisionService(parsed(), {}), /管理员凭据/);
});
