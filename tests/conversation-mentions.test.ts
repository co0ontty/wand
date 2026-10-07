import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { conversationLeaderMention, conversationMentionToken } from "../src/conversation-mentions.js";
import { employeeConversationId } from "../src/conversation-types.js";
import { buildLeaderKickoffPrompt } from "../src/ai-team-prompts.js";
import type { AiTeamStep } from "../src/ai-team-types.js";
import { conversationHarness } from "./helpers/conversation-harness.js";

const members = [{ id: "m_a", name: "香菜" }, { id: "m_b", name: "香菜同学" }, { id: "m_c", name: "Dev Bot" }];

test("only a leading explicit @ selects a coordinator; exact longest names, IDs and upload envelopes work", () => {
  for (const prefix of ["@香菜 ", "  ＠香菜：", "@m_a，"]) {
    assert.deepEqual(conversationLeaderMention(`${prefix}安排设计与实现`, members), { memberId: "m_a", name: "香菜", body: "安排设计与实现" });
  }
  assert.equal((conversationLeaderMention("@香菜同学 做设计", members) as { memberId: string }).memberId, "m_b");
  assert.equal((conversationLeaderMention("@Dev Bot implement", members) as { memberId: string }).memberId, "m_c");
  for (const text of ["好", "请看 @香菜 的报告", "user@example.com", "> @香菜 做设计", "`@香菜 做设计`", "[附件已上传，请查看以下文件:\n/tmp/@香菜\n]\n\n普通沟通"]) {
    assert.equal(conversationLeaderMention(text, members), null, text);
  }
  for (const text of ["@香菜花 做设计", "@不在群里 做设计", "@香菜"]) {
    assert.ok(conversationLeaderMention(text, members) && "error" in conversationLeaderMention(text, members)!, text);
  }
  assert.deepEqual(conversationLeaderMention("[附件已上传，请查看以下文件:\n/tmp/@香菜.png\n]\n\n@Dev Bot 实现", members),
    { memberId: "m_c", name: "Dev Bot", body: "实现" });
  // Subsequent @ references are instructions to this coordinator, not extra coordinators.
  assert.equal((conversationLeaderMention("@香菜 请交给 @Dev Bot 实现", members) as { memberId: string }).memberId, "m_a");
});

test("duplicate names never choose the first employee; picker inserts a stable member ID", () => {
  const roster = [...members, { id: "m_d", name: "香菜" }];
  assert.ok("error" in conversationLeaderMention("@香菜 做设计", roster)!);
  assert.equal(conversationMentionToken(roster[0]!, roster), "@m_a");
  assert.equal(conversationMentionToken(roster[2]!, roster), "@Dev Bot");
  assert.equal((conversationLeaderMention("@m_d 做设计", roster) as { memberId: string }).memberId, "m_d");
});

async function group(h: ReturnType<typeof conversationHarness>): Promise<string> {
  const receipt = await h.service.createGroup(randomUUID(), { employeeIds: ["e_test_1", "e_test_2", "e_test_3"] });
  assert.equal(receipt.state, "accepted");
  return receipt.conversationId;
}

async function finish(h: ReturnType<typeof conversationHarness>, step: AiTeamStep, report: string): Promise<void> {
  const file = path.join(h.cwd, step.reportPath);
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, report);
  const session = h.sessions.get(step.sessionId!)!;
  h.sessions.set(session.id, { ...session, structuredState: { ...session.structuredState!, inFlight: false } });
  h.runner.ingest({ type: "status", sessionId: session.id }); await h.runner.idle();
}

test("@ member owns only this run, dispatches real duty steps after approval, and each member reports separately", async t => {
  const h = conversationHarness(t), id = await group(h), requestId = randomUUID();
  const before = JSON.stringify(h.storage.getConversation(id)!.team);
  const text = "@员工 2 先出设计，再让员工 3 实现，不包办";
  const receipt = await h.service.send(id, requestId, text, null); await h.runner.idle();
  assert.equal(receipt.state, "accepted", receipt.error); assert.equal(receipt.startup, "started"); assert.ok(receipt.runId);
  assert.deepEqual(await h.service.send(id, requestId, text, null), receipt);
  assert.equal(h.storage.listWandTasks().length, 1); assert.equal(h.storage.listAiTeamRuns().length, 1);
  assert.equal(h.storage.getConversation(id)!.communicationSessionId, null, "no fallback to the default speaker");
  const run = h.runner.detail(receipt.runId!).run;
  const lead = run.team.members.find(m => m.employeeId === "e_test_2")!;
  const worker = run.team.members.find(m => m.employeeId === "e_test_3")!;
  assert.equal(lead.isLeader, true); assert.equal(run.team.allowLeaderWork, true);
  assert.equal(JSON.stringify(h.storage.getConversation(id)!.team), before);
  assert.equal(h.executions[0]?.employee?.id, "e_test_2");
  const system = buildLeaderKickoffPrompt(run, "report.json", true).system;
  assert.match(system, /用户通过 @ 指定你为本轮负责人/); assert.match(system, /不代表所有工作都由你执行/);
  assert.match(system, /独立 work 会话/); assert.match(system, /职责 1/); assert.match(system, /职责 3/);
  assert.doesNotMatch(system, /仅员工 1 的角色|仅员工 3 的角色/, "no other employee's private persona in coordinator prompt");
  const planning = h.runner.detail(run.id).steps[0]!;
  await finish(h, planning, JSON.stringify({ action: "assign", message: "按职责安排设计与实现", steps: [
    { member: lead.id, title: "设计", instructions: "只写设计，明确替身", after: [] },
    { member: worker.id, title: "实现", instructions: "只按设计实施，明确替身", after: [1] },
  ] }));
  assert.equal(h.runner.detail(run.id).run.status, "awaiting_approval");
  assert.equal(h.executions.length, 1, "@ does not bypass plan approval");
  const approved = await h.service.act(id, randomUUID(), { taskId: run.taskId, runId: run.id }, "approve");
  assert.equal(approved.state, "accepted");
  const design = h.runner.detail(run.id).steps.find(s => s.kind === "work" && s.memberId === lead.id)!;
  assert.notEqual(design.sessionId, planning.sessionId, "professional work never reuses the JSON planner context");
  assert.equal(h.executions[1]?.employee?.id, "e_test_2");
  assert.match(h.executions[1]?.systemPrompt ?? "", /Markdown/);
  await finish(h, design, "状态: 完成\n明确替身设计报告，无真实模型。");
  const work = h.runner.detail(run.id).steps.find(s => s.kind === "work" && s.memberId === worker.id)!;
  assert.equal(work.status, "running"); assert.equal(h.executions[2]?.employee?.id, "e_test_3");
  await finish(h, work, "状态: 完成\n明确替身实现报告，无真实模型。");
  const summary = h.runner.detail(run.id).steps.filter(s => s.kind === "leader").at(-1)!;
  assert.equal(summary.sessionId, planning.sessionId, "summary returns to coordinator, not their work session");
  await finish(h, summary, JSON.stringify({ action: "finish", message: "设计与实现均有独立报告" }));
  assert.equal(h.runner.detail(run.id).run.status, "done");
  const messages = h.service.detail(id).messages;
  assert.equal(messages.filter(m => m.role === "user" && m.requestId === requestId).length, 1);
  assert.ok(messages.some(m => m.reportFile?.stepId === design.id && m.author?.id === lead.id));
  assert.ok(messages.some(m => m.reportFile?.stepId === work.id && m.author?.id === worker.id));
  const second = await h.service.dispatch(id, randomUUID(), { description: "@员工 3 下一轮请协调", workspaceId: h.workspace.id }); await h.runner.idle();
  assert.equal(h.runner.detail(second.runId!).run.team.members.find(m => m.isLeader)?.employeeId, "e_test_3");
  assert.equal(h.storage.getAiTeamRun(run.id)?.team.members.find(m => m.isLeader)?.employeeId, "e_test_2");
  assert.equal(JSON.stringify(h.storage.getConversation(id)!.team), before);
});

test("ordinary group talk never dispatches; DM dispatch stays with its peer despite body mentions", async t => {
  const h = conversationHarness(t), id = await group(h);
  await h.service.send(id, randomUUID(), "请看 @员工 2 的回复", null);
  await h.service.send(employeeConversationId("e_test_1"), randomUUID(), "@员工 2 只是私聊原文", null); await h.runner.idle();
  assert.equal(h.storage.listAiTeamRuns().length, 0); assert.equal(h.sent.length, 2);
  assert.equal(h.sessions.get(h.sent[1]!.id)?.employeeId, "e_test_1");
  for (const input of ["@不存在 修改", "@员工 2"]) assert.equal((await h.service.send(id, randomUUID(), input, null)).state, "rejected");
  const employee = h.storage.getSiliconEmployee("e_test_2")!;
  h.storage.saveSiliconEmployee({ ...employee, archivedAt: new Date().toISOString() });
  const receipt = await h.service.send(id, randomUUID(), "@员工 2 安排协作", null);
  assert.equal(receipt.state, "rejected"); assert.match(receipt.error!, /已归档/);
  assert.equal(h.storage.listWandTasks().length, 0); assert.equal(h.executions.length, 0);
});

test("active tasks keep exact run ownership: @ cannot silently replace a leader or create duplicate work", async t => {
  const h = conversationHarness(t), id = await group(h);
  const first = await h.service.send(id, randomUUID(), "@员工 2 安排协作", null); await h.runner.idle();
  const target = { taskId: first.taskId!, runId: first.runId! };
  const replaced = await h.service.send(id, randomUUID(), "@员工 3 继续", target);
  assert.equal(replaced.state, "rejected"); assert.match(replaced.error!, /本轮负责人已确定/);
  assert.equal((await h.service.send(id, randomUUID(), "@员工 2 继续", null)).state, "rejected");
  assert.equal((await h.service.send(id, randomUUID(), "@员工 2 补充验收标准", target)).state, "accepted");
  assert.equal(h.storage.listAiTeamRuns().length, 1);
  assert.equal(h.storage.getAiTeamRun(first.runId!)?.team.members.find(m => m.isLeader)?.employeeId, "e_test_2");
});

test("ambiguous/no work project never guesses; explicit task form preserves @ coordinator", async t => {
  const h = conversationHarness(t), id = await group(h);
  h.storage.createWorkspace({ name: "同目录另一个项目", cwd: h.cwd });
  const rejected = await h.service.send(id, randomUUID(), "@员工 2 安排协作", null);
  assert.equal(rejected.state, "rejected"); assert.match(rejected.error!, /选择项目/);
  assert.equal(h.storage.listWandTasks().length, 0); assert.equal(h.executions.length, 0);
  const accepted = await h.service.dispatch(id, randomUUID(), { description: "@员工 2 安排协作", workspaceId: h.workspace.id }); await h.runner.idle();
  assert.equal(accepted.state, "accepted");
  assert.equal(h.runner.detail(accepted.runId!).run.team.members.find(m => m.isLeader)?.employeeId, "e_test_2");
});

test("@ send shares durable task acceptance: startup failure is accepted, deduplicated, and never sent to another speaker", async t => {
  const h = conversationHarness(t), id = await group(h), requestId = randomUUID();
  let attempts = 0;
  h.structured.createRelaySession = () => { attempts++; assert.equal(h.service.receipt(requestId)?.state, "accepted"); throw new Error("明确替身 relay 故障"); };
  const text = "@员工 2 安排协作";
  const receipt = await h.service.send(id, requestId, text, null);
  assert.equal(receipt.state, "accepted"); assert.equal(receipt.startup, "failed"); assert.ok(receipt.taskId);
  assert.deepEqual(await h.service.send(id, requestId, text, null), receipt);
  assert.equal(attempts, 1); assert.equal(h.storage.listWandTasks().length, 1); assert.equal(h.sent.length, 0);
  assert.equal(h.storage.getConversation(id)?.team?.members.find(m => m.isLeader)?.employeeId, "e_test_1");
});

test("uploaded group input keeps the whole original envelope while routing only the user address", async t => {
  const h = conversationHarness(t), id = await group(h);
  const text = "[附件已上传，请查看以下文件:\n/tmp/@员工 1.png\n]\n\n@员工 2 请安排设计与实现";
  const receipt = await h.service.send(id, randomUUID(), text, null); await h.runner.idle();
  assert.equal(receipt.state, "accepted"); assert.ok(receipt.runId);
  const run = h.runner.detail(receipt.runId!).run;
  assert.equal(run.team.members.find(m => m.isLeader)?.employeeId, "e_test_2");
  assert.ok(run.objective.includes(text));
  assert.equal(h.storage.getWandTask(receipt.taskId!)?.title, "请安排设计与实现");
  assert.ok(h.service.detail(id).messages.some(m => m.role === "user" && m.content.some(b => b.type === "text" && b.text === text)));
});
