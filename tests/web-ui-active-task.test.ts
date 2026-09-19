import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";

import { persistActiveTask, readActiveTaskId, restoreActiveTask } from "../src/web-ui/browser/active-task.js";
import { configureWorkspacesRuntime } from "../src/web-ui/react/workspaces/controller.js";
import type { OpenWorkspaceTaskPayload, TaskDirectoryGroup, WorkspacesRuntimeAdapter } from "../src/web-ui/react/workspaces/types.js";

function groups(withTask: boolean): TaskDirectoryGroup[] {
  return [{
    workspaceId: "workspace-1",
    workspaceName: "项目 A",
    workspaceCwd: "/repo",
    tasks: withTask ? [{
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
      sessions: [{ id: "session-1" }],
    }] : [],
    standaloneSessions: [],
  }];
}

/** localStorage 在 Node 里默认不存在；恢复逻辑必须能在它可用时工作。 */
function installStorage(t: TestContext): void {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
  };
  Object.assign(globalThis, { localStorage: storage });
  t.after(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });
}

function installFetch(t: TestContext, handler: () => Promise<Response>): void {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

interface RuntimeCalls {
  opened: OpenWorkspaceTaskPayload[];
  selected: string[];
}

/** 记录 openTask / selectSession 的运行时替身；其余方法都是空实现。 */
function installRuntime(t: TestContext, calls: RuntimeCalls): void {
  const runtime = new Proxy({
    openTask: (payload: OpenWorkspaceTaskPayload) => { calls.opened.push(payload); },
    selectSession: (sessionId: string) => { calls.selected.push(sessionId); },
  } as unknown as WorkspacesRuntimeAdapter, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : () => {}),
  });
  const uninstall = configureWorkspacesRuntime(runtime);
  t.after(uninstall);
}

function newCalls(): RuntimeCalls {
  return { opened: [], selected: [] };
}

test("startup restore reopens the task that was open before the refresh", async (t) => {
  installStorage(t);
  const calls = newCalls();
  installRuntime(t, calls);
  let requests = 0;
  installFetch(t, async () => { requests += 1; return jsonResponse({ groups: groups(true) }); });

  persistActiveTask("task-1");
  assert.equal(readActiveTaskId(), "task-1");
  await restoreActiveTask();

  assert.equal(requests, 1);
  assert.deepEqual(calls.opened, [{
    workspaceId: "workspace-1",
    workspaceName: "项目 A",
    taskId: "task-1",
    taskName: "任务一",
    cwd: "/repo",
  }]);
  assert.deepEqual(calls.selected, [], "openTask already restores the task's own active tab");
  assert.equal(readActiveTaskId(), "task-1", "a restored task stays the cursor for the next refresh");
});

test("startup restore re-selects the session that was on screen before the refresh", async (t) => {
  installStorage(t);
  const calls = newCalls();
  installRuntime(t, calls);
  installFetch(t, async () => jsonResponse({ groups: groups(true) }));

  // 刷新前主区看的是别的会话（例如从看板点开的独立会话）：任务照旧恢复，
  // 但主区必须留在用户看的那个会话上。
  persistActiveTask("task-1");
  await restoreActiveTask("session-loose");

  assert.equal(calls.opened.length, 1);
  assert.deepEqual(calls.selected, ["session-loose"]);
});

test("startup restore forgets a task that no longer exists", async (t) => {
  installStorage(t);
  const calls = newCalls();
  installRuntime(t, calls);
  installFetch(t, async () => jsonResponse({ groups: groups(false) }));

  persistActiveTask("deleted-task");
  await restoreActiveTask();

  assert.deepEqual(calls.opened, [], "a deleted task must not be reopened");
  assert.equal(readActiveTaskId(), "", "the stale cursor must not be retried on every refresh");
});

test("startup restore forgets a task that was completed while the page was closed", async (t) => {
  installStorage(t);
  const calls = newCalls();
  installRuntime(t, calls);
  const finished = groups(true);
  finished[0].tasks[0] = { ...finished[0].tasks[0], status: "done" };
  installFetch(t, async () => jsonResponse({ groups: finished }));

  persistActiveTask("task-1");
  await restoreActiveTask();

  assert.deepEqual(calls.opened, [], "completed tasks are hidden from the sidebar and must stay closed");
  assert.equal(readActiveTaskId(), "");
});

test("startup restore reopens a task whose sessions were all deleted", async (t) => {
  installStorage(t);
  const calls = newCalls();
  installRuntime(t, calls);
  const emptied = groups(true);
  emptied[0].tasks[0] = { ...emptied[0].tasks[0], sessions: [] };
  installFetch(t, async () => jsonResponse({ groups: emptied }));

  persistActiveTask("task-1");
  await restoreActiveTask();

  // 空任务也要回来：标签栏、＋ 新建会话和任务欢迎页都挂在任务上下文上。
  assert.equal(calls.opened.length, 1);
  assert.equal(calls.opened[0].taskId, "task-1");
});

test("startup restore keeps the cursor when the task list cannot be loaded", async (t) => {
  installStorage(t);
  const calls = newCalls();
  installRuntime(t, calls);
  installFetch(t, async () => { throw new Error("offline"); });

  persistActiveTask("task-1");
  await restoreActiveTask();

  assert.deepEqual(calls.opened, []);
  assert.equal(readActiveTaskId(), "task-1");
});

test("startup restore stays silent without a recorded task", async (t) => {
  installStorage(t);
  const calls = newCalls();
  installRuntime(t, calls);
  let requests = 0;
  installFetch(t, async () => { requests += 1; return jsonResponse({ groups: groups(true) }); });

  await restoreActiveTask();

  assert.equal(requests, 0);
  assert.deepEqual(calls.opened, []);
  assert.deepEqual(calls.selected, []);
});

test("startup restore leaves the native embedded terminal alone", async (t) => {
  installStorage(t);
  const calls = newCalls();
  installRuntime(t, calls);
  let requests = 0;
  installFetch(t, async () => { requests += 1; return jsonResponse({ groups: groups(true) }); });
  Object.assign(globalThis, {
    document: { documentElement: { classList: { contains: (token: string) => token === "is-wand-embed-terminal" } } },
  });
  t.after(() => { delete (globalThis as { document?: unknown }).document; });

  persistActiveTask("task-1");
  await restoreActiveTask("session-1");

  assert.equal(requests, 0, "?embed=terminal only wants the terminal pane");
  assert.deepEqual(calls.opened, []);
  assert.deepEqual(calls.selected, []);
  assert.equal(readActiveTaskId(), "task-1", "the cursor survives so the normal web shell still restores later");
});

test("persisting a task replaces the previous cursor and closing clears it", (t) => {
  installStorage(t);
  persistActiveTask("task-1");
  persistActiveTask("task-2");
  assert.equal(readActiveTaskId(), "task-2");
  persistActiveTask(null);
  assert.equal(readActiveTaskId(), "");
});
