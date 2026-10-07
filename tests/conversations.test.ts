import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { ConversationService } from "../src/conversation-service.js";
import { employeeConversationId } from "../src/conversation-types.js";
import { registerConversationRoutes } from "../src/server-conversation-routes.js";
import { buildLeaderKickoffPrompt, parseLeaderDecision } from "../src/ai-team-prompts.js";
import type { AiTeam } from "../src/ai-team-types.js";
import type { WandConfig } from "../src/types.js";
import { conversationHarness as harness } from "./helpers/conversation-harness.js";

test("opening an employee is read-only; each DM send creates its own session and keeps the original message", async t => {
  const h = harness(t); const id = employeeConversationId("e_test_1");
  const before = h.storage.listWandTasks().length;
  assert.equal(h.service.detail(id).sessionId, null); assert.equal(h.service.list().length, 0);
  assert.equal(h.executions.length, 0); assert.equal(h.sent.length, 0);
  const receipt = await h.service.send(id, randomUUID(), "私聊里的原文", null);
  assert.equal(receipt.state, "accepted"); assert.equal(h.storage.listWandTasks().length, before);
  assert.equal(h.storage.listAiTeamRuns().length, 0); assert.equal(h.service.detail(id).messages.length, 2);
  assert.equal(h.service.detail(id).messages[0]?.content[0]?.type, "text");
  assert.equal(h.service.detail(id).messages[1]?.sessionLink?.sessionId, receipt.sessionId);
  assert.equal(h.service.detail(id).communicationSessionId, null);
  assert.equal(h.sessions.get(receipt.sessionId!)?.workspaceId, h.workspace.id);
  h.storage.saveSiliconEmployee({ ...h.storage.getSiliconEmployee("e_test_1")!, name: "已改名" });
  assert.equal(h.service.detail(id).title, "已改名");
  assert.equal(h.service.detail(id).messages[1]?.author?.name, "员工 1");
});

test("empty groups are durable before a task and preserve copied preset / legacy identities", async t => {
  const h = harness(t); const before = JSON.stringify(h.storage.getAiTeam(h.template.id));
  const receipt = await h.service.createGroup(randomUUID(), { templateId: h.template.id });
  assert.equal(receipt.state, "accepted"); const group = h.service.detail(receipt.conversationId);
  assert.equal(group.tasks.length, 0); assert.equal(group.sessionId, null); assert.equal(h.sessions.size, 0); assert.equal(h.executions.length, 0);
  assert.equal(group.team?.instructions, h.template.instructions); assert.equal(group.team?.members.length, 4);
  assert.equal(JSON.stringify(h.storage.getAiTeam(h.template.id)), before);
  const secondClient = new ConversationService({ storage: h.storage, structured: h.structured, runner: h.runner, config: { defaultCwd: h.cwd } as WandConfig });
  assert.equal(secondClient.detail(group.id).id, group.id);
  assert.equal((await h.service.createGroup(randomUUID(), { employeeIds: ["e_test_1", "e_test_1"] })).state, "rejected");
  const legacy: AiTeam = { ...h.template, id: "legacy", members: h.template.members.map((m, i) => ({ ...m, employeeId: undefined, id: `m_legacy${i}` })) };
  h.storage.saveAiTeam(legacy);
  const legacyGroup = await h.service.createGroup(randomUUID(), { templateId: legacy.id });
  assert.equal(h.service.detail(legacyGroup.conversationId).team?.members[0]?.legacyTemplateId, legacy.id);
  assert.equal(h.storage.listSiliconEmployees().length, 4);
});

test("single employee self-assigns real work in the existing runner with separate stage contexts and report delivery", async t => {
  const h = harness(t); const receipt = await h.dispatch(await h.group(), "任务甲");
  const instance = h.service.detail(receipt.conversationId);
  assert.equal(instance.team?.members.length, 1); assert.equal(instance.title, "任务甲");
  const run = h.runner.detail(receipt.runId!).run; const member = run.team.members[0]!;
  const prompt = buildLeaderKickoffPrompt(run, "report.json", true).system;
  assert.match(prompt, /本群只有你一位员工/); assert.match(prompt, /不能声称独立交叉验收/);
  const parsed = parseLeaderDecision(JSON.stringify({ action: "assign", message: "实现这一步", steps: [{ member: member.id, title: "实现", instructions: "明确测试替身工作" }] }), run.team);
  assert.equal(parsed.ok, true);
  let leaderStep = h.runner.detail(run.id).steps.find(s => s.kind === "leader")!;
  mkdirSync(path.dirname(path.join(h.cwd, leaderStep.reportPath)), { recursive: true });
  writeFileSync(path.join(h.cwd, leaderStep.reportPath), JSON.stringify({ action: "assign", message: "规划完成", steps: [{ member: member.id, title: "实现", instructions: "明确测试替身工作" }] }));
  const leaderSession = h.sessions.get(leaderStep.sessionId!)!;
  h.sessions.set(leaderSession.id, { ...leaderSession, structuredState: { ...leaderSession.structuredState!, inFlight: false } });
  h.runner.ingest({ type: "status", sessionId: leaderSession.id }); await h.runner.idle();
  assert.equal(h.runner.detail(run.id).run.status, "awaiting_approval");
  const approval = await h.service.act(instance.id, randomUUID(), { taskId: run.taskId, runId: run.id }, "approve");
  assert.equal(approval.state, "accepted");
  const work = h.runner.detail(run.id).steps.find(s => s.kind === "work")!;
  assert.equal(work.memberId, member.id); assert.notEqual(work.sessionId, leaderStep.sessionId);
  assert.equal(h.executions[1]?.employee?.id, "e_test_1"); assert.match(h.executions[1]?.systemPrompt ?? "", /Markdown/);
  writeFileSync(path.join(h.cwd, work.reportPath), "状态: 完成\n明确测试替身报告。\n验证：未调用真实模型。");
  const workSession = h.sessions.get(work.sessionId!)!;
  h.sessions.set(workSession.id, { ...workSession, structuredState: { ...workSession.structuredState!, inFlight: false } });
  h.runner.ingest({ type: "status", sessionId: workSession.id }); await h.runner.idle();
  assert.ok(h.service.detail(instance.id).messages.some(m => m.reportFile?.stepId === work.id));
  leaderStep = h.runner.detail(run.id).steps.filter(s => s.kind === "leader").at(-1)!;
  assert.equal(leaderStep.sessionId, leaderSession.id);
  writeFileSync(path.join(h.cwd, leaderStep.reportPath), JSON.stringify({ action: "finish", message: "已交付明确测试替身结果" }));
  h.sessions.set(leaderSession.id, { ...h.sessions.get(leaderSession.id)!, structuredState: { ...leaderSession.structuredState!, inFlight: false } });
  h.runner.ingest({ type: "status", sessionId: leaderSession.id }); await h.runner.idle();
  assert.equal(h.runner.detail(run.id).run.status, "done");
  const before = h.storage.listAiTeamRuns().length;
  assert.equal((await h.service.send(instance.id, randomUUID(), "好", null)).state, "accepted");
  assert.equal(h.storage.listAiTeamRuns().length, before);
  assert.equal(h.service.detail(employeeConversationId("e_test_1")).messages.length, 0, "explicit group work does not invent a DM link");
});

test("legacy DM task links remain readable; explicit auto groups follow task titles", async t => {
  const h = harness(t); const dm = employeeConversationId("e_test_1");
  const groupId = await h.group();
  const first = await h.dispatch(groupId, "整理发布清单");
  // Preserved pre-refactor history; reading it must never migrate or redispatch it.
  h.storage.saveConversation(h.service.pendingEmployee("e_test_1"));
  h.storage.appendConversationEvent(dm, { role: "user", content: [{ type: "text", text: "整理发布清单" }] });
  h.storage.appendConversationEvent(dm, { role: "assistant", notice: true, requestId: first.requestId,
    conversationLink: { conversationId: groupId, taskId: first.taskId!, title: "整理发布清单" },
    content: [{ type: "text", text: "我正在处理「整理发布清单」，进展在任务群实时同步。" }] });
  const group = h.service.detail(groupId);
  assert.equal(group.name, "整理发布清单"); assert.equal(group.nameSource, "auto"); assert.equal(group.title, "整理发布清单");
  assert.equal(group.team?.members.length, 1);
  // 原文和一个只读进度卡成对保留；不复制第二份执行历史。
  const messages = h.service.detail(dm).messages;
  assert.equal(messages.length, 2); assert.equal(messages[0]?.role, "user");
  const notices = messages.filter(message => message.conversationLink);
  assert.equal(notices.length, 1); assert.equal(notices[0]?.notice, true);
  assert.equal(notices[0]?.content.map(b => b.type === "text" ? b.text : "").join(""), "我正在处理「整理发布清单」，进展在任务群实时同步。");
  assert.deepEqual(notices[0]?.conversationLink, { conversationId: groupId, taskId: first.taskId, title: "整理发布清单" });
  assert.equal(h.service.detail(dm).tasks.length, 0);
  // 自动群名继续跟随最新任务；自定义群名不被覆盖。
  await h.dispatch(groupId, "第二轮任务"); await h.runner.idle();
  assert.equal(h.service.detail(groupId).name, "第二轮任务");
  const custom = await h.service.createGroup(randomUUID(), { employeeIds: ["e_test_1"], name: "自定义群" });
  await h.dispatch(custom.conversationId, "不改名任务"); await h.runner.idle();
  assert.equal(h.service.detail(custom.conversationId).name, "自定义群");
  // 预设群保留模板名，不被任务标题覆盖。
  const preset = await h.service.createGroup(randomUUID(), { templateId: h.template.id });
  await h.dispatch(preset.conversationId, "预设群任务"); await h.runner.idle();
  assert.equal(h.service.detail(preset.conversationId).name, h.template.name);
});

test("same group has independent tasks; exact-target stop and invite never mutate another run or preset", async t => {
  const h = harness(t); const id = await h.group(); const a = await h.dispatch(id, "任务 A"); const b = await h.dispatch(id, "任务 B");
  const group = h.service.detail(id); assert.equal(group.title, "任务 B"); assert.deepEqual(group.tasks.map(t => t.task.title), ["任务 A", "任务 B"]);
  assert.equal(h.storage.getSessionWorkspace(group.sessionId!)?.workspaceTaskId ?? null, null);
  assert.equal(h.runner.detail(a.runId!).chatTitle, "任务 A");
  const oldRun = h.storage.getAiTeamRun(a.runId!)!; const snapshot = JSON.stringify(oldRun.team);
  const template = JSON.stringify(h.storage.getAiTeam(h.template.id));
  const invitation = await h.service.invite(id, randomUUID(), group.memberVersion, { templateId: h.template.id });
  assert.equal(invitation.state, "accepted"); assert.equal(h.service.detail(id).team?.members.length, 4);
  assert.equal(JSON.stringify(h.storage.getAiTeamRun(a.runId!)!.team), snapshot); assert.equal(JSON.stringify(h.storage.getAiTeam(h.template.id)), template);
  assert.ok(h.service.detail(id).messages.some(m => m.notice && m.content.some(b => b.type === "text" && b.text.includes("我邀请了"))));
  assert.equal((await h.service.act(id, randomUUID(), { taskId: a.taskId!, runId: b.runId! }, "stop")).state, "rejected");
  assert.equal((await h.service.act(id, randomUUID(), { taskId: a.taskId!, runId: a.runId! }, "stop")).state, "accepted");
  assert.equal(h.storage.getAiTeamRun(a.runId!)?.status, "stopped"); assert.equal(h.storage.getAiTeamRun(b.runId!)?.status, "running");
  const next = await h.service.dispatch(id, randomUUID(), { description: "明确继续任务 A", workspaceId: h.workspace.id, continueTaskId: a.taskId }); await h.runner.idle();
  assert.equal(next.taskId, a.taskId); assert.equal(h.storage.getAiTeamRun(next.runId!)?.team.members.length, 4);
  assert.equal(h.storage.getAiTeamRun(next.runId!)?.roundNumber, 2); assert.equal(h.service.detail(id).tasks.length, 2);
  h.storage.updateWandTask(a.taskId!, { title: "A 改名" }); assert.equal(h.service.detail(id).title, "任务 B");
  h.storage.updateWandTask(b.taskId!, { title: "B 完整新名称" }); assert.equal(h.service.detail(id).title, "B 完整新名称");
});

test("request ledger deduplicates creation / send and pending records never execute again", async t => {
  const h = harness(t); const requestId = randomUUID(); const body = { employeeIds: ["e_test_1"], name: "自定义群" };
  const first = await h.service.createGroup(requestId, body); const second = await h.service.createGroup(requestId, body);
  assert.deepEqual(first, second); assert.equal(h.service.list().length, 1);
  const inputId = randomUUID(); await h.service.send(first.conversationId, inputId, "群范围普通沟通", null);
  const sent = h.sent.length; await h.service.send(first.conversationId, inputId, "群范围普通沟通", null); assert.equal(h.sent.length, sent);
  assert.equal(h.service.receipt(inputId)?.state, "accepted");
  const task = await h.dispatch(first.conversationId, "task 不覆盖自定义群名"); assert.equal(h.service.detail(first.conversationId).title, "自定义群");
  const row = h.storage.getConversationRequest(requestId)!; row.receipt.state = "pending"; h.storage.saveConversationRequest(row);
  assert.equal((await h.service.createGroup(requestId, body)).state, "pending"); assert.equal(h.service.list().length, 1);
  const app = express(); app.use(express.json()); registerConversationRoutes(app, h.service);
  const server = app.listen(0, "127.0.0.1"); t.after(() => server.close()); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/conversations/${first.conversationId}/actions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: randomUUID(), action: "stop", target: { taskId: task.taskId, runId: task.runId } }),
  });
  assert.equal(response.status, 202); assert.equal((await response.json() as { state: string }).state, "accepted");
});

test("conversation pin/dissolve/restore preserve history and execution; deletion removes linked tasks and exact run resources", async t => {
  const h = harness(t); const first = await h.group(); const second = await h.group();
  const dispatched = await h.dispatch(first, "待删除任务");
  const before = h.service.detail(first);
  h.service.updateListState(first, { pinned: true });
  assert.equal(h.service.list()[0]?.id, first);
  const pinnedAt = h.service.detail(first).pinnedAt;
  h.service.updateListState(first, { pinned: true });
  assert.equal(h.service.detail(first).pinnedAt, pinnedAt);
  h.service.updateListState(first, { dissolved: true });
  assert.equal(h.service.list().some(row => row.id === first), true);
  assert.ok(h.service.detail(first).dissolvedAt); assert.equal(h.service.detail(first).dissolvedBy, "我");
  assert.deepEqual(h.service.detail(first).messages, before.messages);
  assert.equal(h.storage.getAiTeamRun(dispatched.runId!)?.status, "running", "archiving is not process termination");
  assert.equal((await h.service.send(first, randomUUID(), "不得发送", null)).state, "rejected");
  assert.equal((await h.service.dispatch(first, randomUUID(), { title: "不得派工", description: "test", workspaceId: h.workspace.id })).state, "rejected");
  h.storage.saveConversation(h.storage.getConversation(first)!);
  assert.ok(h.service.detail(first).dissolvedAt, "channel saves cannot clobber lifecycle state");
  h.service.updateListState(first, { dissolved: false });
  assert.equal(h.service.detail(first).dissolvedAt, null);
  const run = h.storage.getAiTeamRun(dispatched.runId!)!;
  const resources = path.join(run.cwd, ".wand-team", run.id);
  mkdirSync(resources, { recursive: true }); writeFileSync(path.join(resources, "extra-resource.txt"), "owned");
  const other = path.join(run.cwd, ".wand-team", "another-run"); mkdirSync(other, { recursive: true }); writeFileSync(path.join(other, "keep.txt"), "keep");
  await Promise.all([h.service.remove(first), h.service.remove(first)]); await h.runner.idle();
  assert.equal(h.storage.getConversation(first), null); assert.equal(h.storage.getWandTask(dispatched.taskId!), null);
  assert.equal(h.storage.getAiTeamRun(run.id), null); assert.equal(existsSync(resources), false); assert.equal(existsSync(other), true);
  assert.equal(h.service.detail(second).id, second);
  assert.equal((await h.service.dispatch(first, randomUUID(), { description: "cannot resurrect", workspaceId: h.workspace.id })).state, "rejected");
  await h.service.remove(first);
});

test("DM deletion removes its messages/channels but preserves employee and dispatched group; stale receipts never recreate it", async t => {
  const h = harness(t); const id = employeeConversationId("e_test_1");
  const channel = (await h.service.prepare(id, randomUUID())).sessionId!;
  const request = randomUUID(); await h.service.send(id, request, "to delete", null);
  const task = await h.dispatch(await h.group(), "独立群任务保留");
  const directSession = h.service.receipt(request)!.sessionId!;
  assert.throws(() => h.service.updateListState(id, { dissolved: true }), /只有群聊/);
  await h.service.remove(id);
  assert.equal(h.storage.getConversation(id), null); assert.equal(h.sessions.has(channel), false);
  assert.equal(h.sessions.has(directSession), false);
  assert.deepEqual(h.service.detail(id).messages, []); assert.ok(h.storage.getSiliconEmployee("e_test_1"));
  assert.ok(h.storage.getWandTask(task.taskId!)); assert.ok(h.storage.getConversation(task.conversationId));
  await h.service.send(id, request, "to delete", null);
  assert.equal(h.storage.getConversation(id), null);
  await h.service.send(id, randomUUID(), "new conversation", null);
  assert.notEqual(h.service.detail(id).communicationSessionId, channel);
  assert.equal(h.service.detail(id).messages.some(message => message.content.some(block => block.type === "text" && block.text === "to delete")), false);
});

test("a late failed communication cannot resurrect a deleted channel or append to another group", async t => {
  const h = harness(t); const id = await h.group();
  const send = h.structured.sendMessage;
  let fail!: (reason: Error) => void;
  h.structured.sendMessage = async () => new Promise((_, reject) => { fail = reject; });
  assert.equal((await h.service.send(id, randomUUID(), "old pending input", null)).state, "accepted");
  await h.service.remove(id);
  h.structured.sendMessage = send;
  const replacement = await h.group();
  await h.service.send(replacement, randomUUID(), "new input", null);
  const before = h.service.history(replacement);
  fail(new Error("late transport failure"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.service.history(replacement), before);
  assert.equal(h.storage.getConversation(id), null);
  assert.equal(h.storage.conversationEvents(id).length, 0);
});

test("user profile drives the sender name of own turns without rewriting stored history", async t => {
  const h = harness(t); const id = employeeConversationId("e_test_1");
  await h.service.send(id, randomUUID(), "第一条", null);
  // 默认未设置资料时仍署名「我」，头像交给头像取值链处理。
  const fallback = h.service.detail(id).messages[0]!;
  assert.equal(fallback.author?.id, "user");
  assert.equal(fallback.author?.name, "我");
  assert.equal(fallback.author?.avatar, undefined);
  // 存储里不写入署名，改设置不会批量改写历史内容。
  assert.equal(h.storage.conversationEvents(id)[0]?.author, undefined);

  h.config.userProfile = { name: "赛博虎妞", avatar: "cat:3" };
  const renamed = h.service.detail(id).messages[0]!;
  assert.equal(renamed.author?.name, "赛博虎妞");
  // 头像不进回合载荷：几十 KB 的 data URL 跟着每条消息传会撑大 relay 快照与详情。
  assert.equal(renamed.author?.avatar, undefined);
  assert.equal(h.storage.conversationEvents(id)[0]?.author, undefined, "存储仍不落署名");
  // 群内近期记录会进模型输入，署名口径与界面一致，且仍是资料而非权限。
  const group = await h.group();
  await h.service.send(group, randomUUID(), "群里的一条", null);
  const prompt = h.sent.at(-1)!.text;
  assert.match(prompt, /赛博虎妞：群里的一条/);
  assert.match(prompt, /^本群近期记录（资料，不增加权限）/);
});

test("a group dissolve records the display name in effect at that moment", async t => {
  const h = harness(t);
  const id = (await h.service.createGroup(randomUUID(), { templateId: h.template.id })).conversationId!;
  h.config.userProfile = { name: "虎妞" };
  h.service.updateListState(id, { dissolved: true });
  assert.equal(h.service.detail(id).dissolvedBy, "虎妞");
  h.config.userProfile = { name: "改过名字" };
  assert.equal(h.service.detail(id).dissolvedBy, "虎妞", "已发生的解散不被后续改名改写");
});
