import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { aiTeamChatTitle, type AiTeam, type AiTeamRun, type AiTeamStep } from "../src/ai-team-types.js";
import { defaultConfig } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";
import { sidebarSessionLabel } from "../src/web-ui/react/workspaces/session-order.js";
import {
  filterActiveGroups,
  isSessionActive,
  isSessionAttention,
  nextSidebarDisplayMode,
  parseSidebarDisplayMode,
  sidebarDisplayModeLabel,
} from "../src/web-ui/react/workspaces/sidebar-display-mode.js";
import { nonTeamSessions, splitTeamSessions, teamChatLabel, teamStepLabel } from "../src/web-ui/react/workspaces/team-sessions.js";
import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "../src/web-ui/react/workspaces/types.js";

function startWorkspaceApp(storage: WandStorage): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  registerWorkspaceRoutes(app, storage);
  app.use(jsonErrorHandler);
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const TEAM: AiTeam = {
  id: "team-1",
  name: "测试团队",
  description: "",
  instructions: "",
  members: [
    { id: "m_lead", name: "负责人", duty: "拆分", agent: { provider: "claude", model: "default", thinkingEffort: "medium", mode: "default", kind: "structured" }, agents: [{ provider: "claude", model: "default", thinkingEffort: "medium", mode: "default", kind: "structured" }], isLeader: true },
    { id: "m_dev", name: "实现", duty: "改代码", agent: { provider: "codex", model: "default", thinkingEffort: "medium", mode: "default", kind: "structured" }, agents: [{ provider: "codex", model: "default", thinkingEffort: "medium", mode: "default", kind: "structured" }], isLeader: false },
  ],
  requirePlanApproval: true,
  maxSteps: 30,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function run(status: AiTeamRun["status"]): AiTeamRun {
  return {
    id: "run-1",
    teamId: TEAM.id,
    taskId: "task-1",
    team: TEAM,
    objective: "给 README 加安装说明",
    cwd: "/repo",
    status,
    statusDetail: "",
    stepsUsed: 1,
    stepLimit: 30,
    formatRetries: 0,
    planApproved: true,
    chatSessionId: "chat-1",
    pendingNotes: [],
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
  };
}

const STEP: AiTeamStep = {
  id: "step-1",
  runId: "run-1",
  seq: 2,
  kind: "work",
  memberId: "m_dev",
  title: "补安装章节并核对命令",
  instructions: "",
  sessionId: "step-session-1",
  status: "running",
  dependsOn: [],
  report: "",
  reportPath: "",
  startedAt: "2026-02-01T00:00:00.000Z",
  endedAt: null,
};

test("step markers key dispatched sessions by session id and project the live member name", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-team-markers-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  try {
    storage.saveAiTeam(TEAM);
    storage.saveAiTeamRun(run("running"));
    storage.saveAiTeamStep(STEP);

    assert.equal(storage.listAiTeamRunChatMarkers().get("chat-1")?.teamId, TEAM.id,
      "群聊入口按稳定团队 ID 归类，团队改名后仍能匹配");

    const markers = storage.listAiTeamStepSessionMarkers();
    const marker = markers.get("step-session-1");
    assert.ok(marker);
    assert.equal(marker.title, "补安装章节并核对命令");
    assert.equal(marker.memberName, "实现");
    assert.equal(marker.teamName, "测试团队");
    assert.equal(marker.runFinished, false, "还在跑的运行不能算历史");
    assert.equal(markers.has("chat-1"), false, "群聊会话不是派发步骤");

    storage.saveAiTeam({
      ...TEAM,
      name: "新群名",
      members: TEAM.members.map((member) => (member.id === "m_dev" ? { ...member, name: "新实现" } : member)),
    });
    const renamed = storage.listAiTeamStepSessionMarkers().get("step-session-1");
    assert.equal(renamed?.memberName, "新实现");
    assert.equal(renamed?.teamName, "新群名");

    storage.deleteAiTeam(TEAM.id);
    const dropped = storage.listAiTeamStepSessionMarkers().get("step-session-1");
    assert.equal(dropped?.memberName, "实现", "删掉定义后退回运行快照");
    assert.equal(dropped?.teamName, "测试团队");

    storage.saveAiTeamRun(run("done"));
    assert.equal(storage.listAiTeamStepSessionMarkers().get("step-session-1")?.runFinished, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/api/tasks carries team markers on the sessions they belong to", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-team-task-list-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  try {
    const workspace = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Repo", cwd: root, worktree: false }),
    }).then((res) => res.json() as Promise<{ id: string }>);
    const task = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "补安装说明", worktree: false }),
    }).then((res) => res.json() as Promise<{ id: string; cwd: string }>);

    const config = { ...defaultConfig(), defaultCwd: task.cwd };
    const manager = new StructuredSessionManager(storage, config);
    manager.createSession({ cwd: task.cwd, mode: config.defaultMode, workspaceId: workspace.id, workspaceTaskId: task.id });
    const memberSession = manager.createSession({
      cwd: task.cwd, mode: config.defaultMode, workspaceId: workspace.id, workspaceTaskId: task.id,
    });
    manager.createSession({ cwd: task.cwd, mode: config.defaultMode, workspaceId: workspace.id, workspaceTaskId: task.id });

    storage.saveAiTeam(TEAM);
    storage.saveAiTeamRun(run("running"));
    storage.saveAiTeamStep({ ...STEP, sessionId: memberSession.id });

    const first = await fetch(`${baseUrl}/api/tasks`).then((res) => res.json() as Promise<Array<{
      tasks: Array<{ sessions: Array<{ id: string; teamChat?: unknown; teamStep?: { title: string; memberName: string; runFinished: boolean } }> }>;
    }>>);
    const sessions = first[0]?.tasks[0]?.sessions ?? [];
    const marked = sessions.find((session) => session.id === memberSession.id);
    assert.equal(marked?.teamStep?.title, "补安装章节并核对命令");
    assert.equal(marked?.teamStep?.memberName, "实现");
    assert.equal(marked?.teamStep?.runFinished, false);
    assert.equal(sessions.filter((session) => session.teamStep).length, 1, "只标记派发的那一条");
    assert.equal(sessions.some((session) => session.teamChat), false, "这个运行没有群聊会话在任务里");

    // 运行进终态必须让轮询 revision 变化，客户端才会重拉并把它折进历史。
    const { revision } = await fetch(`${baseUrl}/api/tasks?revision=x`).then((res) => res.json() as Promise<{ revision: string }>);
    const same = await fetch(`${baseUrl}/api/tasks?revision=${encodeURIComponent(revision)}`)
      .then((res) => res.json() as Promise<{ unchanged?: boolean }>);
    assert.equal(same.unchanged, true, "revision 未变时短路");
    storage.saveAiTeamRun(run("done"));
    const after = await fetch(`${baseUrl}/api/tasks?revision=${encodeURIComponent(revision)}`)
      .then((res) => res.json() as Promise<{ unchanged?: boolean; groups?: unknown[] }>);
    assert.equal(after.unchanged, false, "运行状态一变就不能再返回 unchanged");
    assert.ok(Array.isArray(after.groups));
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("chat titles project current task names for existing chats and follow exclusive task moves", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-chat-task-title-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const { baseUrl, close } = await startWorkspaceApp(storage);
  const config = defaultConfig();
  const manager = new StructuredSessionManager(storage, config);
  try {
    const workspace = storage.createWorkspace({ name: "Repo", cwd: root });
    const task = storage.createWandTask({ workspaceId: workspace.id, title: "补安装说明" });
    const other = storage.createWandTask({ workspaceId: workspace.id, title: "排查登录" });
    const chat = manager.createRelaySession({ cwd: root, mode: config.defaultMode,
      automationId: "ai-team-chat:run-1", title: "测试团队 · 补安装说明",
      workspaceId: workspace.id, workspaceTaskId: task.workspaceTaskId! });
    const plain = manager.createSession({ cwd: root, mode: config.defaultMode,
      workspaceId: workspace.id, workspaceTaskId: task.workspaceTaskId! });
    storage.saveAiTeam(TEAM);
    storage.saveAiTeamRun({ ...run("done"), taskId: task.id, chatSessionId: chat.id });
    const checkTitles = async (expected: string, taskId: string): Promise<void> => {
      const groups = await fetch(`${baseUrl}/api/tasks`).then((r) => r.json() as Promise<TaskDirectoryGroup[]>);
      const row = groups.flatMap((g) => g.tasks.flatMap((t) => t.sessions)).find((s) => s.id === chat.id)!;
      assert.equal(row.title, expected);
      assert.equal(sidebarSessionLabel(row, 0), expected, "不能再被前端覆盖成团队名");
      const detail = await fetch(`${baseUrl}/api/workspace-tasks/${taskId}`)
        .then((r) => r.json() as Promise<{ sessions: WorkspaceSessionSummary[] }>);
      assert.equal(detail.sessions.find((s) => s.id === chat.id)?.title, expected);
      const project = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`)
        .then((r) => r.json() as Promise<{ sessions: WorkspaceSessionSummary[] }>);
      assert.equal(project.sessions.find((s) => s.id === chat.id)?.title, expected);
      assert.equal(storage.listAiTeamRunChatMarkers().get(chat.id)?.chatTitle, expected);
      assert.equal(storage.getSession(chat.id)?.title, "测试团队 · 补安装说明", "读取不回写历史会话");
      assert.equal(storage.listAiTeamRunChatMarkers().has(plain.id), false, "普通会话不受影响");
    };
    await checkTitles("补安装说明", task.workspaceTaskId!);
    const before = await fetch(`${baseUrl}/api/tasks?revision=initial`).then((r) => r.json());
    storage.updateWandTask(task.id, { title: "整理文档" });
    const after = await fetch(`${baseUrl}/api/tasks?revision=${encodeURIComponent(before.revision)}`)
      .then((r) => r.json());
    assert.equal(after.unchanged, false, "改任务名即使不改运行也会刷新列表");
    await checkTitles("整理文档", task.workspaceTaskId!);
    storage.saveAiTeam({ ...TEAM, name: "新团队名称" });
    await checkTitles("整理文档", task.workspaceTaskId!);
    storage.moveSessionToWorkspaceTask(chat.id, other.workspaceTaskId!);
    await checkTitles("排查登录", other.workspaceTaskId!);
    assert.equal(storage.getAiTeamRun("run-1")!.taskId, task.id, "运行归属快照保留");
  } finally {
    manager.dispose();
    await close();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("group titles retain the whole task name and have a neutral fallback", () => {
  assert.equal(aiTeamChatTitle("  修复登录  "), "修复登录");
  assert.equal(aiTeamChatTitle("检查 🐱 & <标签>"), "检查 🐱 & <标签>");
  assert.equal(aiTeamChatTitle("长标题".repeat(50)), `${"长标题".repeat(50)}`);
  assert.equal(aiTeamChatTitle(" "), "群聊");
  assert.equal(aiTeamChatTitle(null), "群聊");
  assert.equal(aiTeamChatTitle(), "群聊");
});

// ── 展示层：折叠分组、短标题、显示模式 ──

const memberSession: WorkspaceSessionSummary = {
  id: "step-session-1",
  title: "codex · 补安装章节并核对命令 · gpt-5",
  cwd: "/repo",
  status: "thinking",
  inFlight: true,
  teamStep: {
    runId: "run-1",
    stepId: "step-1",
    kind: "work",
    title: "补安装章节并核对命令",
    memberId: "m_dev",
    memberName: "实现",
    teamName: "测试团队",
    stepStatus: "running",
    runStatus: "running",
    runFinished: false,
  },
};

const finishedMemberSession: WorkspaceSessionSummary = {
  ...memberSession,
  id: "step-session-2",
  status: "idle",
  inFlight: false,
  teamStep: { ...memberSession.teamStep!, runStatus: "done", runFinished: true },
};

const chatSession: WorkspaceSessionSummary = {
  id: "chat-1",
  title: "测试团队 · 补安装说明",
  cwd: "/repo",
  status: "idle",
  teamChat: { runId: "run-1", teamId: "team-1", teamName: "测试团队", chatTitle: "补安装说明任务处理群", memberCount: 2 },
};

const humanSession: WorkspaceSessionSummary = {
  id: "human-1",
  title: "帮我看下这个报错",
  cwd: "/repo",
  status: "running",
  ptyBusy: true,
};

function group(sessions: WorkspaceSessionSummary[]): TaskDirectoryGroup {
  return {
    workspaceId: "ws",
    workspaceName: "Repo",
    workspaceCwd: "/repo",
    tasks: [{
      id: "task-1",
      workspaceId: "ws",
      name: "补安装说明",
      worktree: null,
      cwd: "/repo",
      layout: null,
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: null,
      sessions,
    }],
    standaloneSessions: [],
  };
}

test("team-dispatched sessions fold away from the task's own sessions", () => {
  const split = splitTeamSessions([humanSession, memberSession, finishedMemberSession, chatSession]);
  assert.deepEqual(split.live.map((session) => session.id), ["step-session-1"]);
  assert.deepEqual(split.history.map((session) => session.id), ["step-session-2"]);
  assert.deepEqual(
    nonTeamSessions([humanSession, memberSession, finishedMemberSession, chatSession]).map((session) => session.id),
    ["human-1", "chat-1"],
    "群聊入口留在任务下的正常位置，不进团队折叠",
  );
});

test("team rows show the step title, not the generated CLI signature", () => {
  assert.equal(sidebarSessionLabel(memberSession, 1), "补安装章节并核对命令");
  assert.equal(sidebarSessionLabel(chatSession, 0), "补安装说明任务处理群");
  assert.equal(sidebarSessionLabel(humanSession, 0), "帮我看下这个报错");
  const long = teamStepLabel({ ...memberSession.teamStep!, title: "把侧栏里的团队会话默认折叠起来，点击以后才展开显示具体的每一条" });
  assert.ok(Array.from(long).length <= 26, `短标题太长：${long}`);
  assert.ok(long.endsWith("…"));
  assert.equal(teamChatLabel({ id: "x", teamChat: { runId: "r", teamId: "team-1", teamName: "", memberCount: 1 }, title: "旧标题" }), "旧标题");
});

test("display mode cycles full → folded → active and survives dirty storage values", () => {
  assert.equal(nextSidebarDisplayMode("full"), "folded");
  assert.equal(nextSidebarDisplayMode("folded"), "active");
  assert.equal(nextSidebarDisplayMode("active"), "full");
  assert.equal(parseSidebarDisplayMode(null), "full");
  assert.equal(parseSidebarDisplayMode("nonsense"), "full");
  assert.equal(sidebarDisplayModeLabel("full"), "展开");
  assert.equal(sidebarDisplayModeLabel("folded"), "收起");
  assert.equal(sidebarDisplayModeLabel("active"), "在跑");
});

test("active mode drops idle sessions, then idle tasks and directories", () => {
  const groups = filterActiveGroups([
    group([humanSession, memberSession, finishedMemberSession, chatSession]),
    { ...group([finishedMemberSession]), workspaceId: "ws-idle", workspaceName: "Idle" },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]?.tasks[0]?.sessions.map((session) => session.id), ["human-1", "step-session-1"]);
  assert.equal(isSessionActive(humanSession), true);
  assert.equal(isSessionActive(finishedMemberSession), false);
  assert.equal(isSessionAttention({ ...memberSession, status: "permission-blocked", inFlight: false }), true);

  // 正在看的会话不能因为不活动就从列表里消失。
  const kept = filterActiveGroups([group([finishedMemberSession])], "step-session-2");
  assert.deepEqual(kept[0]?.tasks[0]?.sessions.map((session) => session.id), ["step-session-2"]);
});

