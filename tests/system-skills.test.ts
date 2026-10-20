import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { parseSystemCliCommand } from "../src/system-cli.js";
import { WandCliApi } from "../src/cli-api.js";
import { installSystemSkill } from "../src/system-skill.js";
import { installManagedSkill } from "../src/managed-skill.js";
import { ensureManagedSkills, formatManagedSkillsEnsureLog, isDefaultConfigPath } from "../src/managed-skills-ensure.js";
import { startEmployeeKnowledgeRunner } from "../src/employee-knowledge.js";
import type { WandConfig, SessionSnapshot } from "../src/types.js";
import type { StructuredRunnerAdapter, StructuredRunnerContext, StructuredRunnerObserver } from "../src/structured-runner.js";
import { ScheduledTaskService } from "../src/scheduled-task-service.js";
import { registerScheduledTaskRoutes } from "../src/server-scheduled-task-routes.js";
import { conversationHarness } from "./helpers/conversation-harness.js";

async function* input(value: unknown) { yield JSON.stringify(value); }
const snapshot = (extra: object = {}) => ({ id: "original/session", sessionKind: "structured", archived: false,
  structuredState: { inFlight: false }, ...extra }) as SessionSnapshot;
function apiHarness(initial = snapshot()) {
  const calls: Array<{ method: string; route: string; body?: unknown }> = [];
  return { calls, api: {
    async get<T>(route: string) { calls.push({ method: "GET", route }); return initial as T; },
    async post<T>(route: string, body: unknown) { calls.push({ method: "POST", route, body }); return initial as T; },
    async patch<T>(route: string, body: unknown) { calls.push({ method: "PATCH", route, body }); return initial as T; },
  } };
}
async function execute(command: string, args: string[], body: unknown, h = apiHarness()) {
  const op = await parseSystemCliCommand(command, args, input(body));
  const result = await op(h.api);
  return { ...h, result };
}

test("system commands map to bounded existing routes and preserve employee settings", async () => {
  for (const [command, args, route] of [
    ["employee:list", [], "/api/silicon-employees"],
    ["employee:list", ["--include-archived"], "/api/silicon-employees?includeArchived=1"],
    ["workspace:list", [], "/api/workspaces"],
    ["schedule:list", ["--include-cancelled"], "/api/scheduled-tasks?includeCancelled=1"],
    ["schedule:read", ["schedule/one"], "/api/scheduled-tasks/schedule%2Fone"],
  ] as Array<[string, string[], string]>) {
    const h = await execute(command, args, {});
    assert.deepEqual(h.calls, [{ method: "GET", route }]);
  }
  const body = { employeeId: "e_one", cwd: "/work", workspaceId: "w_one", prompt: "检查" };
  const created = await execute("session:create", ["--stdin"], body);
  assert.deepEqual(created.calls, [{ method: "POST", route: "/api/sessions", body: { ...body, kind: "structured" } }]);
  for (const [command, args, value] of [
    ["session:create", ["--stdin"], { ...body, mode: "full-access" }],
    ["session:create", ["--stdin"], { ...body, provider: "pi" }],
    ["session:create", ["--stdin"], {}],
    ["schedule:create", ["--stdin"], { employeeId: "e_one", prompt: "x" }],
    ["schedule:update", ["s", "--stdin"], { enabled: false }],
    ["schedule:read", ["--stdin"], {}],
    ["employee:list", ["--config", "/other"], {}],
    ["workspace:list", ["--include-archived"], {}],
    ["session:resume", ["s", "--stdin"], { input: " " }],
    ["schedule:list", ["--include-cancelled", "extra"], {}],
  ] as Array<[string, string[], unknown]>) {
    await assert.rejects(execute(command, args, value), /字段|缺少|revision|用法/);
  }
  await assert.rejects(parseSystemCliCommand("session:create", ["--stdin"], input([])), /JSON 对象/);
  async function* huge() { yield "x".repeat(1024 * 1024 + 1); }
  await assert.rejects(parseSystemCliCommand("session:create", ["--stdin"], huge()), /1 MiB/);
});

test("resume reuses exact structured ID, restores archived state and never interrupts busy/approval/queue", async () => {
  const h = await execute("session:resume", ["original/session", "--stdin"], { input: "检查失败证据，继续原任务" }, apiHarness(snapshot({ archived: true })));
  assert.deepEqual(h.calls, [
    { method: "GET", route: "/api/sessions/original%2Fsession" },
    { method: "POST", route: "/api/sessions/original%2Fsession/unarchive", body: {} },
    { method: "POST", route: "/api/sessions/original%2Fsession/input", body: { input: "检查失败证据，继续原任务", respondImmediately: true } },
  ]);
  for (const extra of [
    { structuredState: { inFlight: true } }, { queuedMessages: ["new"] }, { permissionBlocked: true },
    { pendingEscalation: { id: "approval" } }, { ptyBusy: true }, { ptyCommandRunning: true },
    { sessionKind: "pty" }, { id: "another" },
  ]) {
    const blocked = apiHarness(snapshot(extra));
    await assert.rejects(execute("session:resume", ["original/session", "--stdin"], { input: "continue" }, blocked));
    assert.equal(blocked.calls.length, 1, "no write after rejected preflight");
  }
  const unknown = apiHarness();
  let sends = 0;
  unknown.api.post = async () => { sends++; throw new Error("HTTP 503 unknown delivery"); };
  await assert.rejects(execute("session:resume", ["original/session", "--stdin"], { input: "continue" }, unknown), /503/);
  assert.equal(unknown.calls.length, 1, "read once");
  assert.equal(sends, 1, "no automatic retry");
});

test("schedule CLI uses real HTTP service: two-hour once, stable request, revision and exact checker prompt", async t => {
  const h = conversationHarness(t);
  let now = new Date("2030-01-01T00:00:00Z");
  const service = new ScheduledTaskService({ storage: h.storage, conversations: h.service,
    getSession: id => h.sessions.get(id) ?? h.storage.getSession(id), now: () => now, defaultCwd: () => h.config.defaultCwd });
  t.after(() => service.dispose());
  const app = express(); app.use(express.json());
  app.post("/api/login", (_req, res) => { res.setHeader("Set-Cookie", "wand-test=local; HttpOnly"); res.json({ ok: true }); });
  registerScheduledTaskRoutes(app, service);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const api = new WandCliApi({ ...h.config, port: address.port, https: false } as WandConfig);
  const body = { requestId: "two-hour-check-once", employeeId: "e_test_1", title: "两小时复查",
    prompt: "只读检查健康端点；正常结束；明确异常才续接原 Wand 会话 original/session，不确定不续接。",
    schedule: { kind: "once", runAt: new Date(now.getTime() + 2 * 3600_000).toISOString() } };
  const create = await parseSystemCliCommand("schedule:create", ["--stdin"], input(body));
  const { task } = await create(api) as { task: { id: string; revision: number; nextRunAt: string } };
  assert.equal(task.nextRunAt, "2030-01-01T02:00:00.000Z");
  assert.equal(h.sent.length, 0);
  assert.equal((await create(api) as { task: { id: string } }).task.id, task.id);
  now = new Date("2030-01-01T02:00:01Z");
  await service.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.text, body.prompt);
  const detailOp = await parseSystemCliCommand("schedule:read", [task.id]);
  const detail = await detailOp(api) as { task: { enabled: boolean }; runs: Array<{ sessionId: string }> };
  assert.equal(detail.task.enabled, false);
  assert.equal(detail.runs.length, 1);
  assert.notEqual(detail.runs[0]!.sessionId, "original/session", "checker gets a new execution, not the original");
  await service.tick(); assert.equal(h.sent.length, 1);
  const update = await parseSystemCliCommand("schedule:update", [task.id, "--stdin"], input({ revision: task.revision, cancelled: true }));
  await assert.rejects(update(api), /HTTP 409/, "due occurrence has advanced the revision");
  const current = service.get(task.id).task;
  const cancel = await parseSystemCliCommand("schedule:update", [task.id, "--stdin"], input({ revision: current.revision, cancelled: true }));
  await cancel(api);
  assert.ok(service.get(task.id).task.cancelledAt);
});

test("managed system skill ships helper/runtime/references, preserves edits and does not execute discovery", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wand-system-skill-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, "config/config.json");
  const home = path.join(root, "home");
  const installed = await installSystemSkill(config, undefined, home);
  assert.equal(installed.installed.length, 3);
  assert.equal(new Set(await Promise.all(installed.installed.map(target => realpath(target)))).size, 1);
  assert.deepEqual(installed.changed.sort(), [".runtime.json", "SKILL.md", "references/operations.md", "scripts/wand.mjs", "scripts/web-login.mjs"]);
  assert.equal(installed.linked.length, 3);
  const reinstalled = await installSystemSkill(config, undefined, home);
  assert.deepEqual(reinstalled.installed, installed.installed);
  assert.deepEqual(reinstalled.changed, []);
  assert.deepEqual(reinstalled.linked, []);
  const canonical = path.join(path.dirname(config), "skills/wand-system");
  const runtime = JSON.parse(await readFile(path.join(canonical, ".runtime.json"), "utf8"));
  assert.equal(runtime.config, config);
  assert.ok(path.isAbsolute(runtime.cli));
  assert.deepEqual(Object.keys(runtime).sort(), ["cli", "config", "loader", "node"]);
  const helper = path.join(canonical, "scripts/wand.mjs");
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; out: string; err: string }>(resolve => {
    const child = spawn(process.execPath, [helper, ...args], { cwd: tmpdir(), env: { ...process.env, WAND_SESSION_ID: "", ...env } });
    let out = "", err = ""; child.stdout.on("data", chunk => out += chunk); child.stderr.on("data", chunk => err += chunk);
    child.on("exit", code => resolve({ code, out, err }));
  });
  const current = await run(["session:current"], { WAND_SESSION_ID: "bound-original" });
  assert.equal(current.code, 0, current.err); assert.equal(JSON.parse(current.out).sessionId, "bound-original");
  assert.notEqual((await run(["session:current"])).code, 0);
  for (const args of [["config:password"], ["employee:list", "--config", "/other"], ["service:restart"]]) {
    assert.notEqual((await run(args)).code, 0);
  }
  const doc = path.join(canonical, "SKILL.md");
  await writeFile(doc, await readFile(doc, "utf8") + "\nuser changes");
  await assert.rejects(installSystemSkill(config, undefined, home), /用户修改/);
  assert.match(await readFile(doc, "utf8"), /user changes/);
  const foreign = path.join(root, "foreign/.agents/skills/wand-system");
  await mkdir(foreign, { recursive: true }); await writeFile(path.join(foreign, "SKILL.md"), "foreign");
  await assert.rejects(installSystemSkill(path.join(root, "other/config.json"), ["pi"], path.join(root, "foreign")), /同名/);
  await assert.rejects(installManagedSkill(root, "../bad", { "SKILL.md": "bad" }), /路径/);
  await assert.rejects(installManagedSkill(root, "good", { "../bad": "bad" }), /路径/);
});

test("managed skills ensure syncs both skills, stays quiet when current, and never overwrites user edits", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wand-skills-ensure-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config/config.json");
  const home = path.join(root, "home");
  assert.equal(isDefaultConfigPath(path.join(home, ".wand/config.json"), home), true);
  assert.equal(isDefaultConfigPath(configPath, home), false);
  const first = await ensureManagedSkills(configPath, home);
  assert.deepEqual(first.map(outcome => [outcome.name, outcome.status]),
    [["wand-system", "synced"], ["wand-decision", "synced"]]);
  assert.ok(first.every(outcome => outcome.files > 0 && outcome.links > 0));
  assert.match(formatManagedSkillsEnsureLog(first)!, /^\[wand\] 托管技能已同步：wand-system/);
  const second = await ensureManagedSkills(configPath, home);
  assert.deepEqual(second.map(outcome => outcome.status), ["unchanged", "unchanged"]);
  assert.equal(formatManagedSkillsEnsureLog(second), null);
  const doc = path.join(root, "config/skills/wand-decision/SKILL.md");
  await writeFile(doc, await readFile(doc, "utf8") + "\nuser changes");
  const third = await ensureManagedSkills(configPath, home);
  assert.deepEqual(third.map(outcome => [outcome.name, outcome.status]),
    [["wand-system", "unchanged"], ["wand-decision", "failed"]]);
  assert.match(third[1]!.error!, /用户修改/);
  assert.match(await readFile(doc, "utf8"), /user changes/);
  assert.match(formatManagedSkillsEnsureLog(third)!, /托管技能部分未同步：wand-decision 未同步/);
});

test("runner overwrites inherited current session identity without granting a new credential", t => {
  const h = conversationHarness(t);
  let received: StructuredRunnerContext | undefined;
  const runner: StructuredRunnerAdapter = { start(context) { received = context; return { completion: Promise.resolve(), interrupt() {} }; } };
  startEmployeeKnowledgeRunner(h.storage, runner, {
    session: { id: "child-session" }, env: { WAND_SESSION_ID: "parent-session", WAND_KNOWLEDGE_TOKEN: "inherited" }, prompt: "",
  } as StructuredRunnerContext, {} as StructuredRunnerObserver);
  assert.equal(received!.env.WAND_SESSION_ID, "child-session");
  assert.equal(received!.env.WAND_KNOWLEDGE_TOKEN, undefined);
});
