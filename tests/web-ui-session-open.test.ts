import assert from "node:assert/strict";
import test from "node:test";

import { configureWorkspacesRuntime } from "../src/web-ui/react/workspaces/controller.js";
import { findSessionOwningTask, findTaskContext, openSessionWithOwningTask, taskOpenPayload } from "../src/web-ui/react/workspaces/session-open.js";
import { clearActiveWorkspaceContext, setActiveWorkspaceContext } from "../src/web-ui/react/workspaces/workspace-context.js";
import type { TaskDirectoryGroup, WorkspacesRuntimeAdapter } from "../src/web-ui/react/workspaces/types.js";

function groupsFixture(): TaskDirectoryGroup[] {
  return [{
    workspaceId: "workspace-1",
    workspaceName: "项目 A",
    workspaceCwd: "/repo",
    tasks: [
      {
        id: "task-1",
        workspaceId: "workspace-1",
        name: "任务一",
        cwd: "/repo",
        worktree: null,
        layout: null,
        status: "active",
        createdAt: "2026-01-01",
        lastOpenedAt: null,
        isolated: false,
        sessions: [{ id: "session-1" }, { id: "session-2" }],
      },
    ],
    standaloneSessions: [{ id: "session-loose" }],
  }];
}

test("findSessionOwningTask finds the task that owns a session and ignores loose ones", () => {
  const groups = groupsFixture();
  assert.equal(findSessionOwningTask(groups, "session-2")?.task.id, "task-1");
  assert.equal(findSessionOwningTask(groups, "session-2")?.group.workspaceName, "项目 A");
  assert.equal(findSessionOwningTask(groups, "session-loose"), null);
  assert.equal(findSessionOwningTask(groups, "session-missing"), null);
  assert.equal(findSessionOwningTask([], "session-1"), null);
});

test("findTaskContext resolves a task id to its directory group and open payload", () => {
  const groups = groupsFixture();
  assert.equal(findTaskContext(groups, "task-1")?.task.name, "任务一");
  assert.equal(findTaskContext(groups, " task-1 ")?.group.workspaceId, "workspace-1");
  assert.equal(findTaskContext(groups, "task-missing"), null);
  assert.equal(findTaskContext(groups, ""), null);
  assert.equal(findTaskContext([], "task-1"), null);
  assert.deepEqual(taskOpenPayload(findTaskContext(groups, "task-1")!), {
    workspaceId: "workspace-1",
    workspaceName: "项目 A",
    taskId: "task-1",
    taskName: "任务一",
    cwd: "/repo",
  });
  // 从会话入口打开任务时带上「先选中这一个」：恢复布局后不会先闪一下别的会话。
  assert.equal(taskOpenPayload(findTaskContext(groups, "task-1")!, "session-2").preferredSessionId, "session-2");
  // 全局空间里的任务没有可显示的目录名；与侧栏一致地留空。
  const global = { ...groups[0], workspaceId: "wand-global", workspaceName: "全局", global: true };
  assert.equal(taskOpenPayload(findTaskContext([global], "task-1")!).workspaceName, "");
});

test("opening a session from the board restores its task context before selecting it", async () => {
  const calls: string[] = [];
  const payloads: unknown[] = [];
  const runtime = new Proxy({
    openTask: (payload: unknown) => { calls.push("openTask"); payloads.push(payload); },
    selectSession: (id: string) => { calls.push(`selectSession:${id}`); },
  } as unknown as WorkspacesRuntimeAdapter, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : () => {}),
  });
  const uninstall = configureWorkspacesRuntime(runtime);
  const originalFetch = globalThis.fetch;
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fallback = (id: string): void => { calls.push(`fallback:${id}`); };
  try {
    clearActiveWorkspaceContext();
    globalThis.fetch = async () => jsonResponse({ groups: groupsFixture() });
    await openSessionWithOwningTask("session-2", fallback);
    assert.deepEqual(calls, ["openTask", "selectSession:session-2"]);
    assert.deepEqual(payloads, [{
      workspaceId: "workspace-1",
      workspaceName: "项目 A",
      taskId: "task-1",
      taskName: "任务一",
      cwd: "/repo",
      preferredSessionId: "session-2",
    }]);

    // 已在同一任务内：不再重开任务（避免重复 flush / 恢复覆盖选中态）。
    setActiveWorkspaceContext({ taskId: "task-1" });
    calls.length = 0;
    await openSessionWithOwningTask("session-1", fallback);
    assert.deepEqual(calls, ["fallback:session-1"]);

    // 未分组会话与未知会话保持调用方原有行为。
    clearActiveWorkspaceContext();
    calls.length = 0;
    await openSessionWithOwningTask("session-loose", fallback);
    await openSessionWithOwningTask("session-missing", fallback);
    assert.deepEqual(calls, ["fallback:session-loose", "fallback:session-missing"]);

    // 任务列表拿不到时也必须能打开会话。
    globalThis.fetch = async () => jsonResponse({ error: "boom" }, 500);
    calls.length = 0;
    await openSessionWithOwningTask("session-2", fallback);
    assert.deepEqual(calls, ["fallback:session-2"]);
  } finally {
    globalThis.fetch = originalFetch;
    uninstall();
    clearActiveWorkspaceContext();
  }
});
