import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { subscribeTaskChanges } from "../src/web-ui/react/task-changes.js";
import { HttpWorkspacesRepository } from "../src/web-ui/react/workspaces/repository.js";
import {
  draggedTaskId,
  isTaskDrag,
  startTaskDrag,
  TASK_DRAG_TYPE,
} from "../src/web-ui/react/issues/task-drag.js";
import { isSessionDrag, startSessionDrag } from "../src/web-ui/react/workspaces/session-drag.js";

const source = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function transfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    effectAllowed: "none",
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) ?? "",
    get types() { return [...data.keys()]; },
  } as DataTransfer;
}

test("archiving a sidebar task goes through the archive endpoint and never the cascade delete", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  let changes = 0;
  let failed = false;
  const unsubscribe = subscribeTaskChanges(() => { changes++; });
  try {
    const repository = new HttpWorkspacesRepository(async (url, init) => {
      requests.push({ url: String(url), method: String(init?.method ?? "GET") });
      return new Response(
        JSON.stringify(failed ? { error: "未找到该任务。" } : { id: "task/a", status: "done" }),
        { status: failed ? 404 : 200, headers: { "content-type": "application/json" } },
      );
    });
    const archived = await repository.archiveTask("task/a");
    assert.deepEqual(requests, [{ url: "/api/workspace-tasks/task%2Fa/archive", method: "POST" }]);
    assert.equal(changes, 1, "successful archive refreshes the board through the shared signal");
    assert.equal((archived as { status: string }).status, "done");
    failed = true;
    await assert.rejects(repository.archiveTask("gone"), /未找到该任务/);
    assert.equal(changes, 1, "a rejected archive must not invalidate the two task views");
  } finally {
    unsubscribe();
  }
});

test("batch selection archives tasks but stays a plain action until terminals are picked", async () => {
  const { describeManagedAction, managedSelectionIsDestructive } = await import("../src/web-ui/react/workspaces/sidebar-manage.js");
  const panel = source("src/web-ui/react/workspaces/workspaces-panel.tsx");
  const tasksOnly = { taskIds: ["t1", "t2"], sessionIds: [] };
  assert.equal(managedSelectionIsDestructive(tasksOnly), false);
  assert.equal(managedSelectionIsDestructive({ taskIds: [], sessionIds: ["s1"] }), true);
  assert.match(panel, /managedSelectionIsDestructive\(prunedSelection\) \? "danger" : "secondary"/);
  assert.equal(describeManagedAction(tasksOnly), "归档任务");
});

test("sidebar task menus archive by default and only isolated tasks keep a worktree delete", () => {
  const panel = source("src/web-ui/react/workspaces/workspaces-panel.tsx");
  assert.match(panel, /await httpWorkspacesRepository\.archiveTask\(task\.id\)/);
  assert.match(panel, /归档任务（保留 Worktree）/);
  assert.match(panel, /可在任务看板的归档任务中恢复/);
  // 硬删除只剩隔离任务的 Worktree 清理入口；普通任务不再有级联删除按钮。
  assert.match(panel, /isolated \? \(/);
  assert.match(panel, /删除任务并清理 Worktree/);
  assert.equal(
    (panel.match(/httpWorkspacesRepository\.deleteTask\(/g) ?? []).length,
    1,
    "batch mode archives tasks; only the worktree cleanup path still deletes one",
  );
  assert.doesNotMatch(panel, /describeManagedDeletion/);
});

test("board cards archive by dragging into the archive zone and restore by dragging out", () => {
  const host = source("src/web-ui/react/issues/task-board-host.tsx");
  const styles = source("src/web-ui/content/styles.css");
  // 归档区只接受看板自己的卡片拖拽，终端拖拽继续走列 / 卡片的移动逻辑。
  assert.match(host, /onDragOver=\{\(event\) => \{\s*if \(!isTaskDrag\(event\.dataTransfer\)\) return;[\s\S]*?setArchiveDrop\(true\)/);
  assert.match(host, /if \(id\) void archiveCard\(id\)/);
  assert.match(host, /task-board-archive-zone/);
  assert.match(host, /拖到这里归档：侧栏隐藏，终端与记录保留/);
  // 归档完成后自动展开归档目录，否则卡片只是从看板上消失，看不出落在哪里。
  assert.match(host, /setCollapsedList\(\(current\) => \(\{ \.\.\.current, archived: false \}\)\)/);
  // 恢复：拖回任意列改状态，右键菜单也留了「恢复到等待认领」。
  assert.match(host, /taskBoardRepository\.update\(taskId, \{ status: "todo" \}\)/);
  assert.match(host, /onRestore=\{\(\) => \{/);
  assert.ok(styles.includes(".task-board-archive-zone.is-over .task-board-archive-hint"));
  assert.ok(styles.includes(".task-board-column-list > .task-board-archive-zone"));
});

test("task and session drags never satisfy each other's drop targets", () => {
  const card = transfer();
  startTaskDrag(card, "task-1");
  assert.equal(isTaskDrag(card), true);
  assert.equal(draggedTaskId(card), "task-1");
  assert.equal(isSessionDrag(card), false, "an archived card must not be movable as a session");
  const session = transfer();
  startSessionDrag(session, "session-1");
  assert.equal(isTaskDrag(session), false, "a session drag must not be archivable");
  assert.equal(draggedTaskId(session), "");
  assert.equal(card.getData("text/plain"), "task-1", "columns still accept the legacy text/plain payload");
  assert.equal(TASK_DRAG_TYPE, "application/x-wand-task");
});
