import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { agentKey, memberAgents } from "../src/ai-team-types.js";
import type { WandTaskAgent } from "../src/task-types.js";
import { WandStorage, parseAiTeamRunState, parseStepDispatchInfo } from "../src/storage.js";

const NOW = "2026-01-01T00:00:00.000Z";

/** v1 时代的单个执行配置：成员 JSON 只有 agent，没有 agents。 */
const legacyAgent: WandTaskAgent = {
  provider: "claude",
  model: "default",
  thinkingEffort: "off",
  mode: "full-access",
  kind: "structured",
};

const legacyMembers = [
  { id: "m_lead", name: "负责人", duty: "派工", agent: legacyAgent, isLeader: true },
  { id: "m_dev", name: "实现", duty: "写代码", agent: { ...legacyAgent, provider: "codex" }, isLeader: false },
];

/** 用 v2 之前的旧 schema 造一个库文件：三张表都没有 dispatch_info_json / run_state_json 等后加列。 */
function createLegacyDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE ai_teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      members_json TEXT NOT NULL,
      require_plan_approval INTEGER NOT NULL DEFAULT 1,
      max_steps INTEGER NOT NULL DEFAULT 30,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE ai_team_runs (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      team_json TEXT NOT NULL,
      objective TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      status_detail TEXT NOT NULL DEFAULT '',
      steps_used INTEGER NOT NULL DEFAULT 0,
      step_limit INTEGER NOT NULL,
      format_retries INTEGER NOT NULL DEFAULT 0,
      plan_approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE ai_team_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      member_id TEXT NOT NULL,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      report TEXT NOT NULL DEFAULT '',
      report_path TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      UNIQUE (run_id, seq)
    );
  `);
  const team = {
    id: "team_legacy", name: "旧团队", description: "", instructions: "",
    members: legacyMembers, requirePlanApproval: true, maxSteps: 30, createdAt: NOW, updatedAt: NOW,
  };
  db.prepare(
    "INSERT INTO ai_teams (id, name, description, members_json, require_plan_approval, max_steps, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 30, ?, ?)"
  ).run(team.id, team.name, team.description, JSON.stringify(legacyMembers), NOW, NOW);
  db.prepare(
    `INSERT INTO ai_team_runs (id, team_id, task_id, team_json, objective, cwd, status, status_detail,
       steps_used, step_limit, format_retries, plan_approved, created_at, updated_at)
     VALUES ('run_legacy', 'team_legacy', 'task_legacy', ?, '目标', '/tmp', 'running', '', 0, 30, 0, 1, ?, ?)`
  ).run(JSON.stringify(team), NOW, NOW);
  db.prepare(
    `INSERT INTO ai_team_steps (id, run_id, seq, kind, member_id, title, instructions, session_id, status,
       report, report_path, started_at, ended_at)
     VALUES ('step_legacy', 'run_legacy', 1, 'work', 'm_dev', '旧步骤', '做', NULL, 'queued', '', 'report.md', NULL, NULL)`
  ).run();
  db.close();
}

function openLegacyStorage(t: TestContext): { storage: WandStorage; dbPath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-ai-team-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "wand.db");
  createLegacyDatabase(dbPath);
  const storage = new WandStorage(dbPath);
  t.after(() => {
    try { storage.close(); } catch { /* 测试内已显式关闭 */ }
  });
  return { storage, dbPath };
}

test("[S8] ensureAiTeamSchema adds dispatch_info_json and run_state_json to legacy databases", (t) => {
  const { storage, dbPath } = openLegacyStorage(t);
  storage.close();
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  const stepColumns = (db.prepare("PRAGMA table_info(ai_team_steps)").all() as Array<{ name: string }>).map((column) => column.name);
  const runColumns = (db.prepare("PRAGMA table_info(ai_team_runs)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.ok(stepColumns.includes("dispatch_info_json"), "ai_team_steps.dispatch_info_json added");
  assert.ok(runColumns.includes("run_state_json"), "ai_team_runs.run_state_json added");
  // 旧行零回填：默认值 '{}' 直接可读。
  const step = db.prepare("SELECT dispatch_info_json FROM ai_team_steps WHERE id = 'step_legacy'").get() as { dispatch_info_json: string };
  assert.equal(step.dispatch_info_json, "{}");
});

test("[S8] legacy teams and run snapshots map through memberAgents into single-candidate members", (t) => {
  const { storage } = openLegacyStorage(t);

  const team = storage.getAiTeam("team_legacy");
  assert.ok(team);
  assert.equal(team.members.length, 2);
  for (const member of team.members) {
    assert.equal(member.agents.length, 1, "agents normalized to one candidate");
    assert.deepEqual(member.agents[0], member.agent);
    assert.deepEqual(memberAgents(member), [member.agent]);
  }

  const run = storage.getAiTeamRun("run_legacy");
  assert.ok(run);
  assert.equal(run.team.members.length, 2, "old team_json snapshot stays readable");
  for (const member of run.team.members) {
    assert.deepEqual(memberAgents(member), [member.agent]);
  }

  // 旧步骤行也照常读出（后加列取默认值）。
  const steps = storage.listAiTeamSteps("run_legacy");
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.dependsOn, []);
});

test("[S8] legacy rows remain writable after migration", (t) => {
  const { storage } = openLegacyStorage(t);
  const team = storage.getAiTeam("team_legacy");
  assert.ok(team);

  // 团队定义升级成多候选后可以原路保存并读回。
  const backup: WandTaskAgent = { ...legacyAgent, provider: "pi", model: "pi-max" };
  team.members[1]!.agents = [{ ...legacyAgent, provider: "codex" }, backup];
  team.members[1]!.agent = team.members[1]!.agents[0]!;
  storage.saveAiTeam(team);
  const reloaded = storage.getAiTeam("team_legacy");
  assert.ok(reloaded);
  assert.deepEqual(memberAgents(reloaded.members[1]!).map((candidate) => candidate.provider), ["codex", "pi"]);
  assert.equal(agentKey(reloaded.members[1]!.agents[1]!), "pi|pi-max|off|full-access|structured");

  // 运行与步骤的既有写路径不受新列影响。
  const run = storage.getAiTeamRun("run_legacy");
  assert.ok(run);
  run.statusDetail = "写回测试";
  storage.saveAiTeamRun(run);
  assert.equal(storage.getAiTeamRun("run_legacy")?.statusDetail, "写回测试");

  const step = storage.listAiTeamSteps("run_legacy")[0]!;
  step.status = "done";
  step.report = "完成";
  storage.saveAiTeamStep(step);
  const reloadedStep = storage.listAiTeamSteps("run_legacy")[0]!;
  assert.equal(reloadedStep.status, "done");
  assert.equal(reloadedStep.report, "完成");
});

test("[S8] old rows with the default '{}' columns read back as the no-degrade fallback", (t) => {
  const { storage, dbPath } = openLegacyStorage(t);

  // 步骤：默认 '{}' = 首选、没跳过任何候选，读侧不挂 dispatchInfo 字段。
  const step = storage.listAiTeamSteps("run_legacy")[0]!;
  assert.equal(step.dispatchInfo, undefined, "旧行不凭空造出降级留痕");
  assert.deepEqual(parseStepDispatchInfo("{}"), { usedCandidate: 0, skipped: [] });
  assert.deepEqual(parseStepDispatchInfo(null), { usedCandidate: 0, skipped: [] });

  // run：默认 '{}' = 空黑名单，重启后没有任何候选被拉黑。
  assert.deepEqual(storage.getAiTeamRunState("run_legacy"), { providers: [], agents: [], strikes: {}, hostDisabled: [] });

  // 脏值只丢脏条目，不让整字段作废；自相矛盾的 usedCandidate 以留痕向下纠正。
  assert.deepEqual(parseStepDispatchInfo("not json"), { usedCandidate: 0, skipped: [] });
  assert.deepEqual(parseStepDispatchInfo(JSON.stringify({ usedCandidate: 3, skipped: "x" })), { usedCandidate: 3, skipped: [] });
  // 坏条目逐条丢弃；留痕还在时以留痕为准向下纠正，绝不凭空跳级。
  const trail = { candidate: 0, agent: legacyAgent, reason: "cli 不可用", errorKind: "spawn-missing" };
  assert.deepEqual(parseStepDispatchInfo(JSON.stringify({ usedCandidate: 3, skipped: [trail, { candidate: -1 }] })),
    { usedCandidate: 1, skipped: [trail] });
  assert.deepEqual(parseAiTeamRunState(JSON.stringify({ providers: ["codex", "nope"], strikes: { k: -1, j: 1.7 }, hostDisabled: ["structured", "x"] })),
    { providers: ["codex"], agents: [], strikes: { j: 1 }, hostDisabled: ["structured"] });

  // 写路径对新列是原子的：只写 run_state_json 不碰业务字段，只补步骤留痕不碰报告。
  storage.setAiTeamRunState("run_legacy", { providers: ["codex"], agents: [], strikes: {}, hostDisabled: [] });
  const run = storage.getAiTeamRun("run_legacy");
  assert.equal(run?.objective, "目标", "写 run_state_json 不影响 saveAiTeamRun 负责的业务字段");
  assert.equal(run?.status, "running");
  assert.deepEqual(storage.getAiTeamRunState("run_legacy").providers, ["codex"]);
  storage.saveAiTeamStep({ ...step, dispatchInfo: { usedCandidate: 1, skipped: [] } });
  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
  const raw = db.prepare("SELECT dispatch_info_json FROM ai_team_steps WHERE id = 'step_legacy'").get() as { dispatch_info_json: string };
  assert.deepEqual(JSON.parse(raw.dispatch_info_json), { usedCandidate: 1, skipped: [] });
});

test("memberAgents and agentKey behave as pure helpers on bare JSON", () => {
  // 未归一的裸对象（只有 agent）也能直接经 memberAgents 取候选。
  const bare = { agent: legacyAgent };
  assert.deepEqual(memberAgents(bare), [legacyAgent]);
  assert.deepEqual(memberAgents({ agent: legacyAgent, agents: [] }), [legacyAgent]);
  const two = [legacyAgent, { ...legacyAgent, provider: "codex" }];
  assert.equal(memberAgents({ agent: legacyAgent, agents: two }), two, "non-empty agents returned as-is");

  // 五元组按字面量比较：model 不同即不同候选，default 不做等价归一。
  assert.equal(agentKey(legacyAgent), "claude|default|off|full-access|structured");
  assert.notEqual(agentKey({ ...legacyAgent, model: "sonnet" }), agentKey(legacyAgent));
  assert.notEqual(agentKey({ ...legacyAgent, kind: "pty" }), agentKey(legacyAgent));
});
