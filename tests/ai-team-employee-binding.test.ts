import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { dispatchAgentForTask } from "../src/agent-dispatch.js";
import { freezeTeamEmployees, teamMemberEmployee } from "../src/ai-team-employee-binding.js";
import { AiTeamRunner, type AiTeamSessionOps } from "../src/ai-team-runner.js";
import type { AiTeam, SiliconEmployee } from "../src/ai-team-types.js";
import { defaultConfig } from "../src/config.js";
import { defaultEmployeeDefinition, DEFAULT_EMPLOYEE_PROMPT } from "../src/default-employee.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";
import { parseAiTeamInput } from "../src/server-ai-team-routes.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { StructuredRunnerAdapter, StructuredRunnerContext } from "../src/structured-runner.js";
import type { WandTaskAgent } from "../src/task-types.js";
import type { SessionSnapshot } from "../src/types.js";

const NOW = "2026-10-03T00:00:00.000Z";
const agent = (provider: WandTaskAgent["provider"] = "pi"): WandTaskAgent => ({
  provider, model: "default", thinkingEffort: "off", mode: provider === "codex" ? "full-access" : "default", kind: "structured",
});
const employee = (id = "e_alice", overrides: Partial<SiliconEmployee> = {}): SiliconEmployee => ({
  id, name: id, avatar: "cat:1", duty: "员工职责", prompt: `BASE_ROLE_${id}`,
  agents: [agent()], createdAt: NOW, updatedAt: NOW, ...overrides,
});
function input(employeeId: unknown = "e_alice") {
  return { name: "团队", members: [
    { id: "m_lead", employeeId, name: "伪造名字", avatar: "bad avatar", agents: [{ provider: "nope" }],
      prompt: "FORGED_ROLE", _employeeSnapshot: employee("e_forged"), duty: "团队派工", role: "plan", isLeader: true },
    { id: "m_dev", name: "独立成员", duty: "写代码", agent: agent("codex"), role: "work" },
  ], requirePlanApproval: false };
}
function setup(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-team-employees-"));
  const dbPath = path.join(root, "wand.db");
  const storage = new WandStorage(dbPath);
  storage.saveSiliconEmployee(employee());
  storage.saveSiliconEmployee(employee("e_bob", { agents: [agent("codex"), agent("pi")] }));
  t.after(async () => {
    await whenIterationPromptsSettled();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, dbPath, storage };
}

class Ops implements AiTeamSessionOps {
  readonly opened: Array<Parameters<AiTeamSessionOps["open"]>[0]> = [];
  readonly snapshots = new Map<string, SessionSnapshot>();
  readonly sends: string[] = [];
  async open(value: Parameters<AiTeamSessionOps["open"]>[0]): Promise<string> {
    this.opened.push(value);
    const id = `s_${this.opened.length}`;
    this.snapshots.set(id, { id, employeeId: value.employee?.id, provider: value.agent.provider,
      status: "running", structuredState: { inFlight: true }, messages: [], output: "" } as SessionSnapshot);
    return id;
  }
  async send(id: string): Promise<void> { this.sends.push(id); this.snapshots.get(id)!.structuredState!.inFlight = true; }
  stop(): void {}
  snapshot(id: string): SessionSnapshot | null { return this.snapshots.get(id) ?? null; }
  ownerOf(): "structured" { return "structured"; }
}
function runnerSetup(t: TestContext, team?: AiTeam) {
  const fixture = setup(t);
  const actual = team ?? parseAiTeamInput(input(), null, NOW, fixture.storage);
  fixture.storage.saveAiTeam(actual);
  const task = fixture.storage.createWandTask({ title: "团队任务" });
  const ops = new Ops();
  const runner = new AiTeamRunner({ storage: fixture.storage, ops, resolveCwd: () => fixture.root });
  t.after(() => runner.dispose());
  return { ...fixture, team: actual, task, ops, runner };
}
function finishLeader(h: ReturnType<typeof runnerSetup>, runId: string, decision: unknown): void {
  const step = h.storage.listAiTeamSteps(runId).filter((step) => step.kind === "leader").at(-1)!;
  const file = path.join(h.root, step.reportPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(decision));
  const past = new Date(Date.now() - 10_000);
  utimesSync(file, past, past);
  h.ops.snapshots.get(step.sessionId!)!.structuredState!.inFlight = false;
  h.runner.ingest({ type: "status", sessionId: step.sessionId! });
}

// No same-name inference; only the explicit stable id is meaningful.
test("parse binding trusts storage identity/candidates, not HTTP fields or forged snapshot", (t) => {
  const { storage } = setup(t);
  const team = parseAiTeamInput(input(), null, NOW, storage);
  assert.equal(team.members[0]!.employeeId, "e_alice");
  assert.equal(team.members[0]!.name, "e_alice");
  assert.equal(team.members[0]!.avatar, "cat:1");
  assert.deepEqual(team.members[0]!.agents, [agent()]);
  assert.equal(team.members[0]!.duty, "团队派工");
  assert.equal(team.members[0]!.role, "plan");
  assert.equal(team.members[0]!.isLeader, true);
  assert.equal(teamMemberEmployee(team.members[0]!), undefined, "API definitions do not contain base-role snapshots");
  const legacy = { ...input(), members: [
    { id: "m_lead", name: "e_alice", agent: agent(), isLeader: true }, input().members[1],
  ] };
  assert.equal(parseAiTeamInput(legacy, null, NOW).members[0]!.employeeId, undefined);
  assert.throws(() => parseAiTeamInput(input(), null, NOW), /真实员工来源/);
});

test("legacy updates preserve by member id; null/empty explicitly unlink", (t) => {
  const { storage } = setup(t);
  const first = parseAiTeamInput(input(), null, NOW, storage);
  const old = { ...first, members: first.members.map(({ employeeId: _id, ...member }) => member) };
  assert.equal(parseAiTeamInput(old, first, NOW, storage).members[0]!.employeeId, "e_alice");
  for (const employeeId of [null, "", "  "]) {
    const changed = parseAiTeamInput({ ...old, members: [{ ...old.members[0], employeeId }, old.members[1]] }, first, NOW, storage);
    assert.equal(changed.members[0]!.employeeId, undefined);
  }
  const replacement = parseAiTeamInput({ ...old, members: [{ ...old.members[0], employeeId: "e_bob" }, old.members[1]] }, first, NOW, storage);
  assert.equal(replacement.members[0]!.id, "m_lead");
  assert.equal(replacement.members[0]!.name, "e_bob");
});

test("bindings reject duplicate, malformed, nonexistent, archived and PTY employees", (t) => {
  const { storage } = setup(t);
  assert.throws(() => parseAiTeamInput({ ...input(), members: [input().members[0],
    { ...input().members[1], employeeId: "e_alice" }] }, null, NOW, storage), /同一员工/);
  for (const id of [42, {}, "e_missing"]) assert.throws(() => parseAiTeamInput(input(id), null, NOW, storage));
  storage.archiveSiliconEmployee("e_alice", NOW);
  assert.throws(() => parseAiTeamInput(input(), null, NOW, storage), /已归档/);
  storage.unarchiveSiliconEmployee("e_alice");
  storage.saveSiliconEmployee(employee("e_alice", { agents: [{ ...agent(), kind: "pty" }] }));
  assert.throws(() => parseAiTeamInput(input(), null, NOW, storage), /结构化/);
});

test("storage roundtrip keeps link, resolves current fields and privately restores frozen role across restart", async (t) => {
  const h = runnerSetup(t);
  const started = await h.runner.start({ teamId: h.team.id, taskId: h.task.id });
  const reopened = new WandStorage(h.dbPath);
  t.after(() => reopened.close());
  assert.equal(reopened.getAiTeam(h.team.id)!.members[0]!.employeeId, "e_alice");
  const frozen = reopened.getAiTeamRun(started.run.id)!.team.members[0]!;
  assert.equal(teamMemberEmployee(frozen)!.prompt, "BASE_ROLE_e_alice");
  assert.equal(teamMemberEmployee(frozen)!.id, "e_alice");
  assert.equal(JSON.stringify(started).includes("BASE_ROLE"), false);
  assert.equal(JSON.stringify(h.runner.listForTask(h.task.id)).includes("_employeeSnapshot"), false);
  assert.equal(JSON.stringify(h.runner.listRuns({})).includes("BASE_ROLE"), false);
  h.storage.saveSiliconEmployee(employee("e_alice", { name: "新名", avatar: "cat:4", agents: [agent("grok")], prompt: "NEW_ROLE" }));
  assert.equal(reopened.getAiTeam(h.team.id)!.members[0]!.name, "新名");
  assert.equal(reopened.getAiTeam(h.team.id)!.members[0]!.agent.provider, "grok");
  assert.equal(reopened.getAiTeamRun(started.run.id)!.team.members[0]!.name, "e_alice");
  assert.equal(h.runner.detail(started.run.id).displayTeam!.members[0]!.name, "新名");
  assert.equal(h.runner.detail(started.run.id).displayTeam!.members[0]!.agent.provider, "pi", "display never changes frozen candidates");
});

test("saveAiTeam validates bindings even for internal callers", (t) => {
  const { storage } = setup(t);
  const team = parseAiTeamInput(input(), null, NOW, storage);
  assert.throws(() => storage.saveAiTeam({ ...team, members: [team.members[0]!,
    { ...team.members[1]!, employeeId: "e_alice" }] }), /同一员工/);
  storage.deleteSiliconEmployee("e_alice");
  assert.throws(() => storage.saveAiTeam(team), /不存在/);
});

test("used bound role/candidates freeze on reply; replacement cannot reuse or relabel old employee", async (t) => {
  const h = runnerSetup(t);
  const started = await h.runner.start({ teamId: h.team.id, taskId: h.task.id });
  assert.equal(h.ops.opened[0]!.employee!.id, "e_alice");
  assert.equal(h.ops.opened[0]!.employeeCandidateIndex, 0);
  assert.ok(h.ops.opened[0]!.systemPrompt!.includes("BASE_ROLE_e_alice"));
  assert.ok(!h.ops.opened[0]!.prompt.includes("BASE_ROLE"));
  finishLeader(h, started.run.id, { action: "ask", message: "等回复" });
  await h.runner.idle();
  h.storage.saveSiliconEmployee(employee("e_alice", { prompt: "CHANGED_ROLE", agents: [agent("grok")] }));
  const replacement = parseAiTeamInput(input("e_bob"), h.team, NOW, h.storage);
  h.storage.saveAiTeam(replacement);
  await h.runner.reply(started.run.id, "继续");
  assert.deepEqual(h.ops.sends, ["s_1"], "same frozen employee may reuse their own session");
  const frozen = h.storage.getAiTeamRun(started.run.id)!.team.members[0]!;
  assert.equal(frozen.employeeId, "e_alice");
  assert.equal(frozen.agent.provider, "pi");
  assert.equal(teamMemberEmployee(frozen)!.prompt, "BASE_ROLE_e_alice");
  assert.equal(h.runner.detail(started.run.id).displayTeam!.members[0]!.name, "e_alice");
  await h.runner.stop(started.run.id);
  const next = await h.runner.start({ teamId: h.team.id, taskId: h.task.id });
  assert.equal(next.run.team.members[0]!.employeeId, "e_bob");
  assert.equal(h.ops.opened.at(-1)!.employee!.id, "e_bob");
  await h.runner.stop(next.run.id);
  h.storage.saveSiliconEmployee(employee("e_bob", { agents: [agent("grok")], prompt: "LATEST_BOB_ROLE" }));
  await h.runner.start({ teamId: h.team.id, taskId: h.task.id });
  assert.equal(h.ops.opened.at(-1)!.agent.provider, "grok");
  assert.ok(h.ops.opened.at(-1)!.systemPrompt!.includes("LATEST_BOB_ROLE"));
});

test("archived/deleted employees block new starts but old snapshots can continue and deletion falls back to frozen name", async (t) => {
  const h = runnerSetup(t);
  const started = await h.runner.start({ teamId: h.team.id, taskId: h.task.id });
  finishLeader(h, started.run.id, { action: "ask", message: "等回复" });
  await h.runner.idle();
  const task2 = h.storage.createWandTask({ title: "新任务" });
  h.storage.archiveSiliconEmployee("e_alice", NOW);
  await assert.rejects(h.runner.start({ teamId: h.team.id, taskId: task2.id }), /归档/);
  h.storage.deleteSiliconEmployee("e_alice");
  await assert.rejects(h.runner.start({ teamId: h.team.id, taskId: task2.id }), /不存在/);
  // A mismatched session employee id is not reusable, even with the same CLI/model.
  h.ops.snapshots.get("s_1")!.employeeId = "e_bob";
  await h.runner.reply(started.run.id, "继续");
  assert.equal(h.ops.opened.length, 2);
  assert.equal(h.ops.opened[1]!.employee!.id, "e_alice");
  assert.equal(h.ops.opened[1]!.employee!.prompt, "BASE_ROLE_e_alice");
  assert.equal(h.runner.detail(started.run.id).displayTeam!.members[0]!.name, "e_alice");
});

test("default partner freezes base role without copying the short-term habit projection", (t) => {
  const { storage } = setup(t);
  const definition = defaultEmployeeDefinition([agent()], NOW);
  const source = { getSiliconEmployee: () => ({ ...definition, prompt: DEFAULT_EMPLOYEE_PROMPT + "\nPRIVATE_HABIT" }), getSiliconEmployeeDefinition: () => definition };
  const team = parseAiTeamInput(input(definition.id), null, NOW, source);
  const frozen = freezeTeamEmployees(team, source);
  assert.equal(teamMemberEmployee(frozen.members[0]!)!.prompt, DEFAULT_EMPLOYEE_PROMPT);
  assert.equal(JSON.stringify(frozen).includes("PRIVATE_HABIT"), false);
  assert.equal(storage.getAiTeam(team.id), null);
});

function recordingRunner(contexts: StructuredRunnerContext[], spawnFailure = false): StructuredRunnerAdapter {
  return { start(ctx) {
    contexts.push(ctx);
    return { args: [], pid: null, spawnedAt: NOW, interrupt() {}, completion: Promise.resolve({
      state: { blocks: [], result: "已处理", sessionId: "native" }, exitCode: spawnFailure ? null : 0,
      signal: null, stderr: "", primaryError: null,
      ...(spawnFailure ? { spawnError: Object.assign(new Error("missing"), { code: "ENOENT" }) } : {}),
    }) };
  } };
}

test("real task dispatch carries actual employee id, frozen candidates/index; runtime context only reads their namespace", async (t) => {
  const { root, storage } = setup(t);
  storage.rememberEmployeeKnowledge("e_bob", "BOB_ONLY 专属发布规范");
  storage.rememberEmployeeKnowledge("e_alice", "ALICE_ONLY 独立资料");
  const contexts: StructuredRunnerContext[] = [];
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root }, null,
    { pi: recordingRunner(contexts) });
  t.after(() => manager.dispose());
  const team = freezeTeamEmployees(parseAiTeamInput(input("e_bob"), null, NOW, storage), storage);
  const member = team.members[0]!;
  const frozen = teamMemberEmployee(member)!;
  const task = storage.createWandTask({ title: "派发知识隔离" });
  const dispatched = await dispatchAgentForTask({ storage, config: defaultConfig(), structured: manager, processes: null }, {
    task, agent: frozen.agents[1]!, employee: frozen, employeeCandidateIndex: 1,
    automationId: "ai-team:run_knowledge", systemPrompt: frozen.prompt + "\nTEAM_RULE", prompt: "发布规范是什么？",
  });
  // The first completion is async; drain it using the manager's own in-flight state.
  for (let tries = 0; manager.get(dispatched.session.id)?.structuredState?.inFlight && tries < 100; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const session = storage.getSession(dispatched.session.id)!;
  assert.equal(session.employeeId, "e_bob");
  assert.equal(session.employeeCandidateIndex, 1);
  assert.deepEqual(session.employeeCandidates, frozen.agents);
  assert.ok(contexts[0]!.session.runtimeSystemPrompt!.includes("BOB_ONLY"));
  assert.ok(!contexts[0]!.session.runtimeSystemPrompt!.includes("ALICE_ONLY"));
  assert.ok(!contexts[0]!.prompt.includes("BOB_ONLY"));
  assert.equal(session.runtimeSystemPrompt, undefined);
  assert.ok(!session.systemPrompt!.includes("BOB_ONLY"));
  assert.ok(!JSON.stringify(team).includes("BOB_ONLY"));
  await assert.rejects(dispatchAgentForTask({ storage, config: defaultConfig(), structured: manager, processes: null }, {
    task, agent: { ...agent(), kind: "pty" }, employee: frozen, employeeCandidateIndex: 1,
    automationId: "ai-team:bad", prompt: "禁止终端身份",
  }), /只支持结构化/);
});

test("team employee snapshots do not run the private-chat candidate retry loop", async (t) => {
  const { root, storage } = setup(t);
  const contexts: StructuredRunnerContext[] = [];
  const fallback: StructuredRunnerContext[] = [];
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root }, null,
    { codex: recordingRunner(contexts, true), pi: recordingRunner(fallback) });
  t.after(() => manager.dispose());
  const person = employee("e_bob", { agents: [agent("codex"), agent("pi")] });
  const session = manager.createSession({ cwd: root, provider: "codex", mode: "default",
    automationId: "ai-team:run_safe", employeeId: person.id, employeeCandidates: person.agents, employeeCandidateIndex: 0 });
  await assert.rejects(manager.sendMessage(session.id, "开始步骤"));
  assert.equal(contexts.length, 1);
  assert.equal(fallback.length, 0, "only the team scheduler may select a fallback");
  assert.equal(manager.get(session.id)!.employeeCandidateIndex, 0);
  assert.deepEqual(storage.getSession(session.id)!.employeeCandidates, person.agents);
});

test("adding an employee at an old independent member id cannot relabel or refresh the old CLI run", async (t) => {
  const h = runnerSetup(t);
  const legacy = parseAiTeamInput({ name: "独立团队", members: [
    { id: "m_lead", employeeId: null, name: "旧独立负责人", agent: agent(), isLeader: true }, input().members[1],
  ] }, h.team, NOW);
  h.storage.saveAiTeam(legacy);
  const started = await h.runner.start({ teamId: h.team.id, taskId: h.task.id });
  finishLeader(h, started.run.id, { action: "ask", message: "等回复" });
  await h.runner.idle();
  h.storage.saveAiTeam(parseAiTeamInput(input(), legacy, NOW, h.storage));
  await h.runner.reply(started.run.id, "继续");
  assert.equal(h.storage.getAiTeamRun(started.run.id)!.team.members[0]!.employeeId, undefined);
  assert.equal(h.runner.detail(started.run.id).displayTeam!.members[0]!.name, "旧独立负责人");
  assert.equal(h.storage.listAiTeamStepSessionMarkers().get("s_1")!.memberName, "旧独立负责人");
});
