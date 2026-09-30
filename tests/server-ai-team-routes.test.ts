import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";

import { AiTeamRunner, type AiTeamSessionOps } from "../src/ai-team-runner.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { registerAiTeamRoutes } from "../src/server-ai-team-routes.js";
import { WandStorage } from "../src/storage.js";

const agent = { provider: "claude", model: "default", mode: "full-access", kind: "structured" };

function validTeam() {
  return {
    name: "团队",
    members: [
      { name: "负责人", duty: "派工", agent, isLeader: true },
      { name: "实现", duty: "写代码", agent: { ...agent, provider: "codex" } },
    ],
  };
}

async function harness(t: TestContext): Promise<{
  url: string; storage: WandStorage; runner: AiTeamRunner; changes: string[];
}> {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-ai-team-routes-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const ops: AiTeamSessionOps = {
    open: async () => "s1",
    send: async () => undefined,
    stop: () => undefined,
    snapshot: () => ({ id: "s1", status: "running", structuredState: { inFlight: true }, messages: [] }) as never,
    ownerOf: () => "structured",
  };
  const runner = new AiTeamRunner({ storage, ops, resolveCwd: () => root });
  const app = express();
  app.use(express.json());
  const changes: string[] = [];
  registerAiTeamRoutes(app, { storage, runner, notifyTeamChanged: (id) => changes.push(id) });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    runner.dispose();
    await new Promise((done) => server.close(done));
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, storage, runner, changes };
}

async function call(url: string, method: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("teams are created, updated and listed with normalized members", async (t) => {
  const { url } = await harness(t);
  const created = await call(`${url}/api/ai-teams`, "POST", validTeam());
  assert.equal(created.status, 201);
  assert.equal(created.json.requirePlanApproval, true);
  assert.equal(created.json.maxSteps, 30);
  assert.match(created.json.members[0].id, /^m_/);
  assert.equal(created.json.members[1].agent.thinkingEffort, "off");

  const members = created.json.members.map((member: Record<string, unknown>) => ({ ...member, duty: "新职责" }));
  const updated = await call(`${url}/api/ai-teams/${created.json.id}`, "PUT", { ...validTeam(), members, maxSteps: 50 });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.members[0].id, created.json.members[0].id, "member ids are kept on update");
  assert.equal(updated.json.maxSteps, 50);
  assert.equal((await call(`${url}/api/ai-teams`, "GET")).json.length, 1);
});

test("PUT notifies readers and run detail projects renamed members without rewriting execution", async (t) => {
  const { url, storage, runner, changes } = await harness(t);
  const created = await call(`${url}/api/ai-teams`, "POST", validTeam());
  const task = storage.createWandTask({ title: "改名验证", description: "验证成员署名" });
  const started = await runner.start({ teamId: created.json.id, taskId: task.id });
  const members = created.json.members.map((member: { id: string; name: string }) =>
    member.name === "实现" ? { ...member, name: "新名字", avatar: "cat:4" } : member);
  const updated = await call(`${url}/api/ai-teams/${created.json.id}`, "PUT", {
    ...created.json, members,
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(changes, [created.json.id]);
  const detail = await call(`${url}/api/ai-team-runs/${started.run.id}`, "GET");
  assert.equal(detail.json.run.team.members[1].name, "实现");
  assert.equal(detail.json.displayTeam.members[1].name, "新名字");
  assert.equal(detail.json.displayTeam.members[1].avatar, "cat:4");
  assert.equal(storage.getAiTeamRun(started.run.id)?.team.members[1]?.name, "实现");
});

test("team validation rejects bad member lists with Chinese messages", async (t) => {
  const { url } = await harness(t);
  const base = validTeam();
  const cases = [
    { ...base, members: base.members.slice(0, 1) },
    { ...base, members: [base.members[0], { ...base.members[1], name: "负责人" }] },
    { ...base, members: base.members.map((member) => ({ ...member, isLeader: false })) },
    { ...base, members: [base.members[0], { ...base.members[1], agent: { provider: "nope" } }] },
    { ...base, members: [base.members[0], { ...base.members[1], isLeader: true }] },
    { ...base, maxSteps: 1 },
    { ...base, name: "" },
  ];
  for (const body of cases) {
    const result = await call(`${url}/api/ai-teams`, "POST", body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.match(result.json.error, /[\u4e00-\u9fa5]/);
  }
});

test("members accept agents arrays and the server forces agent = agents[0]", async (t) => {
  const { url } = await harness(t);
  const first = { provider: "claude", model: "sonnet-x", thinkingEffort: "deep", mode: "full-access", kind: "structured" };
  const second = { ...agent, provider: "codex" };
  const body = {
    name: "多候选",
    members: [
      // 客户端故意带一个矛盾的兼容字段，服务端必须覆写为 agents[0]。
      { name: "负责人", duty: "派工", agents: [first, second], agent: { ...agent, provider: "pi" }, isLeader: true, role: "plan" },
      { name: "实现", duty: "写代码", agents: [second] },
    ],
  };
  const created = await call(`${url}/api/ai-teams`, "POST", body);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const leader = created.json.members[0];
  assert.deepEqual(leader.agents, [
    { ...first, thinkingEffort: "deep" },
    { ...second, thinkingEffort: "off" },
  ]);
  assert.deepEqual(leader.agent, created.json.members[0].agents[0], "agent is forced to agents[0]");
  assert.equal(leader.role, "plan");
  assert.deepEqual(created.json.members[1].agent, created.json.members[1].agents[0]);

  // 旧 {agent} 单对象格式仍然接受，agents 归一为单元素数组。
  const legacy = await call(`${url}/api/ai-teams`, "POST", validTeam());
  assert.equal(legacy.status, 201);
  assert.equal(legacy.json.members[0].agents.length, 1);
  assert.deepEqual(legacy.json.members[0].agents[0], legacy.json.members[0].agent);
});

test("member candidate validation rejects empty, oversized and duplicate candidate lists", async (t) => {
  const { url } = await harness(t);
  const base = validTeam();
  const worker = () => ({ ...base.members[1] });
  const cases: Array<Record<string, unknown>> = [
    { ...base.members[0], agents: [] },
    { ...base.members[0], agents: "claude" },
    { ...base.members[0], agents: [{ provider: "nope" }] },
    { ...base.members[0], agents: Array.from({ length: 5 }, (_, i) => ({ ...agent, model: `m-${i}` })) },
    // 五元组完全相同 → 重复；model 按字面量比较，default 不与具体模型名等价。
    { ...base.members[0], agents: [agent, { ...agent }] },
    { ...base.members[0], agents: [agent, { ...agent, thinkingEffort: "off" }] },
  ];
  for (const agents of cases) {
    const result = await call(`${url}/api/ai-teams`, "POST", {
      ...base,
      members: [agents, worker()],
    });
    assert.equal(result.status, 400, JSON.stringify(agents));
    assert.match(result.json.error, /[\u4e00-\u9fa5]/);
  }

  // 上限 4 合法；4 个不同候选可保存。
  const ok = await call(`${url}/api/ai-teams`, "POST", {
    ...base,
    members: [
      { ...base.members[0], agents: Array.from({ length: 4 }, (_, i) => ({ ...agent, model: `m-${i}` })) },
      worker(),
    ],
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.members[0].agents.length, 4);

  // 未知 role 值按缺省处理，不落库。
  const oddRole = await call(`${url}/api/ai-teams`, "POST", {
    ...base,
    members: [{ ...base.members[0], role: "boss" }, worker()],
  });
  assert.equal(oddRole.status, 201);
  assert.equal(oddRole.json.members[0].role, undefined);
});

test("run actions map state conflicts to 409 and unknown runs to 404", async (t) => {
  const { url, storage } = await harness(t);
  const team = (await call(`${url}/api/ai-teams`, "POST", validTeam())).json;
  const task = storage.createWandTask({ title: "任务" });
  const started = await call(`${url}/api/wand-tasks/${task.id}/team-runs`, "POST", { teamId: team.id });
  assert.equal(started.status, 202);
  assert.equal(started.json.run.status, "running");
  assert.equal(started.json.steps.length, 1);
  assert.deepEqual(storage.getWandTask(task.id)?.executionSubject, { type: "team", id: team.id });

  assert.equal((await call(`${url}/api/wand-tasks/${task.id}/team-runs`, "POST", { teamId: team.id })).status, 409);
  assert.equal((await call(`${url}/api/ai-team-runs/${started.json.run.id}/approve`, "POST")).status, 409);
  assert.equal((await call(`${url}/api/ai-team-runs/nope`, "GET")).status, 404);
  assert.equal((await call(`${url}/api/wand-tasks/${task.id}/team-runs`, "GET")).json.length, 1);

  const stopped = await call(`${url}/api/ai-team-runs/${started.json.run.id}/stop`, "POST", {});
  assert.equal(stopped.json.run.status, "stopped");
});

// ── T5 直接开工路由 + 团队详情端点 ──

test("[T5] direct kickoff validates the workspace before it creates anything", async (t) => {
  const { url, storage } = await harness(t);
  const team = (await call(`${url}/api/ai-teams`, "POST", validTeam())).json;
  const global = storage.createWorkspace({ name: "全局", cwd: path.join(os.tmpdir(), "scratch"), kind: "global" });
  const empty = storage.createWorkspace({ name: "没有目录", cwd: "" });
  const project = storage.createWorkspace({ name: "项目", cwd: path.join(os.tmpdir(), "project") });
  const note = "给 README 加安装说明";
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ note }, "请选择工作项目"],
    [{ note, workspaceId: "" }, "请选择工作项目"],
    [{ note, workspaceId: "ws-missing" }, "请选择工作项目"],
    [{ note, workspaceId: global.id }, "不能在全局暂存工作区运行"],
    [{ note, workspaceId: empty.id }, "还没有工作目录"],
    [{ workspaceId: project.id }, "开工说明不能为空"],
    [{ workspaceId: project.id, note: "x".repeat(4001) }, "不能超过 4000 个字符"],
  ];
  for (const [body, message] of cases) {
    const result = await call(`${url}/api/ai-teams/${team.id}/runs`, "POST", body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.match(result.json.error, new RegExp(message), JSON.stringify(body));
  }
  assert.equal(storage.listWandTasks(global.id).length, 0, "全局工作区一个卡都没落");
  assert.equal(storage.listWandTasks(empty.id).length, 0);
  assert.equal(storage.listWandTasks(project.id).length, 0, "校验不过不建卡");

  // 路由没有 cwd 入参：客户端多带的 cwd 一律被忽略，目录仍是所选项目的。
  const smuggled = await call(`${url}/api/ai-teams/${team.id}/runs`, "POST", {
    note, workspaceId: project.id, cwd: "/tmp/想越界",
  });
  assert.equal(smuggled.status, 202);
  assert.equal(storage.getWandTask(smuggled.json.taskId)!.workspaceId, project.id);
});

test("[T5] a successful kickoff creates the team_direct card and returns the run", async (t) => {
  const { url, storage } = await harness(t);
  const team = (await call(`${url}/api/ai-teams`, "POST", validTeam())).json;
  const project = storage.createWorkspace({ name: "wand", cwd: path.join(os.tmpdir(), "wand-project") });
  const note = `${"给 README 增加安装说明，".repeat(4)}\n\n把 npm install 那段补全，顺带写 pnpm 与全局安装。`;
  const result = await call(`${url}/api/ai-teams/${team.id}/runs`, "POST", { note, workspaceId: project.id });
  assert.equal(result.status, 202);
  assert.equal(result.json.run.teamId, team.id);
  assert.equal(result.json.steps.length, 1, "只有负责人那一步");
  assert.ok(Object.keys(result.json.memberStates).length >= 0);
  assert.ok(Array.isArray(result.json.chatTurns), "detail 的既有形状原样返回");

  const card = storage.getWandTask(result.json.taskId);
  assert.ok(card, "返回 taskId");
  assert.equal(card.workspaceId, project.id, "显式落已校验项目，不静默兜到 scratch（N2）");
  assert.deepEqual(card.labels, ["team_direct"]);
  assert.equal(card.status, "doing");
  assert.deepEqual(card.executionSubject, { type: "team", id: team.id });
  assert.equal(card.description, note);
  assert.ok(card.title.length <= 40 && card.title.startsWith("给 README"), `首行走既有截断：${card.title}`);
  assert.equal(card.milestoneId, storage.ensureDefaultWandMilestone().id, "没选迭代落默认迭代");
  assert.deepEqual(card.agent, { ...agent, thinkingEffort: "off" }, "卡片执行配置取负责人首选");
  // 每次点击都是新卡新 run：服务端不做跨卡去重。
  const again = await call(`${url}/api/ai-teams/${team.id}/runs`, "POST", { note, workspaceId: project.id });
  assert.equal(again.status, 202);
  assert.notEqual(again.json.taskId, result.json.taskId);
  assert.notEqual(again.json.run.id, result.json.run.id);
});

test("[T5] a failed start rolls the auto-created card back", async (t) => {
  const { url, storage, runner } = await harness(t);
  const team = (await call(`${url}/api/ai-teams`, "POST", validTeam())).json;
  const project = storage.createWorkspace({ name: "wand", cwd: path.join(os.tmpdir(), "wand-project") });
  const real = runner.start.bind(runner);
  (runner as unknown as { start: () => Promise<never> }).start = () => Promise.reject(new Error("成员被删掉了，没法开工。"));
  try {
    const failed = await call(`${url}/api/ai-teams/${team.id}/runs`, "POST", {
      note: "改 README", workspaceId: project.id,
    });
    assert.equal(failed.status, 400);
    assert.match(failed.json.error, /成员被删掉了/);
    assert.equal(storage.listWandTasks(project.id).length, 0, "不留空卡");
    assert.equal(storage.listAiTeamRuns({ teamId: team.id }).length, 0);

    // 团队不存在连卡都不建（校验链在建卡之前）。
    const missing = await call(`${url}/api/ai-teams/team_nope/runs`, "POST", {
      note: "改 README", workspaceId: project.id,
    });
    assert.equal(missing.status, 404);
    assert.equal(storage.listWandTasks(project.id).length, 0);
  } finally {
    (runner as unknown as { start: typeof real }).start = real;
  }
  const ok = await call(`${url}/api/ai-teams/${team.id}/runs`, "POST", { note: "改 README", workspaceId: project.id });
  assert.equal(ok.status, 202, "恢复真实 start 后照常开工");
});

test("[T5] team detail returns the team plus run summaries, unknown teams are 404", async (t) => {
  const { url, storage } = await harness(t);
  const team = (await call(`${url}/api/ai-teams`, "POST", validTeam())).json;
  const project = storage.createWorkspace({ name: "wand", cwd: path.join(os.tmpdir(), "wand-project") });
  const started = await call(`${url}/api/ai-teams/${team.id}/runs`, "POST", {
    note: "给 README 加安装说明", workspaceId: project.id,
  });
  assert.equal(started.status, 202);

  const detail = await call(`${url}/api/ai-teams/${team.id}`, "GET");
  assert.equal(detail.status, 200);
  assert.equal(detail.json.team.id, team.id);
  assert.equal(detail.json.team.members.length, 2);
  assert.equal(detail.json.runs.length, 1);
  assert.equal(detail.json.runs[0].id, started.json.run.id);
  assert.equal(detail.json.runs[0].taskTitle, storage.getWandTask(started.json.taskId)!.title);
  assert.match(detail.json.runs[0].taskIdentifier, /^TASK-/);

  assert.equal((await call(`${url}/api/ai-teams/team_nope`, "GET")).status, 404);
  assert.equal((await call(`${url}/api/ai-teams`, "GET")).json.length, 1, "列表路由不变");
});

test("[T5] team routes stay behind the global /api auth middleware (§9.6)", () => {
  const serverSource = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.ok(serverSource.includes('app.use("/api", requireAuth)'), "全局 /api 鉴权仍在");
  assert.ok(
    serverSource.indexOf('app.use("/api", requireAuth)') < serverSource.indexOf("registerAiTeamRoutes(app"),
    "团队路由在全局鉴权之后注册，本路由文件不自己挂 requireAuth",
  );
});

// ── live 端点（§4.9）──

test("GET /api/ai-team-runs/:id/live returns running steps and 404s unknown runs", async (t) => {
  const { url, storage } = await harness(t);
  const team = (await call(`${url}/api/ai-teams`, "POST", validTeam())).json;
  const task = storage.createWandTask({ title: "任务" });
  const started = await call(`${url}/api/wand-tasks/${task.id}/team-runs`, "POST", { teamId: team.id });
  assert.equal(started.status, 202);

  const live = await call(`${url}/api/ai-team-runs/${started.json.run.id}/live`, "GET");
  assert.equal(live.status, 200);
  assert.equal(live.json.runId, started.json.run.id);
  assert.equal(live.json.steps.length, 1, "负责人那一步正在跑");
  const step = live.json.steps[0];
  assert.equal(step.stepId, started.json.steps[0].id);
  assert.equal(step.memberName, "负责人");
  assert.equal(step.provider, "claude");
  assert.equal(step.state, "working");
  assert.equal(typeof step.text, "string");
  assert.equal(step.omittedChars, 0);
  assert.equal(step.sessionId, "s1");
  // 模型与思考深度是给候选真值，客户端才有东西可显示；路由不另挑字段。
  assert.equal(step.model, "default");
  assert.equal(typeof step.thinkingEffort, "string");
  assert.deepEqual(Object.keys(step).sort(), [
    "memberId", "memberName", "model", "omittedChars", "provider", "seq", "sessionId",
    "state", "stepId", "text", "thinkingEffort", "updatedAt",
  ], "/live 返回与 AiTeamLiveStep 逐字段一致");
  assert.match(step.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const missing = await call(`${url}/api/ai-team-runs/nope/live`, "GET");
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /团队运行不存在/);
});
