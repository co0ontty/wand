import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createTaskDetailStore } from "../src/web-ui/react/workspaces/task-detail-store.js";
import { createTaskLayoutController } from "../src/web-ui/react/workspaces/task-layout-controller.js";
import * as windowLayout from "../src/web-ui/react/workspaces/window-layout.js";
import { orderWorkspaceSessions } from "../src/web-ui/react/workspaces/session-order.js";
import type { WorkspaceTaskDetail, WorkspacesRuntimeAdapter } from "../src/web-ui/react/workspaces/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
function fixture(id: string): WorkspaceTaskDetail {
  return { id, name: id, workspaceId: "workspace", cwd: `/${id}`, layout: null, layoutRevision: 0,
    status: "active", worktree: null, createdAt: "2026-01-01", lastOpenedAt: null, isolated: false,
    sessions: [{ id: `${id}-session`, title: id, cwd: `/${id}` }] };
}
function harness() {
  const state = { selectedId: null as string | null };
  let context: Record<string, any> = { layout: null, taskId: null };
  let runtime!: WorkspacesRuntimeAdapter;
  const reads: Array<{ id: string; result: ReturnType<typeof deferred<WorkspaceTaskDetail>> }> = [];
  const writes: Array<{ id: string; layout: unknown; revision?: number; result: ReturnType<typeof deferred<any>> }> = [];
  const errors: string[] = [];
  const starts: Array<{ cwd: string; options: Record<string, unknown> }> = [];
  const models: Record<string, string> = {};
  const repository = {
    getTask(id: string) { const result = deferred<WorkspaceTaskDetail>(); reads.push({ id, result }); return result.promise; },
    saveTaskLayout(id: string, layout: unknown, revision?: number) {
      const result = deferred<any>(); writes.push({ id, layout, revision, result }); return result.promise;
    },
  };
  const store = createTaskDetailStore(repository);
  const fallback = new Proxy({}, { get: () => () => {} });
  const dependencies: Record<string, unknown> = {
    "./state": { state },
    "../react/workspaces/controller": { configureWorkspacesRuntime: (value: WorkspacesRuntimeAdapter) => { runtime = value; return () => {}; } },
    "../react/workspaces/workspace-context": {
      setActiveWorkspaceContext: (patch: object) => { context = { ...context, ...patch }; },
      clearActiveWorkspaceContext: () => { context = { taskId: null, layout: null }; },
      workspaceContextStore: { getSnapshot: () => context },
    },
    "../react/workspaces/repository": { httpWorkspacesRepository: repository },
    "../react/workspaces/task-detail-store": { taskDetailStore: store },
    "../react/workspaces/task-layout-controller": { createTaskLayoutController },
    "../react/workspaces/window-layout": windowLayout,
    "../react/workspaces/session-order": { orderWorkspaceSessions },
    "./notifications": { showToast: (message: string) => errors.push(message) },
    "./session-engine": {
      goHome: () => { state.selectedId = null; }, dismissDrawerIfOverlay: () => {},
      selectSession: (id: string) => { state.selectedId = id; },
      getChatModelForProvider: (provider: string) => models[provider] ?? "",
      setChatModelForProvider: (provider: string, model: string) => { models[provider] = model; },
      startSessionInCwd: (cwd: string, options: Record<string, unknown>) => {
        starts.push({ cwd, options });
        return Promise.resolve("new-session");
      },
    },
  };
  const source = readFileSync(new URL("../src/web-ui/browser/workspaces-adapter.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const exports: Record<string, any> = {};
  runInNewContext(outputText, { exports, require: (id: string) => dependencies[id] ?? fallback,
    localStorage: { setItem: () => {}, removeItem: () => {} } });
  exports.installWorkspacesLegacyAdapter();
  const open = (id: string, extra: Record<string, unknown> = {}) => runtime.openTask({ taskId: id, taskName: id, workspaceId: "workspace", workspaceName: "workspace", cwd: `/${id}`, ...extra });
  return { runtime, reads, writes, errors, starts, state, context: () => context, open };
}

test("task prompts start a bound session for both PTY and structured runners", async () => {
  for (const kind of ["pty", "structured"] as const) {
    const h = harness();
    const created = h.runtime.newTaskSession({ taskId: "A", workspaceId: "workspace", cwd: "/A",
      target: "pi", kind, prompt: "实现这个任务的第一步", model: "claude-opus-4-1" });
    await tick();
    h.reads[0].result.resolve(fixture("A"));
    await created;
    assert.equal(h.starts[0].cwd, "/A");
    assert.equal(h.starts[0].options.workspaceTaskId, "A");
    assert.equal(h.starts[0].options.kind, kind);
    assert.equal(h.starts[0].options.initialInput, "实现这个任务的第一步");
    // 选择器里选的模型必须跟会话一起提交，PTY 与结构化都要。
    assert.equal(h.starts[0].options.model, "claude-opus-4-1");
  }
});

test("model preference reads and writes the composer's per-provider memory", () => {
  const h = harness();
  assert.equal(h.runtime.modelPreference("claude"), "");
  h.runtime.rememberModelPreference("claude", "opus");
  assert.equal(h.runtime.modelPreference("claude"), "opus");
  h.runtime.rememberModelPreference("claude", "");
  assert.equal(h.runtime.modelPreference("claude"), "");
});

test("adapter routes restoration, user edits and creation through one task revision queue", async () => {
  const h = harness();
  const opened = h.open("A"); await tick(); h.reads[0].result.resolve(fixture("A")); await opened;
  assert.equal(h.writes.length, 1, "restoration uses write queue");
  const created = h.runtime.newTaskSession({ taskId: "A", workspaceId: "workspace", cwd: "/A", target: "shell", kind: "pty" });
  await tick();
  h.reads[1].result.resolve({ ...fixture("A"), sessions: [...fixture("A").sessions, { id: "new-session" }] });
  await created;
  const latest = { ...h.context().layout, activeWindowId: "window-new-session" };
  const saved = h.runtime.saveTaskLayout(latest);
  assert.equal(h.writes.length, 1, "creation and UI edits wait for restoration");
  h.writes[0].result.resolve({ layout: h.writes[0].layout, layoutRevision: 1 }); await tick();
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].revision, 1);
  assert.equal(h.writes[1].layout, latest);
  h.writes[1].result.resolve({ layout: latest, layoutRevision: 2 });
  assert.equal(await saved, "saved");
});

test("adapter drops superseded opens and prevents old-task save/recovery responses changing the new task", async () => {
  const h = harness();
  const a = h.open("A"); await tick();
  const b = h.open("B"); await tick();
  h.reads[0].result.resolve(fixture("A")); await a;
  assert.equal(h.state.selectedId, null);
  assert.equal(h.writes.length, 0);
  h.reads[1].result.resolve(fixture("B")); await b;
  assert.equal(h.state.selectedId, "B-session");
  const c = h.open("C"); await tick();
  h.writes[0].result.reject(new Error("offline")); await tick();
  const recovery = h.reads.findLast((read) => read.id === "B")!;
  recovery.result.resolve({ ...fixture("B"), layoutRevision: 99 }); await tick();
  assert.equal(h.context().taskId, "C");
  assert.equal(h.context().layout, null);
  assert.equal(h.context().layoutRevision, undefined);
  assert.match(h.errors[0], /布局未保存/);
  h.reads.find((read) => read.id === "C")!.result.resolve(fixture("C")); await c;
  h.writes.at(-1)!.result.resolve({ layout: h.writes.at(-1)!.layout, layoutRevision: 1 }); await tick();
});

test("opening a task restores its saved active split instead of selecting the first session", async () => {
  const h = harness();
  const remote = fixture("A");
  remote.sessions = [{ id: "first" }, { id: "second" }, { id: "third" }];
  const initial = windowLayout.reconcileTaskWindowLayout(null, ["first", "second", "third"], "first");
  remote.layout = windowLayout.moveSessionBeside(initial, "third", initial.windows[1].id, undefined, "h");
  const opened = h.open("A"); await tick(); h.reads[0].result.resolve(remote); await opened;
  assert.equal(h.state.selectedId, "third");
  assert.deepEqual(h.context().layout, remote.layout);
  assert.equal(h.writes.length, 0, "restoring an unchanged saved layout does not issue a PUT");
});

test("opening a task selects the requested session instead of the layout's active tab", async () => {
  const remote = fixture("A");
  remote.sessions = [{ id: "first" }, { id: "second" }];
  remote.layout = windowLayout.reconcileTaskWindowLayout(null, ["first", "second"], "first");

  // 调用方点名了会话（侧栏 / 看板 / 通知点的哪一个）：恢复出来就是它。
  const requested = harness();
  const opened = requested.open("A", { preferredSessionId: "second" });
  await tick(); requested.reads[0].result.resolve(remote); await opened;
  assert.equal(requested.state.selectedId, "second");

  // 进入任务前选中、且属于这个任务的会话同样优先；goHome() 会清空 selectedId，
  // 所以必须在它之前读，否则永远落到布局里的活动标签上。
  const entering = harness();
  entering.state.selectedId = "second";
  const reentered = entering.open("A");
  await tick(); entering.reads[0].result.resolve(remote); await reentered;
  assert.equal(entering.state.selectedId, "second");

  // 点名的会话不在任务里（旧列表 / 已删除）：回落到布局里的活动标签。
  const stale = harness();
  const staleOpen = stale.open("A", { preferredSessionId: "missing" });
  await tick(); stale.reads[0].result.resolve(remote); await staleOpen;
  assert.equal(stale.state.selectedId, "first");
});

test("conflict recovery restores remote active window and selection, not the failed optimistic selection", async () => {
  const h = harness();
  const remote = fixture("A");
  remote.sessions = [{ id: "first" }, { id: "second" }];
  remote.layout = windowLayout.reconcileTaskWindowLayout(null, ["first", "second"], "first");
  const opened = h.open("A"); await tick(); h.reads[0].result.resolve(remote); await opened;
  h.state.selectedId = "second";
  const saving = h.runtime.saveTaskLayout(windowLayout.activateWorkWindow(remote.layout, remote.layout.windows[1].id));
  h.writes[0].result.reject(new Error("conflict")); await tick();
  h.reads[1].result.resolve({ ...remote, layoutRevision: 8 });
  assert.equal(await saving, "failed");
  assert.equal(h.state.selectedId, "first");
  assert.deepEqual(h.context().layout, remote.layout);
  assert.equal(h.context().layoutRevision, 8);
});

test("failed task writes block poll reconciliation and reopening writes without changing the draft", async () => {
  const h = harness();
  const opened = h.open("A"); await tick(); h.reads[0].result.resolve(fixture("A")); await opened;
  h.writes[0].result.reject(new Error("conflict")); await tick();
  const draft = h.context().layout;
  const fromPoll = windowLayout.reconcileTaskWindowLayout(draft, ["A-session", "poll-added"], "poll-added");
  assert.equal(await h.runtime.saveTaskLayout(fromPoll, { automatic: true }), "failed");
  assert.equal(h.context().layout, draft, "suppressed automatic save must not change the visible draft");
  h.reads[1].result.resolve(fixture("A")); await tick();
  const reopened = h.open("A"); await tick();
  h.reads[2].result.resolve({ ...fixture("A"), sessions: [...fixture("A").sessions, { id: "poll-added" }] });
  await reopened;
  assert.equal(h.writes.length, 1, "initialization cannot bypass automatic-write suppression");
});

test("closing a workspace invalidates an in-flight task open", async () => {
  const h = harness(); const opened = h.open("A"); await tick();
  h.runtime.closeWorkspace(); h.reads[0].result.resolve(fixture("A")); await opened;
  assert.equal(h.context().taskId, null); assert.equal(h.state.selectedId, null); assert.equal(h.writes.length, 0);
});
