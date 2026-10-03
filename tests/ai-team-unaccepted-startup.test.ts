import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AiTeamRunner, createAiTeamSessionOps } from "../src/ai-team-runner.js";
import type { SiliconEmployee } from "../src/ai-team-types.js";
import { defaultConfig } from "../src/config.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";
import type { ProcessManager } from "../src/process-manager.js";
import { parseAiTeamInput } from "../src/server-ai-team-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { StructuredRunnerAdapter, StructuredRunnerContext, StructuredRunnerResult } from "../src/structured-runner.js";
import type { WandTaskAgent } from "../src/task-types.js";

const agent = (provider: WandTaskAgent["provider"]): WandTaskAgent => ({
  provider, model: "default", thinkingEffort: "off", mode: "full-access", kind: "structured",
});
const person = (id: string, agents: WandTaskAgent[]): SiliconEmployee => ({
  id, name: id, avatar: "cat:2", duty: "职责", prompt: `BASE_${id}`, agents,
  createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
});
const result = (overrides: Partial<StructuredRunnerResult> = {}): StructuredRunnerResult => ({
  state: { blocks: [], result: "", sessionId: null }, exitCode: 0, signal: null, stderr: "", primaryError: null,
  ...overrides,
});
const missing = (): StructuredRunnerResult => result({ exitCode: null,
  spawnError: Object.assign(new Error("missing executable"), { code: "ENOENT" }) });
function adapter(start: (ctx: StructuredRunnerContext) => Promise<StructuredRunnerResult>): StructuredRunnerAdapter {
  return { start(ctx) { return { args: [], pid: null, spawnedAt: new Date().toISOString(),
    interrupt() {}, completion: start(ctx) }; } };
}
function setup(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-team-unaccepted-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root };
  storage.saveSiliconEmployee(person("e_worker", [agent("codex"), agent("pi")]));
  storage.saveSiliconEmployee(person("e_leader", [agent("claude"), agent("pi")]));
  t.after(async () => { await whenIterationPromptsSettled(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, storage, config };
}
async function until(check: () => boolean, drain: () => Promise<void> = async () => {}): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    await drain();
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for controlled runner state");
}
function writeLeaderDecision(ctx: StructuredRunnerContext, action: "assign" | "ask"): void {
  const relative = ctx.prompt.match(/本轮报告文件：([^\n]+)/)![1]!;
  const file = path.join(ctx.session.cwd, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(action === "assign"
    ? { action, message: "派工", steps: [{ member: "m_worker", title: "工作", instructions: "执行一步" }] }
    : { action, message: "完成，等回复" }));
  const past = new Date(Date.now() - 10_000); utimesSync(file, past, past);
}

for (const failure of ["unaccepted", "metadata", "accepted", "unknown", "superseded"] as const) {
  test(`real team dispatch ${failure}: only explicit unaccepted spawn retries candidate 1 once`, async (t) => {
    const { root, storage, config } = setup(t);
    const unaccepted = failure === "unaccepted" || failure === "metadata";
    const starts: StructuredRunnerContext[] = [];
    let leaderTurns = 0;
    const leader = adapter(async (ctx) => {
      writeLeaderDecision(ctx, leaderTurns++ === 0 ? "assign" : "ask");
      return result({ state: { blocks: [{ type: "text", text: "已写入" }], result: "已写入", sessionId: "leader-native" } });
    });
    const first = adapter(async (ctx) => {
      starts.push(ctx);
      if (unaccepted || (failure === "superseded" && starts.length === 1)) return missing();
      if (failure === "superseded") throw new Error("new request delivery is unknown");
      if (failure === "unknown") throw new Error("spawn codex ENOENT but delivery is unknown");
      return result({ exitCode: 1, stderr: "spawn codex ENOENT after accepting input" });
    });
    const second = adapter(async (ctx) => {
      starts.push(ctx);
      return result({ state: { blocks: [{ type: "text", text: "完成工作" }], result: "完成工作", sessionId: "worker-native" } });
    });
    const manager = new StructuredSessionManager(storage, config, null, { claudeCli: leader, codex: first, pi: second });
    // PTY is unused. Actual registry + createAiTeamSessionOps + task dispatch + manager are exercised.
    const registry = new SessionRegistry({ getOwned: () => null } as unknown as ProcessManager, manager, storage);
    const runner = new AiTeamRunner({ storage, ops: createAiTeamSessionOps({ storage, config, structured: manager,
      processes: null, sessions: registry }), resolveCwd: () => root });
    t.after(() => { runner.dispose(); manager.dispose(); });
    const failedTokens = new Map<string, string>();
    let superseded = false;
    let metadataUpdated = false;
    manager.setEventEmitter((event) => {
      if (event.type === "status" && manager.get(event.sessionId)?.status === "failed") {
        const token = manager.teamRequestId(event.sessionId);
        if (unaccepted) assert.ok(token, "fact is available before failed-state observers");
        if (token) failedTokens.set(event.sessionId, token);
        if (failure === "metadata") {
          const before = manager.get(event.sessionId);
          // Replace the real snapshot after explicit failure, before the queued team evaluation.
          manager.setSessionTopic(event.sessionId, "更新展示标题", "仅更新非执行元数据");
          assert.notEqual(manager.get(event.sessionId), before);
          assert.equal(manager.teamRequestId(event.sessionId), token, "metadata must retain the execution UUID fact");
          metadataUpdated = true;
        }
        if (failure === "superseded" && !superseded) {
          superseded = true;
          // An external newer request replaces the failed team turn before queued team observers execute.
          void manager.sendMessage(event.sessionId, "新的独立请求").catch(() => undefined);
        }
      }
      runner.ingest(event);
    });
    const team = parseAiTeamInput({ name: "实际团队", requirePlanApproval: false, members: [
      { id: "m_lead", employeeId: "e_leader", isLeader: true, duty: "派工" },
      { id: "m_worker", employeeId: "e_worker", duty: "实现" },
    ] }, null, new Date().toISOString(), storage);
    storage.saveAiTeam(team);
    const task = storage.createWandTask({ title: "实际异步派发" });
    const initial = await runner.start({ teamId: team.id, taskId: task.id });
    // Initial leader completion may precede its step link; feed its completed real session once.
    runner.ingest({ type: "status", sessionId: storage.listAiTeamSteps(initial.run.id)[0]!.sessionId! });
    await until(() => storage.listAiTeamSteps(initial.run.id).some((step) => step.kind === "work"
      && (step.status === "done" || step.status === "failed")), () => runner.idle());
    assert.equal(starts.length, unaccepted || failure === "superseded" ? 2 : 1);
    if (failure === "metadata") assert.ok(metadataUpdated, "real metadata replacement was exercised");
    assert.equal(starts[0]!.session.employeeId, "e_worker");
    assert.equal(starts[0]!.session.employeeCandidateIndex, 0);
    if (unaccepted) {
      assert.equal(starts[1]!.session.employeeId, "e_worker");
      assert.equal(starts[1]!.session.employeeCandidateIndex, 1);
      assert.deepEqual(starts[1]!.session.employeeCandidates, starts[0]!.session.employeeCandidates);
      assert.notEqual(starts[1]!.session.id, starts[0]!.session.id);
      const steps = storage.listAiTeamSteps(initial.run.id);
      assert.equal(steps.filter((step) => step.kind === "work" && step.status === "skipped").length, 1);
      assert.equal(steps.find((step) => step.kind === "work" && step.status === "done")!.dispatchInfo!.usedCandidate, 1);
      assert.equal(storage.getAiTeamRun(initial.run.id)!.stepsUsed, steps.filter((step) => step.status === "done" || step.status === "failed").length,
        "unaccepted skipped candidate does not consume another team step");
      const failedId = starts[0]!.session.id;
      assert.equal(manager.consumeUnacceptedTeamStartup(failedId, failedTokens.get(failedId)!), false, "fact consumed once");
      runner.ingest({ type: "ended", sessionId: failedId });
      await runner.idle();
      assert.equal(starts.length, 2, "duplicate failure events cannot dispatch twice");
    }
    if (failure === "superseded") {
      assert.ok(superseded);
      assert.ok(starts.every((ctx) => ctx.session.provider === "codex" && ctx.session.employeeCandidateIndex === 0),
        "an old unaccepted fact cannot select a fallback for a newer unknown request");
      assert.equal(manager.consumeUnacceptedTeamStartup(starts[0]!.session.id, failedTokens.get(starts[0]!.session.id)!), false);
    }
    assert.ok(!JSON.stringify(runner.detail(initial.run.id)).includes("unacceptedTeamStarts"));
  });
}

test("real leader spawn failure consumes its fact but retains waiting_user, no automatic candidate fallback", async (t) => {
  const { root, storage, config } = setup(t);
  const starts: StructuredRunnerContext[] = [];
  const manager = new StructuredSessionManager(storage, config, null, {
    claudeCli: adapter(async (ctx) => { starts.push(ctx); return missing(); }),
    pi: adapter(async (ctx) => { starts.push(ctx); return result(); }),
  });
  const registry = new SessionRegistry({ getOwned: () => null } as unknown as ProcessManager, manager, storage);
  const runner = new AiTeamRunner({ storage, ops: createAiTeamSessionOps({ storage, config, structured: manager,
    processes: null, sessions: registry }), resolveCwd: () => root });
  t.after(() => { runner.dispose(); manager.dispose(); });
  let failedToken: string | null = null;
  manager.setEventEmitter((event) => {
    if (event.type === "status" && manager.get(event.sessionId)?.status === "failed") failedToken = manager.teamRequestId(event.sessionId);
    runner.ingest(event);
  });
  const team = parseAiTeamInput({ name: "负责人失败", members: [
    { id: "m_lead", employeeId: "e_leader", isLeader: true }, { id: "m_worker", employeeId: "e_worker" },
  ] }, null, new Date().toISOString(), storage);
  storage.saveAiTeam(team);
  const task = storage.createWandTask({ title: "负责人" });
  const detail = await runner.start({ teamId: team.id, taskId: task.id });
  await until(() => storage.getAiTeamRun(detail.run.id)!.status === "waiting_user", () => runner.idle());
  assert.equal(starts.length, 1);
  assert.ok(failedToken);
  assert.equal(manager.consumeUnacceptedTeamStartup(starts[0]!.session.id, failedToken!), false);
  assert.equal(storage.getAiTeamRun(detail.run.id)!.stepsUsed, 1);
});

test("manager startup facts are current-request one-shot, disappear on new request/stop/delete/dispose and never enter storage", async (t) => {
  const { root, storage, config } = setup(t);
  let fail = true;
  const manager = new StructuredSessionManager(storage, config, null, {
    codex: adapter(async () => fail ? missing() : result()),
  });
  t.after(() => manager.dispose());
  const make = () => manager.createSession({ cwd: root, provider: "codex", mode: "full-access", automationId: "ai-team:fact",
    employeeId: "e_worker", employeeCandidates: [agent("codex"), agent("pi")], employeeCandidateIndex: 0 });
  const sendFailure = async (id: string) => {
    let token = "";
    await assert.rejects(manager.sendMessage(id, "启动", { teamRequestStarted: (_id, requestId) => { token = requestId; } }));
    assert.equal(manager.teamRequestId(id), token);
    assert.ok(!JSON.stringify(storage.getSession(id)).includes(token), "private failed token not persisted");
    return token;
  };
  const one = make(); const token = await sendFailure(one.id);
  assert.equal(manager.consumeUnacceptedTeamStartup(one.id, "wrong-generation"), false);
  assert.equal(manager.consumeUnacceptedTeamStartup(one.id, token), true);
  assert.equal(manager.consumeUnacceptedTeamStartup(one.id, token), false);
  const stopped = make(); const stopToken = await sendFailure(stopped.id);
  manager.stop(stopped.id);
  assert.equal(manager.consumeUnacceptedTeamStartup(stopped.id, stopToken), false);
  const renewed = make(); const oldToken = await sendFailure(renewed.id);
  fail = false;
  await manager.sendMessage(renewed.id, "新的请求");
  assert.equal(manager.consumeUnacceptedTeamStartup(renewed.id, oldToken), false);
  fail = true;
  const deleted = make(); const deleteToken = await sendFailure(deleted.id);
  manager.delete(deleted.id);
  assert.equal(manager.consumeUnacceptedTeamStartup(deleted.id, deleteToken), false);
  const disposed = make(); const disposeToken = await sendFailure(disposed.id);
  manager.dispose();
  assert.equal(manager.consumeUnacceptedTeamStartup(disposed.id, disposeToken), false);
});

test("late old spawn failure after stop/new request cannot publish a fact or fail the new request", async (t) => {
  const { root, storage, config } = setup(t);
  const resolve: Array<(value: StructuredRunnerResult) => void> = [];
  const manager = new StructuredSessionManager(storage, config, null, {
    codex: adapter(() => new Promise<StructuredRunnerResult>((done) => resolve.push(done))),
  });
  t.after(() => manager.dispose());
  const session = manager.createSession({ cwd: root, provider: "codex", mode: "full-access", automationId: "ai-team:late" });
  let oldToken = ""; let newToken = "";
  const old = manager.sendMessage(session.id, "旧请求", { teamRequestStarted: (_id, token) => { oldToken = token; } });
  manager.stop(session.id);
  const current = manager.sendMessage(session.id, "新请求", { teamRequestStarted: (_id, token) => { newToken = token; } });
  assert.notEqual(oldToken, newToken);
  resolve[0]!(missing()); await old;
  assert.equal(manager.get(session.id)!.structuredState!.activeRequestId, newToken);
  assert.equal(manager.consumeUnacceptedTeamStartup(session.id, oldToken), false);
  assert.equal(manager.consumeUnacceptedTeamStartup(session.id, newToken), false);
  resolve[1]!(result({ exitCode: 1, stderr: "unknown delivery ENOENT" }));
  await assert.rejects(current);
  assert.equal(manager.teamRequestId(session.id), null);
  assert.equal(manager.consumeUnacceptedTeamStartup(session.id, oldToken), false);
});
