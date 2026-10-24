import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { registerDingTalkRoutes } from "../src/server-dingtalk-routes.js";
import { requireAdmin } from "../src/middleware/auth.js";
import { BROWSER_ADMIN_PRINCIPAL, CONNECTED_APP_PRINCIPAL } from "../src/auth.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DingTalkService, dingTalkId, dingTalkFinalText } from "../src/dingtalk-service.js";
import { DingTalkError, dwsPayload, type DwsTransport } from "../src/dingtalk-dws.js";
import type { DingTalkBinding, DingTalkJob, DingTalkRobot, DingTalkRun } from "../src/dingtalk-types.js";
import type { ProcessEvent, SessionSnapshot } from "../src/types.js";
import { conversationHarness } from "./helpers/conversation-harness.js";
import { parseJsonResponse } from "../src/web-ui/react/http-adapter.js";

// Explicit protocol doubles. No DWS binary, OAuth endpoint, WebSocket or paid model is invoked.
function fixture(t: test.TestContext, options: { approval?: boolean; unknownSubmit?: boolean; omitCode?: boolean; unavailable?: boolean; profileGate?: () => Promise<void> } = {}) {
  const h = conversationHarness(t), calls: string[][] = [], members = new Map<string, Set<string>>(), releases = new Set<string>(), payloads: Array<{ args: string[]; input?: string }> = []; let robot = 0;
  const dws: DwsTransport = {
    async call(args, callOptions) {
      calls.push(args); payloads.push({ args, input: callOptions?.input });
      if (options.unavailable) throw new DingTalkError("unavailable", "DWS 不可用，请先安装连接器依赖。");
      const flag = (key: string) => args[args.indexOf(key) + 1];
      if (args[0] === "profile") { await options.profileGate?.(); return { profiles: [{ profile: "corp:owner", corpId: "corp", userId: "owner", userName: "授权人" }] }; }
      if (args[0] === "auth") return { authenticated: true };
      if (args.includes("+my-groups")) return { groups: [{ openConversationId: "group-a", name: "群 A" }, { openConversationId: "group-b", name: "群 B" }], hasMore: false };
      if (args.includes("submit")) { if (options.unknownSubmit) throw new DingTalkError("timeout", "未确认", true); return { taskId: `task-${++robot}` }; }
      if (args.includes("result")) return { status: "SUCCESS", unifiedAppId: flag("--task-id").replace("task-", "app-") };
      if (args.includes("robot") && args.includes("get")) return { mode: "STREAM", status: "ONLINE", ...(options.omitCode ? {} : { robotCode: flag("--unified-app-id") }) };
      if (args.includes("version") && args.includes("create")) return { versionId: `version-${flag("--unified-app-id")}` };
      if (args.includes("check-approval")) return { requiresApproval: !!options.approval, publishable: !options.approval };
      if (args.includes("version") && args.includes("status")) return { versionStatus: releases.has(flag("--version-id")) ? "RELEASE" : "INIT" };
      if (args.includes("version") && args.includes("publish")) { releases.add(flag("--version-id")); return { published: true }; }
      if (args.includes("credentials")) return { clientId: `client-${flag("--unified-app-id")}`, clientSecret: "fixture-not-a-real-secret" };
      if (args.includes("+bot-search")) return { robots: [{ robotName: "同名诱饵", robotCode: "wrong-code" }, { robotName: "实际机器人", robotCode: "client-app-1" }] };
      if (args[0] === "chat" && args[1] === "group" && args[2] === "bots") return { bots: [...(members.get(flag("--group")) ?? [])].map(robotCode => ({ robotCode })) };
      if (args.includes("+chat-add-bot")) { const id = flag("--id"); const set = members.get(id) ?? new Set(); set.add(flag("--robot-code")); members.set(id, set); return { added: true }; }
      if (args.includes("+chat-messages")) return { messages: [], hasMore: false };
      if (args.includes("+messages-send")) return { openMessageId: "outbound-fixture-id" };
      return { success: true };
    },
    stream() { return { close() {} }; },
  };
  const service = new DingTalkService({ storage: h.storage, dws, config: h.config, structured: h.structured, changed() {},
    robotStream: (() => ({ start() {}, dispose() {} })) as any });
  h.service.attachExternal(service); h.storage.onClose(() => service.dispose());
  const settled = async (job: DingTalkJob) => {
    for (let i = 0; i < 200; i++) { const current = h.storage.getDingTalkRecord<DingTalkJob>("job", job.id)!; if (current.state !== "running") return current; await new Promise(r => setTimeout(r, 2)); }
    throw new Error("fixture provisioning did not settle");
  };
  const connect = async (groups = ["group-a"], employees = ["e_test_1"]) => {
    await service.discover("corp:owner"); const plan = await service.plan({ accountId: "corp:owner", groupIds: groups, employeeIds: employees });
    const job = await service.connect(plan.id, true); await settled(job); return { plan, job: h.storage.getDingTalkRecord<DingTalkJob>("job", job.id)! };
  };
  return { ...h, conversations: h.service, service, calls, payloads, connect, settled };
}

test("missing DWS is a valid status, not the shared HTTP error envelope that hides the install button", async t => {
  const h = fixture(t, { unavailable: true }), status = await h.service.status();
  assert.equal(status.installed, false); assert.equal("error" in status, false);
  assert.equal(status.diagnostic, "DWS 不可用，请先安装连接器依赖。");
  const parsed = await parseJsonResponse<typeof status>(new Response(JSON.stringify(status), { status: 200 }));
  assert.equal(parsed.installed, false); assert.deepEqual(parsed.accounts, []);
  assert.deepEqual(h.calls, [["auth", "status"]], "status checking only probes, never installs");
});

test("DWS envelopes unwrap structured helpers and reject business errors without exposing bodies", () => {
  assert.deepEqual(dwsPayload({ data: { response: { content: [{ type: "text", text: '{"success":true,"result":{"taskId":"fixture"}}' }] } } }).taskId, "fixture");
  assert.equal(dwsPayload([{ robotCode: "fixture" }]).items[0].robotCode, "fixture");
  assert.throws(() => dwsPayload({ success: false, errorMsg: "credential-canary" }), e => e instanceof DingTalkError && !e.message.includes("credential-canary"));
});

test("multiple employees share one group mirror and cross-group robots are reused", async t => {
  const h = fixture(t);
  const first = await h.connect(["group-a"], ["e_test_1", "e_test_2"]);
  assert.equal(first.job.state, "done"); assert.equal(h.storage.listConversations().length, 1);
  assert.equal(h.storage.listDingTalkRecords("robot").length, 2);
  assert.equal(h.calls.filter(c => c.includes("submit")).length, 2);
  const second = await h.connect(["group-a", "group-b"], ["e_test_1"]);
  assert.equal(second.plan.pairs.filter(p => p.existing).length, 1); assert.equal(second.plan.newRobots, 0);
  assert.equal(h.calls.filter(c => c.includes("submit")).length, 2);
  assert.equal(h.storage.listConversations().length, 2);
  const detail = h.service.groupForConversation(h.storage.listConversations()[0]!.id)!;
  const mirror = h.storage.getConversation(detail.conversationId)!;
  assert.equal(mirror.team, null); assert.equal(mirror.external?.provider, "dingtalk");
  assert.equal(JSON.stringify(await h.service.status()).includes("fixture-not-a-real-secret"), false);
  assert.equal(readFileSync(h.storage.databasePath()).includes(Buffer.from("fixture-not-a-real-secret")), false);
});

test("robot identity falls back to an actual owned stable code, never the first fuzzy name", async t => {
  const h = fixture(t, { omitCode: true }); const { job } = await h.connect();
  assert.equal(job.state, "done");
  assert.equal(h.storage.listDingTalkRecords<DingTalkRobot>("robot")[0]!.robotCode, "client-app-1");
  assert.equal(h.calls.some(c => c[0] === "chat" && c[1] === "group" && c[2] === "bots"), true);
});

test("initial fixed Agent keeps its exact existing mode, never the first same-tool candidate or the employee default", async t => {
  const h = fixture(t), employee = h.storage.getSiliconEmployeeDefinition("e_test_1")!;
  const existing = employee.agents[0]!;
  h.storage.saveSiliconEmployee({ ...employee, agents: [{ ...existing, mode: "default" }, { ...existing, mode: "full-access" }] });
  await h.service.discover("corp:owner");
  await assert.rejects(h.service.plan({ accountId: "corp:owner", groupIds: ["group-a"], employeeIds: [employee.id] }), /交互授权/);
  const plan = await h.service.plan({ accountId: "corp:owner", groupIds: ["group-a"], employeeIds: [employee.id], candidateIndices: { [employee.id]: 1 } });
  assert.equal(plan.employees[0]!.agent!.mode, "full-access");
  await h.settled(await h.service.connect(plan.id, true));
  const binding = h.storage.listDingTalkRecords<DingTalkBinding>("binding")[0]!, robot = h.storage.listDingTalkRecords<DingTalkRobot>("robot")[0]!;
  assert.equal(binding.fixedAgent!.mode, "full-access");
  await h.service.receiveRobot(robot.id, { conversationType: "2", robotCode: robot.robotCode, chatbotCorpId: "corp", senderCorpId: "corp", conversationId: "group-a", senderStaffId: "owner", msgId: "fixed-request", msgtype: "text", text: { content: "按选定候选执行" } });
  assert.equal(h.sessions.get(h.sent[0]!.id)!.mode, "full-access");
  assert.equal(h.storage.getSiliconEmployeeDefinition(employee.id)!.agents[0]!.mode, "default");
  assert.throws(() => h.service.updateBinding(binding.id, { candidateIndex: 0 }), /交互授权/);
});

test("plan confirmation and employee revision are required before any remote write", async t => {
  const h = fixture(t); await h.service.discover("corp:owner");
  const plan = await h.service.plan({ accountId: "corp:owner", groupIds: ["group-a"], employeeIds: ["e_test_1"] });
  await assert.rejects(h.service.connect(plan.id, false), /确认/);
  const employee = h.storage.getSiliconEmployeeDefinition("e_test_1")!;
  h.storage.saveSiliconEmployee({ ...employee, updatedAt: "changed" });
  await assert.rejects(h.service.connect(plan.id, true), /改变/);
  assert.equal(h.calls.some(c => c.includes("submit")), false);
});

test("same plan is accepted once across duplicate submissions", async t => {
  const h = fixture(t); await h.service.discover("corp:owner");
  const plan = await h.service.plan({ accountId: "corp:owner", groupIds: ["group-a"], employeeIds: ["e_test_1"] });
  const job = await h.service.connect(plan.id, true); await h.settled(job);
  assert.equal((await h.service.connect(plan.id, true)).id, job.id);
  assert.equal(h.calls.filter(c => c.includes("submit")).length, 1);
});

test("platform approval requirement stops provisioning, never creates a waiting approval workflow", async t => {
  const h = fixture(t, { approval: true }); const { job } = await h.connect();
  assert.equal(job.state, "partial");
  const binding = h.storage.listDingTalkRecords<DingTalkBinding>("binding")[0]!;
  assert.equal(binding.state, "restricted"); assert.match(binding.error!, /免审批/);
  assert.equal(h.calls.some(c => c.includes("publish") || c.includes("+chat-add-bot")), false);
});

test("unknown creation retains durable identity and is never silently repeated", async t => {
  const h = fixture(t, { unknownSubmit: true }); await h.connect();
  const r = h.storage.listDingTalkRecords<DingTalkRobot>("robot")[0]!; assert.equal(r.state, "unknown");
  assert.equal(h.calls.filter(c => c.includes("submit")).length, 1);
  await h.service.restore(); assert.equal(h.calls.filter(c => c.includes("submit")).length, 1);
});

test("ordinary external messages are durable, deduplicated, named, and do not start an employee", async t => {
  const h = fixture(t); await h.connect(); const group = h.service.groupForConversation(h.storage.listConversations()[0]!.id)!;
  const payload = { conversation_id: "group-a", message_id: "platform-message", sender_open_dingtalk_id: "person-id", sender: "群成员", content: "普通消息不是任务", create_time: Date.now() };
  h.service.receiveGroup(group.id, payload); h.service.receiveGroup(group.id, payload);
  assert.equal(h.storage.conversationEvents(group.conversationId).length, 1); assert.equal(h.sent.length, 0);
  const detail = h.storage.getConversation(group.conversationId)!;
  assert.equal(h.storage.conversationEvents(detail.id)[0]!.author!.name, "群成员");
  h.service.receiveGroup(group.id, { ...payload, message_id: "projected-history", text: '{"content":"这是用户原样发送的JSON"}', content: "opaque-transport-envelope" });
  const projected = h.storage.conversationEvents(detail.id).find(t => t.external?.messageId === "projected-history")!;
  assert.equal((projected.content[0] as { text: string }).text, '{"content":"这是用户原样发送的JSON"}');
  const receipt = await h.service.send(detail.id, randomUUID(), "@/private/fixture-path 仅按字面发送，不能读取文件");
  assert.equal(h.payloads.find(p => p.args.includes("+messages-send"))?.input, "@/private/fixture-path 仅按字面发送，不能读取文件");
  assert.equal(receipt.state, "accepted"); assert.equal(h.storage.listWandTasks().length, 0);
  const beforeEcho = h.storage.conversationEvents(detail.id).length;
  h.service.receiveGroup(group.id, { conversation_id: "group-a", message_id: "outbound-fixture-id", sender: "授权人", content: "来自 Wand 的群消息" });
  assert.equal(h.storage.conversationEvents(detail.id).length, beforeEcho, "outbound receipt and echo share one message");
  h.service.receiveGroup(group.id, { conversation_id: "group-a", message_id: "platform-message", type: "user_im_message_recall_group" });
  assert.equal(h.storage.conversationEvents(detail.id)[0]!.content[0]!.type, "text");
  assert.equal((h.storage.conversationEvents(detail.id)[0]!.content[0] as { text: string }).text, "消息已撤回");
});

test("robot ingress rejects wrong tenant/user and duplicate callbacks start exactly one fresh employee run", async t => {
  const h = fixture(t); await h.connect(); const r = h.storage.listDingTalkRecords<DingTalkRobot>("robot")[0]!;
  const payload = { conversationType: "2", robotCode: r.robotCode, chatbotCorpId: "corp", senderCorpId: "corp", conversationId: "group-a", senderStaffId: "owner", senderNick: "授权人", msgId: "inbound-message", msgtype: "text", text: { content: "请回答" } };
  await h.service.receiveRobot(r.id, { ...payload, senderCorpId: "other-corp" });
  await h.service.receiveRobot(r.id, { ...payload, senderStaffId: "not-authorized" });
  assert.equal(h.sent.length, 0);
  await h.service.receiveRobot(r.id, payload); await h.service.receiveRobot(r.id, payload);
  assert.equal(h.sent.length, 1); const session = h.sessions.get(h.sent[0]!.id)!;
  assert.equal(session.employeeId, "e_test_1"); assert.match(session.automationId!, /^dingtalk:/);
  assert.equal(session.systemPrompt!.includes("仅员工 1 的角色"), true);
  const binding = h.storage.listDingTalkRecords<DingTalkBinding>("binding")[0]!;
  h.service.updateBinding(binding.id, { allowGroupMembers: true });
  await h.service.receiveRobot(r.id, { ...payload, msgId: "group-member-allowed", senderStaffId: "colleague" });
  assert.equal(h.sent.length, 2, "an explicit group-members grant permits a same-org member");
  await h.service.receiveRobot(r.id, { ...payload, msgId: "bot-loop-blocked", senderStaffId: "colleague", senderIsBot: true });
  assert.equal(h.sent.length, 2, "known bot callbacks never recursively trigger employees");
  h.service.updateBinding(binding.id, { allowGroupMembers: false });
  await h.service.receiveRobot(r.id, { ...payload, msgId: "group-member-revoked", senderStaffId: "colleague" });
  assert.equal(h.sent.length, 2);
});

test("a shared native message addressed to two employee robots starts each exactly once", async t => {
  const h = fixture(t); await h.connect(["group-a"], ["e_test_1", "e_test_2"]);
  const robots = h.storage.listDingTalkRecords<DingTalkRobot>("robot");
  for (let repeat = 0; repeat < 2; repeat++) for (const robot of robots) await h.service.receiveRobot(robot.id, { conversationType: "2", robotCode: robot.robotCode, chatbotCorpId: "corp", senderCorpId: "corp", conversationId: "group-a", senderStaffId: "owner", msgId: "same-native-multi-at-message", msgtype: "text", text: { content: "两位各自回答" } });
  assert.equal(h.sent.length, 2);
  assert.deepEqual(new Set(h.sent.map(s => h.sessions.get(s.id)!.employeeId)), new Set(["e_test_1", "e_test_2"]));
});

test("final export excludes thinking/tools and sends only once after explicit completed assistant text", async t => {
  const h = fixture(t); await h.connect(); const r = h.storage.listDingTalkRecords<DingTalkRobot>("robot")[0]!;
  await h.service.receiveRobot(r.id, { conversationType: "2", robotCode: r.robotCode, chatbotCorpId: "corp", senderCorpId: "corp", conversationId: "group-a", senderStaffId: "owner", msgId: "final-fixture", msgtype: "text", text: { content: "问题" } });
  const session = h.sessions.get(h.sent[0]!.id)!;
  const finished = { ...session, status: "idle", exitCode: 0, endedAt: new Date().toISOString(), structuredState: { ...session.structuredState!, inFlight: false }, messages: [{ role: "assistant", completedAt: new Date().toISOString(), content: [{ type: "thinking", text: "private-thought" }, { type: "tool_use", id: "tool", name: "bash", input: { command: "private-tool" } }, { type: "text", text: "最终回答" }] }] } as unknown as SessionSnapshot;
  assert.equal(dingTalkFinalText({ ...finished, endedAt: null, exitCode: null }), null, "quiet/intermediate text is not a completed request");
  assert.equal(dingTalkFinalText(finished), "最终回答"); h.sessions.set(session.id, finished);
  const event = { type: "ended", sessionId: session.id, data: {} } as ProcessEvent;
  h.service.ingest(event); h.service.ingest(event);
  for (let i = 0; i < 100 && !h.calls.some(c => c.includes("+messages-send")); i++) await new Promise(r => setTimeout(r, 2));
  const sends = h.calls.filter(c => c.includes("+messages-send")); assert.equal(sends.length, 1);
  assert.equal(sends[0]![sends[0]!.indexOf("--text") + 1], "-");
  assert.equal(sends[0]!.includes("--body-stdin"), true);
  assert.equal(h.payloads.find(p => p.args.includes("+messages-send"))?.input, "最终回答");
  assert.equal(JSON.stringify(sends).includes("private-thought"), false); assert.equal(JSON.stringify(sends).includes("private-tool"), false);
  const group = h.service.groupForConversation(h.storage.listConversations()[0]!.id)!;
  await h.conversations.remove(group.conversationId);
  const tombstones = h.storage.listDingTalkRecords<DingTalkRun>("run");
  assert.equal(tombstones.length, 1); assert.equal(tombstones[0]!.text, undefined, "mirror deletion removes output copies without losing duplicate protection");
  assert.equal(h.service.groupForConversation(group.conversationId)?.syncState, "paused");
  assert.equal(h.storage.listDingTalkRecords("robot").length, 1, "shared robot is not deleted");
});

test("late final output cannot cross a removed-and-recreated binding generation", async t => {
  let holdNext = false, release!: () => void;
  const h = fixture(t, { profileGate: async () => { if (holdNext) { holdNext = false; await new Promise<void>(resolve => { release = resolve; }); } } });
  await h.connect(); const robot = h.storage.listDingTalkRecords<DingTalkRobot>("robot")[0]!;
  const payload = { conversationType: "2", robotCode: robot.robotCode, chatbotCorpId: "corp", senderCorpId: "corp", conversationId: "group-a", senderStaffId: "owner", msgId: "old-generation-message", msgtype: "text", text: { content: "旧请求" } };
  await h.service.receiveRobot(robot.id, payload);
  const session = h.sessions.get(h.sent[0]!.id)!;
  h.sessions.set(session.id, { ...session, status: "idle", exitCode: 0, endedAt: new Date().toISOString(), structuredState: { ...session.structuredState!, inFlight: false }, messages: [{ role: "assistant", completedAt: new Date().toISOString(), content: [{ type: "text", text: "旧授权结果不能发到新绑定" }] }] });
  const before = h.storage.listDingTalkRecords<DingTalkBinding>("binding")[0]!;
  holdNext = true; h.service.ingest({ type: "ended", sessionId: session.id, data: {} } as ProcessEvent);
  assert.equal(typeof release, "function");
  h.service.removeBinding(before.id); await h.connect();
  const after = h.storage.getDingTalkRecord<DingTalkBinding>("binding", before.id)!; assert.notEqual(after.generation, before.generation);
  release(); for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(h.calls.some(c => c.includes("+messages-send")), false);
  await h.service.receiveRobot(robot.id, payload); assert.equal(h.sent.length, 1, "old platform callback is still a tombstoned request");
});

test("restart recovers definitely-unsent completed output even beyond ten thousand historical runs, without replaying a model", async t => {
  const h = fixture(t); await h.connect(); const binding = h.storage.listDingTalkRecords<DingTalkBinding>("binding")[0]!;
  const group = h.service.groupForConversation(h.storage.listConversations()[0]!.id)!;
  h.storage.transaction(() => { for (let i = 0; i < 10001; i++) h.storage.saveDingTalkRecord("run", `history-${i.toString().padStart(5, "0")}`, { id: `history-${i}`, state: "delivered", delivery: "sent" }); });
  const session = h.structured.createSession({ cwd: h.cwd, mode: "full-access", provider: "pi", automationId: "dingtalk:zz-recovered-run" });
  h.sessions.set(session.id, { ...session, exitCode: 0, endedAt: new Date().toISOString(), structuredState: { ...session.structuredState!, inFlight: false }, messages: [{ role: "assistant", completedAt: new Date().toISOString(), content: [{ type: "text", text: "恢复的是原已完成结果" }] }] });
  h.storage.saveDingTalkRecord("run", "zz-recovered-run", { id: "zz-recovered-run", groupId: group.id, bindingId: binding.id, bindingGeneration: binding.generation, incomingId: "already-accepted", sessionId: session.id, state: "running", updatedAt: new Date().toISOString() });
  await h.service.restore();
  for (let i = 0; i < 100 && h.storage.getDingTalkRecord<DingTalkRun>("run", "zz-recovered-run")?.delivery !== "sent"; i++) await new Promise(r => setTimeout(r, 2));
  assert.equal(h.storage.getDingTalkRecord<DingTalkRun>("run", "zz-recovered-run")!.delivery, "sent");
  assert.equal(h.sent.length, 0, "restoration must not send model input again");
  assert.equal(h.calls.filter(c => c.includes("+messages-send")).length, 1);
});

test("restart never replays an uncertain send claim and exposes the binding as requiring reconciliation", async t => {
  const h = fixture(t); await h.connect(); const binding = h.storage.listDingTalkRecords<DingTalkBinding>("binding")[0]!;
  h.storage.saveDingTalkRecord("run", "uncertain-send", { id: "uncertain-send", groupId: binding.groupId, bindingId: binding.id, bindingGeneration: binding.generation, incomingId: "accepted-message", state: "completed", delivery: "sending", text: "此前可能已送达", updatedAt: new Date().toISOString() });
  h.storage.claimDingTalkRecord("request", "final:uncertain-send", { id: "final:uncertain-send", state: "sending" });
  await h.service.restore();
  assert.equal(h.storage.getDingTalkRecord<DingTalkRun>("run", "uncertain-send")!.delivery, "unknown");
  assert.equal(h.storage.getDingTalkRecord<DingTalkBinding>("binding", binding.id)!.state, "unknown");
  assert.equal(h.calls.some(c => c.includes("+messages-send")), false); assert.equal(h.sent.length, 0);
});

test("durable output queue admits at most four delivery workers and resumes remaining payloads", async t => {
  let gated = false; const releases: Array<() => void> = [];
  const h = fixture(t, { profileGate: async () => { if (gated) await new Promise<void>(r => releases.push(r)); } });
  await h.connect(); const binding = h.storage.listDingTalkRecords<DingTalkBinding>("binding")[0]!;
  for (let i = 0; i < 8; i++) h.storage.saveDingTalkRecord("run", `queued-${i}`, { id: `queued-${i}`, groupId: binding.groupId, bindingId: binding.id, bindingGeneration: binding.generation, incomingId: `accepted-${i}`, state: "completed", delivery: i === 0 ? "sending" : "pending", text: `最终正文 ${i}`, updatedAt: new Date().toISOString() });
  gated = true; await h.service.restore(); assert.equal(releases.length, 4);
  releases.splice(0).forEach(release => release());
  for (let i = 0; i < 100 && releases.length < 4; i++) await new Promise(r => setTimeout(r, 2));
  assert.equal(releases.length, 4); gated = false; releases.splice(0).forEach(release => release());
  for (let i = 0; i < 100 && h.storage.listDingTalkRecords<DingTalkRun>("run").filter(r => r.delivery === "sent").length < 8; i++) await new Promise(r => setTimeout(r, 2));
  assert.equal(h.storage.listDingTalkRecords<DingTalkRun>("run").filter(r => r.delivery === "sent").length, 8);
  assert.equal(h.calls.filter(c => c.includes("+messages-send")).length, 8); assert.equal(h.sent.length, 0);
});

test("DingTalk management API is admin-only, no-store and never echoes robot credentials", async t => {
  const h = fixture(t); const app = express(); app.use(express.json()); let installed = 0;
  app.use((req, _res, next) => { req.principal = req.headers["x-test-admin"] === "yes" ? BROWSER_ADMIN_PRINCIPAL : CONNECTED_APP_PRINCIPAL; next(); });
  registerDingTalkRoutes(app, { service: h.service, requireAdmin, install: async () => { installed++; } });
  const server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/connectors/dingtalk`;
  for (const path of ["", "/groups?accountId=corp%3Aowner", "/auth/unknown"]) assert.equal((await fetch(base + path)).status, 403);
  assert.equal((await fetch(base + "/install", { method: "POST" })).status, 403); assert.equal(installed, 0);
  const headers = { "x-test-admin": "yes", "Content-Type": "application/json" };
  const response = await fetch(base, { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  await h.service.restore(); assert.equal(installed, 0, "status reads and startup recovery never install dependencies");
  assert.equal((await fetch(base + "/install", { headers })).status, 404); assert.equal(installed, 0);
  const installation = await fetch(base + "/install", { method: "POST", headers });
  assert.equal(installation.status, 200); assert.equal(installed, 1, "only the explicit admin POST invokes installation");
  const invalid = await fetch(base + "/plans", { method: "POST", headers, body: JSON.stringify({ accountId: "corp:owner", groupIds: ["unverified-group"], employeeIds: ["e_test_1"] }) });
  assert.equal(invalid.status, 400); assert.equal(h.calls.some(c => c.includes("submit")), false);
  await h.connect();
  assert.equal((await (await fetch(base, { headers })).text()).includes("fixture-not-a-real-secret"), false);
});

test("external mirrors cannot dispatch internal tasks or create a model channel", async t => {
  const h = fixture(t); await h.connect(); const id = h.storage.listConversations()[0]!.id;
  const p = await h.conversations.prepare(id, randomUUID()); assert.equal(p.state, "accepted"); assert.equal(h.sessions.size, 0);
  const d = await h.conversations.dispatch(id, randomUUID(), { title: "not-an-internal-task", description: "输入", workspaceId: h.workspace.id });
  assert.equal(d.state, "rejected"); assert.equal(h.storage.listWandTasks().length, 0);
  assert.equal(dingTalkId("corp", "a"), dingTalkId("corp", "a")); assert.notEqual(dingTalkId("corp", "a"), dingTalkId("other", "a"));
});
