import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  AiTeamConflictError,
  AiTeamRunner,
  redactAiTeamErrorText,
  type AiTeamChatOps,
  type AiTeamSessionOps,
} from "../src/ai-team-runner.js";
import {
  agentKey,
  AI_TEAM_DETAIL_CHAT_TURNS,
  type AiTeam,
  type AiTeamMember,
  type AiTeamStep,
} from "../src/ai-team-types.js";
import { WandStorage } from "../src/storage.js";
import type { WandTaskAgent } from "../src/task-types.js";
import type { ConversationTurn, SessionSnapshot } from "../src/types.js";

const structuredAgent = (provider: WandTaskAgent["provider"]): WandTaskAgent => ({
  provider, model: "default", thinkingEffort: "off", mode: "full-access", kind: "structured",
});

interface FakeSession {
  id: string;
  owner: "structured" | "pty";
  status: SessionSnapshot["status"];
  inFlight: boolean;
  messages: ConversationTurn[];
  sent: string[];
  provider: string;
  lastError: string | null;
}

class FakeOps implements AiTeamSessionOps {
  readonly sessions = new Map<string, FakeSession>();
  readonly opened: Array<{ sessionId: string; provider: string; model: string; kind: string; prompt: string; systemPrompt?: string }> = [];
  /** 含失败的尝试：降级验收要看「有没有再起一次会话」，成功列表不够。 */
  readonly attempts: Array<{ provider: string; model: string }> = [];
  readonly stopped: string[] = [];
  /** 返回错误文案即模拟该候选起不来（ENOENT / 未启用 … 会话 等）。 */
  openFailure: ((agent: WandTaskAgent) => string | null) | null = null;
  sendFailure: string | null = null;
  stopThrows = false;
  private counter = 0;

  async open(input: { agent: WandTaskAgent; prompt: string; systemPrompt?: string }): Promise<string> {
    this.attempts.push({ provider: input.agent.provider, model: input.agent.model });
    const failure = this.openFailure?.(input.agent);
    if (failure) throw new Error(failure);
    const id = `s${++this.counter}`;
    this.sessions.set(id, {
      id, owner: input.agent.kind === "pty" ? "pty" : "structured", status: "running", inFlight: true,
      messages: [{ role: "user", content: [{ type: "text", text: input.prompt }] }], sent: [input.prompt],
      provider: input.agent.provider, lastError: null,
    });
    this.opened.push({
      sessionId: id,
      provider: input.agent.provider,
      model: input.agent.model,
      kind: input.agent.kind,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
    });
    return id;
  }

  async send(sessionId: string, text: string): Promise<void> {
    if (this.sendFailure) throw new Error(this.sendFailure);
    const session = this.sessions.get(sessionId)!;
    session.sent.push(text);
    session.inFlight = true;
    session.messages.push({ role: "user", content: [{ type: "text", text }] });
  }

  stop(sessionId: string): void {
    if (this.stopThrows) {
      this.stopped.push(sessionId);
      throw new Error("render daemon 没应答");
    }
    this.stopped.push(sessionId);
    this.sessions.get(sessionId)!.status = "stopped";
  }

  snapshot(sessionId: string): SessionSnapshot | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      id: session.id, status: session.status, messages: session.messages, provider: session.provider,
      structuredState: session.owner === "structured"
        ? { inFlight: session.inFlight, lastError: session.lastError }
        : undefined,
    } as unknown as SessionSnapshot;
  }

  ownerOf(sessionId: string): "structured" | "pty" | null {
    return this.sessions.get(sessionId)?.owner ?? null;
  }

  /** 模拟一轮结束：可选地追加 assistant 回复。 */
  finishTurn(sessionId: string, reply?: string): void {
    const session = this.sessions.get(sessionId)!;
    session.inFlight = false;
    if (reply !== undefined) session.messages.push({ role: "assistant", content: [{ type: "text", text: reply }] });
  }
}

class FakeChat implements AiTeamChatOps {
  readonly turns = new Map<string, ConversationTurn[]>();
  private counter = 0;

  /** 转发会话在真实现里就是一个普通结构化会话，所以这里也把它映进 ops.sessions。 */
  constructor(private readonly ops: FakeOps) {}

  open(): string {
    const id = `chat${++this.counter}`;
    this.turns.set(id, []);
    this.ops.sessions.set(id, {
      id, owner: "structured", status: "running", inFlight: false, messages: [], sent: [],
      provider: "claude", lastError: null,
    });
    return id;
  }

  post(sessionId: string, turns: ConversationTurn[]): void {
    this.turns.get(sessionId)!.push(...turns);
    this.ops.sessions.get(sessionId)?.messages.push(...turns);
  }

  /** 每条发言压成「发言人: 文本」便于断言；提示行前面加「·」。 */
  lines(sessionId: string): string[] {
    return this.turns.get(sessionId)!.map((turn) => {
      const text = turn.content.map((block) => block.type === "text" ? block.text : "").join("");
      const who = turn.role === "user" ? "用户" : turn.author?.name ?? "";
      return `${turn.notice ? "·" : ""}${who}: ${text}`;
    });
  }
}

interface Harness {
  storage: WandStorage;
  ops: FakeOps;
  chat: FakeChat;
  runner: AiTeamRunner;
  cwd: string;
  team: AiTeam;
  taskId: string;
  clock: { now: number };
  models?: (provider: WandTaskAgent["provider"]) => string[];
}

function harness(
  t: TestContext,
  overrides: Partial<AiTeam> = {},
  options: {
    worker?: WandTaskAgent;
    workerAgents?: WandTaskAgent[];
    models?: (provider: WandTaskAgent["provider"]) => string[];
  } = {},
): Harness {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-ai-team-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo");
  mkdirSync(cwd);
  const storage = new WandStorage(path.join(root, "wand.db"));
  const worker: AiTeamMember = options.workerAgents
    ? {
      id: "m_dev", name: "实现", duty: "改代码",
      agents: options.workerAgents, agent: options.workerAgents[0]!, isLeader: false,
    }
    : {
      id: "m_dev", name: "实现", duty: "改代码",
      agents: [options.worker ?? structuredAgent("codex")], agent: options.worker ?? structuredAgent("codex"), isLeader: false,
    };
  const team: AiTeam = {
    id: "team-1", name: "测试团队", description: "", instructions: "",
    members: [
      {
        id: "m_lead", name: "负责人", duty: "拆分和派工", agents: [structuredAgent("claude")],
        agent: structuredAgent("claude"), isLeader: true,
      },
      worker,
      {
        id: "m_qa", name: "验收", duty: "跑测试", agents: [structuredAgent("pi")],
        agent: structuredAgent("pi"), isLeader: false,
      },
    ],
    requirePlanApproval: true, maxSteps: 30,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  storage.saveAiTeam(team);
  const task = storage.createWandTask({ title: "给 README 加安装说明", description: "写清楚 npm 安装" });
  const ops = new FakeOps();
  const chat = new FakeChat(ops);
  const clock = { now: Date.parse("2026-02-01T00:00:00.000Z") };
  const runner = new AiTeamRunner({
    storage, ops, chat, resolveCwd: () => cwd, now: () => clock.now, models: options.models,
  });
  t.after(() => runner.dispose());
  return { storage, ops, chat, runner, cwd, team, taskId: task.id, clock, models: options.models };
}

function runningStep(h: Harness, runId: string): AiTeamStep {
  const step = h.storage.listAiTeamSteps(runId).find((item) => item.status === "running");
  assert.ok(step, "expected a running step");
  return step;
}

/** 写报告文件并把 mtime 调到过去，跳过“文件稳定”等待。 */
function writeReport(h: Harness, step: AiTeamStep, content: string): void {
  const file = path.join(h.cwd, step.reportPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  const past = new Date(h.clock.now - 10_000);
  utimesSync(file, past, past);
}

async function settle(h: Harness, sessionId: string): Promise<void> {
  h.runner.ingest({ type: "status", sessionId });
  await h.runner.idle();
}

const assign = (steps: Array<[string, string]>, message = "计划") => JSON.stringify({
  action: "assign", message,
  steps: steps.map(([member, title]) => ({ member, title, instructions: `${title} 的具体要求` })),
});

async function startAndPlan(h: Harness, steps: Array<[string, string]>): Promise<string> {
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const leader = runningStep(h, detail.run.id);
  writeReport(h, leader, assign(steps));
  h.ops.finishTurn(leader.sessionId!);
  await settle(h, leader.sessionId!);
  return detail.run.id;
}

/** 带 after 的派工（序号从 1 开始，[]= 立刻开始，可并行）。 */
const assignRaw = (steps: Array<{ member: string; title: string; after?: number[] }>, message = "计划") => JSON.stringify({
  action: "assign", message,
  steps: steps.map((item) => ({
    member: item.member, title: item.title, instructions: `${item.title} 的具体要求`,
    ...(item.after ? { after: item.after } : {}),
  })),
});

async function startAndPlanRaw(h: Harness, steps: Parameters<typeof assignRaw>[0]): Promise<string> {
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const leader = runningStep(h, detail.run.id);
  writeReport(h, leader, assignRaw(steps));
  h.ops.finishTurn(leader.sessionId!);
  await settle(h, leader.sessionId!);
  return detail.run.id;
}

test("kickoff puts role and rules in the system prompt and only the goal in the first message", async (t) => {
  const h = harness(t);
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  assert.equal(h.ops.opened.length, 1);
  assert.equal(h.ops.opened[0]!.provider, "claude");
  const system = h.ops.opened[0]!.systemPrompt!;
  const message = h.ops.opened[0]!.prompt;
  for (const text of ["m_dev", "实现", "改代码", "m_qa", "验收", "跑测试", "回复方式", "after"]) {
    assert.ok(system.includes(text), `system prompt should mention ${text}`);
  }
  assert.ok(message.includes("给 README 加安装说明"), "message carries the objective");
  assert.ok(!message.includes("回复方式"), "rules must not be repeated in the user message");
  assert.ok(!message.includes("m_dev"), "roster must not be repeated in the user message");
  assert.equal(detail.run.status, "running");
  assert.equal(detail.steps[0]!.kind, "leader");
  assert.equal(h.storage.getWandTask(h.taskId)!.status, "doing");
});

test("a typed team assignment does not resend the task card description", async (t) => {
  const h = harness(t);
  const detail = await h.runner.start({
    teamId: h.team.id,
    taskId: h.taskId,
    note: "只改指派框里这句",
  });
  assert.equal(detail.run.objective.includes("写清楚 npm 安装"), false);
  assert.match(detail.run.objective, /只改指派框里这句/);
  assert.ok(h.ops.opened[0]!.prompt.includes("只改指派框里这句"));
  assert.equal(h.ops.opened[0]!.prompt.includes("写清楚 npm 安装"), false);
});

test("first plan waits for approval, then the first member is dispatched", async (t) => {
  const h = harness(t);
  const runId = await startAndPlan(h, [["m_dev", "改 README"], ["m_qa", "验收"]]);
  let detail = h.runner.detail(runId);
  assert.equal(detail.run.status, "awaiting_approval");
  assert.equal(detail.steps.filter((step) => step.status === "queued").length, 2);
  assert.equal(h.ops.opened.length, 1);

  detail = await h.runner.approve(runId);
  assert.equal(detail.run.status, "running");
  assert.equal(h.ops.opened.length, 2);
  assert.equal(h.ops.opened[1]!.provider, "codex");
  assert.ok(h.ops.opened[1]!.prompt.includes("改 README 的具体要求"));
});

test("leader may reply with JSON in the structured conversation instead of a file", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const leader = runningStep(h, detail.run.id);
  h.ops.finishTurn(leader.sessionId!, `好的，这是计划：\n\`\`\`json\n${assign([["实现", "改 README"]])}\n\`\`\``);
  await settle(h, leader.sessionId!);
  const after = h.runner.detail(detail.run.id);
  assert.equal(after.run.status, "running");
  assert.equal(h.ops.opened.length, 2, "member resolved by name and dispatched");
});

test("members run in order and their reports reach the leader as a handoff file", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const runId = await startAndPlan(h, [["m_dev", "改 README"], ["m_qa", "验收"]]);
  const dev = runningStep(h, runId);
  writeReport(h, dev, "状态: 完成\n改了 README.md");
  h.ops.finishTurn(dev.sessionId!);
  await settle(h, dev.sessionId!);

  const qa = runningStep(h, runId);
  assert.equal(qa.memberId, "m_qa");
  // 上游交接走文件：验收步骤的提示词只给路径，不贴实现那一步的报告正文。
  const qaPrompt = h.ops.sessions.get(qa.sessionId!)!.sent.at(-1)!;
  assert.ok(qaPrompt.includes(dev.reportPath), "上游报告文件路径进提示词");
  assert.ok(qaPrompt.includes(`handoff-${qa.seq}-work.md`), "上游交接文件路径进提示词");
  assert.ok(!qaPrompt.includes("改了 README.md"), "上游报告正文不进提示词");
  const qaHandoff = readFileSync(path.join(h.cwd, ".wand-team", runId, `handoff-${qa.seq}-work.md`), "utf8");
  assert.ok(qaHandoff.includes("改了 README.md"), "交接文件里有上游报告全文");

  h.ops.finishTurn(qa.sessionId!, "状态: 完成\n测试通过");
  await settle(h, qa.sessionId!);

  const leader = runningStep(h, runId);
  assert.equal(leader.kind, "leader");
  assert.equal(leader.sessionId, "s1", "leader session is reused");
  const followup = h.ops.sessions.get("s1")!.sent.at(-1)!;
  assert.ok(followup.includes(`handoff-${leader.seq}-leader.md`), "leader gets one handoff file to read");
  assert.ok(followup.includes(dev.reportPath) && followup.includes(qa.reportPath));
  assert.ok(!followup.includes("改了 README.md") && !followup.includes("测试通过"), "报告正文不进提示词");
  const handoff = readFileSync(path.join(h.cwd, ".wand-team", runId, `handoff-${leader.seq}-leader.md`), "utf8");
  assert.ok(handoff.includes("改了 README.md") && handoff.includes("测试通过"), "交接文件汇总两步报告");

  writeReport(h, leader, JSON.stringify({ action: "finish", message: "README 已更新并验收" }));
  h.ops.finishTurn(leader.sessionId!);
  await settle(h, leader.sessionId!);
  const detail = h.runner.detail(runId);
  assert.equal(detail.run.status, "done");
  assert.equal(detail.run.statusDetail, "README 已更新并验收");
  assert.equal(detail.run.stepsUsed, 4);
});

test("a member assigned twice continues in its existing session", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const runId = await startAndPlan(h, [["m_dev", "第一步"], ["m_dev", "第二步"]]);
  const first = runningStep(h, runId);
  h.ops.finishTurn(first.sessionId!, "状态: 完成");
  await settle(h, first.sessionId!);
  const second = runningStep(h, runId);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(h.ops.opened.length, 2);
  const text = h.ops.sessions.get(first.sessionId!)!.sent.at(-1)!;
  assert.ok(text.includes("第二步"));
  assert.ok(!text.includes("你的职责"), "follow-up prompt skips the identity preamble");
});

test("PTY members finish only via the report file or manual completion", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    worker: { provider: "qoder", model: "default", thinkingEffort: "off", mode: "full-access", kind: "pty" },
  });
  const runId = await startAndPlan(h, [["m_dev", "改 README"], ["m_dev", "再改一次"]]);
  const step = runningStep(h, runId);
  assert.equal(h.ops.ownerOf(step.sessionId!), "pty");
  h.ops.finishTurn(step.sessionId!, "我做完了");
  await settle(h, step.sessionId!);
  assert.equal(runningStep(h, runId).id, step.id, "a PTY reply alone does not finish the step");

  writeReport(h, step, "状态: 完成");
  await settle(h, step.sessionId!);
  const second = runningStep(h, runId);
  assert.notEqual(second.id, step.id);

  const detail = await h.runner.completeStep(runId, second.id, "");
  assert.equal(detail.steps.find((item) => item.id === second.id)!.report, "用户手动标记完成");
  assert.equal(runningStep(h, runId).kind, "leader");
});

test("a fresh report file waits until it stops changing", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const leader = runningStep(h, detail.run.id);
  const file = path.join(h.cwd, leader.reportPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "{\"action\":");
  h.clock.now = Date.now();
  h.ops.finishTurn(leader.sessionId!);
  await settle(h, leader.sessionId!);
  assert.equal(runningStep(h, detail.run.id).id, leader.id);
});

test("malformed leader replies are retried twice, then the run waits for the user", async (t) => {
  const h = harness(t);
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const leader = runningStep(h, detail.run.id);
    writeReport(h, leader, attempt === 1 ? assign([["m_nobody", "x"]]) : "不是 JSON");
    h.ops.finishTurn(leader.sessionId!);
    await settle(h, leader.sessionId!);
  }
  const after = h.runner.detail(detail.run.id);
  assert.equal(after.run.status, "waiting_user");
  assert.equal(after.run.statusDetail, "Leader 回复格式多次不正确");
  assert.equal(h.ops.opened.length, 1, "retries go to the same leader session");
  const sent = h.ops.sessions.get("s1")!.sent;
  assert.equal(sent.length, 3);
  assert.ok(sent[2]!.includes("m_nobody"), "the correction names the unknown member");
});

test("ask waits for the user; reply forwards the user's words to the leader", async (t) => {
  const h = harness(t);
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const leader = runningStep(h, detail.run.id);
  writeReport(h, leader, JSON.stringify({ action: "ask", message: "用中文还是英文？" }));
  h.ops.finishTurn(leader.sessionId!);
  await settle(h, leader.sessionId!);
  let after = h.runner.detail(detail.run.id);
  assert.equal(after.run.status, "waiting_user");
  assert.equal(after.run.statusDetail, "用中文还是英文？");
  await assert.rejects(h.runner.approve(detail.run.id), AiTeamConflictError);

  after = await h.runner.reply(detail.run.id, "中文");
  assert.equal(after.run.status, "running");
  assert.ok(h.ops.sessions.get("s1")!.sent.at(-1)!.includes("## 用户补充\n中文"));
});

test("reject skips the plan and asks the leader to re-plan; the new plan still needs approval", async (t) => {
  const h = harness(t);
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const after = await h.runner.reject(runId, "先写测试");
  assert.ok(after.steps.some((step) => step.status === "skipped"));
  const leader = runningStep(h, runId);
  assert.ok(h.ops.sessions.get(leader.sessionId!)!.sent.at(-1)!.includes("先写测试"));
  writeReport(h, leader, assign([["m_qa", "写测试"]]));
  h.ops.finishTurn(leader.sessionId!);
  await settle(h, leader.sessionId!);
  assert.equal(h.runner.detail(runId).run.status, "awaiting_approval");
});

test("the step limit pauses the run and continue extends it", async (t) => {
  const h = harness(t, { requirePlanApproval: false, maxSteps: 2 });
  const runId = await startAndPlan(h, [["m_dev", "一"], ["m_qa", "二"]]);
  const dev = runningStep(h, runId);
  h.ops.finishTurn(dev.sessionId!, "状态: 完成");
  await settle(h, dev.sessionId!);
  let detail = h.runner.detail(runId);
  assert.equal(detail.run.status, "waiting_user");
  assert.equal(detail.run.statusDetail, "已达到步数上限");

  detail = await h.runner.continueRun(runId, 10);
  assert.equal(detail.run.status, "running");
  assert.equal(detail.run.stepLimit, 12);
  assert.equal(runningStep(h, runId).memberId, "m_qa");
});

test("stop halts the running session and skips pending work", async (t) => {
  const h = harness(t);
  const runId = await startAndPlan(h, [["m_dev", "一"], ["m_qa", "二"]]);
  await h.runner.approve(runId);
  const dev = runningStep(h, runId);
  const detail = await h.runner.stop(runId);
  assert.equal(detail.run.status, "stopped");
  assert.deepEqual(h.ops.stopped, [dev.sessionId]);
  assert.deepEqual(detail.steps.slice(1).map((step) => step.status), ["skipped", "skipped"]);
  await assert.rejects(h.runner.stop(runId), AiTeamConflictError);
});

test("reconcile fails steps whose session vanished and hands back to the leader", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const runId = await startAndPlan(h, [["m_dev", "一"]]);
  const dev = runningStep(h, runId);
  h.ops.sessions.delete(dev.sessionId!);

  const restarted = new AiTeamRunner({ storage: h.storage, ops: h.ops, resolveCwd: () => h.cwd, now: () => h.clock.now });
  t.after(() => restarted.dispose());
  restarted.reconcile();
  await restarted.idle();
  const detail = restarted.detail(runId);
  assert.equal(detail.steps.find((step) => step.id === dev.id)!.status, "failed");
  assert.equal(detail.steps.at(-1)!.kind, "leader");
  assert.equal(detail.steps.at(-1)!.status, "running");
});

test("reconcile advances steps whose session finished while the server was down", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const runId = await startAndPlan(h, [["m_dev", "一"], ["m_qa", "二"]]);
  const dev = runningStep(h, runId);
  writeReport(h, dev, "状态: 完成");
  h.ops.finishTurn(dev.sessionId!);

  const restarted = new AiTeamRunner({ storage: h.storage, ops: h.ops, resolveCwd: () => h.cwd, now: () => h.clock.now });
  t.after(() => restarted.dispose());
  restarted.reconcile();
  await restarted.idle();
  assert.equal(runningStep(h, runId).memberId, "m_qa");
});

test("a task can only have one active team run", async (t) => {
  const h = harness(t);
  await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  await assert.rejects(h.runner.start({ teamId: h.team.id, taskId: h.taskId }), AiTeamConflictError);
});

test("a failed member step hands back to the leader with the failure", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const runId = await startAndPlan(h, [["m_dev", "一"], ["m_qa", "二"]]);
  const dev = runningStep(h, runId);
  h.ops.sessions.get(dev.sessionId!)!.status = "failed";
  await settle(h, dev.sessionId!);
  const detail = h.runner.detail(runId);
  assert.equal(detail.steps.find((step) => step.id === dev.id)!.status, "failed");
  assert.equal(detail.steps.find((step) => step.memberId === "m_qa")!.status, "skipped");
  assert.equal(runningStep(h, runId).kind, "leader");
  assert.ok(h.ops.sessions.get("s1")!.sent.at(-1)!.includes("失败"));
});

test("a lost leader session is replaced by a new one that carries the team context", async (t) => {
  const h = harness(t);
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const leader = runningStep(h, detail.run.id);
  h.ops.sessions.get(leader.sessionId!)!.status = "exited";
  await settle(h, leader.sessionId!);
  const retry = runningStep(h, detail.run.id);
  assert.equal(retry.kind, "leader");
  assert.notEqual(retry.sessionId, leader.sessionId);
  assert.equal(h.ops.opened.length, 2);
  assert.ok(h.ops.opened[1]!.systemPrompt!.includes("m_dev"), "the new leader session gets the roster again");
  assert.ok(h.ops.opened[1]!.prompt.includes("给 README 加安装说明"), "a fresh session gets the goal too");
  assert.ok(h.ops.opened[1]!.prompt.includes(retry.reportPath));
});

test("an error reply from a failed session is not taken as the member's report", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const runId = await startAndPlan(h, [["m_dev", "一"]]);
  const dev = runningStep(h, runId);
  h.ops.finishTurn(dev.sessionId!, "API Error: 503 No available accounts");
  h.ops.sessions.get(dev.sessionId!)!.status = "failed";
  await settle(h, dev.sessionId!);
  assert.equal(h.runner.detail(runId).steps.find((step) => step.id === dev.id)!.status, "failed");
});

test("independent steps for different members run in parallel; dependent steps wait", async (t) => {
  const h = harness(t, { requirePlanApproval: false, instructions: "先确认兼容性再动手" });
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  assert.match(h.ops.opened[0]!.systemPrompt!, /协作指令\n先确认兼容性再动手/);
  const leader = runningStep(h, detail.run.id);
  writeReport(h, leader, JSON.stringify({
    action: "assign", message: "并行",
    steps: [
      { member: "m_dev", title: "改前端", instructions: "a", after: [] },
      { member: "m_qa", title: "写测试", instructions: "b", after: [] },
      { member: "m_qa", title: "回归", instructions: "c", after: [1, 2] },
    ],
  }));
  h.ops.finishTurn(leader.sessionId!);
  await settle(h, leader.sessionId!);

  const running = () => h.storage.listAiTeamSteps(detail.run.id).filter((step) => step.status === "running");
  assert.deepEqual(running().map((step) => step.title), ["改前端", "写测试"]);
  const [front, tests] = running();

  // 验收先交差：回归还要等前端，不能开始。
  writeReport(h, tests!, "状态: 完成");
  h.ops.finishTurn(tests!.sessionId!);
  await settle(h, tests!.sessionId!);
  assert.deepEqual(running().map((step) => step.title), ["改前端"]);

  writeReport(h, front!, "状态: 完成");
  h.ops.finishTurn(front!.sessionId!);
  await settle(h, front!.sessionId!);
  assert.deepEqual(running().map((step) => step.title), ["回归"]);
  // 同一成员继续用原会话。
  assert.equal(running()[0]!.sessionId, tests!.sessionId);
});

test("a parallel failure waits for the other members before handing back to the leader", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const leader = runningStep(h, detail.run.id);
  writeReport(h, leader, JSON.stringify({
    action: "assign", message: "并行",
    steps: [
      { member: "m_dev", title: "甲", instructions: "a", after: [] },
      { member: "m_qa", title: "乙", instructions: "b", after: [] },
    ],
  }));
  h.ops.finishTurn(leader.sessionId!);
  await settle(h, leader.sessionId!);
  const [first, second] = h.storage.listAiTeamSteps(detail.run.id).filter((step) => step.status === "running");

  h.ops.sessions.get(first!.sessionId!)!.status = "failed";
  await settle(h, first!.sessionId!);
  const afterFail = h.storage.listAiTeamSteps(detail.run.id);
  assert.equal(afterFail.filter((step) => step.kind === "leader").length, 1, "leader waits for the other member");

  writeReport(h, second!, "状态: 完成\n乙做完了");
  h.ops.finishTurn(second!.sessionId!);
  await settle(h, second!.sessionId!);
  const next = runningStep(h, detail.run.id);
  assert.equal(next.kind, "leader");
  const followup = h.ops.sessions.get(leader.sessionId!)!.sent.at(-1)!;
  assert.match(followup, /甲 · 失败/);
  assert.match(followup, /第\d+步 · 验收 · 乙 · 完成/);
  const handoff = readFileSync(
    path.join(h.cwd, ".wand-team", detail.run.id, `handoff-${next.seq}-leader.md`),
    "utf8",
  );
  assert.match(handoff, /乙做完了/, "报告正文只在交接文件里");
  assert.ok(!followup.includes("乙做完了"), "提示词不再内联报告正文");
});

test("team run list carries the task title and filters by team and activity", async (t) => {
  const h = harness(t);
  await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const runs = h.runner.listRuns({ teamId: h.team.id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.taskTitle, "给 README 加安装说明");
  assert.equal(h.runner.listRuns({ teamId: "other" }).length, 0);
  assert.equal(h.runner.listRuns({ activeOnly: true }).length, 1);
});

test("a leader whose model errors out stops with the real error instead of format retries", async (t) => {
  const h = harness(t);
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const leader = runningStep(h, detail.run.id);
  const session = h.ops.sessions.get(leader.sessionId!)!;
  session.inFlight = false;
  session.status = "failed";
  session.lastError = "Codex error: The usage limit has been reached";
  await settle(h, leader.sessionId!);
  const after = h.runner.detail(detail.run.id);
  assert.equal(after.run.status, "waiting_user");
  assert.equal(after.run.statusDetail, "负责人出错：Codex error: The usage limit has been reached");
  assert.equal(after.run.formatRetries, 0);
  assert.equal(h.ops.opened.length, 1, "no retry is sent to the same failing model");
});

test("replying after the team changed a member's CLI picks up the new config in a new session", async (t) => {
  const h = harness(t);
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const leader = runningStep(h, detail.run.id);
  const session = h.ops.sessions.get(leader.sessionId!)!;
  session.inFlight = false;
  session.status = "failed";
  session.lastError = "usage limit";
  await settle(h, leader.sessionId!);
  h.storage.saveAiTeam({
    ...h.team,
    // v2 换了 CLI = 换候选列表（服务端保存时 agent 与 agents[0] 双写，测试手工保持一致）。
    members: h.team.members.map((member) => member.isLeader
      ? { ...member, agent: structuredAgent("pi"), agents: [structuredAgent("pi")] }
      : member),
  });
  await h.runner.reply(detail.run.id, "换了模型，继续");
  const retry = runningStep(h, detail.run.id);
  assert.notEqual(retry.sessionId, leader.sessionId);
  assert.equal(h.ops.opened.at(-1)!.provider, "pi");
  assert.ok(h.ops.opened.at(-1)!.prompt.includes("换了模型，继续"));
  assert.equal(h.runner.detail(detail.run.id).run.team.members.find((member) => member.isLeader)!.agent.provider, "pi");
});

test("a team run posts its plan, dispatches and reports into one group chat", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const runId = await startAndPlan(h, [["m_dev", "写代码"]]);
  const chatId = h.runner.detail(runId).run.chatSessionId!;
  assert.ok(chatId);
  const dev = runningStep(h, runId);
  writeReport(h, dev, "改好了");
  h.ops.finishTurn(dev.sessionId!);
  await settle(h, dev.sessionId!);
  const lines = h.chat.lines(chatId);
  assert.match(lines[0]!, /^用户: 给 README 加安装说明/);
  assert.match(lines[1]!, /^·: 团队「测试团队」接手了这个任务：负责人（负责人）、实现、验收/);
  assert.match(lines[2]!, /^负责人: 计划\n\n1\. \*\*@实现\*\* 写代码/);
  assert.equal(lines[3], "·实现: 实现 开始「写代码」");
  assert.equal(lines[4], "实现: ✅ 完成「写代码」\n\n改好了");
  const report = h.chat.turns.get(chatId)![4]!;
  assert.equal(report.author?.sessionId, dev.sessionId);
  assert.equal(report.author?.provider, "codex");
});

test("group chat replies approve, revise, queue notes, and restart finished runs", async (t) => {
  const h = harness(t);
  const runId = await startAndPlan(h, [["m_dev", "写代码"]]);
  const chatId = h.runner.detail(runId).run.chatSessionId!;
  assert.equal(h.runner.detail(runId).run.status, "awaiting_approval");
  assert.ok(h.chat.lines(chatId).includes("·: 等你批准计划：回复「批准」开始执行，或者直接写修改意见。"));

  // 不是批准类短语：当修改意见退回，负责人重新安排。
  await h.runner.chatInput(chatId, "先别动 README，只改文档站");
  const leader = runningStep(h, runId);
  assert.equal(leader.kind, "leader");
  assert.ok(h.ops.sessions.get(leader.sessionId!)!.sent.at(-1)!.includes("先别动 README，只改文档站"));
  writeReport(h, leader, assign([["m_dev", "改文档站"]]));
  h.ops.finishTurn(leader.sessionId!);
  await settle(h, leader.sessionId!);

  await h.runner.chatInput(chatId, "批准");
  const dev = runningStep(h, runId);
  assert.equal(dev.title, "改文档站");

  // 成员干活时说的话记下来，负责人下一轮一起看到。
  await h.runner.chatInput(chatId, "记得补截图");
  assert.deepEqual(h.runner.detail(runId).run.pendingNotes, ["记得补截图"]);
  writeReport(h, dev, "改好了");
  h.ops.finishTurn(dev.sessionId!);
  await settle(h, dev.sessionId!);
  const next = runningStep(h, runId);
  assert.ok(h.ops.sessions.get(next.sessionId!)!.sent.at(-1)!.includes("记得补截图"));
  assert.deepEqual(h.runner.detail(runId).run.pendingNotes, []);

  writeReport(h, next, JSON.stringify({ action: "finish", message: "都做完了" }));
  h.ops.finishTurn(next.sessionId!);
  await settle(h, next.sessionId!);
  assert.equal(h.runner.detail(runId).run.status, "done");

  // 结束后在群里说话：同一个群聊接着开一轮新的。
  await h.runner.chatInput(chatId, "再加一段 FAQ");
  const runs = h.runner.listForTask(h.taskId);
  assert.equal(runs.length, 2);
  const again = runs.find((run) => run.id !== runId)!;
  assert.equal(again.chatSessionId, chatId);
  assert.match(again.objective, /再加一段 FAQ/);
  assert.equal(again.objective.includes("写清楚 npm 安装"), false, "a new assignment does not resend the card description");
  assert.equal(h.chat.lines(chatId).filter((line) => line.startsWith("用户: 再加一段 FAQ")).length, 0,
    "the chat already shows what the user typed; the runner does not echo it");
});

test("a follow-up in the same group chat hands the earlier rounds to the new leader and members", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const chatId = h.runner.detail(runId).run.chatSessionId!;
  const dev = runningStep(h, runId);
  writeReport(h, dev, "状态: 完成\nREADME.md 顶部加了 npm 安装说明");
  h.ops.finishTurn(dev.sessionId!);
  await settle(h, dev.sessionId!);
  const finisher = runningStep(h, runId);
  writeReport(h, finisher, JSON.stringify({ action: "finish", message: "都做完了" }));
  h.ops.finishTurn(finisher.sessionId!);
  await settle(h, finisher.sessionId!);
  assert.equal(h.runner.detail(runId).run.status, "done");
  assert.ok(!h.ops.opened[0]!.prompt.includes("chat-history"), "第一轮没有群聊历史可接");

  // relay 会话在转给 runner 之前已经落下用户这句（structured-session-manager.sendMessage）。
  h.chat.post(chatId, [{ role: "user", content: [{ type: "text", text: "安装命令换成 pnpm" }] }]);
  await h.runner.chatInput(chatId, "安装命令换成 pnpm");

  const again = h.runner.listForTask(h.taskId).find((run) => run.id !== runId)!;
  const historyPath = `.wand-team/${again.id}/chat-history.md`;
  const lead = runningStep(h, again.id);
  const leadOpened = h.ops.opened.find((item) => item.sessionId === lead.sessionId)!;
  assert.ok(leadOpened.prompt.includes(historyPath), "新负责人一上来就拿到续跑文件");
  assert.match(leadOpened.prompt, /已经做完的不要重做/);
  const file = readFileSync(path.join(h.cwd, historyPath), "utf8");
  assert.match(file, /第2步 · 实现 · 改 README · 完成/, "上一轮的步骤与结局写进摘要");
  assert.match(file, /README\.md 顶部加了 npm 安装说明/, "上一轮的报告正文留在群聊原文里");
  assert.match(file, /都做完了/);
  assert.match(file, /安装命令换成 pnpm/);
  assert.equal(file.split("接手了这个任务").length - 1, 1, "历史只收上一轮，不带新运行自己的接手 notice");
  assert.ok(!file.includes("接着这个群聊里上一轮的进度继续"), "新运行的续跑 notice 也不进历史");
  assert.ok(h.chat.lines(chatId).some((line) => line.startsWith("·: 接着这个群聊里上一轮的进度继续")),
    "群里看得出这是接着上一轮往下走");

  // 成员这一次也是新会话，同样先从续跑文件读上一轮的状态。
  writeReport(h, lead, assign([["m_dev", "换成 pnpm"]]));
  h.ops.finishTurn(lead.sessionId!);
  await settle(h, lead.sessionId!);
  const work = runningStep(h, again.id);
  const workOpened = h.ops.opened.find((item) => item.sessionId === work.sessionId)!;
  assert.ok(workOpened.prompt.includes(historyPath));
  assert.match(workOpened.prompt, /本群聊历史/);
});

test("replies from the run panel are echoed into the group chat", async (t) => {
  const h = harness(t);
  const runId = await startAndPlan(h, [["m_dev", "写代码"]]);
  const chatId = h.runner.detail(runId).run.chatSessionId!;
  await h.runner.approve(runId);
  assert.ok(h.chat.lines(chatId).includes("用户: 批准"));
});

// ── T3 候选降级 ──

const candidate = (
  provider: WandTaskAgent["provider"],
  model = "default",
  kind: WandTaskAgent["kind"] = "structured",
): WandTaskAgent => ({ provider, model, thinkingEffort: "off", mode: "full-access", kind });

const ENOENT = "codex exec ENOENT: spawn codex ENOENT";

test("[T3] a spawn-missing first candidate degrades into a new step without costing a step", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "broken"), candidate("opencode")],
  });
  h.ops.openFailure = (agent) => agent.provider === "codex" ? ENOENT : null;
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);

  const steps = h.runner.detail(runId).steps;
  const skipped = steps.filter((step) => step.status === "skipped");
  assert.equal(skipped.length, 1, "旧候选留痕成 skipped 步");
  assert.match(skipped[0]!.report, /候选 1 不可用/);
  assert.match(skipped[0]!.report, /ENOENT/);

  const running = runningStep(h, runId);
  assert.equal(running.kind, "work");
  assert.equal(running.memberId, "m_dev");
  assert.equal(running.title, "改 README");
  assert.notEqual(running.reportPath, skipped[0]!.reportPath, "新候选写自己的报告文件");
  assert.equal(h.ops.opened.at(-1)!.provider, "opencode");
  assert.equal(h.ops.opened.length, 2, "同成员只有一个会话，没有第二个旧候选会话");
  assert.equal(h.runner.detail(runId).run.stepsUsed, 1, "降级步不占 stepsUsed");
});

test("[T3] a provider blacklisted by spawn-missing is skipped without another attempt", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "one"), candidate("codex", "two"), candidate("opencode")],
  });
  h.ops.openFailure = (agent) => agent.provider === "codex" ? ENOENT : null;
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);

  assert.equal(h.ops.attempts.filter((item) => item.provider === "codex").length, 1,
    "第二个 codex 候选连会话都不起");
  const steps = h.runner.detail(runId).steps;
  assert.equal(steps.filter((step) => step.status === "skipped").length, 2, "每个跳过的候选都留痕");
  assert.equal(h.ops.opened.length, 2);
  assert.equal(h.ops.opened.at(-1)!.provider, "opencode");
});

test("[T3] the last candidate failing hands a single failed step back to the leader", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "one"), candidate("codex", "two")],
  });
  h.ops.openFailure = (agent) => agent.provider === "codex" ? ENOENT : null;
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  await settle(h, h.runner.detail(runId).run.chatSessionId!);

  const steps = h.runner.detail(runId).steps;
  const failed = steps.filter((step) => step.status === "failed");
  assert.equal(failed.length, 1);
  assert.match(failed[0]!.report, /所有候选均不可用/);
  assert.match(failed[0]!.report, /候选 1/);
  assert.match(failed[0]!.report, /候选 2/);
  assert.equal(runningStep(h, runId).kind, "leader", "耗尽后交回 Leader，不另设 waiting_user 捷径");
});

test("[T3] degraded steps keep their dependents pointed at the replacement step", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "broken"), candidate("opencode")],
  });
  h.ops.openFailure = (agent) => agent.provider === "codex" ? ENOENT : null;
  const runId = await startAndPlanRaw(h, [
    { member: "m_dev", title: "实现", after: [] },
    { member: "m_qa", title: "验收", after: [1] },
    { member: "m_qa", title: "复验", after: [1] },
  ]);

  // 重指向必须真的落在库里：detail() 是内存快照，listAiTeamSteps 走一次 SELECT。
  const steps = h.storage.listAiTeamSteps(runId);
  const old = steps.find((step) => step.status === "skipped")!;
  const replacement = steps.find((step) => step.status === "running" && step.kind === "work")!;
  assert.notEqual(old.id, replacement.id);
  assert.equal(replacement.dispatchInfo?.usedCandidate, 1, "新步从候选 2 继续，不回退到首选");
  const dependents = steps.filter((step) => step.memberId === "m_qa");
  assert.equal(dependents.length, 2, "同轮排队步没有被 startLeaderRound 批量作废");
  for (const dependent of dependents) {
    assert.equal(dependent.status, "queued");
    assert.deepEqual(dependent.dependsOn, [replacement.id], "依赖重指向新步");
  }
  assert.equal(h.ops.opened.filter((item) => item.provider === "pi").length, 0);

  writeReport(h, replacement, "状态: 完成\n改好了");
  h.ops.finishTurn(replacement.sessionId!);
  await settle(h, replacement.sessionId!);
  const after = h.storage.listAiTeamSteps(runId);
  assert.equal(after.filter((step) => step.memberId === "m_qa" && step.status === "running").length, 1,
    "新候选做完后验收步照常派出");
});

test("[T3] degrading inside the dispatch loop does not double-dispatch parallel steps", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "broken"), candidate("opencode")],
  });
  h.ops.openFailure = (agent) => agent.provider === "codex" ? ENOENT : null;
  const runId = await startAndPlanRaw(h, [
    { member: "m_dev", title: "实现", after: [] },
    { member: "m_qa", title: "验收", after: [] },
  ]);

  assert.equal(h.ops.opened.length, 3, "Leader + 降级后的实现 + 验收，各一次");
  assert.equal(h.ops.opened.filter((item) => item.provider === "opencode").length, 1);
  assert.equal(h.ops.opened.filter((item) => item.provider === "pi").length, 1);
  const running = h.runner.detail(runId).steps.filter((step) => step.status === "running");
  assert.equal(running.length, 2);
  assert.deepEqual(running.map((step) => step.memberId).sort(), ["m_dev", "m_qa"]);
});

test("[T3] only failures inside the startup window degrade; later ones go back to the leader", async (t) => {
  const inside = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex"), candidate("opencode")],
  });
  const insideRun = await startAndPlan(inside, [["m_dev", "改 README"]]);
  const dead = runningStep(inside, insideRun);
  Object.assign(inside.ops.sessions.get(dead.sessionId!)!, { status: "failed", inFlight: false, lastError: null });
  inside.clock.now += 10_000;
  await settle(inside, dead.sessionId!);
  assert.equal(inside.ops.opened.at(-1)!.provider, "opencode", "窗口内无输出即降级下一候选");
  assert.equal(inside.runner.detail(insideRun).steps.find((step) => step.id === dead.id)!.status, "skipped");
  assert.match(inside.runner.detail(insideRun).steps.find((step) => step.id === dead.id)!.report, /候选 1 不可用/);

  const outside = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex"), candidate("opencode")],
  });
  const outsideRun = await startAndPlan(outside, [["m_dev", "改 README"]]);
  const stale = runningStep(outside, outsideRun);
  Object.assign(outside.ops.sessions.get(stale.sessionId!)!, { status: "failed", inFlight: false, lastError: null });
  outside.clock.now += 60_000;
  await settle(outside, stale.sessionId!);
  assert.equal(outside.ops.opened.length, 2, "窗口外按 runtime-failure 处理，不换候选");
  assert.equal(outside.runner.detail(outsideRun).steps.find((step) => step.id === stale.id)!.status, "failed");
  assert.equal(runningStep(outside, outsideRun).kind, "leader");
});

test("[T3] a session that already produced output never degrades", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex"), candidate("opencode")],
  });
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const step = runningStep(h, runId);
  h.ops.finishTurn(step.sessionId!, "我先看一眼代码");
  const session = h.ops.sessions.get(step.sessionId!)!;
  session.status = "failed";
  session.inFlight = false;
  session.lastError = "503 upstream unavailable";
  await settle(h, step.sessionId!);
  assert.equal(h.ops.opened.length, 2);
  assert.equal(h.runner.detail(runId).steps.find((item) => item.id === step.id)!.status, "failed");
});

test("[T3] PTY candidates keep the v1 behaviour on async failures", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("qoder", "default", "pty"), candidate("codex")],
  });
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const step = runningStep(h, runId);
  assert.equal(h.ops.ownerOf(step.sessionId!), "pty");
  Object.assign(h.ops.sessions.get(step.sessionId!)!, { status: "failed", inFlight: false, lastError: null });
  h.clock.now += 1_000;
  await settle(h, step.sessionId!);
  assert.equal(h.ops.opened.length, 2, "PTY 的异步失败不分类、不降级");
  assert.equal(h.runner.detail(runId).steps.find((item) => item.id === step.id)!.status, "failed");
});

test("[T3] host-disabled ends degrading for that kind instead of being swallowed", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "one"), candidate("codex", "two")],
  });
  h.ops.openFailure = (agent) => agent.provider === "codex" ? "当前服务未启用结构化会话，无法派发 Agent。" : null;
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);

  const first = h.runner.detail(runId).steps.find((step) => step.kind === "work")!;
  assert.equal(first.status, "failed", "host-disabled 不开降级新步");
  assert.match(first.report, /未启用结构化会话/);
  assert.equal(h.ops.attempts.filter((item) => item.provider === "codex").length, 1,
    "第二个同 kind 候选不再尝试");

  // Leader 再派一次同成员：事前就发现该 kind 全被封掉，直接给出原因，不起会话。
  const leader = runningStep(h, runId);
  writeReport(h, leader, assign([["m_dev", "再来一次"]]));
  h.ops.finishTurn(leader.sessionId!);
  await settle(h, leader.sessionId!);
  await h.runner.approve(runId).catch(() => undefined);
  const steps = h.runner.detail(runId).steps;
  const second = steps.filter((step) => step.kind === "work").at(-1)!;
  assert.equal(second.status, "failed");
  assert.match(second.report, /所有候选均不可用/);
  assert.equal(h.ops.opened.length, 1, "整个 run 停止降级");
});

test("[T3] a model missing from a ready catalog is skipped before dispatch, with a paper trail", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "ghost-model"), candidate("opencode")],
    models: (provider) => provider === "codex" ? ["real-model", "another-model"] : [],
  });
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);

  assert.equal(h.ops.opened.some((item) => item.provider === "codex"), false, "省掉一次注定失败的启动");
  const steps = h.runner.detail(runId).steps;
  const skipped = steps.find((step) => step.status === "skipped")!;
  assert.match(skipped.report, /候选 1 不可用/);
  assert.match(skipped.report, /ghost-model/);
  assert.equal(runningStep(h, runId).kind, "work");
  assert.equal(h.ops.opened.at(-1)!.provider, "opencode");
  const chatId = h.runner.detail(runId).run.chatSessionId!;
  assert.ok(h.chat.lines(chatId).some((line) => line.includes("开始「改 README」")), "群聊看得到新候选开工");
});

test("[T3] an unknown model with no ready catalog is dispatched anyway", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "ghost-model"), candidate("opencode")],
    models: () => [],
  });
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  assert.equal(h.ops.opened.at(-1)!.provider, "codex", "冷启动拿不准就放行");
  assert.equal(h.runner.detail(runId).steps.filter((step) => step.status === "skipped").length, 0);
});

test("[T3] stop and reject never trigger candidate degradation", async (t) => {
  const stopped = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex"), candidate("opencode")],
  });
  const stoppedRun = await startAndPlan(stopped, [["m_dev", "改 README"], ["m_qa", "验收"]]);
  const dead = runningStep(stopped, stoppedRun);
  Object.assign(stopped.ops.sessions.get(dead.sessionId!)!, { status: "stopped", inFlight: false, lastError: null });
  await settle(stopped, dead.sessionId!);
  assert.equal(stopped.ops.opened.length, 2, "用户停止的会话不换候选");
  assert.equal(stopped.runner.detail(stoppedRun).steps.find((step) => step.id === dead.id)!.status, "failed");

  const rejected = harness(t, {}, { workerAgents: [candidate("codex"), candidate("opencode")] });
  const rejectedRun = await startAndPlan(rejected, [["m_dev", "改 README"]]);
  await rejected.runner.reject(rejectedRun, "先别动 README");
  assert.equal(rejected.ops.opened.length, 1, "驳回只重排计划，不产生降级步");
  assert.equal(rejected.runner.detail(rejectedRun).steps.filter((step) => step.status === "skipped"
    && step.report.includes("不可用")).length, 0);
});

/** 已开过计划的运行再要一轮派工（Leader 会话复用，写第二份计划）。 */
async function planMore(h: Harness, runId: string, steps: Parameters<typeof assignRaw>[0]): Promise<void> {
  const leader = runningStep(h, runId);
  assert.equal(leader.kind, "leader");
  writeReport(h, leader, assignRaw(steps));
  h.ops.finishTurn(leader.sessionId!);
  await settle(h, leader.sessionId!);
}

test("[T3] degrading stops the previous session and a throwing stop does not wedge the run", async (t) => {
  for (const stopThrows of [false, true]) {
    const h = harness(t, { requirePlanApproval: false }, {
      workerAgents: [candidate("codex", "broken"), candidate("opencode"), candidate("grok")],
    });
    h.ops.stopThrows = stopThrows;
    h.ops.openFailure = (agent) => agent.provider === "codex" ? ENOENT : null;
    const runId = await startAndPlan(h, [["m_dev", "第一次"]]);
    const first = runningStep(h, runId);
    assert.equal(h.ops.opened.find((item) => item.sessionId === first.sessionId)!.provider, "opencode");
    writeReport(h, first, "状态: 完成");
    h.ops.finishTurn(first.sessionId!);
    await settle(h, first.sessionId!);

    // 首选已被拉黑 → 事前降到候选 2 → 复用同一个会话 → 发送时 ENOENT → 再降一级。
    h.ops.sendFailure = ENOENT;
    await planMore(h, runId, [{ member: "m_dev", title: "第二次", after: [] }]);

    assert.deepEqual(h.ops.stopped, [first.sessionId!], "安全阀：旧会话先停掉");
    const steps = h.runner.detail(runId).steps;
    const skipped = steps.filter((step) => step.title === "第二次" && step.status === "skipped");
    assert.equal(skipped.length, 2, `stop 抛错（${stopThrows}）也要完成两步记账`);
    assert.match(skipped.at(-1)!.report, /候选 2 不可用/);
    const running = runningStep(h, runId);
    assert.equal(running.title, "第二次");
    assert.equal(h.ops.opened.find((item) => item.sessionId === running.sessionId)!.provider, "grok");
    assert.equal(h.runner.detail(runId).run.status, "running");
  }
});

test("[T3] a degraded member's next step reuses the session of its actual candidate", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "broken"), candidate("opencode")],
  });
  h.ops.openFailure = (agent) => agent.provider === "codex" ? ENOENT : null;
  const runId = await startAndPlan(h, [["m_dev", "第一次"]]);
  const first = runningStep(h, runId);
  assert.equal(h.ops.opened.find((item) => item.sessionId === first.sessionId)!.provider, "opencode");

  writeReport(h, first, "状态: 完成");
  h.ops.finishTurn(first.sessionId!);
  await settle(h, first.sessionId!);
  await planMore(h, runId, [{ member: "m_dev", title: "第二次", after: [] }]);

  const steps = h.runner.detail(runId).steps;
  assert.ok(steps.some((step) => step.title === "第二次" && step.status === "skipped"), "首选仍留痕");
  const running = runningStep(h, runId);
  assert.equal(running.sessionId, first.sessionId, "复用实际候选的活会话，不另开一个 CLI");
  assert.equal(h.ops.attempts.filter((item) => item.provider === "opencode").length, 1);
});

/**
 * 模拟服务重启：丢掉进程内 runner，只留同一份 SQLite + 同一批 FakeOps 会话 + 同一时钟，
 * 再 new 一个 AiTeamRunner 走启动路径 reconcile()。降级链的真源必须在库里，不在内存里。
 */
function restart(h: Harness, t: TestContext): AiTeamRunner {
  h.runner.dispose();
  const runner = new AiTeamRunner({
    storage: h.storage, ops: h.ops, chat: h.chat, resolveCwd: () => h.cwd,
    now: () => h.clock.now, models: h.models,
  });
  t.after(() => runner.dispose());
  h.runner = runner;
  runner.reconcile();
  return runner;
}

test("[T3] a restart mid-chain keeps the provider blacklist and continues the used candidate", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "broken"), candidate("opencode"), candidate("grok")],
  });
  h.ops.openFailure = (agent) => agent.provider === "codex" ? ENOENT : null;
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const degraded = runningStep(h, runId);
  assert.equal(h.ops.opened.find((item) => item.sessionId === degraded.sessionId)!.provider, "opencode");
  assert.equal(degraded.dispatchInfo?.usedCandidate, 1, "候选 2 的留痕先落库");

  const restarted = restart(h, t);
  await restarted.idle();
  assert.equal(h.ops.attempts.length, 3, "reconcile 接回活会话，不重开候选");

  Object.assign(h.ops.sessions.get(degraded.sessionId!)!, { status: "failed", inFlight: false, lastError: null });
  await settle(h, degraded.sessionId!);

  const steps = h.storage.listAiTeamSteps(runId);
  const running = steps.find((step) => step.status === "running" && step.kind === "work")!;
  assert.equal(running.dispatchInfo?.usedCandidate, 2, "续接候选 3，重启后不回退到候选 1");
  assert.deepEqual(
    running.dispatchInfo?.skipped.map((item) => [item.candidate, item.agent.provider, item.errorKind]),
    [[0, "codex", "spawn-missing"], [1, "opencode", "startup-timeout"]],
    "跳过链在库里累加，不是新链",
  );
  assert.equal(h.ops.attempts.filter((item) => item.provider === "codex").length, 1,
    "已拉黑的 provider 重启后仍不起会话");
  assert.equal(h.ops.opened.find((item) => item.sessionId === running.sessionId)!.provider, "grok");
});

test("[T3] startup-timeout strikes survive a restart and keep counting toward the tuple blacklist", async (t) => {
  const slow = candidate("codex", "slow");
  const key = agentKey(slow);
  const h = harness(t, { requirePlanApproval: false }, { workerAgents: [slow, candidate("opencode")] });
  const runId = await startAndPlan(h, [["m_dev", "第一次"]]);
  const first = runningStep(h, runId);
  Object.assign(h.ops.sessions.get(first.sessionId!)!, { status: "failed", inFlight: false, lastError: null });
  await settle(h, first.sessionId!);
  assert.equal(h.storage.getAiTeamRunState(runId).strikes[key], 1, "一次启动超时记一击，落在 run_state_json");

  // 重启发生在降级链中途：候选 2 还在干活，新 runner 接回来后让它做完再排第二轮。
  restart(h, t);
  const rescued = runningStep(h, runId);
  assert.equal(rescued.dispatchInfo?.usedCandidate, 1, "重启后新 runner 从库里读到候选 2");
  writeReport(h, rescued, "状态: 完成");
  h.ops.finishTurn(rescued.sessionId!);
  await settle(h, rescued.sessionId!);
  await planMore(h, runId, [{ member: "m_dev", title: "第二次", after: [] }]);

  const again = runningStep(h, runId);
  assert.equal(again.dispatchInfo, undefined, "一击还没拉黑：新一轮的首步没有留痕，仍从首选开始");
  Object.assign(h.ops.sessions.get(again.sessionId!)!, { status: "failed", inFlight: false, lastError: null });
  await settle(h, again.sessionId!);

  const state = h.storage.getAiTeamRunState(runId);
  assert.equal(state.strikes[key], 2, "重启后 strikes 接着累计，不清零");
  assert.deepEqual(state.agents, [{ key, kind: "startup-timeout" }], "满两击按五元组拉黑");
  const running = h.storage.listAiTeamSteps(runId).find((step) => step.status === "running" && step.kind === "work")!;
  assert.equal(running.dispatchInfo?.usedCandidate, 1);
  assert.equal(h.ops.opened.find((item) => item.sessionId === running.sessionId)!.provider, "opencode");
  assert.deepEqual(state.providers, [], "startup-timeout 不连坐整个 provider");
});

// ── T3b 可观测性与署名 ──

/** 取一条发言的纯文本（本套件的 turn 都只有 text block）。 */
function turnText(turn: ConversationTurn): string {
  return turn.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

const notices = (h: Harness, chatId: string): string[] =>
  h.chat.lines(chatId).filter((line) => line.startsWith("·"));

test("[T3b] each degradation posts one group-chat notice naming the member and the new candidate", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "broken"), candidate("opencode"), candidate("grok")],
  });
  const longReason = `codex exec ENOENT: ${"E".repeat(200)}${"T".repeat(400)}`;
  h.ops.openFailure = (agent) => agent.provider === "codex" ? longReason : null;
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const chatId = h.runner.detail(runId).run.chatSessionId!;

  const degrade = notices(h, chatId).filter((line) => line.includes("首选配置不可用"));
  assert.equal(degrade.length, 1, "一次降级一行，不重复刷屏");
  assert.match(degrade[0]!, /实现 的首选配置不可用/);
  assert.match(degrade[0]!, /已切换到候选 2/);
  assert.ok(degrade[0]!.includes(" … "), "超长失败原因走头尾截断");
  assert.ok(degrade[0]!.length < longReason.length, `整行不跟随原文膨胀：${degrade[0]!.length}`);
  assert.ok(!degrade[0]!.includes("T".repeat(241)), "尾部只保留 240 字");

  // detail().steps 原样带出库里的 dispatchInfo（§4.4），无留痕的步骤不凭空造。
  const steps = h.runner.detail(runId).steps;
  assert.equal(steps.find((step) => step.kind === "leader")!.dispatchInfo, undefined);
  assert.equal(steps.find((step) => step.status === "skipped")!.dispatchInfo?.usedCandidate, 0);
  assert.equal(runningStep(h, runId).dispatchInfo?.usedCandidate, 1);
});

test("[T3b] a candidate skipped before dispatch also gets its notice", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "ghost-model"), candidate("opencode")],
    models: (provider) => (provider === "codex" ? ["real-model"] : []),
  });
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const chatId = h.runner.detail(runId).run.chatSessionId!;
  const degrade = notices(h, chatId).filter((line) => line.includes("首选配置不可用"));
  assert.equal(degrade.length, 1);
  assert.match(degrade[0]!, /ghost-model/);
  assert.match(degrade[0]!, /已切换到候选 2/);
});

test("[T3b] group chat signing follows the candidate actually used, not the preferred one", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "broken"), candidate("opencode")],
  });
  h.ops.openFailure = (agent) => agent.provider === "codex" ? ENOENT : null;
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const chatId = h.runner.detail(runId).run.chatSessionId!;

  const work = runningStep(h, runId);
  assert.equal(h.ops.opened.find((item) => item.sessionId === work.sessionId)!.provider, "opencode");
  writeReport(h, work, "状态: 完成");
  h.ops.finishTurn(work.sessionId!);
  await settle(h, work.sessionId!);

  const turns = h.chat.turns.get(chatId)!;
  const done = turns.find((turn) => turnText(turn).includes("✅ 完成"))!;
  assert.equal(done.author?.provider, "opencode", "完成发言署实际候选，不是首选 codex");
  const degradeLine = turns.filter((turn) => turn.notice && turnText(turn).includes("首选配置不可用"));
  assert.equal(degradeLine.length, 1);
  assert.equal(degradeLine[0]!.author?.provider, "opencode", "降级行署切过去的新候选");
  const starts = turns.filter((turn) => turnText(turn).includes("开始「改 README」"));
  assert.equal(starts[0]!.author?.provider, "codex", "第一次开工确实用的首选");
  assert.equal(starts[starts.length - 1]!.author?.provider, "opencode", "降级后的开工行跟着换候选");
  const leaderTurn = turns.find((turn) => turn.author?.leader === true)!;
  assert.equal(leaderTurn.author?.provider, "claude", "Leader 没有步骤候选可取，回退首选");
});

test("[T3b] verifying a member who already implemented only warns and never blocks the dispatch", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const team = h.storage.getAiTeam(h.team.id)!;
  team.members.find((member) => member.id === "m_dev")!.role = "verify";
  h.storage.saveAiTeam(team);

  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const work = runningStep(h, runId);
  writeReport(h, work, "状态: 完成");
  h.ops.finishTurn(work.sessionId!);
  await settle(h, work.sessionId!);
  const chatId = h.runner.detail(runId).run.chatSessionId!;
  assert.equal(notices(h, chatId).filter((line) => line.includes("既做过实现")).length, 0,
    "还没被派验收时不该有提示");

  await planMore(h, runId, [{ member: "m_dev", title: "验收改动", after: [] }]);
  const warn = notices(h, chatId).filter((line) => line.includes("既做过实现"));
  assert.equal(warn.length, 1, "同一次派工对同一成员只提示一次");
  assert.match(warn[0]!, /「实现」既做过实现又被安排验收/);
  const running = runningStep(h, runId);
  assert.equal(running.title, "验收改动");
  assert.equal(running.status, "running", "服务端不做职责硬校验，照常派发");
});

test("[T3b] detail() returns the latest 200 relay turns and an empty list for legacy runs", async (t) => {
  const h = harness(t);
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const runId = detail.run.id;
  const chatId = detail.run.chatSessionId!;
  const messages: ConversationTurn[] = Array.from({ length: 250 }, (_, index) => ({
    role: "assistant",
    content: [{ type: "text", text: `第 ${index + 1} 条` }],
  }));
  h.ops.sessions.set(chatId, {
    id: chatId, owner: "structured", status: "running", inFlight: false,
    messages, sent: [], provider: "claude", lastError: null,
  });

  const turns = h.runner.detail(runId).chatTurns;
  assert.equal(turns.length, AI_TEAM_DETAIL_CHAT_TURNS);
  assert.equal(turnText(turns[0]!), "第 51 条");
  assert.equal(turnText(turns[turns.length - 1]!), "第 250 条");

  const run = h.storage.getAiTeamRun(runId)!;
  run.chatSessionId = null;
  h.storage.saveAiTeamRun(run);
  assert.deepEqual(h.runner.detail(runId).chatTurns, [], "没有群聊会话的旧运行给空数组");
});

// ── T3b 返工：降级原因脱敏（§4.5）──

test("[T3b] the degrade reason reaching notice, report and dispatch_info_json carries no paths or credentials", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "broken"), candidate("opencode")],
  });
  const configDir = h.storage.directory();
  const home = os.homedir();
  const secret = "sk-ABCDEFGHIJKLMNOPQRSTUVWX1234";
  const connectionCode = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
  const noisy = `codex exec ENOENT: spawn codex ENOENT`
    + ` cwd=/Users/someone/.wand/sessions/s3/logs`
    + ` config=${configDir}/config.json db=${home}/.wand/wand.db`
    + ` token=${secret} code=${connectionCode}`;
  h.ops.openFailure = (agent) => (agent.provider === "codex" ? noisy : null);
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const chatId = h.runner.detail(runId).run.chatSessionId!;

  const skipped = h.runner.detail(runId).steps.find((step) => step.status === "skipped")!;
  const flows: Record<string, string> = {
    notice: notices(h, chatId).find((line) => line.includes("首选配置不可用"))!,
    report: skipped.report,
    dispatchInfo: skipped.dispatchInfo!.skipped[0]!.reason,
  };
  assert.ok(Object.values(flows).every(Boolean), "三条流都要有内容");
  for (const [name, text] of Object.entries(flows)) {
    assert.ok(!text.includes("/Users/someone"), `${name}：他人 home 绝对路径已收掉`);
    assert.ok(!text.includes(home), `${name}：本机 home 绝对路径已收掉`);
    assert.ok(!text.includes(configDir), `${name}：激活配置目录（含隔离路径）已换占位`);
    assert.ok(!text.includes(secret), `${name}：token 值不外泄`);
    assert.ok(!text.includes(connectionCode), `${name}：连接码值不外泄`);
    assert.match(text, /ENOENT/, `${name}：分类信号照旧留在文案里`);
    assert.ok(text.includes("~") && text.includes("<配置目录>") && text.includes("<已隐藏>"),
      `${name}：替换后的形态可核对 → ${text}`);
  }
  // 句式与候选序号是负责人裁定的口径，本轮不许动。
  assert.match(flows.notice, /⚠️ 实现 的首选配置不可用（.*），已切换到候选 2$/);
});

test("[T3b] redaction is a pure function over the directories it is handed", () => {
  const dirs = { homeDir: "/Users/co0ontty", configDir: "/tmp/wand-dev" };
  assert.equal(
    redactAiTeamErrorText("spawn codex ENOENT in /Users/co0ontty/.nvm/versions/node", dirs),
    "spawn codex ENOENT in ~/.nvm/versions/node");
  assert.equal(
    redactAiTeamErrorText("read /home/li/.wand/config.json failed", dirs),
    "read ~/.wand/config.json failed", "别的用户的绝对路径同样收掉");
  assert.equal(
    redactAiTeamErrorText("config=/tmp/wand-dev/config.json", dirs),
    "config=<配置目录>/config.json");
  assert.equal(
    redactAiTeamErrorText("token=abc123 & code=xyz789 & api_key: \"quoted secret\"", dirs),
    "token=<已隐藏> & code=<已隐藏> & api_key: <已隐藏>");
  assert.equal(
    redactAiTeamErrorText("code: 'ENOENT', syscall: 'spawn'", dirs),
    "code: 'ENOENT', syscall: 'spawn'", "弱名字只认 code=，不误吞错误码");
  assert.equal(
    redactAiTeamErrorText("authorization=Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffff", dirs),
    "authorization=<已隐藏>", "高熵长串兜底");
  assert.equal(
    redactAiTeamErrorText("HTTP 401, headers={authorization: Bearer sk-abcdefghijklmnop1234567890,"
      + " x-api-key: AKIAIOSFODNN7EXAMPLE1234567890abcd}", dirs),
    "HTTP 401, headers={authorization: <已隐藏>, x-api-key: <已隐藏>}", "provider 头里的凭据同样收掉");
  assert.equal(redactAiTeamErrorText("模型 ghost-model 不在 codex 已发现的模型清单里", dirs),
    "模型 ghost-model 不在 codex 已发现的模型清单里", "短词与模型名不误伤");
  assert.equal(redactAiTeamErrorText("", dirs), "");

  const noisy = `ENOENT /Users/other/.wand token=sk-ABCDEFGHIJKLMNOP1234 ${"/tmp/wand-dev/wand.db"}`;
  const once = redactAiTeamErrorText(noisy, dirs);
  assert.equal(redactAiTeamErrorText(once, dirs), once, "同一输入重复清洗结果不变（纯函数、幂等）");
});
