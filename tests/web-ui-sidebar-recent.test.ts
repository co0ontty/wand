import assert from "node:assert/strict";
import test from "node:test";

import {
  RECENT_CONVERSATION_LIMIT,
  collectRecentEntries,
  filterRecentEntries,
  recentConversationGroups,
  recentSessionIdentity,
} from "../src/web-ui/react/workspaces/sidebar-recent.js";
import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "../src/web-ui/react/workspaces/types.js";

const EMPLOYEES = [
  { id: "e_a", name: "赛博虎妞", avatar: "cat:1" },
  { id: "e_b", name: "石一", avatar: "cat:2" },
];

function session(overrides: Partial<WorkspaceSessionSummary> & { id: string }): WorkspaceSessionSummary {
  return { startedAt: "2026-10-03T00:00:00.000Z", ...overrides };
}

function groupsOf(input: {
  tasks?: Array<{ id: string; name: string; sessions: WorkspaceSessionSummary[] }>;
  standalone?: WorkspaceSessionSummary[];
}): TaskDirectoryGroup[] {
  return [{
    workspaceId: "ws-1",
    workspaceName: "wand",
    workspaceCwd: "/repo",
    tasks: (input.tasks ?? []).map((task) => ({
      id: task.id,
      name: task.name,
      workspaceId: "ws-1",
      cwd: "/repo",
      status: "active" as const,
      createdAt: "2026-10-01T00:00:00.000Z",
      lastOpenedAt: "2026-10-03T00:00:00.000Z",
      sessions: task.sessions,
    })),
    standaloneSessions: input.standalone ?? [],
  }];
}

test("会话归属：员工 > 群聊团队 > 派发步骤团队 > PTY 终端 > 空白终端 > 其它 CLI", () => {
  assert.deepEqual(
    recentSessionIdentity(session({ id: "s1", employeeId: "e_a", sessionKind: "pty", provider: "pi" })),
    { key: "employee:e_a", kind: "employee" },
  );
  assert.deepEqual(
    recentSessionIdentity(session({
      id: "s2",
      teamChat: { teamId: "t1", runId: "r1", teamName: "开发四人组", memberCount: 4 },
    })),
    { key: "team:t1", kind: "team" },
  );
  // 缺 teamId 的旧数据退回 runId；群聊优先于派发步骤。
  assert.deepEqual(
    recentSessionIdentity(session({
      id: "s3",
      teamChat: { teamId: "", runId: "r9", teamName: "旧团队", memberCount: 2 },
      teamStep: { runId: "r9", stepId: "st1", kind: "work", title: "改代码", memberId: "m1", memberName: "华杰", teamName: "旧团队", stepStatus: "done", runStatus: "done", runFinished: true },
    })),
    { key: "team:r9", kind: "team" },
  );
  assert.deepEqual(
    recentSessionIdentity(session({
      id: "s4",
      teamStep: { runId: "r2", stepId: "st2", kind: "work", title: "改代码", memberId: "m1", memberName: "华杰", teamName: "开发四人组", stepStatus: "running", runStatus: "running", runFinished: false },
    })),
    { key: "team-run:r2", kind: "team" },
  );
  assert.deepEqual(
    recentSessionIdentity(session({ id: "s5", sessionKind: "pty", provider: "claude" })),
    { key: "terminal", kind: "terminal" },
  );
  assert.deepEqual(
    recentSessionIdentity(session({ id: "s6", sessionKind: "pty" })),
    { key: "blank-terminal", kind: "blank-terminal" },
  );
  assert.deepEqual(
    recentSessionIdentity(session({ id: "s7", provider: "codex", sessionKind: "structured" })),
    { key: "cli:codex", kind: "cli" },
  );
});

test("只有真有会话的归属才出现，员工只有一条会话时不套空壳组头", () => {
  const groups = groupsOf({
    tasks: [{ id: "task-1", name: "对齐安卓", sessions: [session({ id: "s1", employeeId: "e_a", title: "对齐安卓" })] }],
    standalone: [session({ id: "s2", employeeId: "e_b", title: "看文档" })],
  });
  const recent = recentConversationGroups(collectRecentEntries(groups), { employees: EMPLOYEES });
  assert.deepEqual(recent.map((group) => group.title), ["赛博虎妞", "石一"]);
  for (const group of recent) {
    assert.equal(group.showsHeader, false, "单条会话的员工组不画一级行");
    assert.equal(group.entries.length, 1);
  }
  // 没有任何会话的员工不出现在列表里。
  assert.equal(recent.some((group) => group.title === "勤劳的初二"), false);
});

test("员工分组带上当前员工 id，其它归属为 null", () => {
  const groups = groupsOf({
    tasks: [{ id: "task-1", name: "对齐安卓", sessions: [session({ id: "s1", employeeId: "e_a", title: "对齐安卓" })] }],
    standalone: [
      session({ id: "s2", sessionKind: "pty", provider: "pi", title: "PTY" }),
      session({ id: "s3", provider: "codex", title: "Codex 对话" }),
    ],
  });
  const recent = recentConversationGroups(collectRecentEntries(groups), { employees: EMPLOYEES });
  const employee = recent.find((group) => group.kind === "employee");
  assert.equal(employee?.employeeId, "e_a");
  assert.equal(recent.find((group) => group.kind === "terminal")?.employeeId, null);
  assert.equal(recent.find((group) => group.kind === "cli")?.employeeId, null);
});

test("同一员工多条会话合成一个可折叠组，组标题按当前定义投影", () => {
  const groups = groupsOf({
    tasks: [
      { id: "task-1", name: "对齐安卓", sessions: [session({ id: "s1", employeeId: "e_a", employeeName: "旧名字", title: "对齐安卓" })] },
      { id: "task-2", name: "报错折叠", sessions: [session({ id: "s2", employeeId: "e_a", employeeName: "旧名字", title: "报错折叠", startedAt: "2026-10-03T02:00:00.000Z" })] },
    ],
  });
  const recent = recentConversationGroups(collectRecentEntries(groups), { employees: EMPLOYEES });
  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.title, "赛博虎妞", "展示员工当前名字，而不是会话里的旧快照");
  assert.equal(recent[0]?.showsHeader, true);
  assert.deepEqual(recent[0]?.entries.map((entry) => entry.session.id), ["s2", "s1"], "组内按最近排序");
  assert.equal(recent[0]?.entries[0]?.taskName, "报错折叠");
});

test("终端恒有组头并排在最后，员工 / 团队只看最近窗口", () => {
  const many = Array.from({ length: RECENT_CONVERSATION_LIMIT + 3 }, (_, index) => session({
    id: `cli-${index}`,
    provider: "pi",
    title: `对话 ${index}`,
    // 越靠后越新：窗口应该留下最新的那几条。
    startedAt: `2026-10-03T00:00:${String(index).padStart(2, "0")}.000Z`,
  }));
  const groups = groupsOf({
    standalone: [
      session({ id: "pty-1", sessionKind: "pty", provider: "claude", title: "老终端", startedAt: "2026-09-01T00:00:00.000Z" }),
      session({ id: "blank-1", sessionKind: "pty", title: "空白", startedAt: "2026-09-02T00:00:00.000Z" }),
      ...many,
    ],
  });
  const recent = recentConversationGroups(collectRecentEntries(groups), { employees: EMPLOYEES });
  const titles = recent.map((group) => group.title);
  assert.deepEqual(titles.slice(-2), ["PTY 终端", "空白终端"], "终端排在最后且顺序固定");
  const cli = recent.find((group) => group.title === "Pi");
  assert.equal(cli?.kind, "cli");
  assert.equal(cli?.entries.length, RECENT_CONVERSATION_LIMIT, "CLI / 员工 / 团队只取最近窗口");
  assert.equal(cli?.entries[0]?.session.id, `cli-${RECENT_CONVERSATION_LIMIT + 2}`, "窗口留最新的");
  const pty = recent.find((group) => group.kind === "terminal");
  assert.equal(pty?.entries[0]?.session.id, "pty-1", "终端不受窗口截断");
  assert.equal(pty?.showsHeader, true);
});

test("搜索按会话标题 / 任务名 / 目录名 / 员工与团队名命中，「在跑」档只留在动会话", () => {
  const groups = groupsOf({
    tasks: [
      { id: "task-1", name: "对齐安卓", sessions: [session({ id: "s1", employeeId: "e_a", title: "Web 侧边栏对齐安卓", status: "thinking", inFlight: true })] },
      { id: "task-2", name: "报错折叠", sessions: [session({ id: "s2", employeeId: "e_b", title: "报错折叠", status: "idle" })] },
    ],
    standalone: [session({ id: "s3", sessionKind: "pty", title: "空白终端", startedAt: "2026-10-03T03:00:00.000Z" })],
  });
  const entries = collectRecentEntries(groups);
  const employees = EMPLOYEES;
  assert.deepEqual(filterRecentEntries(entries, { query: "安卓", employees }).map((e) => e.session.id), ["s1"]);
  assert.deepEqual(filterRecentEntries(entries, { query: "石一", employees }).map((e) => e.session.id), ["s2"]);
  assert.deepEqual(filterRecentEntries(entries, { query: "wand", employees }).map((e) => e.session.id),
    ["s3", "s1", "s2"], "目录名也算命中（顺序按最近）");
  assert.deepEqual(filterRecentEntries(entries, { query: "没有这个", employees }), []);
  assert.deepEqual(filterRecentEntries(entries, { activeOnly: true }).map((e) => e.session.id), ["s1"]);
  // 正在看的那条即使不活动也留在「在跑」档里。
  assert.deepEqual(
    filterRecentEntries(entries, { activeOnly: true, selectedSessionId: "s2" }).map((e) => e.session.id),
    ["s1", "s2"],
  );
});
