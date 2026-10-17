import assert from "node:assert/strict";
import test from "node:test";
import { defaultDirectoryTask, isDefaultTaskSelected, toggleDefaultTaskSelection } from "../src/web-ui/react/workspaces/sidebar-default-task.js";
import { filterSidebarGroups } from "../src/web-ui/react/workspaces/sidebar-search.js";
import { EMPTY_SIDEBAR_MANAGE_SELECTION } from "../src/web-ui/react/workspaces/sidebar-manage.js";
import type { TaskDirectoryGroup } from "../src/web-ui/react/workspaces/types.js";

function directory(overrides: Partial<TaskDirectoryGroup> = {}): TaskDirectoryGroup {
  return { workspaceId: "w", workspaceName: "Atlas", workspaceCwd: "/repo/atlas", tasks: [], standaloneSessions: [], ...overrides };
}

test("every directory has a stable display-only default task, including empty and synthetic directories", () => {
  for (const group of [directory(), directory({ workspaceId: "cwd:/tmp/scratch", synthetic: true })]) {
    const task = defaultDirectoryTask(group);
    assert.equal(task.name, "Atlas - 未分组任务");
    assert.equal(task.cwd, group.workspaceCwd);
    assert.equal(task.worktree, null);
    assert.equal(task.layout, null);
    assert.equal(task.canArchive, false);
    assert.deepEqual(task.sessions, []);
    assert.deepEqual(group.tasks, [], "projection must not insert a fake persisted task");
    assert.equal(defaultDirectoryTask({ ...group, workspaceName: "改名目录" }).id, task.id);
    assert.equal(defaultDirectoryTask({ ...group, workspaceName: "改名目录" }).name, "改名目录 - 未分组任务");
  }
});

test("default children are exactly the directory's unbound sessions and archive, without changing membership", () => {
  const base = directory();
  const bound = { id: "bound", workspaceTaskId: "real" };
  const loose = { id: "loose" };
  const archived = { id: "archived", archived: true };
  const real = { ...defaultDirectoryTask(base), id: "real", name: "真实任务", sessions: [bound] };
  const group = directory({ tasks: [real], standaloneSessions: [loose], archivedSessions: [archived] });
  const projection = defaultDirectoryTask(group);
  assert.deepEqual(projection.sessions, [loose]);
  assert.deepEqual(projection.archivedSessions, [archived]);
  assert.equal("workspaceTaskId" in loose, false);
  assert.deepEqual(real.sessions, [bound]);
  const moved = { ...group, tasks: [{ ...real, sessions: [bound, { ...loose, workspaceTaskId: "real" }] }], standaloneSessions: [] };
  assert.deepEqual(defaultDirectoryTask(moved).sessions, [], "binding to a real task removes the default child");
  const onlyAssigned = defaultDirectoryTask(directory({ tasks: [real] }));
  assert.equal(onlyAssigned.name, "Atlas - 未分组任务");
  assert.deepEqual(onlyAssigned.sessions, []);
  assert.notEqual(onlyAssigned.id, real.id);
});

test("search finds existing default sessions by group name, without empty placeholders", () => {
  const group = directory({ standaloneSessions: [{ id: "a", title: "界面检查" }, { id: "b", title: "整理日志" }] });
  assert.equal(filterSidebarGroups([directory()], "未分组任务").length, 0);
  assert.equal(filterSidebarGroups([group], "Atlas 未分组")[0]?.standaloneSessions.length, 2);
  assert.deepEqual(filterSidebarGroups([group], "界面")[0]?.standaloneSessions.map(s => s.id), ["a"]);
  assert.deepEqual(filterSidebarGroups([group], "不存在"), []);
});

test("selecting the default task selects only real child session ids, never its synthetic task id", () => {
  const group = directory({ standaloneSessions: [{ id: "a" }, { id: "b" }] });
  const selected = toggleDefaultTaskSelection(EMPTY_SIDEBAR_MANAGE_SELECTION, group);
  assert.deepEqual(selected, { taskIds: [], sessionIds: ["a", "b"] });
  assert.equal(isDefaultTaskSelected(selected, group), true);
  assert.equal(isDefaultTaskSelected(selected, directory()), false);
  assert.deepEqual(toggleDefaultTaskSelection(selected, group), EMPTY_SIDEBAR_MANAGE_SELECTION);
  const other = { directoryIds: ["other-directory"], taskIds: ["real-task"], sessionIds: ["elsewhere"] };
  assert.deepEqual(toggleDefaultTaskSelection(toggleDefaultTaskSelection(other, group), group), other,
    "the fixed task must never select or delete a real directory");
});
