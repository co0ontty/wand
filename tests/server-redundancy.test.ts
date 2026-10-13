import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { projectTeamDefinition, projectTeamEmployees } from "../src/ai-team-employee-binding.js";
import { parseAiTeamInput } from "../src/server-ai-team-routes.js";
import { compactTransportAvatar } from "../src/fixed-employee-avatar.js";
import { ConversationService } from "../src/conversation-service.js";
import { fallbackProviderModel, resolveExplicitOrFallbackModel } from "../src/session-model.js";
import { buildSessionListPage } from "../src/server-session-routes.js";
import { toSessionDetailDTO, toSessionListItemDTO } from "../src/session-transport.js";
import { structuredQuietStatusData } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";
import type { AiTeam, SiliconEmployee } from "../src/ai-team-types.js";
import type { ConversationInstance, ConversationTurn } from "../src/types.js";
import type { SessionSnapshot, WandConfig } from "../src/types.js";
import { defaultConfig } from "../src/config.js";

const uploaded = "data:image/png;base64,aaaa";

function snapshot(avatar: string): SessionSnapshot {
  return {
    id: "s1", provider: "pi", sessionKind: "structured", command: "pi", cwd: "/repo", mode: "default",
    status: "idle", exitCode: null, startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, output: "",
    employeeId: "e1", employeeName: "员工", employeeAvatar: avatar,
    queuedMessages: ["still here"],
    piSettings: { resources: { skills: [], mcpServers: [] } },
    worktreeMergeInfo: { targetBranch: "main" },
  } as SessionSnapshot;
}

test("list cards omit uploaded avatars while detail and short tokens stay", () => {
  assert.equal(compactTransportAvatar(uploaded), undefined);
  assert.equal(compactTransportAvatar("plush-cat:v1:silver"), "plush-cat:v1:silver");
  assert.equal(compactTransportAvatar("cat:3"), "cat:3");
  const page = buildSessionListPage([snapshot(uploaded)], 0, 10);
  assert.equal(page.entries[0]?.session.employeeAvatar, undefined);
  assert.equal(toSessionListItemDTO(snapshot(uploaded)).employeeAvatar, uploaded);
  assert.equal(toSessionDetailDTO(snapshot(uploaded)).employeeAvatar, uploaded);
  assert.equal(toSessionListItemDTO(snapshot("cat:3"), { avatar: "compact" }).employeeAvatar, "cat:3");
  const live = toSessionListItemDTO(snapshot(uploaded));
  assert.deepEqual(live.queuedMessages, ["still here"]);
  assert.equal(live.worktreeMergeInfo?.targetBranch, "main");
});

test("quiet heartbeat does not repeat the transcript or uploaded avatar", () => {
  const data = structuredQuietStatusData({
    ...snapshot(uploaded),
    output: "x".repeat(1000),
    messages: [{ role: "assistant", content: [{ type: "text", text: "长回复" }] }],
    structuredState: { provider: "pi", runner: "pi-cli-json", inFlight: true, turnStartedAt: "2026-01-01T00:00:01.000Z", lastActivityAt: "2026-01-01T00:00:02.000Z" },
  } as SessionSnapshot);
  assert.equal("messages" in data, false);
  assert.equal("output" in data, false);
  assert.equal("queuedMessages" in data, false);
  assert.equal(data.employeeAvatar, undefined);
  assert.equal(data.employeeId, "e1");
  assert.equal((data.structuredState as { inFlight?: boolean }).inFlight, true);
});

test("explicit session model wins and default uses the shared fallback", () => {
  const config = defaultConfig() as WandConfig;
  assert.equal(resolveExplicitOrFallbackModel(config, "pi", "custom-model"), "custom-model");
  assert.equal(resolveExplicitOrFallbackModel(config, "pi", "default"), fallbackProviderModel(config, "pi"));
  assert.equal(resolveExplicitOrFallbackModel(config, "pi", "   "), fallbackProviderModel(config, "pi"));
});

test("unbound team members accept the employee plush avatar contract", () => {
  const agent = { provider: "pi" as const, model: "m", thinkingEffort: "off" as const, mode: "default" as const, kind: "structured" as const };
  const team = parseAiTeamInput({
    name: "团队",
    members: [
      { name: "甲", duty: "负责", avatar: "plush-cat:v1:silver", agent, isLeader: true },
      { name: "乙", duty: "实现", avatar: "plush:v1:round:coral:none:none", agent: { ...agent, provider: "codex", mode: "full-access" } },
    ],
  }, null, "2026-01-01T00:00:00.000Z");
  assert.equal(team.members[0]?.avatar, "plush-cat:v1:silver");
  assert.equal(team.members[1]?.avatar, "plush:v1:round:coral:none:none");
  assert.throws(() => parseAiTeamInput({
    name: "团队",
    members: [
      { name: "甲", avatar: "https://example.invalid/a.png", agent, isLeader: true },
      { name: "乙", agent },
    ],
  }, null, "2026-01-01T00:00:00.000Z"), /成员「甲」的头像格式无效/);
});

test("team projections share employee display fields and only the definition copies agents", () => {
  const employee: SiliconEmployee = {
    id: "e1", name: "现名", avatar: "cat:2", duty: "职责", prompt: "角色",
    agents: [{ provider: "pi", model: "m", thinkingEffort: "off", mode: "default", kind: "structured" }],
    createdAt: "", updatedAt: "",
  };
  const team = {
    id: "team", name: "团队", description: "", instructions: "", maxSteps: 4, requirePlanApproval: true,
    createdAt: "", updatedAt: "",
    members: [{ id: "m1", employeeId: "e1", name: "旧名", avatar: "cat:1", duty: "", agent: employee.agents[0], agents: [], isLeader: true }],
  } as AiTeam;
  const source = { getSiliconEmployee: () => employee };
  const display = projectTeamEmployees(team, source).members[0]!;
  const definition = projectTeamDefinition(team, source).members[0]!;
  assert.equal(display.name, "现名");
  assert.equal(display.avatar, "cat:2");
  assert.equal(definition.name, display.name);
  assert.equal(definition.avatar, display.avatar);
  assert.equal(definition.agents[0]?.model, "m");
  assert.notEqual(display.agents, definition.agents);
});

test("conversation list preview does not load full session transcripts", () => {
  const calls = { getSession: 0, lastSessionTurn: 0, events: 0 };
  const instance = {
    id: "dm_e_test", owner: "local-owner", kind: "dm", peerEmployeeId: "e_test", name: "测试",
    nameSource: "auto", sourceTemplateId: null, team: null, memberVersion: 1, joinedVersions: {},
    sessionId: "s1", communicationSessionId: "s1", historySessionIds: [], createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as ConversationInstance;
  const storage = {
    listConversations: () => [instance],
    conversationTasks: () => [],
    conversationListState: () => ({ pinnedAt: null, dissolvedAt: null, dissolvedBy: null, deleting: false }),
    getSiliconEmployee: () => ({
      id: "e_test", name: "测试", avatar: uploaded, duty: "职责", prompt: "角色",
      agents: [{ provider: "pi", model: "m", thinkingEffort: "off", mode: "default", kind: "structured" }],
      createdAt: "", updatedAt: "",
    }),
    lastConversationEvent: () => { calls.events += 1; return null; },
    lastSessionTurn: (_id: string, role?: string) => {
      calls.lastSessionTurn += 1;
      return role === "assistant" ? { role: "assistant", createdAt: "2026-01-02T00:00:00.000Z", content: [{ type: "text", text: "只看这一条" }] } as ConversationTurn : null;
    },
    getSessionSlim: () => ({ id: "s1", employeeId: "e_test", employeeName: "测试", employeeAvatar: uploaded }),
    getSession: () => { calls.getSession += 1; throw new Error("full session"); },
    conversationEvents: () => { throw new Error("all events"); },
  };
  const service = new ConversationService({
    storage: storage as never,
    structured: { get: () => null } as never,
    runner: {} as never,
    config: { userProfile: { name: "我" } } as WandConfig,
  });
  const listed = service.list();
  assert.equal(listed[0]?.preview, "只看这一条");
  assert.equal(calls.getSession, 0);
  assert.equal(calls.events, 1);
  assert.equal(calls.lastSessionTurn, 1);
  assert.equal(listed[0]?.team, null);
});

test("session turn tail reads the last matching role without returning earlier turns", t => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-turn-tail-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  storage.saveSession({
    id: "s1", provider: "pi", sessionKind: "structured", command: "pi", cwd: root, mode: "default",
    status: "idle", exitCode: null, startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, output: "",
  });
  storage.checkpointSessionMessages("s1", [
    { role: "user", createdAt: "2026-01-01T00:00:01.000Z", content: [{ type: "text", text: "第一句" }] },
    { role: "assistant", createdAt: "2026-01-01T00:00:02.000Z", content: [{ type: "text", text: "较早回复" }] },
    { role: "user", createdAt: "2026-01-01T00:00:03.000Z", content: [{ type: "text", text: "第二句" }] },
    { role: "assistant", createdAt: "2026-01-01T00:00:04.000Z", content: [{ type: "text", text: "最后回复" }] },
  ]);
  const last = storage.lastSessionTurn("s1");
  const lastUser = storage.lastSessionTurn("s1", "user");
  assert.equal(last?.content[0]?.type === "text" ? last.content[0].text : "", "最后回复");
  assert.equal(lastUser?.content[0]?.type === "text" ? lastUser.content[0].text : "", "第二句");
  assert.equal(storage.lastSessionTurn("missing"), null);
});
