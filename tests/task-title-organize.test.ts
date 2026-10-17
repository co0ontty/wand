import assert from "node:assert/strict";
import test from "node:test";

import {
  describeOrganizeOutcome,
  isClassifiableTitle,
  parseTitleJudgment,
  planTitleOrganization,
  titleIdentity,
  type OrganizeSession,
  type OrganizeTask,
} from "../src/task-title-organize.js";

function task(patch: Partial<OrganizeTask> & Pick<OrganizeTask, "id" | "titles">): OrganizeTask {
  return {
    cardId: `card-${patch.id}`,
    workspaceId: "ws",
    directoryKey: "/repo",
    status: "doing",
    parentTaskId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    archived: false,
    ...patch,
  };
}

function session(patch: Partial<OrganizeSession> & Pick<OrganizeSession, "id" | "title">): OrganizeSession {
  return {
    directoryKey: "/repo",
    workspaceTaskId: null,
    teamOwned: false,
    archived: false,
    ...patch,
  };
}

test("title identity ignores presentation differences but preserves meaningful punctuation", () => {
  assert.equal(titleIdentity("修复 Web 批量删除目录"), titleIdentity("修复 web 批量删除目录"));
  assert.equal(titleIdentity("macOS 优化"), titleIdentity("macos优化"));
  assert.notEqual(titleIdentity("修复 Web 批量删除目录"), titleIdentity("修复 Web 批量删除目录功能"));
  assert.equal(titleIdentity("修复登录。"), titleIdentity("修复登录"));
  assert.notEqual(titleIdentity("实现 C++ 接口"), titleIdentity("实现 C# 接口"));
  assert.notEqual(titleIdentity("升级版本 1.0"), titleIdentity("升级版本 10"));
  assert.equal(isClassifiableTitle("未命名任务"), false);
  assert.equal(isClassifiableTitle("Claude 1"), false);
  assert.equal(isClassifiableTitle("Claude #1"), false);
  assert.equal(isClassifiableTitle("Pi-1"), false);
  assert.equal(isClassifiableTitle("💻✨"), false);
  assert.equal(isClassifiableTitle("修复登录"), true);
});

test("same title moves a session onto the matching task and leaves unrelated sessions", async () => {
  const login = task({ id: "login", titles: ["修复登录"] });
  const docs = task({ id: "docs", titles: ["更新文档"], createdAt: "2026-10-02T00:00:00.000Z" });
  const plan = await planTitleOrganization([login, docs], [
    session({ id: "s-login", title: "修复登录", workspaceTaskId: "docs" }),
    session({ id: "s-docs", title: "更新文档", workspaceTaskId: "login" }),
    session({ id: "s-other", title: "优化 macOS 输入框", workspaceTaskId: "login" }),
    session({ id: "s-loose", title: "修复登录" }),
  ], async () => ({ sessions: [], tasks: [] }));
  assert.deepEqual(plan.sessionMoves.map((item) => [item.sessionId, item.taskId]).sort(), [
    ["s-docs", "docs"],
    ["s-login", "login"],
    ["s-loose", "login"],
  ]);
  assert.equal(plan.taskParents.length, 0);
  assert.equal(plan.refused.length, 0, "shared verbs are not a match and are not reported as failures");
});

test("keyword overlap does not assign a session to the only selected task", async () => {
  const plan = await planTitleOrganization(
    [task({ id: "macos", titles: ["macos 优化"] })],
    [session({ id: "actions", title: "修复 GitHub Actions 并梳理测试" })],
    async () => ({ sessions: [{ id: "actions", taskId: "macos" }], tasks: [] }),
  );
  // The judge may claim a match; code still accepts only an explicit judgment.
  // This case checks the judge is not implied by being the only candidate:
  const refused = await planTitleOrganization(
    [task({ id: "macos", titles: ["macos 优化"] })],
    [session({ id: "actions", title: "修复 GitHub Actions 并梳理测试" })],
    async () => ({ sessions: [{ id: "actions", taskId: null }], tasks: [] }),
  );
  assert.deepEqual(plan.sessionMoves, [{ sessionId: "actions", taskId: "macos" }]);
  assert.deepEqual(refused.sessionMoves, []);
  assert.equal(refused.refused.length, 0);
});

test("meaningful language and version punctuation is not an exact same-work match", async () => {
  const plan = await planTitleOrganization([
    task({ id: "cpp", titles: ["实现 C++ 接口"] }),
    task({ id: "csharp", titles: ["实现 C# 接口"] }),
  ], [session({ id: "cpp-session", title: "实现 C++ 接口", workspaceTaskId: "cpp" })], async () => ({ sessions: [], tasks: [] }));
  assert.deepEqual(plan.taskParents, []);
  assert.deepEqual(plan.sessionMoves, []);
});

test("cross-directory title equality does not move a session", async () => {
  const plan = await planTitleOrganization(
    [task({ id: "login", titles: ["修复登录"], directoryKey: "/repo" })],
    [session({ id: "other", title: "修复登录", directoryKey: "/other" })],
  );
  assert.deepEqual(plan.sessionMoves, []);
  assert.equal(plan.refused[0]?.reason, "不在同一项目目录，未改归属");
});

test("duplicate titles parent onto the doing task and consolidate sessions", async () => {
  const older = task({ id: "older", titles: ["修复登录"], createdAt: "2026-10-01T00:00:00.000Z", status: "todo" });
  const doing = task({ id: "doing", titles: ["修复登录。"], createdAt: "2026-10-03T00:00:00.000Z", status: "doing" });
  const plan = await planTitleOrganization([older, doing], [
    session({ id: "kept", title: "修复登录", workspaceTaskId: "older" }),
    session({ id: "unrelated", title: "别的工作", workspaceTaskId: "older" }),
  ]);
  assert.deepEqual(plan.sessionMoves, [{ sessionId: "kept", taskId: "doing" }]);
  assert.deepEqual(plan.taskParents, [{ workspaceTaskId: "older", parentCardId: "card-doing" }]);
  const again = await planTitleOrganization(
    [{ ...older, parentTaskId: "card-doing" }, doing],
    [session({ id: "kept", title: "修复登录", workspaceTaskId: "doing" })],
  );
  assert.deepEqual(again.sessionMoves, []);
  assert.deepEqual(again.taskParents, []);
});

test("an unstarted canonical can become a planning parent without execution", async () => {
  const plan = await planTitleOrganization([
    task({ id: "first", titles: ["修复登录"], status: "todo", createdAt: "2026-10-01T00:00:00.000Z" }),
    task({ id: "second", titles: ["修复登录"], status: "todo", createdAt: "2026-10-02T00:00:00.000Z" }),
  ], [
    session({ id: "anchor", title: "别的工作", workspaceTaskId: "first" }),
    session({ id: "s", title: "修复登录", workspaceTaskId: "second" }),
  ]);
  assert.deepEqual(plan.sessionMoves, [{ sessionId: "s", taskId: "first" }]);
  assert.deepEqual(plan.taskParents, [{ workspaceTaskId: "second", parentCardId: "card-first" }]);
  assert.equal(plan.refused.some(item => item.id === "second"), false);
});

test("team sessions and existing parents are not rewritten", async () => {
  const plan = await planTitleOrganization([
    task({ id: "parent", titles: ["macos 优化"] }),
    task({ id: "child", titles: ["macos 优化"], parentTaskId: "card-parent", createdAt: "2026-10-02T00:00:00.000Z" }),
  ], [session({ id: "team", title: "macos 优化", teamOwned: true, workspaceTaskId: "child" })]);
  assert.deepEqual(plan.sessionMoves, []);
  assert.deepEqual(plan.taskParents, []);
  assert.equal(plan.refused.some((item) => item.id === "team"), true);
});

test("judge failure keeps exact matches and reports that uncertain items were left", async () => {
  const plan = await planTitleOrganization([
    task({ id: "login", titles: ["修复登录"] }),
    task({ id: "docs", titles: ["更新文档"] }),
  ], [
    session({ id: "exact", title: "修复登录" }),
    session({ id: "near", title: "登录页报错" }),
  ], async () => { throw new Error("model down"); });
  assert.deepEqual(plan.sessionMoves, [{ sessionId: "exact", taskId: "login" }]);
  assert.equal(plan.refused.some((item) => item.reason.includes("自动判断不可用")), true);
  assert.equal(plan.sessionMoves.some((item) => item.sessionId === "near"), false);
});

test("judge cannot invent a parent or cross a workspace boundary", async () => {
  const invented = await planTitleOrganization([
    task({ id: "web", titles: ["修复 Web 批量删除"] }),
    task({ id: "sidebar", titles: ["修复侧边栏多选"] }),
  ], [], async () => ({ sessions: [], tasks: [{ id: "sidebar", parentId: "missing" }] }));
  assert.deepEqual(invented.taskParents, []);
  assert.match(invented.refused[0]?.reason ?? "", /不能归入该任务/);
  const split = await planTitleOrganization([
    task({ id: "left", titles: ["修复登录"], workspaceId: "a", directoryKey: "/shared" }),
    task({ id: "right", titles: ["修复登录"], workspaceId: "b", directoryKey: "/shared", createdAt: "2026-10-02T00:00:00.000Z" }),
  ], []);
  assert.deepEqual(split.taskParents, []);
  assert.match(split.refused[0]?.reason ?? "", /不在同一项目/);
});

test("global tasks never acquire a parent from another directory, even when the judge claims a match", async () => {
  const left = task({ id: "left", titles: ["修复客户端"], workspaceId: null, directoryKey: "/left" });
  const child = task({ id: "child", titles: ["修复登录弹窗"], workspaceId: null, directoryKey: "/left" });
  const right = task({ id: "right", titles: ["改进客户端交互"], workspaceId: null, directoryKey: "/right" });
  const plan = await planTitleOrganization([left, child, right], [], async () => ({
    sessions: [], tasks: [{ id: "child", parentId: "right" }],
  }));
  assert.deepEqual(plan.taskParents, []);
  assert.ok(plan.refused.some(item => item.id === "child" && item.reason === "不能归入该任务"));
});

test("separate global directories are not peer candidates for task parent judgment", async () => {
  let judged = false;
  const plan = await planTitleOrganization([
    task({ id: "left", titles: ["修复客户端"], workspaceId: null, directoryKey: "/left" }),
    task({ id: "right", titles: ["修复登录弹窗"], workspaceId: null, directoryKey: "/right" }),
  ], [], async () => { judged = true; return { sessions: [], tasks: [] }; });
  assert.equal(judged, false, "不同目录不能仅因workspaceId同为null就发起父子关系比较");
  assert.deepEqual(plan.taskParents, []);
});

test("parseTitleJudgment accepts a fenced object and rejects prose", () => {
  assert.deepEqual(parseTitleJudgment('```json\n{"sessions":[{"id":"s","taskId":null}],"tasks":[]}\n```'), {
    sessions: [{ id: "s", taskId: null }],
    tasks: [],
  });
  assert.throws(() => parseTitleJudgment("这两个标题都提到了修复，所以归为一类。"), /JSON/);
});

test("outcome copy stays on the action and surfaces a refusal", () => {
  assert.deepEqual(describeOrganizeOutcome({
    movedSessions: [{}],
    categorizedTasks: [{}],
    refused: [{ reason: "不在同一项目目录，未改归属" }],
  }), { label: "已归类 1 个任务、归属 1 个会话", reason: "另有 1 项未处理：不在同一项目目录，未改归属" });
  assert.equal(describeOrganizeOutcome({ movedSessions: [], categorizedTasks: [], refused: [] }).label, "未发现可安全归类的项");
  assert.deepEqual(describeOrganizeOutcome({ movedSessions: [], categorizedTasks: [], refused: [], eligibleTasks: 3, skippedTasks: 2 }), {
    label: "未发现可安全归类的项", reason: "已检查 3 个任务；已跳过 2 个用户自定标题的任务",
  });
  assert.deepEqual(describeOrganizeOutcome({ movedSessions: [], categorizedTasks: [], refused: [{ reason: "自动判断不可用" }], eligibleTasks: 3 }), {
    label: "未调整任何任务或会话", reason: "已检查 3 个任务；自动判断不可用",
  });
});


test("semantic batch planning accepts each unarchived root and refuses children as parents", async () => {
  for (const status of ["todo", "doing", "done"] as const) {
    const plan = await planTitleOrganization([task({ id: "parent", titles: ["主目标"], status }), task({ id: "leaf", titles: ["独立子项"], status: "todo" })], [], async () => ({ sessions: [], tasks: [{ id: "leaf", parentId: "parent" }] }));
    assert.deepEqual(plan.taskParents, [{ workspaceTaskId: "leaf", parentCardId: "card-parent" }]);
  }
  const plan = await planTitleOrganization([task({ id: "root", titles: ["主目标"] }), task({ id: "child", titles: ["历史子项"], parentTaskId: "card-root" }), task({ id: "leaf", titles: ["独立子项"] })], [], async () => ({ sessions: [], tasks: [{ id: "leaf", parentId: "child" }] }));
  assert.deepEqual(plan.taskParents, []);
  assert.match(plan.refused.find(item => item.id === "leaf")?.reason ?? "", /最多两层/);
});
