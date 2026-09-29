import assert from "node:assert/strict";
import test from "node:test";

import { aiTeamChatHistoryPath, aiTeamHandoffPath, aiTeamReportPath, buildAiTeamObjective, buildLeaderFollowupPrompt, buildLeaderKickoffPrompt, buildMemberPrompt, parseLeaderDecision, renderChatHistoryFile, renderHandoffFile } from "../src/ai-team-prompts.js";
import type { AiTeam, AiTeamRun, AiTeamStep } from "../src/ai-team-types.js";
import type { ConversationTurn } from "../src/types.js";

const agent = { provider: "claude", model: "default", thinkingEffort: "off", mode: "full-access", kind: "structured" } as const;
const team: AiTeam = {
  id: "t", name: "T", description: "", instructions: "", requirePlanApproval: true, maxSteps: 30, createdAt: "", updatedAt: "",
  members: [
    { id: "m_lead", name: "Lead", duty: "", agent, isLeader: true },
    { id: "m_dev", name: "Dev Bot", duty: "", agent, isLeader: false },
  ],
};

test("parseLeaderDecision accepts the three actions and resolves members by id or name", () => {
  const byName = parseLeaderDecision(`前言 {不是json} 然后 {"action":"assign","message":"m","steps":[{"member":" dev bot ","title":"t","instructions":"i"}]}`, team);
  assert.ok(byName.ok);
  assert.deepEqual(byName.decision, { action: "assign", message: "m", steps: [{ memberId: "m_dev", title: "t", instructions: "i", after: [] }] });
  assert.deepEqual(parseLeaderDecision('{"action":"ask","message":"q {x}"}', team), { ok: true, decision: { action: "ask", message: "q {x}" } });
  assert.deepEqual(parseLeaderDecision('{"action":"finish","message":"done"}', team), { ok: true, decision: { action: "finish", message: "done" } });
});

test("parseLeaderDecision rejects bad shapes with a Chinese reason", () => {
  const cases = [
    "no json here",
    '{"action":"dance","message":"x"}',
    '{"action":"ask"}',
    '{"action":"assign","message":"m","steps":[]}',
    '{"action":"assign","message":"m","steps":[{"member":"m_lead","title":"t","instructions":"i"}]}',
    '{"action":"assign","message":"m","steps":[{"member":"m_dev","title":"","instructions":"i"}]}',
    `{"action":"assign","message":"m","steps":${JSON.stringify(Array.from({ length: 6 }, () => ({ member: "m_dev", title: "t", instructions: "i" })))}}`,
  ];
  for (const text of cases) {
    const result = parseLeaderDecision(text, team);
    assert.equal(result.ok, false, text);
    if (!result.ok) assert.match(result.error, /[\u4e00-\u9fa5]/);
  }
});

test("parseLeaderDecision truncates oversized fields", () => {
  const result = parseLeaderDecision(JSON.stringify({ action: "assign", message: "m".repeat(5000), steps: [{ member: "m_dev", title: "t".repeat(200), instructions: "i" }] }), team);
  assert.ok(result.ok && result.decision.action === "assign");
  assert.equal(result.decision.message.length, 2000);
  assert.equal(result.decision.steps[0]!.title.length, 80);
});

test("the leader example does not teach an invalid after on the only step", () => {
  const run = { team, objective: "目标" } as AiTeamRun;
  const sample = buildLeaderKickoffPrompt(run, "report.json", true).system;
  assert.equal(sample.includes('"after":[1]'), false, "a one-step example with after:[1] cannot be parsed");
  const copied = parseLeaderDecision(
    '{"action":"assign","message":"开始","steps":[{"member":"m_dev","title":"写","instructions":"写完"}]}',
    team,
  );
  assert.equal(copied.ok, true);
});

test("a typed assignment replaces the task card description", () => {
  const task = {
    title: "新功能",
    description: "你不要执行，你是制定计划的人，然后我现在有很多ci",
  };
  assert.equal(buildAiTeamObjective(task, "只改指派框的提示词"), "任务：新功能\n\n只改指派框的提示词");
  assert.equal(buildAiTeamObjective(task, "新功能里补一段安装说明"), "新功能里补一段安装说明");
  assert.equal(buildAiTeamObjective(task), "新功能\n\n你不要执行，你是制定计划的人，然后我现在有很多ci");
});

test("a task title the description already covers is not repeated", () => {
  // 真实案例（run_46c0a39145b3）：标题是描述开头被截断出来的前缀，拼起来目标会整段重复。
  const description = "subagent的显示效果很奇怪，你去找到合理的实现方式，进行优化，可以参考其他vibecoding 客户端的实现方式";
  const title = "subagent的显示效果很奇怪，你去找到合理的实现方式，进行优化，可以参考其他";
  assert.equal(buildAiTeamObjective({ title, description }), description);
  assert.equal(buildAiTeamObjective({ title: description, description }), description);
  assert.equal(buildAiTeamObjective({ title: `${description}（补充）`, description }), `${description}（补充）`);
  assert.equal(buildAiTeamObjective({ title: "新功能", description: "加一段安装说明" }), "新功能\n\n加一段安装说明");
});

test("leader prompts keep role and rules in the system prompt, content in the message", () => {
  const run = { team, objective: "把安装说明写清楚" } as AiTeamRun;
  const kickoff = buildLeaderKickoffPrompt(run, ".wand-team/r1/1-leader.json", true);
  assert.ok(kickoff.system.includes("m_dev") && kickoff.system.includes("Dev Bot"));
  assert.ok(kickoff.system.includes("CLI: claude/默认"), "没有默认模型解析器时只写「默认」，不写「默认模型」");
  // `default` 哨兵不是模型名：给了服务端默认模型就写它的名字。
  const named = buildLeaderKickoffPrompt(run, ".wand-team/r1/1-leader.json", true, null, () => "opus");
  assert.ok(named.system.includes("CLI: claude/opus/"), "有默认模型时名单里写具体名字");
  assert.ok(!named.system.includes("默认模型"));
  assert.ok(kickoff.system.includes("回复方式") && kickoff.system.includes("after"));
  assert.equal(
    kickoff.message,
    "团队目标：把安装说明写清楚\n\n本轮报告文件：.wand-team/r1/1-leader.json",
    "用户消息只剩目标与本轮文件路径",
  );
  assert.ok(!kickoff.message.includes("回复方式"), "rules stay out of the user message");

  const reused = buildLeaderKickoffPrompt(run, ".wand-team/r1/1-leader.json", false);
  assert.ok(!reused.message.includes("把安装说明写清楚"), "reused sessions already have the goal");
});

test("handoff files carry the upstream reports while prompts only carry paths", () => {
  const run = { team, objective: "目标" } as AiTeamRun;
  const dev = {
    seq: 3,
    title: "改 README",
    memberId: "m_dev",
    status: "done",
    reportPath: aiTeamReportPath("r1", 3, "work", "m_dev"),
    report: "状态: 完成\n改了 README.md",
  } as AiTeamStep;
  const qa = { ...dev, seq: 4, memberId: "m_qa", title: "验收", reportPath: aiTeamReportPath("r1", 4, "work", "m_qa") } as AiTeamStep;

  assert.equal(aiTeamHandoffPath("r1", 5, "work"), ".wand-team/r1/handoff-5-work.md");
  assert.equal(aiTeamHandoffPath("r1", 6, "leader"), ".wand-team/r1/handoff-6-leader.md");

  const file = renderHandoffFile([
    { seq: 3, title: "改 README", memberName: "Dev Bot", status: "done", reportPath: dev.reportPath, report: dev.report },
    { seq: 4, title: "验收", memberName: "QA", status: "done", reportPath: qa.reportPath, report: "状态: 完成\n测试通过" },
  ], "2026-01-01T00:00:00.000Z");
  assert.ok(file.includes("## 第3步 · Dev Bot · 改 README · 完成"));
  assert.ok(file.includes("改了 README.md") && file.includes("测试通过"), "交接文件带报告全文");

  // 成员提示词：上游只给文件，不贴正文。
  const member = buildMemberPrompt(run, qa, team.members[1]!, false, {
    handoffPath: aiTeamHandoffPath("r1", 4, "work"),
    steps: [{ seq: 3, title: "改 README", memberName: "Dev Bot", status: "done", reportPath: dev.reportPath }],
  });
  assert.ok(member.message.includes(aiTeamHandoffPath("r1", 4, "work")));
  assert.ok(member.message.includes(dev.reportPath));
  assert.ok(member.message.includes("## 上游交接"));
  assert.ok(!member.message.includes("先读这个文件"), "读交接文件的规则在系统提示里，不进用户消息");
  assert.ok(member.system.includes("上游交接文件") && member.system.includes("先读它再开始本步骤"));
  assert.ok(!member.message.includes("改了 README.md"), "报告正文不进提示词");

  // Leader 轮次：同样只给路径 + 汇总文件。
  const followup = buildLeaderFollowupPrompt(
    run,
    [{ step: dev, memberName: "Dev Bot" }, { step: qa, memberName: "QA" }],
    aiTeamReportPath("r1", 5, "leader", "m_lead"),
    undefined,
    false,
    aiTeamHandoffPath("r1", 5, "leader"),
  );
  assert.ok(followup.message.includes(aiTeamHandoffPath("r1", 5, "leader")));
  assert.ok(followup.message.includes(dev.reportPath) && followup.message.includes(qa.reportPath));
  assert.ok(!followup.message.includes("改了 README.md") && !followup.message.includes("测试通过"));
  assert.ok(!followup.message.includes("先读这个文件") && !followup.message.includes("凭标题猜"));
  assert.ok(followup.system.includes("先读它再决定下一步") && followup.system.includes("不要凭标题猜"));
});

test("the chat history file carries the earlier rounds and the transcript tail", () => {
  const turns: ConversationTurn[] = [
    { role: "user", content: [{ type: "text", text: "给 README 加安装说明" }] },
    { role: "assistant", notice: true, content: [{ type: "text", text: "团队「T」接手了这个任务" }] },
    {
      role: "assistant",
      author: { id: "m_lead", name: "Lead", leader: true },
      content: [{ type: "text", text: "先让实现改 README\n\n1. **@Dev Bot** 改 README" }],
    },
    {
      role: "assistant",
      author: { id: "m_dev", name: "Dev Bot", provider: "codex" },
      content: [{ type: "text", text: "✅ 完成「改 README」\n\n状态: 完成\nREADME.md 加了 npm 安装说明" }],
    },
  ];
  const file = renderChatHistoryFile({
    runs: [{ status: "done", steps: [{ seq: 2, memberName: "Dev Bot", title: "改 README", status: "done" }] }],
    turns,
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.match(file, /# 本群聊之前的记录/);
  assert.match(file, /- 状态：已完成/);
  assert.match(file, /第2步 · Dev Bot · 改 README · 完成/);
  assert.match(file, /\*\*用户\*\*\n给 README 加安装说明/);
  assert.match(file, /\*\*Lead（负责人）\*\*/);
  assert.match(file, /> 团队：团队「T」接手了这个任务/, "notice 压成引用行");
  assert.match(file, /README\.md 加了 npm 安装说明/, "报告正文留在原文里");
  assert.ok(!file.includes("已省略"));
});

test("the chat history file caps the transcript and keeps the newest turns", () => {
  const turns: ConversationTurn[] = Array.from({ length: 40 }, (_, index) => ({
    role: "assistant",
    author: { id: "m_dev", name: "Dev Bot" },
    content: [{ type: "text", text: `第 ${index + 1} 条：${"字".repeat(80)}` }],
  }));
  const file = renderChatHistoryFile({ runs: [], turns, generatedAt: "now", maxBytes: 1200 });
  assert.match(file, /更早的 \d+ 条发言已省略/);
  assert.match(file, /第 40 条/);
  assert.ok(!file.includes("第 1 条："), "超预算从最早处丢");
});

test("kickoff and fresh-session prompts point at the chat history, reused sessions do not", () => {
  const run = { team, objective: "目标" } as AiTeamRun;
  const historyPath = aiTeamChatHistoryPath("r2");
  assert.equal(historyPath, ".wand-team/r2/chat-history.md");
  const kickoff = buildLeaderKickoffPrompt(run, "report.json", true, historyPath);
  assert.ok(kickoff.message.includes(historyPath));
  assert.ok(!kickoff.message.includes("已经做完的不要重做"), "读文件的规则在系统提示里，不重复进用户消息");
  assert.match(kickoff.system, /已经做完的不要重做/);
  assert.ok(!buildLeaderKickoffPrompt(run, "report.json", true).message.includes("chat-history"), "不续跑就不带这一段");

  const step = { title: "换成 pnpm", instructions: "做事", reportPath: "r.md" } as AiTeamStep;
  const member = buildMemberPrompt(run, step, team.members[1]!, true, null, historyPath);
  assert.ok(member.message.includes(historyPath) && member.message.includes("本群聊之前的记录"));
  assert.ok(member.system.includes("在已有改动的基础上继续"));
  assert.ok(!buildMemberPrompt(run, step, team.members[1]!, false, null, historyPath).message.includes(historyPath),
    "复用的会话已经读过一次，不再重复贴路径");
  assert.ok(buildLeaderFollowupPrompt(run, [], "report.json", "继续", true, null, historyPath).message.includes(historyPath));
  assert.ok(!buildLeaderFollowupPrompt(run, [], "report.json", "继续", false, null, historyPath).message.includes(historyPath));
});

test("member prompts name the report file and skip the goal on reused sessions", () => {
  const run = { team, objective: "目标" } as AiTeamRun;
  const step = { title: "改", instructions: "做事", reportPath: aiTeamReportPath("r1", 3, "work", "m_dev") } as AiTeamStep;
  assert.equal(step.reportPath, ".wand-team/r1/3-m_dev.md");
  const first = buildMemberPrompt(run, step, team.members[1]!, true);
  const later = buildMemberPrompt(run, step, team.members[1]!, false);
  assert.ok(first.message.includes("团队目标：目标") && first.message.includes(step.reportPath));
  assert.ok(!later.message.includes("团队目标") && later.message.includes(step.reportPath));
  assert.ok(first.message.includes(`本轮报告文件：${step.reportPath}`), "用户消息用固定标签给出本轮文件");
  assert.ok(first.system.includes("Dev Bot") && first.system.includes("报告约定"));
  assert.ok(!first.message.includes("报告约定"), "report rules live in the system prompt");
});

test("parseLeaderDecision maps after to step dependencies and defaults to sequential", () => {
  const result = parseLeaderDecision(JSON.stringify({
    action: "assign", message: "m",
    steps: [
      { member: "m_dev", title: "a", instructions: "i" },
      { member: "m_dev", title: "b", instructions: "i" },
      { member: "m_dev", title: "c", instructions: "i", after: [] },
      { member: "m_dev", title: "d", instructions: "i", after: [1, 3, 3] },
    ],
  }), team);
  assert.ok(result.ok && result.decision.action === "assign");
  assert.deepEqual(result.decision.steps.map((step) => step.after), [[], [0], [], [0, 2]]);
  const bad = parseLeaderDecision(JSON.stringify({
    action: "assign", message: "m", steps: [{ member: "m_dev", title: "a", instructions: "i", after: [1] }],
  }), team);
  assert.equal(bad.ok, false);
});

const backupAgent = { provider: "codex", model: "gpt-backup", thinkingEffort: "deep", mode: "full-access", kind: "structured" } as const;
const qaAgent = { provider: "pi", model: "pi-verify", thinkingEffort: "off", mode: "full-access", kind: "structured" } as const;
const v2Team: AiTeam = {
  ...team,
  members: [
    { ...team.members[0]!, agents: [agent] },
    { ...team.members[1]!, agents: [agent, backupAgent], role: "work" },
    { id: "m_qa", name: "QA", duty: "跑测试", agents: [qaAgent], agent: qaAgent, role: "verify", isLeader: false },
    { id: "m_plan", name: "Plan", duty: "出方案", agents: [agent], agent, role: "plan", isLeader: false },
    { id: "m_any", name: "Any", duty: "", agents: [agent], agent, isLeader: false },
  ],
};

test("[T4] memberLine renders role label and only the preferred candidate", () => {
  const system = buildLeaderKickoffPrompt({ team: v2Team, objective: "目标" } as AiTeamRun, "r.json", true).system;
  assert.ok(system.includes("名字: Dev Bot | 角色: 干活实现"), "role label sits between name and duty");
  assert.ok(system.includes("名字: QA | 角色: 验收测试"));
  assert.ok(system.includes("名字: Plan | 角色: 制定计划"));
  assert.ok(!/名字: Any[^\n]*角色/.test(system), "any/缺省角色不显示标签");
  // 首选候选一行 provider/model/effort；非首选候选绝不出现。
  assert.ok(system.includes("CLI: claude/默认/off"));
  assert.ok(!system.includes("gpt-backup"), "backup candidates must not leak into the leader prompt");
  assert.ok(!system.includes("codex/"), "backup candidate provider must not leak either");
  assert.ok(system.includes("执行配置由系统按候选顺序自动降级，你只按成员能力分派，不操心模型可用性"));
});

test("[T4] leader system prompt gains role-first and one-step-per-member rules", () => {
  const system = buildLeaderKickoffPrompt({ team, objective: "目标" } as AiTeamRun, "r.json", true).system;
  assert.ok(system.includes("派工优先按角色：制定计划给 plan 成员，实现给 work 成员，验收给 verify 成员；没标角色的成员视为 any。"));
  assert.ok(system.includes("同一成员同一时间只有一个步骤；互不相干的步骤并行派出，有先后关系的用 after 声明。"));
  // v1 原文两条保留。
  assert.ok(system.includes("并行成员共用同一个工作目录，不要让两个人同时改同一批文件。"));
  assert.ok(system.includes("实现与验收交给不同成员，不要让同一个成员验收自己的工作。"));
});

test("[T4] reply format requires file scope for work and 验收标准 checklist for verify", () => {
  const system = buildLeaderKickoffPrompt({ team, objective: "目标" } as AiTeamRun, "r.json", true).system;
  assert.ok(system.includes("实现步骤的 instructions 必须列出允许改动的文件/目录范围"));
  assert.ok(system.includes("验收步骤的 instructions 必须以「验收标准」清单收尾"));
});

test("[T4] member system prompt teaches chat bubbles with the member name", () => {
  const run = { team: v2Team, objective: "目标" } as AiTeamRun;
  const step = { title: "改", instructions: "做事", reportPath: aiTeamReportPath("r1", 2, "work", "m_dev") } as AiTeamStep;
  const system = buildMemberPrompt(run, step, v2Team.members[1]!, true).system;
  assert.ok(system.includes("你的发言会以群聊气泡出现，署名是你的名字；报告仍写进报告文件。"));
});

test("[T4] parseLeaderDecision still has no role hard validation", () => {
  // 派工给任意角色（甚至验收成员做实现）都只校验成员存在性，口径不变。
  for (const ref of ["m_qa", "Any", "m_dev"]) {
    const result = parseLeaderDecision(`{"action":"assign","message":"m","steps":[{"member":"${ref}","title":"t","instructions":"i"}]}`, v2Team);
    assert.equal(result.ok, true, ref);
  }
});

test("[v2] the chat history file renders the intro and start turns verbatim", () => {
  const turns: ConversationTurn[] = [
    {
      role: "assistant", notice: true,
      author: { id: "m_lead", name: "沈砚", leader: true },
      content: [{ type: "text", text: "创建了团队群聊「前端双人组」" }],
    },
    {
      role: "assistant", notice: true,
      author: { id: "m_lead", name: "沈砚", leader: true },
      content: [{ type: "text", text: "邀请 @实现者、@审查者 加入群聊" }],
    },
    {
      role: "assistant",
      author: { id: "m_dev", name: "实现者", provider: "codex" },
      content: [{
        type: "text",
        text: "我正在开始工作：第 2 步「实现 Web 端」\n依据 @设计师 第 1 步「设计规格」的产物 .wand-team/run_1/report-1-work-m_designer.md",
      }],
    },
  ];
  const file = renderChatHistoryFile({ runs: [], turns, generatedAt: "now" });
  // 入群行是 notice → 引用行；作者槽写负责人。
  assert.match(file, /> 沈砚（负责人）：创建了团队群聊「前端双人组」/);
  assert.match(file, /> 沈砚（负责人）：邀请 @实现者、@审查者 加入群聊/);
  // 开工发言是真实发言 → 加粗说话人 + 正文（依据行不丢字）。
  assert.match(file, /\*\*实现者\*\*\n我正在开始工作：第 2 步「实现 Web 端」/);
  assert.match(file, /依据 @设计师 第 1 步「设计规格」的产物 \.wand-team\/run_1\/report-1-work-m_designer\.md/);
  assert.ok(!file.includes("undefined"), "缺字段不冒 undefined");
});

test("[v2] the leader prompt explains that after becomes the basis shown in the chat", () => {
  const kickoff = buildLeaderKickoffPrompt({ team, objective: "把安装说明写清楚" } as AiTeamRun, ".wand-team/r1/1-leader.json", true);
  assert.ok(kickoff.system.includes("依据"), "派工提示词说明 after 会渲染成群里的「依据」");
  assert.ok(kickoff.system.includes('"after": [1, 2]：等第 1、2 步都做完再开始。'), "原 after 说明一字不改");
});
