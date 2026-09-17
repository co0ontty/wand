import assert from "node:assert/strict";
import test from "node:test";
import { filterSidebarGroups } from "../src/web-ui/react/workspaces/sidebar-search.js";
import type { TaskDirectoryGroup, WorkspaceTaskSummary } from "../src/web-ui/react/workspaces/types.js";

function task(id: string, status: "active" | "done"): WorkspaceTaskSummary {
  return {
    id, workspaceId: "workspace", name: id, cwd: "/workspace", status,
    worktree: null, isolated: false, layout: null,
    createdAt: "2026-01-01T00:00:00Z", lastOpenedAt: null,
    sessions: [{ id: `${id}-session`, title: `${id}-session`, status: "running" }],
  };
}

const source: TaskDirectoryGroup = {
  workspaceId: "workspace", workspaceName: "Project", workspaceCwd: "/workspace",
  tasks: [task("completed", "done"), task("active", "active")],
  standaloneSessions: [{ id: "loose", status: "exited" }],
};

test("sidebar hides completed tasks and their sessions before applying search", () => {
  for (const query of ["", " ", "Project", "/workspace"]) {
    const visible = filterSidebarGroups([source], query);
    assert.deepEqual(visible[0].tasks.map((item) => item.id), ["active"]);
    assert.deepEqual(visible[0].standaloneSessions, source.standaloneSessions);
  }
  assert.deepEqual(filterSidebarGroups([source], "completed"), []);
  assert.deepEqual(filterSidebarGroups([source], "completed-session"), []);
  assert.deepEqual(filterSidebarGroups([source], "live", { "completed-session": "live" }), []);
  assert.equal(source.tasks.length, 2);
  assert.equal(source.tasks[0].sessions.length, 1);
});

test("legacy global tasks use a named fallback group after real workspaces", () => {
  const global = { ...source, workspaceId: "wand-global", global: true, workspaceName: "全局" };
  const groups = filterSidebarGroups([global, source], "");
  assert.deepEqual(groups.map((group) => group.workspaceId), ["workspace", "wand-global"]);
  assert.equal(groups[1].workspaceName, "未归属工作区");
  assert.equal(global.workspaceName, "全局");
  assert.equal(filterSidebarGroups([global], "未归属").length, 1);
  assert.deepEqual(filterSidebarGroups([{ ...global, tasks: [task("done", "done")], standaloneSessions: [] }], ""), []);
  assert.deepEqual(groups[1].tasks[0].sessions, source.tasks[1].sessions);
});

test("sidebar keeps empty workspaces and restores reopened tasks without deleting history", () => {
  const completedOnly = { ...source, tasks: [source.tasks[0]], standaloneSessions: [] };
  assert.equal(filterSidebarGroups([completedOnly], "").length, 1);
  assert.deepEqual(filterSidebarGroups([completedOnly], "")[0].tasks, []);
  const reopened = { ...source.tasks[0], status: "active" as const };
  assert.deepEqual(filterSidebarGroups([{ ...completedOnly, tasks: [reopened] }], "")[0].tasks, [reopened]);
});
