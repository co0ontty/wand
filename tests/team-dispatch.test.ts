import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";

import { planTeamDispatch, startTeamDispatch } from "../src/team-dispatch.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { registerTeamDispatchRoutes } from "../src/server-team-dispatch-routes.js";
import { WandStorage } from "../src/storage.js";
import type { DecisionResult } from "../src/decision-types.js";

// 员工候选必须是存储层认得的形状（parseWandTaskAgent 要求 thinkingEffort 合法）。
const agents = [{ provider: "pi", model: "default", thinkingEffort: "off", mode: "managed", kind: "structured" }] as never;

function seed(storage: WandStorage, employees: Array<{ name: string; duty: string; tags?: string[]; systemKey?: string; archived?: boolean }>): void {
  for (const [index, employee] of employees.entries()) {
    const id = `e_${index}`;
    storage.saveSiliconEmployee({
      id,
      name: employee.name,
      duty: employee.duty,
      prompt: `${employee.name} 的角色`,
      avatar: "",
      agents,
      ...(employee.tags ? { tags: employee.tags } : {}),
      ...(employee.systemKey ? { systemKey: employee.systemKey } : {}),
      ...(employee.archived ? { archivedAt: new Date().toISOString() } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
  }
}

/** 决策替身：按名字给概率，未列出的给 0.1；记录每次调用的题目数。 */
function fakeDecision(probabilities: Record<string, number>) {
  const calls: Array<{ questions: number; state: string }> = [];
  const evaluate = async (value: unknown): Promise<DecisionResult> => {
    const request = value as { state: string; questions: Record<string, { instructions: string }> };
    calls.push({ questions: Object.keys(request.questions).length, state: request.state });
    const answers: Record<string, Record<string, unknown>> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const name = /「(.+?)」/.exec(question.instructions)?.[1] ?? "";
      answers[id] = { type: "noul", noul: probabilities[name] ?? 0.1 };
    }
    return {
      model: "aac6fef/laya-multilingual-mlx",
      answers,
      usage: { input_tokens: 100, output_tokens: 0 },
      experimental: true,
      runtime: "laya-mlx",
    };
  };
  return { evaluate, calls };
}

function harness(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-team-dispatch-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const workspace = storage.createWorkspace({ name: "项目", cwd: root } as never);
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, storage, workspaceId: workspace.id };
}

test("候选集排除系统运维与已归档员工", async (t) => {
  const { storage } = harness(t);
  seed(storage, [
    { name: "阿甲", duty: "前端", tags: ["UI"] },
    { name: "勤劳的初二", duty: "系统运维", systemKey: "wand-ops" },
    { name: "老乙", duty: "后端", archived: true },
  ]);
  const note = "做一个登录页";
  let seenQuestions: string[] = [];
  const { evaluate } = fakeDecision({ 阿甲: 0.9 });
  const plan = await planTeamDispatch({
    storage, note,
    evaluate: async (value, caller, signal) => {
      seenQuestions = Object.values((value as { questions: Record<string, { instructions: string }> }).questions).map((q) => q.instructions);
      return evaluate(value, caller, signal);
    },
  });
  assert.equal(plan.considered, 1, "只有阿甲可派工");
  assert.equal(seenQuestions.length, 1);
  assert.match(seenQuestions[0]!, /阿甲/);
  assert.doesNotMatch(JSON.stringify(seenQuestions), /勤劳的初二|老乙/);
});

test("超员时按批调用（每批 ≤8 人），门槛、上限、负责人与备选都对", async (t) => {
  const { storage } = harness(t);
  const names = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  seed(storage, names.map((name) => ({ name: `员工${name}`, duty: `${name}的活` })));
  const probabilities = Object.fromEntries(names.map((name, index) => [`员工${name}`, index === 9 ? 0.7 : 0.9 - index * 0.02]));
  const { evaluate, calls } = fakeDecision(probabilities);

  const plan = await planTeamDispatch({ storage, note: "一件很复杂的事", maxMembers: 3, evaluate });
  assert.equal(calls.length, 2, "10 名候选 → 8 + 2 两批");
  assert.deepEqual(calls.map((call) => call.questions), [8, 2]);
  assert.match(calls[0]!.state, /一件很复杂的事/);
  assert.equal(plan.members.length, 3);
  assert.deepEqual(plan.members.map((member) => member.name), ["员工一", "员工二", "员工三"]);
  assert.equal(plan.members[0]!.isLeader, true);
  assert.equal(plan.members[1]!.isLeader, false);
  assert.equal(plan.bench.length, 7, "达到门槛但超出上限的人进备选");
  assert.equal(plan.considered, 10);
  assert.equal(plan.decision.model, "aac6fef/laya-multilingual-mlx");
  assert.equal(plan.decision.inputTokens, 200);
  assert.match(plan.note, /确认后才会开工/);
});

test("员工多于一次规划的上限时：只评估前 64 人，其余明确报告未评估", async (t) => {
  const { storage } = harness(t);
  seed(storage, Array.from({ length: 70 }, (_, index) => ({ name: `员工${index}`, duty: `活${index}` })));
  const { evaluate, calls } = fakeDecision({ 员工0: 0.9, 员工1: 0.8 });
  const plan = await planTeamDispatch({ storage, note: "很大的目录", evaluate });
  assert.equal(calls.length, 8, "最多 8 次判断（64 人）");
  assert.equal(plan.considered, 70);
  assert.equal(plan.omitted, 6);
  assert.match(plan.note, /未评估/);
  assert.deepEqual(plan.members.map((member) => member.name), ["员工0", "员工1"]);
});

test("无人达标时返回空名单并说明原因，不编造名单", async (t) => {
  const { storage } = harness(t);
  seed(storage, [{ name: "甲", duty: "前端" }, { name: "乙", duty: "后端" }]);
  const plan = await planTeamDispatch({ storage, note: "写一个脚本", evaluate: fakeDecision({}).evaluate });
  assert.deepEqual(plan.members, []);
  assert.match(plan.note, /没有员工的参与概率超过/);
  assert.equal(plan.decision.calls, 1);
});

test("只有 1 人达标时说明团队至少需要 2 人", async (t) => {
  const { storage } = harness(t);
  seed(storage, [{ name: "甲", duty: "前端" }, { name: "乙", duty: "后端" }]);
  const plan = await planTeamDispatch({ storage, note: "写一个脚本", evaluate: fakeDecision({ 甲: 0.9 }).evaluate });
  assert.equal(plan.members.length, 1);
  assert.match(plan.note, /至少需要 2 人/);
});

test("空目录直接给出可操作的说明", async (t) => {
  const { storage } = harness(t);
  assert.equal(storage.listSiliconEmployees().length, 0);
  const plan = await planTeamDispatch({ storage, note: "任何事", evaluate: async () => { throw new Error("不应调用决策"); } });
  assert.deepEqual(plan.members, []);
  assert.equal(plan.decision.calls, 0);
  assert.match(plan.note, /还没有可派工的员工/);
});

test("开工：按名单建临时团队 + 建卡 + 起 run，冻结员工候选", async (t) => {
  const { storage, workspaceId, root } = harness(t);
  seed(storage, [{ name: "甲", duty: "前端", tags: ["UI"] }, { name: "乙", duty: "后端" }]);
  const started: Array<{ teamId: string; taskId: string; note?: string }> = [];
  const result = await startTeamDispatch({
    storage,
    runner: { start: async (input) => { started.push(input); return { runId: "run_1" }; } },
    workspaceId,
    note: "做一个登录页",
    members: [{ employeeId: "e_0", isLeader: true }, { employeeId: "e_1" }],
  });
  const team = storage.getAiTeam(result.teamId);
  assert.ok(team, "临时团队必须落库（run 从定义冻结成员）");
  assert.match(team!.name, /^临时派工 · /);
  assert.equal(team!.members.length, 2);
  assert.equal(team!.members[0]!.isLeader, true);
  assert.equal(team!.members[0]!.employeeId, "e_0");
  assert.deepEqual(team!.members[0]!.agents, agents, "候选执行配置按员工快照冻结");
  assert.match(team!.instructions, /本地决策模型按任务描述临时组建/);
  const task = storage.getWandTask(result.taskId);
  assert.equal(task?.status, "doing");
  assert.deepEqual(task?.executionSubject, { type: "team", id: team!.id });
  assert.deepEqual(task?.labels, ["team_direct"]);
  assert.equal(task?.workspaceId, workspaceId);
  assert.deepEqual(started, [{ teamId: team!.id, taskId: result.taskId, note: "做一个登录页" }]);
  assert.ok(root.length > 0);
});

test("开工校验：重复/缺失/未知/已归档/系统运维/人数/负责人", async (t) => {
  const { storage, workspaceId } = harness(t);
  seed(storage, [
    { name: "甲", duty: "前端" },
    { name: "乙", duty: "后端" },
    { name: "运维", duty: "系统运维", systemKey: "wand-ops" },
    { name: "旧人", duty: "历史", archived: true },
  ]);
  const base = {
    storage,
    runner: { start: async () => ({}) },
    workspaceId,
    note: "做点事",
  };
  await assert.rejects(startTeamDispatch({ ...base, members: [{ employeeId: "e_0" }] }), /至少需要 2 名/);
  await assert.rejects(startTeamDispatch({ ...base, members: [{ employeeId: "e_0" }, { employeeId: "e_0" }] }), /重复或缺失/);
  await assert.rejects(startTeamDispatch({ ...base, members: [{ employeeId: "e_0" }, { employeeId: "e_999" }] }), /不存在/);
  await assert.rejects(startTeamDispatch({ ...base, members: [{ employeeId: "e_0" }, { employeeId: "e_3" }] }), /已归档/);
  await assert.rejects(startTeamDispatch({ ...base, members: [{ employeeId: "e_0" }, { employeeId: "e_2" }] }), /系统运维/);
  await assert.rejects(
    startTeamDispatch({ ...base, members: [{ employeeId: "e_0", isLeader: true }, { employeeId: "e_1", isLeader: true }] }),
    /只能指定一名负责人/,
  );
  await assert.rejects(startTeamDispatch({ ...base, note: "  ", members: [{ employeeId: "e_0" }, { employeeId: "e_1" }] }), /开工说明/);
  // 没有临时团队/任务残留
  assert.deepEqual(storage.listAiTeams(), []);
  assert.deepEqual(storage.listWandTasks(), []);
});

test("开工失败时回收刚建的卡与临时团队", async (t) => {
  const { storage, workspaceId } = harness(t);
  seed(storage, [{ name: "甲", duty: "前端" }, { name: "乙", duty: "后端" }]);
  await assert.rejects(
    startTeamDispatch({
      storage,
      runner: { start: async () => { throw new Error("起 run 失败"); } },
      workspaceId,
      note: "做点事",
      members: [{ employeeId: "e_0" }, { employeeId: "e_1" }],
    }),
    /起 run 失败/,
  );
  assert.deepEqual(storage.listWandTasks(), [], "不留空卡");
  assert.deepEqual(storage.listAiTeams(), [], "不留残留团队");
});

test("路由：决策未启用时明确拒绝；规划与开工串起来可用", async (t) => {
  const { storage, workspaceId } = harness(t);
  seed(storage, [{ name: "甲", duty: "前端" }, { name: "乙", duty: "后端" }]);
  const app = express();
  app.use(express.json());
  const started: string[] = [];
  let enabled = false;
  registerTeamDispatchRoutes(app, {
    storage,
    runner: { start: async (input) => { started.push(input.teamId); return { runId: "run_route" }; } },
    decisions: {
      status: () => ({ enabled, supported: true, configured: true }),
      evaluate: fakeDecision({ 甲: 0.9, 乙: 0.8 }).evaluate,
    },
  });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((done) => server.close(done)); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (pathname: string, body: unknown) => {
    const response = await fetch(`${url}${pathname}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };

  const rejected = await post("/api/team-dispatch/plan", { note: "做点事" });
  assert.equal(rejected.status, 400);
  assert.match(String(rejected.json.error), /本地决策未启用/);

  enabled = true;
  const planned = await post("/api/team-dispatch/plan", { note: "做点事" });
  assert.equal(planned.status, 200);
  const members = planned.json.members as Array<{ employeeId: string; isLeader: boolean }>;
  assert.deepEqual(members.map((member) => member.employeeId), ["e_0", "e_1"]);
  assert.equal(members[0]!.isLeader, true);

  const startedResponse = await post("/api/team-dispatch/start", {
    workspaceId,
    note: "做点事",
    members: members.map((member) => ({ employeeId: member.employeeId, ...(member.isLeader ? { isLeader: true } : {}) })),
  });
  assert.equal(startedResponse.status, 202);
  assert.equal(startedResponse.json.runId, "run_route");
  assert.equal(started.length, 1);
  assert.equal(started[0], startedResponse.json.teamId);
  assert.equal(String(startedResponse.json.taskId).length > 0, true);
});
