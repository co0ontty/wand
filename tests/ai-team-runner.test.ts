import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  AiTeamConflictError,
  AiTeamRunner,
  assignmentBasisNote,
  CHAT_INVITE_PER_LINE,
  chatIntroLines,
  redactAiTeamErrorText,
  stepStartText,
  type AiTeamChatOps,
  type AiTeamSessionOps,
} from "../src/ai-team-runner.js";
import {
  agentKey,
  AI_TEAM_DETAIL_CHAT_TURNS,
  AI_TEAM_LIVE_TEXT_MAX_CHARS,
  type AiTeam,
  type AiTeamLiveStep,
  type AiTeamLiveUpdate,
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
  /** PTY 终端原始输出（live 文本在 pty 非 claude 时的唯一来源）。 */
  output?: string;
  /** 置真即 activityState → needs_permission，用来验「只有状态变也要推」。 */
  permissionBlocked?: boolean;
  /** claude 的 PTY 只有在 CLI 已激活时才挂 pty bridge（messages 才会随流式更新）。 */
  providerCliActive?: boolean;
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
      provider: input.agent.provider, lastError: null, output: "",
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
      output: session.output ?? "", permissionBlocked: session.permissionBlocked === true,
      providerCliActive: session.providerCliActive === true,
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
  readonly titles = new Map<string, string>();
  readonly turns = new Map<string, ConversationTurn[]>();
  private counter = 0;

  /** 转发会话在真实现里就是一个普通结构化会话，所以这里也把它映进 ops.sessions。 */
  constructor(private readonly ops: FakeOps) {}

  open({ title }: Parameters<AiTeamChatOps["open"]>[0]): string {
    const id = `chat${++this.counter}`;
    this.titles.set(id, title);
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
    notifyLive?: (update: AiTeamLiveUpdate) => void;
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
    storage, ops, chat, resolveCwd: () => cwd, now: () => clock.now,
    models: options.models, notifyLive: options.notifyLive,
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

test("renaming a member updates display identity without rewriting run snapshots or chat history", async (t) => {
  const h = harness(t);
  const started = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const before = h.runner.detail(started.run.id);
  const originalTurns = JSON.stringify(before.chatTurns);
  assert.ok(before.chatTurns.some((turn) => turn.author?.id === "m_lead"));

  const updated: AiTeam = {
    ...h.team, name: "新群名", updatedAt: "2026-02-02T00:00:00.000Z",
    members: h.team.members.map((member) => member.id === "m_lead"
      ? { ...member, name: "新负责人", avatar: "cat:3" }
      : member.id === "m_dev" ? { ...member, name: "新实现", avatar: "cat:2" } : member),
  };
  h.storage.saveAiTeam(updated);
  const after = h.runner.detail(started.run.id);
  assert.equal(after.run.team.name, "测试团队", "runner retains its execution snapshot");
  assert.equal(after.run.team.members[0]!.name, "负责人");
  assert.equal(after.displayTeam?.name, "新群名");
  assert.equal(after.displayTeam?.members[0]?.name, "新负责人");
  assert.equal(after.displayTeam?.members[1]?.name, "新实现");
  assert.equal(after.displayTeam?.members[1]?.avatar, "cat:2");
  assert.deepEqual(after.displayTeam?.members.map((member) => member.id),
    before.run.team.members.map((member) => member.id), "existing run roster never gains new members");
  assert.equal(JSON.stringify(after.chatTurns), originalTurns, "historical author and text are immutable");
  assert.equal(h.storage.getAiTeamRun(started.run.id)?.team.members[0]?.name, "负责人");
  assert.equal(h.storage.listAiTeamRunChatMarkers().get(started.run.chatSessionId!)?.teamName, "新群名",
    "会话列表的群名也走当前定义");

  h.storage.deleteAiTeam(h.team.id);
  assert.equal(h.storage.listAiTeamRunChatMarkers().get(started.run.chatSessionId!)?.teamName, "测试团队");
  assert.equal(h.runner.detail(started.run.id).displayTeam?.members[0]?.name, "负责人",
    "deleting a definition falls back to the saved roster");
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

test("chat continue after the limit uses the raised team budget and preserves queued work", async (t) => {
  const h = harness(t, { requirePlanApproval: false, maxSteps: 2 });
  const runId = await startAndPlan(h, [["m_dev", "先实现"], ["m_qa", "再验收"]]);
  const chatId = h.runner.detail(runId).run.chatSessionId!;
  const dev = runningStep(h, runId);
  h.ops.finishTurn(dev.sessionId!, "实现完成");
  await settle(h, dev.sessionId!);
  const queued = h.runner.detail(runId).steps.find((step) => step.title === "再验收")!;
  assert.equal(queued.status, "queued");
  assert.equal(h.runner.detail(runId).run.stepLimit, 2);

  h.storage.saveAiTeam({ ...h.team, maxSteps: 80 });
  await h.runner.chatInput(chatId, "让团队继续");
  const after = h.runner.detail(runId);
  assert.equal(after.run.status, "running");
  assert.equal(after.run.stepLimit, 80, "团队新上限在原运行明确续跑时生效");
  assert.equal(after.run.team.maxSteps, 80);
  assert.equal(after.steps.find((step) => step.id === queued.id)?.status, "running");
  assert.equal(runningStep(h, runId).memberId, "m_qa", "不能重新请负责人而跳过原计划");
  assert.equal(after.steps.filter((step) => step.kind === "leader").length, 1);
  assert.equal(h.chat.lines(chatId).filter((line) => line.includes("步数上限加到 80")).length, 1);
});

test("a simple reply also extends the limit; new instructions go to the leader", async (t) => {
  const h = harness(t, { requirePlanApproval: false, maxSteps: 2 });
  const runId = await startAndPlan(h, [["m_dev", "先实现"], ["m_qa", "再验收"]]);
  const dev = runningStep(h, runId);
  h.ops.finishTurn(dev.sessionId!, "实现完成");
  await settle(h, dev.sessionId!);

  const after = await h.runner.reply(runId, "继续");
  assert.equal(after.run.stepLimit, 12, "没有改团队配置也要给旧运行加步数");
  assert.equal(after.steps.find((step) => step.title === "再验收")?.status, "running");

  const other = harness(t, { requirePlanApproval: false, maxSteps: 2 });
  const otherRunId = await startAndPlan(other, [["m_dev", "先实现"], ["m_qa", "再验收"]]);
  const otherDev = runningStep(other, otherRunId);
  other.ops.finishTurn(otherDev.sessionId!, "实现完成");
  await settle(other, otherDev.sessionId!);
  const changed = await other.runner.reply(otherRunId, "先调整验收范围再继续");
  assert.equal(changed.run.stepLimit, 12);
  assert.equal(changed.steps.find((step) => step.title === "再验收")?.status, "skipped");
  const leader = runningStep(other, otherRunId);
  assert.equal(leader.kind, "leader");
  assert.match(other.ops.sessions.get(leader.sessionId!)!.sent.at(-1)!, /先调整验收范围再继续/);
});

test("continue is rejected for a leader question even when its budget is exhausted", async (t) => {
  const h = harness(t, { maxSteps: 1 });
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const leader = runningStep(h, detail.run.id);
  writeReport(h, leader, JSON.stringify({ action: "ask", message: "选哪种格式？" }));
  h.ops.finishTurn(leader.sessionId!);
  await settle(h, leader.sessionId!);
  const waiting = h.runner.detail(detail.run.id);
  assert.equal(waiting.run.stepsUsed, waiting.run.stepLimit);
  assert.equal(waiting.run.statusDetail, "选哪种格式？");
  await assert.rejects(h.runner.continueRun(detail.run.id, 10), AiTeamConflictError);
  assert.deepEqual(h.runner.detail(detail.run.id).run, waiting.run);
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

test("group chat title follows the task, not team renames or subsequent instructions", async (t) => {
  const h = harness(t);
  const started = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const chatId = started.run.chatSessionId!;
  const expected = "给 README 加安装说明任务处理群";
  assert.equal(h.chat.titles.get(chatId), expected, "新建会话的标题按任务命名");
  assert.equal(started.chatTitle, expected, "聊天页头与会话标题一致");
  assert.equal(h.storage.listAiTeamRunChatMarkers().get(chatId)?.chatTitle, expected);
  assert.ok(h.chat.lines(chatId).includes(`·负责人: 创建了团队群聊「${expected}」`));
  const history = JSON.stringify(started.chatTurns);
  const snapshot = JSON.stringify(started.run.team);
  h.storage.updateWandTask(h.taskId, { title: "整理 README" });
  const renamed = h.runner.detail(started.run.id);
  assert.equal(renamed.chatTitle, "整理 README任务处理群");
  assert.equal(renamed.chatTitleUpdatedAt, h.storage.getWandTask(h.taskId)!.updatedAt);
  assert.equal(h.storage.listAiTeamRunChatMarkers().get(chatId)?.chatTitle, renamed.chatTitle);
  assert.equal(JSON.stringify(renamed.chatTurns), history, "不批量改写历史发言");
  assert.equal(JSON.stringify(renamed.run.team), snapshot, "不修改执行快照");
  h.storage.saveAiTeam({ ...h.team, name: "另一个团队名称" });
  assert.equal(h.runner.detail(started.run.id).chatTitle, renamed.chatTitle, "团队改名不改变群名");
  await h.runner.chatInput(chatId, "顺便检查拼写");
  assert.equal(h.runner.detail(started.run.id).chatTitle, renamed.chatTitle, "输入指令不是群名");
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
  // v2 入群序列（S1/S2）：两条居中系统行，作者都是负责人，不再有旧的「接手了这个任务：roster」。
  assert.match(lines[1]!, /^·负责人: 创建了团队群聊「给 README 加安装说明任务处理群」$/);
  assert.match(lines[2]!, /^·负责人: 邀请 @实现、@验收 加入群聊$/);
  assert.equal(lines.some((line) => line.includes("接手了这个任务")), false, "旧 roster 文案已被入群序列取代");
  assert.match(lines[3]!, /^负责人: 计划\n\n1\. \*\*@实现\*\* 写代码$/);
  // 开工发言（S4）：成员自己发的真实发言，第 1 行带真实步号与标题。
  assert.equal(lines[4], "实现: 我正在开始工作：第 2 步「写代码」");
  assert.equal(lines[5], "实现: ✅ 完成「写代码」\n\n改好了");
  const report = h.chat.turns.get(chatId)![5]!;
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
  assert.ok(!leadOpened.prompt.includes("已经做完的不要重做"), "读文件的规则不重复进用户消息");
  assert.match(leadOpened.systemPrompt!, /已经做完的不要重做/);
  const file = readFileSync(path.join(h.cwd, historyPath), "utf8");
  assert.match(file, /第2步 · 实现 · 改 README · 完成/, "上一轮的步骤与结局写进摘要");
  assert.match(file, /README\.md 顶部加了 npm 安装说明/, "上一轮的报告正文留在群聊原文里");
  assert.match(file, /都做完了/);
  assert.match(file, /安装命令换成 pnpm/);
  assert.equal(file.split("创建了团队群聊").length - 1, 1, "历史只收上一轮的入群序列，不带新运行自己的那条");
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
  assert.ok(workOpened.prompt.includes("本群聊之前的记录"));
  assert.match(workOpened.systemPrompt!, /在已有改动的基础上继续/);
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
  const turns = h.chat.turns.get(h.runner.detail(runId).run.chatSessionId!)!;
  assert.equal(turns.filter((turn) => turnText(turn).startsWith("我正在开始工作：")).length, 1,
    "第一候选尝试保留 S4；第二候选被预检拉黑不虚构 S4");
  assert.equal(turns.find((turn) => turnText(turn).startsWith("❌ 没完成「改 README」"))?.author?.sessionId,
    undefined, "从未成功 open 的失败报告不伪造 sessionId");
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

test("[T3] a failed Pi startup notice is not a model reply and tries the backup model", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("pi", "mk2api/monkeycode-ultra/gpt-6-astra"), candidate("pi", "openai-codex/gpt-6-sol")],
  });
  const runId = await startAndPlan(h, [["m_dev", "设计界面"]]);
  const first = runningStep(h, runId);
  const session = h.ops.sessions.get(first.sessionId!)!;
  session.status = "failed";
  session.inFlight = false;
  session.lastError = "积分已耗尽，调用失败";
  session.messages.push({
    role: "assistant", content: [{ type: "text", text: `结构化会话执行失败：${session.lastError}` }],
  });
  h.clock.now += 2_000;
  await settle(h, first.sessionId!);

  const skipped = h.storage.listAiTeamSteps(runId).find((step) => step.id === first.id)!;
  assert.equal(skipped.status, "skipped");
  assert.equal(h.ops.opened.at(-1)!.model, "openai-codex/gpt-6-sol");
  assert.equal(runningStep(h, runId).dispatchInfo?.usedCandidate, 1);
  assert.equal(h.runner.detail(runId).run.stepsUsed, 1, "系统错误提示不扣步骤预算");
});

test("[T3] a reused session's earlier replies do not hide the current step's startup failure", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("pi", "first"), candidate("pi", "backup")],
  });
  const runId = await startAndPlan(h, [["m_dev", "第一轮设计"]]);
  const first = runningStep(h, runId);
  writeReport(h, first, "状态: 完成\n第一轮规格");
  h.ops.finishTurn(first.sessionId!, "第一轮规格已交付");
  await settle(h, first.sessionId!);
  await planMore(h, runId, [{ member: "m_dev", title: "补充设计", after: [] }]);

  const next = runningStep(h, runId);
  assert.equal(next.sessionId, first.sessionId, "第二轮复用原会话");
  const session = h.ops.sessions.get(next.sessionId!)!;
  session.status = "failed";
  session.inFlight = false;
  session.lastError = "积分已耗尽，调用失败";
  session.messages.push({
    role: "assistant", content: [{ type: "text", text: `结构化会话执行失败：${session.lastError}` }],
  });
  h.clock.now += 2_000;
  await settle(h, next.sessionId!);

  assert.equal(h.storage.listAiTeamSteps(runId).find((step) => step.id === next.id)!.status, "skipped");
  assert.equal(h.ops.opened.at(-1)!.model, "backup", "当前轮没正常输出，应改用第二候选");
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
  session.messages.push({
    role: "assistant", content: [{ type: "text", text: `结构化会话执行失败：${session.lastError}` }],
  });
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
  assert.ok(h.chat.lines(chatId).some((line) => line.includes("我正在开始工作：") && line.includes("「改 README」")),
    "群聊看得到新候选开工");
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
  const starts = turns.filter((turn) => turnText(turn).includes("我正在开始工作："));
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

// ── live 文本通道（§4.9）──

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("output events push debounced live text, identical text is not re-pushed", async (t) => {
  const pushes: AiTeamLiveUpdate[] = [];
  const h = harness(t, {}, { notifyLive: (update) => pushes.push(update) });
  const started = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const runId = started.run.id;
  const leader = runningStep(h, runId);
  writeReport(h, leader, assign([["m_dev", "写安装说明"]]));
  h.ops.finishTurn(leader.sessionId!);
  await settle(h, leader.sessionId!);
  await h.runner.approve(runId);
  const work = runningStep(h, runId);
  assert.equal(work.kind, "work");
  pushes.length = 0;

  // 会话里多了一行 tool_use，连发三个 output 事件：去抖后只推一次，payload 带 runId/taskId。
  const session = h.ops.sessions.get(work.sessionId!)!;
  session.messages.push({
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "Read", description: "读 README", input: {} }],
  });
  h.runner.ingest({ type: "output", sessionId: work.sessionId! });
  h.runner.ingest({ type: "output", sessionId: work.sessionId! });
  h.runner.ingest({ type: "output", sessionId: work.sessionId! });
  await sleep(650);
  await h.runner.idle();
  assert.equal(pushes.length, 1, "500ms 去抖：三次事件一次推送");
  assert.equal(pushes[0]!.runId, runId);
  assert.equal(pushes[0]!.taskId, h.taskId);
  const liveStep: AiTeamLiveStep = pushes[0]!.steps[0]!;
  assert.equal(pushes[0]!.steps.length, 1);
  assert.equal(liveStep.stepId, work.id);
  assert.equal(liveStep.memberName, "实现");
  assert.equal(liveStep.provider, "codex");
  assert.equal(liveStep.state, "working");
  assert.ok(liveStep.text.includes("▸ Read · 读 README"), liveStep.text.slice(0, 120));

  // 文本没变：再来 output 不重复推。
  h.runner.ingest({ type: "output", sessionId: work.sessionId! });
  await sleep(650);
  await h.runner.idle();
  assert.equal(pushes.length, 1, "文本与上次完全相同就不重复推");

  // 文本变了：再推一次。
  session.messages.push({ role: "assistant", content: [{ type: "text", text: "接着写第二段" }] });
  h.runner.ingest({ type: "output", sessionId: work.sessionId! });
  await sleep(650);
  await h.runner.idle();
  assert.equal(pushes.length, 2);
  assert.ok(pushes[1]!.steps[0]!.text.includes("接着写第二段"));

  // 步骤结束：finishStep 落地后补推一次收尾，结束的步不再出现。
  writeReport(h, work, "状态: 完成\n安装了 npm 说明");
  h.ops.finishTurn(work.sessionId!);
  await settle(h, work.sessionId!);
  const last = pushes[pushes.length - 1]!;
  assert.ok(last.steps.every((step) => step.stepId !== work.id), "结束的步不再出现在 live 列表");

  // stop：所有步骤落定，最后推一次空列表让卡片收尾。
  await h.runner.stop(runId);
  assert.equal(pushes[pushes.length - 1]!.steps.length, 0, "stop 后推空列表收尾");
});

test("live() only covers running steps with a snapshot and truncates long text", async (t) => {
  const h = harness(t);
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const leader = runningStep(h, detail.run.id);
  h.ops.sessions.get(leader.sessionId!)!.messages.push({
    role: "assistant", content: [{ type: "text", text: "字".repeat(AI_TEAM_LIVE_TEXT_MAX_CHARS + 7) }],
  });
  const steps = h.runner.live(detail.run.id);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.text.length, AI_TEAM_LIVE_TEXT_MAX_CHARS);
  assert.ok(steps[0]!.omittedChars >= 7, "提示词 + 长文本一起截尾");
  // 会话快照丢了也不抛，直接跳过；queued/done 的步骤不进来。
  h.ops.sessions.delete(leader.sessionId!);
  assert.deepEqual(h.runner.live(detail.run.id), []);
  assert.throws(() => h.runner.live("run_nope"), /团队运行不存在/);
});

// ── live 文本的来源：pty 非 claude 走 output（R1），claude pty / structured 走 messages ──

const ptyAgent = (provider: WandTaskAgent["provider"]): WandTaskAgent => ({
  provider, model: "default", thinkingEffort: "off", mode: "full-access", kind: "pty",
});

test("[live R1] a non-claude PTY step reports the growing terminal output, not the stale turn", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, { worker: ptyAgent("codex") });
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const work = runningStep(h, runId);
  assert.equal(h.ops.ownerOf(work.sessionId!), "pty");
  const session = h.ops.sessions.get(work.sessionId!)!;
  // codex 的 PTY 没挂 pty bridge，流式期 messages 不增长：里面留着的是上一条 turn。
  session.messages = [{ role: "assistant", content: [{ type: "text", text: "上一轮残留的旧回复" }] }];
  session.output = "reading src/readme.md\ncoding: 改写安装章节";
  const steps = h.runner.live(runId);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.provider, "codex");
  assert.equal(steps[0]!.text, "reading src/readme.md\ncoding: 改写安装章节");
  assert.ok(!steps[0]!.text.includes("上一轮残留"), "过期文本不能锚在卡片上");
});

test("[live R1] a claude PTY step with the CLI active still renders messages", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, { worker: ptyAgent("claude") });
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const work = runningStep(h, runId);
  assert.equal(h.ops.ownerOf(work.sessionId!), "pty");
  const session = h.ops.sessions.get(work.sessionId!)!;
  // bridge 只在 claude 且 providerCliActive 时挂载，这时 messages 是新鲜的。
  session.providerCliActive = true;
  session.messages = [
    { role: "user", content: [{ type: "text", text: "本轮指令" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "我先读文件" },
        { type: "tool_use", id: "t1", name: "Read", description: "读 README", input: {} },
      ],
    },
  ];
  session.output = "一堆不该进卡片的原始终端噪声";
  const steps = h.runner.live(runId);
  assert.ok(steps[0]!.text.includes("我先读文件"), "claude PTY 仍按 messages 渲染");
  assert.ok(steps[0]!.text.includes("▸ Read · 读 README"));
  assert.ok(!steps[0]!.text.includes("原始终端噪声"), "有 bridge 时不回落 output");
});

test("[live R1] a structured step is unchanged: messages win even while output grows", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const work = runningStep(h, runId);
  assert.equal(h.ops.ownerOf(work.sessionId!), "structured");
  const session = h.ops.sessions.get(work.sessionId!)!;
  session.messages = [
    { role: "user", content: [{ type: "text", text: "本轮指令" }] },
    { role: "assistant", content: [{ type: "text", text: "结构化流式进度" }] },
  ];
  session.output = "stderr: 一些无关输出";
  const steps = h.runner.live(runId);
  assert.equal(steps[0]!.text, "本轮指令\n结构化流式进度");
  assert.ok(!steps[0]!.text.includes("stderr"));
});

test("[live R1] a claude PTY step whose CLI is not active is a bare terminal too", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, { worker: ptyAgent("claude") });
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const work = runningStep(h, runId);
  const session = h.ops.sessions.get(work.sessionId!)!;
  assert.equal(session.providerCliActive, undefined, "没激活 = initializeClaudeBridge 首行就早退");
  // 和 codex PTY 同一个反例：messages 里是上一条 turn 的残留。
  session.messages = [{ role: "assistant", content: [{ type: "text", text: "上一轮残留的旧回复" }] }];
  session.output = "claude 终端此刻在输出的新内容";
  const steps = h.runner.live(runId);
  assert.equal(steps[0]!.text, "claude 终端此刻在输出的新内容");
  assert.ok(!steps[0]!.text.includes("上一轮残留"), "bridge 没挂上就不能锚在旧回合上");
});

test("[live] a step reports the model and effort of the candidate actually in use", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [
      { provider: "codex", model: "gpt-5.1-codex", thinkingEffort: "codex:medium", mode: "full-access", kind: "pty" },
      { provider: "opencode", model: "glm-4.7", thinkingEffort: "max", mode: "full-access", kind: "pty" },
    ],
  });
  h.ops.openFailure = (agent) => agent.provider === "codex" ? ENOENT : null;
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const work = runningStep(h, runId);
  assert.equal(h.ops.opened.find((item) => item.sessionId === work.sessionId)!.provider, "opencode", "首选起不来，已降级");
  const steps = h.runner.live(runId);
  // 降级换候选后，卡片上的模型与思考深度跟着切过去的新候选，不是首选。
  assert.equal(steps[0]!.model, "glm-4.7");
  assert.equal(steps[0]!.thinkingEffort, "max");
});

test("[live] model and effort pass through as truth, including default and off", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, { worker: ptyAgent("codex") });
  const detail = await h.runner.start({ teamId: h.team.id, taskId: h.taskId });
  const leader = runningStep(h, detail.run.id);
  assert.equal(leader.kind, "leader");
  const steps = h.runner.live(detail.run.id);
  // structuredAgent("claude") 是 model:"default" / thinkingEffort:"off"：原样给出去，不翻译成文案。
  assert.equal(steps[0]!.model, "default");
  assert.equal(steps[0]!.thinkingEffort, "off");
});

test("[chat] authored turns carry the model and effort of the candidate actually used", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [
      candidate("codex", "broken"),
      { provider: "opencode", model: "glm-4.7", thinkingEffort: "deep", mode: "full-access", kind: "structured" },
    ],
  });
  h.ops.openFailure = (agent) => agent.provider === "codex" ? ENOENT : null;
  const runId = await startAndPlan(h, [["m_dev", "改 README"]]);
  const chatId = h.runner.detail(runId).run.chatSessionId!;
  const turns = h.chat.turns.get(chatId)!;

  const leaderTurn = turns.find((turn) => turn.author?.leader === true)!;
  assert.equal(leaderTurn.author?.model, "default", "负责人回合署自己步骤实际候选的模型");
  assert.equal(leaderTurn.author?.thinkingEffort, "off");

  const starts = turns.filter((turn) => turnText(turn).includes("我正在开始工作："));
  assert.equal(starts[0]!.author?.model, "broken", "第一次开工行署当时真正用的首选");
  assert.equal(starts[starts.length - 1]!.author?.model, "glm-4.7", "降级后的开工行跟着换");
  assert.equal(starts[starts.length - 1]!.author?.thinkingEffort, "deep");

  const degradeLine = turns.find((turn) => turn.notice && turnText(turn).includes("首选配置不可用"))!;
  assert.equal(degradeLine.author?.model, "glm-4.7", "降级行署切过去的新候选");
  assert.equal(degradeLine.author?.thinkingEffort, "deep");

  const work = runningStep(h, runId);
  writeReport(h, work, "状态: 完成");
  h.ops.finishTurn(work.sessionId!);
  await settle(h, work.sessionId!);
  const done = turns.find((turn) => turnText(turn).includes("✅ 完成"))!;
  assert.equal(done.author?.model, "glm-4.7");
  assert.equal(done.author?.thinkingEffort, "deep");

  // 入群序列（S1/S2）是带署名的系统提示：作者就是负责人本人，模型/深度取他真实的首选候选，不凭空造。
  // （「不给 author 的系统提示不会冒出署名」由续跑那条 `·: 接着…` 断言守着：`·:` 前缀 = 无作者。）
  const intro = turns.filter((turn) => turn.notice && turnText(turn).includes("创建了团队群聊"));
  assert.equal(intro.length, 1);
  assert.equal(intro[0]!.author?.leader, true, "入群行署负责人");
  assert.equal(intro[0]!.author?.model, "default");
  assert.equal(intro[0]!.author?.thinkingEffort, "off");
});

test("[live] a terminal run drops its push fingerprint", async (t) => {
  const pushes: AiTeamLiveUpdate[] = [];
  const h = harness(t, {}, { notifyLive: (update) => pushes.push(update) });
  const runId = await startAndPlan(h, [["m_dev", "写安装说明"]]);
  await h.runner.approve(runId);
  const work = runningStep(h, runId);
  const session = h.ops.sessions.get(work.sessionId!)!;
  session.messages.push({ role: "assistant", content: [{ type: "text", text: "第一段输出" }] });
  h.runner.ingest({ type: "output", sessionId: work.sessionId! });
  await sleep(650);
  await h.runner.idle();
  const keys = (h.runner as unknown as { lastLiveKey: Map<string, string> }).lastLiveKey;
  assert.ok(keys.has(runId), "推过一次就留下指纹");

  await h.runner.stop(runId);
  assert.equal(pushes[pushes.length - 1]!.steps.length, 0, "终态收尾仍推一次空列表");
  assert.ok(!keys.has(runId), "收尾之后不留指纹，长跑服务不按 run 数攒字符串");
});

test("[live] the fallback sweep reconciles state even when no event ever arrives", async (t) => {
  const pushes: AiTeamLiveUpdate[] = [];
  const h = harness(t, {}, { notifyLive: (update) => pushes.push(update) });
  const runId = await startAndPlan(h, [["m_dev", "写安装说明"]]);
  await h.runner.approve(runId);
  const work = runningStep(h, runId);
  const session = h.ops.sessions.get(work.sessionId!)!;
  session.messages.push({ role: "assistant", content: [{ type: "text", text: "第一段输出" }] });
  // 先让「文本 + 状态」的列表落地一次，作为对账前的基线。
  h.runner.ingest({ type: "output", sessionId: work.sessionId! });
  await sleep(650);
  await h.runner.idle();
  const baseline = pushes[pushes.length - 1]!;
  assert.equal(baseline.steps[0]!.state, "working");
  const before = baseline.steps[0]!.text;
  pushes.length = 0;

  // registry 内部静默翻转：一条事件都不会进来，只有兜底巡检会重算这一份列表。
  session.permissionBlocked = true;
  t.mock.timers.enable({ timers: ["setInterval"] });
  try {
    h.runner.reconcile();
    t.mock.timers.tick(5_000);
  } finally {
    t.mock.timers.reset();
  }
  await h.runner.idle();
  assert.equal(pushes.length, 1, "巡检对账推一次");
  assert.equal(pushes[0]!.steps[0]!.state, "needs_permission");
  assert.equal(pushes[0]!.steps[0]!.text, before, "文本没变，只是把状态对齐");
});

test("[live] a state change alone re-pushes even when the text is byte-identical", async (t) => {
  const pushes: AiTeamLiveUpdate[] = [];
  const h = harness(t, {}, { notifyLive: (update) => pushes.push(update) });
  const runId = await startAndPlan(h, [["m_dev", "写安装说明"]]);
  await h.runner.approve(runId);
  const work = runningStep(h, runId);
  const session = h.ops.sessions.get(work.sessionId!)!;
  session.messages.push({ role: "assistant", content: [{ type: "text", text: "第一段输出" }] });
  pushes.length = 0;

  h.runner.ingest({ type: "output", sessionId: work.sessionId! });
  await sleep(650);
  await h.runner.idle();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]!.steps[0]!.state, "working");

  // 文本一字未动，只是弹了权限框：状态芯片必须立刻更新，不能等下一次 run 重拉。
  // 权限/提问这类变化是 status 事件带进来的，所以这里刻意不发 output。
  session.permissionBlocked = true;
  h.runner.ingest({ type: "status", sessionId: work.sessionId! });
  await sleep(650);
  await h.runner.idle();
  assert.equal(pushes.length, 2, "state 单独变化也要推一次");
  assert.equal(pushes[1]!.steps[0]!.text, pushes[0]!.steps[0]!.text);
  assert.equal(pushes[1]!.steps[0]!.state, "needs_permission");

  h.runner.ingest({ type: "output", sessionId: work.sessionId! });
  await sleep(650);
  await h.runner.idle();
  assert.equal(pushes.length, 2, "文本与状态都没变就不重复推");
});

// ---------- v2：入群序列与开工发言（设计 v2.1 S1–S5） ----------

const introMember = (name: string, id = `m_${name}`): AiTeamMember => ({
  id, name, duty: "", agents: [structuredAgent("codex")], agent: structuredAgent("codex"), isLeader: false,
});

const introLeader: AiTeamMember = {
  id: "m_lead2", name: "沈砚", duty: "", agents: [structuredAgent("claude")],
  agent: structuredAgent("claude"), isLeader: true,
};

test("[v2] chat intro lines follow S1–S3 with four invitees per line", () => {
  assert.equal(CHAT_INVITE_PER_LINE, 4);
  assert.deepEqual(
    chatIntroLines({ members: [introLeader, introMember("实现者"), introMember("审查者")] }, "前端优化任务处理群"),
    ["创建了团队群聊「前端优化任务处理群」", "邀请 @实现者、@审查者 加入群聊"],
  );
  // 除负责人外没人：仍两条，第二条不伪造成员。
  assert.deepEqual(
    chatIntroLines({ members: [introLeader] }, "单人验证任务处理群"),
    ["创建了团队群聊「单人验证任务处理群」", "还没有邀请其他成员入群"],
  );
  // 群名空白 → 不带书名号；>4 人拆行，第二行起「继续邀请」。
  assert.deepEqual(
    chatIntroLines({
      members: [introLeader, introMember("a"), introMember("b"), introMember("c"), introMember("d"), introMember("e"), introMember("f")],
    }, "   "),
    ["创建了团队群聊", "邀请 @a、@b、@c、@d 加入群聊", "继续邀请 @e、@f 加入群聊"],
  );
  // 名字空白的成员不进名单。
  assert.deepEqual(
    chatIntroLines({ members: [introLeader, introMember("", "m_blank")] }, "T"),
    ["创建了团队群聊「T」", "还没有邀请其他成员入群"],
  );
});

test("[v2] step start text keeps the basis deterministic", () => {
  assert.equal(stepStartText({ seq: 2, title: "实现 Web 端" }), "我正在开始工作：第 2 步「实现 Web 端」");
  assert.equal(stepStartText({ seq: 2, title: "  " }), "我正在开始工作：第 2 步");
  const upstream = [{
    seq: 1, title: "设计规格", memberName: "设计师",
    reportPath: ".wand-team/run_1/report-1-work-m_designer.md",
  }];
  assert.equal(
    stepStartText({ seq: 2, title: "实现 Web 端" }, upstream, 1),
    "我正在开始工作：第 2 步「实现 Web 端」\n依据 @设计师 第 1 步「设计规格」的产物 .wand-team/run_1/report-1-work-m_designer.md",
  );
  // 依赖解析不到（旧数据 / 步骤被删）→ 降级句；上游标题空白 → 只剩步号；reportPath 前后空白被裁掉。
  assert.equal(
    stepStartText({ seq: 3, title: "联调" }, [], 2),
    "我正在开始工作：第 3 步「联调」\n依据上游步骤的产物继续",
  );
  assert.equal(
    stepStartText({ seq: 3, title: "联调" }, [{ seq: 1, title: " ", memberName: "甲", reportPath: "  " }], 1),
    "我正在开始工作：第 3 步「联调」\n依据 @甲 第 1 步的产物",
  );
  // 上游超过两条：列前两条 + 「等 N 步」（N = 依赖总数）。
  assert.equal(
    stepStartText({ seq: 4, title: "D" }, [
      { seq: 1, title: "A", memberName: "甲", reportPath: "a.md" },
      { seq: 2, title: "B", memberName: "乙", reportPath: "b.md" },
      { seq: 3, title: "C", memberName: "丙", reportPath: "c.md" },
    ], 3),
    "我正在开始工作：第 4 步「D」\n依据 @甲 第 1 步「A」的产物 a.md、@乙 第 2 步「B」的产物 b.md 等 3 步",
  );
});

test("[v2] assignment basis note replaces the old wait parenthesis", () => {
  assert.equal(assignmentBasisNote([], ["设计规格"]), "", "首步没有上游就没有括注");
  assert.equal(assignmentBasisNote([0], ["设计规格", "实现"]), "（依据：第 1 步「设计规格」的产物）");
  assert.equal(
    assignmentBasisNote([0, 1], ["设计规格", "实现"]),
    "（依据：第 1 步「设计规格」的产物、第 2 步「实现」的产物）",
  );
  assert.equal(assignmentBasisNote([0], ["  "]), "（依据：第 1 步的产物）", "上游标题空白只剩步号");
});

test("[v2] the intro sequence is posted once per group chat and never replayed", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const runId = await startAndPlan(h, [["m_dev", "写代码"]]);
  const chatId = h.runner.detail(runId).run.chatSessionId!;

  const lines = h.chat.lines(chatId);
  assert.match(lines[1]!, /^·负责人: 创建了团队群聊「给 README 加安装说明任务处理群」$/);
  assert.match(lines[2]!, /^·负责人: 邀请 @实现、@验收 加入群聊$/);
  assert.equal(lines.filter((line) => line.includes("创建了团队群聊")).length, 1);
  assert.equal(lines.filter((line) => line.includes("加入群聊")).length, 1);

  // 同一个群聊里接着开新一轮（续跑 / 结束后再说话）：入群序列不重播，只留续跑那句。
  const dev = runningStep(h, runId);
  writeReport(h, dev, "状态: 完成");
  h.ops.finishTurn(dev.sessionId!);
  await settle(h, dev.sessionId!);
  const finisher = runningStep(h, runId);
  writeReport(h, finisher, JSON.stringify({ action: "finish", message: "都做完了" }));
  h.ops.finishTurn(finisher.sessionId!);
  await settle(h, finisher.sessionId!);
  assert.equal(h.runner.detail(runId).run.status, "done");

  h.chat.post(chatId, [{ role: "user", content: [{ type: "text", text: "再补一段 FAQ" }] }]);
  await h.runner.chatInput(chatId, "再补一段 FAQ");
  const runs = h.runner.listForTask(h.taskId);
  assert.equal(runs.length, 2);
  assert.equal(runs.find((run) => run.id !== runId)!.chatSessionId, chatId, "续跑落在同一个群聊里");

  const after = h.chat.lines(chatId);
  assert.equal(after.filter((line) => line.includes("创建了团队群聊")).length, 1, "入群序列只出现一次");
  assert.equal(after.filter((line) => line.includes("加入群聊")).length, 1);
  assert.ok(after.some((line) => line.startsWith("·: 接着这个群聊里上一轮的进度继续")), "续跑只有那句继续 notice");
});

test("[v2] a work start is a real member turn with the upstream basis in the second line", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  // 两步顺序执行（parseLeaderDecision 的默认 after = 上一步）：第 2 步才有上游依据。
  const runId = await startAndPlan(h, [["m_dev", "设计规格"], ["m_qa", "验收"]]);
  const chatId = h.runner.detail(runId).run.chatSessionId!;
  const turns = h.chat.turns.get(chatId)!;

  const plan = turns.find((turn) => !turn.notice && turn.author?.leader === true)!;
  const planText = turnText(plan);
  assert.match(planText, /^1\. \*\*@实现\*\* 设计规格$/m, "首步没有上游 → 不带括注");
  assert.match(planText, /^2\. \*\*@验收\*\* 验收（依据：第 1 步「设计规格」的产物）$/m);
  assert.equal(planText.includes("等第"), false, "旧的等待文案不再与新依据并列");

  const dev = runningStep(h, runId);
  assert.equal(dev.seq, 2);
  const devStart = turns.find((turn) => turnText(turn).includes("我正在开始工作：第 2 步"))!;
  assert.equal(devStart.notice, undefined, "开工发言是真实发言，不是居中 notice");
  assert.equal(turnText(devStart), "我正在开始工作：第 2 步「设计规格」", "无依赖时只有第一行");
  assert.equal(devStart.author?.name, "实现");
  assert.equal(devStart.author?.provider, "codex");
  // 新开会话的那一刻还不知道 sessionId（与旧 notice 同位置），报告回合一定带；复用会话时开工行也带。
  assert.equal(devStart.author?.sessionId, undefined);

  writeReport(h, dev, "状态: 完成\n设计写好了");
  h.ops.finishTurn(dev.sessionId!);
  await settle(h, dev.sessionId!);

  const qa = runningStep(h, runId);
  assert.equal(qa.seq, 3);
  const qaStart = h.chat.turns.get(chatId)!.find((turn) => turnText(turn).includes("我正在开始工作：第 3 步"))!;
  assert.equal(qaStart.notice, undefined);
  assert.equal(
    turnText(qaStart),
    `我正在开始工作：第 3 步「验收」\n依据 @实现 第 2 步「设计规格」的产物 ${dev.reportPath}`,
  );
  assert.equal(qaStart.author?.name, "验收");
  assert.equal(qaStart.author?.provider, "pi");
  // 已成功打开过的会话，报告使用其真实 ID；尚未打开就失败时不能伪造（下方另测）。
  writeReport(h, qa, "状态: 完成");
  h.ops.finishTurn(qa.sessionId!);
  await settle(h, qa.sessionId!);
  const qaReport = h.chat.turns.get(chatId)!.find((turn) => turnText(turn).includes("✅ 完成「验收」"))!;
  assert.equal(qaReport.author?.sessionId, qa.sessionId);
});

test("[R1 S-1] new work S4 is posted before open resolves, never gains an invented ID", async (t) => {
  const h = harness(t);
  const runId = await startAndPlan(h, [["m_dev", "第一步"]]);
  const chatId = h.runner.detail(runId).run.chatSessionId!;
  const original = h.ops.open.bind(h.ops);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  h.ops.open = async (input) => {
    if (input.agent.provider === "codex") { enter(); await gate; }
    return original(input);
  };
  const approving = h.runner.approve(runId);
  await entered;
  const start = h.chat.turns.get(chatId)!.find((turn) => turnText(turn).startsWith("我正在开始工作："))!;
  assert.equal(start.notice, undefined);
  assert.equal(start.author?.sessionId, undefined);
  assert.equal(start.author?.provider, "codex");
  assert.equal(start.author?.model, "default");
  assert.equal(start.author?.thinkingEffort, "off");
  assert.equal(runningStep(h, runId).sessionId, null, "running 已写入，而 open 尚未完成");
  release();
  await approving;
  const work = runningStep(h, runId);
  assert.ok(work.sessionId);
  assert.equal(start.author?.sessionId, undefined, "同一条 S4 不补发/不回填");
  assert.equal(h.chat.turns.get(chatId)!.filter((turn) => turnText(turn).startsWith("我正在开始工作：")).length, 1);
  writeReport(h, work, "状态: 完成");
  h.ops.finishTurn(work.sessionId!);
  await settle(h, work.sessionId!);
  const report = h.chat.turns.get(chatId)!.find((turn) => turnText(turn).startsWith("✅ 完成「第一步」"))!;
  assert.equal(report.author?.sessionId, work.sessionId);
});

test("[R1 S-2] reused work S4 is before send and carries that exact session, not a recent guess", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, { worker: {
    provider: "codex", model: "gpt-real", thinkingEffort: "deep", kind: "structured", mode: "full-access",
  } });
  const runId = await startAndPlan(h, [["m_dev", "第一步"], ["m_dev", "第二步"]]);
  const first = runningStep(h, runId);
  const chatId = h.runner.detail(runId).run.chatSessionId!;
  const original = h.ops.send.bind(h.ops);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  h.ops.send = async (id, text) => {
    if (id === first.sessionId) { enter(); await gate; }
    return original(id, text);
  };
  writeReport(h, first, "状态: 完成");
  h.ops.finishTurn(first.sessionId!);
  const processing = settle(h, first.sessionId!);
  await entered;
  const second = h.runner.detail(runId).steps.find((step) => step.kind === "work"
    && step.status === "running" && step.id !== first.id)!;
  assert.ok(second, "同一成员第二步已进入 running");
  const start = h.chat.turns.get(chatId)!.find((turn) => turnText(turn).startsWith(`我正在开始工作：第 ${second.seq} 步`))!;
  assert.equal(start.author?.sessionId, first.sessionId);
  assert.equal(start.author?.provider, "codex");
  assert.equal(start.author?.model, "gpt-real");
  assert.equal(start.author?.thinkingEffort, "deep");
  assert.equal(h.ops.sessions.get(first.sessionId!)!.sent.length, 1, "send 仍被拦住");
  release();
  await processing;
  assert.equal(h.ops.sessions.get(first.sessionId!)!.sent.length, 2);
});

test("[R1 S-3] reused send failure retains the real ID and original failure exit", async (t) => {
  const h = harness(t, { requirePlanApproval: false });
  const runId = await startAndPlan(h, [["m_dev", "第一步"], ["m_dev", "第二步"]]);
  const first = runningStep(h, runId);
  const original = h.ops.send.bind(h.ops);
  h.ops.send = async (id, text) => {
    if (id === first.sessionId) throw new Error("permission denied");
    return original(id, text);
  };
  writeReport(h, first, "状态: 完成");
  h.ops.finishTurn(first.sessionId!);
  await settle(h, first.sessionId!);
  const turns = h.chat.turns.get(h.runner.detail(runId).run.chatSessionId!)!;
  const second = h.runner.detail(runId).steps.find((step) => step.kind === "work" && step.title === "第二步")!;
  assert.equal(second.status, "failed");
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(turns.find((turn) => turnText(turn).startsWith(`我正在开始工作：第 ${second.seq} 步`))?.author?.sessionId,
    first.sessionId);
  assert.equal(turns.find((turn) => turnText(turn).startsWith("❌ 没完成「第二步」"))?.author?.sessionId,
    first.sessionId);
});

test("[R1 S-3/S-4] open failure retains unlinked S4/report; preflight skip has no S4", async (t) => {
  const failed = harness(t, { requirePlanApproval: false }, { worker: candidate("codex", "bad") });
  failed.ops.openFailure = (agent) => agent.provider === "codex" ? "permission denied" : null;
  const failedRun = await startAndPlan(failed, [["m_dev", "执行"]]);
  const failedTurns = failed.chat.turns.get(failed.runner.detail(failedRun).run.chatSessionId!)!;
  const start = failedTurns.find((turn) => turnText(turn).startsWith("我正在开始工作："))!;
  const report = failedTurns.find((turn) => turnText(turn).startsWith("❌ 没完成「执行」"))!;
  assert.equal(start.author?.sessionId, undefined);
  assert.equal(report.author?.sessionId, undefined);
  assert.equal(failed.runner.detail(failedRun).steps.find((step) => step.kind === "work")?.status, "failed");

  const skipped = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "ghost"), candidate("opencode", "valid")],
    models: (provider) => provider === "codex" ? ["different"] : [],
  });
  const skippedRun = await startAndPlan(skipped, [["m_dev", "执行"]]);
  const turns = skipped.chat.turns.get(skipped.runner.detail(skippedRun).run.chatSessionId!)!;
  const attempts = turns.filter((turn) => turnText(turn).startsWith("我正在开始工作："));
  const noticeIndex = turns.findIndex((turn) => turn.notice && turnText(turn).includes("已切换到候选 2"));
  const startIndex = turns.indexOf(attempts[0]!);
  assert.equal(attempts.length, 1, "预检拒绝的第一候选不虚构 S4");
  assert.ok(noticeIndex >= 0 && noticeIndex < startIndex, "降级 notice 早于新派发");
  assert.equal(attempts[0]!.author?.provider, "opencode");
  assert.equal(skipped.runner.detail(skippedRun).steps.filter((step) => step.status === "skipped").length, 1);
});

test("[R1 S-4/S-5] replacement has new seq; S5 uses batch position, not persisted seq", async (t) => {
  const h = harness(t, { requirePlanApproval: false }, {
    workerAgents: [candidate("codex", "bad"), candidate("opencode", "real")],
  });
  h.ops.openFailure = (agent) => agent.provider === "codex" ? ENOENT : null;
  const runId = await startAndPlanRaw(h, [
    { member: "m_dev", title: "实现" }, { member: "m_qa", title: "审查", after: [1] },
  ]);
  const detail = h.runner.detail(runId);
  const turns = h.chat.turns.get(detail.run.chatSessionId!)!;
  const plan = turns.find((turn) => !turn.notice && turn.author?.leader && turnText(turn).includes("**@实现**"))!;
  assert.match(turnText(plan), /2\. \*\*@验收\*\* 审查（依据：第 1 步「实现」的产物）/);
  const starts = turns.filter((turn) => turnText(turn).startsWith("我正在开始工作："));
  assert.equal(starts.length, 2, "失败与替换各留一条；不按同标题去重");
  assert.equal(starts[0]!.author?.provider, "codex");
  assert.equal(starts[1]!.author?.provider, "opencode");
  assert.match(turnText(starts[0]!), /第 2 步「实现」/);
  assert.match(turnText(starts[1]!), /第 4 步「实现」/);
  const notice = turns.findIndex((turn) => turn.notice && turnText(turn).includes("已切换到候选 2"));
  assert.ok(turns.indexOf(starts[0]!) < notice && notice < turns.indexOf(starts[1]!));
  assert.equal(detail.steps.find((step) => step.seq === 2)?.status, "skipped");
  assert.equal(detail.steps.find((step) => step.seq === 4)?.status, "running");
});
