import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WandStorage } from "../src/storage.js";
import { assertTaskHierarchy, taskGoalProjection, taskHasOpenDescendant } from "../src/task-hierarchy.js";
import { filterSidebarGroups } from "../src/web-ui/react/workspaces/sidebar-search.js";
import { filterActiveGroups } from "../src/web-ui/react/workspaces/sidebar-display-mode.js";
import type { TaskDirectoryGroup, TaskSummary } from "../src/web-ui/react/workspaces/types.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "wand-goals-"));
  const storage = new WandStorage(join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  return storage;
}

test("one goal and three planned deliverables: no execution, one default goal, two-level atomic writes", t => {
  const storage = fixture(t);
  const root = storage.createWandTask({ title: "可验收目标" });
  const children = ["实现", "验证", "交付"].map(title => storage.createWandTask({ title, parentTaskId: root.id }));
  assert.equal(storage.listWandTasks().length, 4);
  assert.deepEqual(storage.listWandTaskSessionIds(root.id), []);
  assert.deepEqual(taskGoalProjection(storage.listWandTasks(), storage.listWandTasks()).map(t => t.id), [root.id]);
  assert.deepEqual(taskGoalProjection(storage.listWandTasks(), [children[1]!]).map(t => t.id), [root.id]);
  assert.throws(() => storage.createWandTask({ title: "孙任务", parentTaskId: children[0]!.id }), /最多两层/);
  assert.equal(storage.listWandTasks().length, 4, "failed create rolls back container and card");
  assert.throws(() => storage.updateWandTask(root.id, { parentTaskId: children[0]!.id }), /循环/);
  const other = storage.createWandTask({ title: "另一个目标" });
  assert.throws(() => storage.updateWandTask(root.id, { parentTaskId: other.id }), /带子任务/);
  assert.throws(() => storage.updateWandTask(children[1]!.id, { parentTaskId: children[0]!.id }), /最多两层/);
  assert.equal(storage.getWandTask(root.id)?.status, "todo", "planning never declares acceptance");
  assert.equal(storage.listAllWorkspaceTasks().length, 5);
});

test("legacy depth stays editable without widening it or flattening history", () => {
  const root = { id: "r", parentTaskId: null, workspaceId: null };
  const child = { id: "c", parentTaskId: "r", workspaceId: null };
  const legacy = { id: "g", parentTaskId: "c", workspaceId: null };
  assert.doesNotThrow(() => assertTaskHierarchy([root, child, legacy], "g", "c", null, legacy));
  assert.throws(() => assertTaskHierarchy([root, child, legacy], "new", "g", null), /最多两层/);
  assert.deepEqual(taskGoalProjection([root, child, legacy], [legacy]), [root]);
  assert.equal(legacy.parentTaskId, "c");
});

function sidebarTask(id: string, parentWorkspaceTaskId: string | null, sessions: TaskSummary["sessions"] = []): TaskSummary {
  return { id, parentWorkspaceTaskId, workspaceId: "w", name: id, worktree: null, layout: null, status: "active", createdAt: "2026-10-17", lastOpenedAt: null, cwd: "/qa", isolated: false, sessions };
}
test("execution sidebar prunes plans and empty directories, retains parent with child-only execution through search/activity/move", () => {
  const tasks = [sidebarTask("goal", null), ...["one", "two", "three"].map(id => sidebarTask(id, "goal"))];
  const group: TaskDirectoryGroup = { workspaceId: "w", workspaceName: "QA", workspaceCwd: "/qa", tasks, standaloneSessions: [] };
  assert.deepEqual(filterSidebarGroups([group], ""), []);
  tasks[1]!.sessions = [{ id: "execution", title: "实现证据", status: "thinking", sessionKind: "structured" }];
  const visible = filterSidebarGroups([group], "");
  assert.deepEqual(visible[0]!.tasks.map(t => t.id), ["goal", "one"]);
  assert.deepEqual(filterActiveGroups(visible)[0]!.tasks.map(t => t.id), ["goal", "one"]);
  assert.deepEqual(filterSidebarGroups([group], "实现证据")[0]!.tasks.map(t => t.id), ["goal", "one"]);
  assert.equal(filterSidebarGroups([group], "two")[0]!.tasks[1]!.name, "two", "unstarted task remains searchable with context");
  tasks[1]!.sessions = [];
  assert.deepEqual(filterSidebarGroups([group], ""), []);
  assert.equal(tasks.length, 4, "projection cannot delete planned tasks");
});

test("acceptance requires evidence and all children; sessions/archival cannot pass a goal", t => {
  const storage = fixture(t);
  const root = storage.createWandTask({ title: "交付目标" });
  const child = storage.createWandTask({ title: "独立交付", parentTaskId: root.id });
  const accepted = { evidence: "output/QA-report.txt · exact source session", blocker: "", acceptedAt: "2026-10-17T00:00:00Z" };
  assert.throws(() => storage.updateWandTask(root.id, { acceptance: accepted }), /子任务未验收/);
  storage.updateWandTask(child.id, { status: "done" });
  assert.throws(() => storage.updateWandTask(root.id, { acceptance: accepted }), /子任务未验收/);
  assert.throws(() => storage.updateWandTask(child.id, { acceptance: { ...accepted, evidence: "" } }), /交付证据/);
  storage.updateWandTask(child.id, { acceptance: accepted });
  assert.equal(storage.getWandTask(root.id)?.acceptance?.acceptedAt ?? null, null);
  storage.updateWandTask(root.id, { acceptance: accepted });
  assert.ok(storage.getWandTask(root.id)?.acceptance?.acceptedAt);
  storage.updateWandTask(child.id, { description: "交付范围改变" });
  assert.equal(storage.getWandTask(child.id)?.acceptance?.acceptedAt, null);
  assert.equal(storage.getWandTask(root.id)?.acceptance?.acceptedAt, null);
});


test("last standalone session archived removes its default group; explicit history search remains reachable", () => {
  const group: TaskDirectoryGroup = { workspaceId: "w", workspaceName: "QA", workspaceCwd: "/qa", tasks: [], standaloneSessions: [], archivedSessions: [{ id: "history", title: "历史证据", archived: true }] };
  assert.deepEqual(filterSidebarGroups([group], ""), []);
  assert.equal(filterSidebarGroups([group], "历史证据")[0]?.archivedSessions?.[0]?.id, "history");
  assert.equal(group.archivedSessions?.length, 1, "history is retained in the original source");
});


test("closed parent context survives an open child and a legacy descendant under timeline filtering", () => {
  const tasks = [{ id: "goal", parentTaskId: null, status: "done" }, { id: "child", parentTaskId: "goal", status: "done" }, { id: "legacy", parentTaskId: "child", status: "doing" }];
  assert.equal(taskHasOpenDescendant(tasks, "goal"), true);
  assert.equal(taskHasOpenDescendant(tasks.map(task => ({ ...task, status: "done" })), "goal"), false);
});
