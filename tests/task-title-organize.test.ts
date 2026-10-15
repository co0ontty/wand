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

test("title identity ignores case and punctuation but not different work", () => {
  assert.equal(titleIdentity("修复 Web 批量删除目录"), titleIdentity("修复 web 批量删除目录"));
  assert.equal(titleIdentity("macOS 优化"), titleIdentity("macos优化"));
  assert.notEqual(titleIdentity("修复 Web 批量删除目录"), titleIdentity("修复 Web 批量删除目录功能"));
  assert.equal(isClassifiableTitle("未命名任务"), false);
  assert.equal(isClassifiableTitle("Claude 1"), false);
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

test("a non-doing canonical does not become a parent, but sessions still move", async () => {
  const plan = await planTitleOrganization([
    task({ id: "first", titles: ["修复登录"], status: "todo", createdAt: "2026-10-01T00:00:00.000Z" }),
    task({ id: "second", titles: ["修复登录"], status: "todo", createdAt: "2026-10-02T00:00:00.000Z" }),
  ], [
    session({ id: "anchor", title: "别的工作", workspaceTaskId: "first" }),
    session({ id: "s", title: "修复登录", workspaceTaskId: "second" }),
  ]);
  assert.deepEqual(plan.sessionMoves, [{ sessionId: "s", taskId: "first" }]);
  assert.equal(plan.taskParents.length, 0);
  assert.match(plan.refused[0]?.reason ?? "", /不在处理中/);
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
  assert.equal(describeOrganizeOutcome({ movedSessions: [], categorizedTasks: [], refused: [] }).label, "所选标题已归类");
});
