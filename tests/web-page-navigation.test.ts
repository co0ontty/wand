import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function fixture(search: string) {
  const source = readFileSync(new URL("../src/web-ui/browser/page-navigation.ts", import.meta.url), "utf8");
  let context: any = { workspaceId: null, taskId: null, layout: null };
  const state: any = { selectedId: null, sessions: [{ id: "s", workspaceId: "w", workspaceTaskId: "t" }] };
  let failure = "";
  let onSelection = () => {};
  let readTask: (() => Promise<any>) | null = null;
  const calls: string[] = [];
  const tab = { id: "tab-s", kind: "session", sessionId: "s" };
  const layout = { type: "windows", activeWindowId: "other", windows: [{ id: "win", layout: { type: "pane", tabs: [tab], active: 0 }, activeTabId: "tab-s" }] };
  let params = new URLSearchParams(search);
  const runtime = {
    closeWorkspace: () => { context = { workspaceId: null, taskId: null, layout: null }; },
    openWorkspace: (workspace: any) => { context = { ...context, workspaceId: workspace.id }; },
    openTask: async (payload: any) => { calls.push(payload.taskId); context = { ...payload, layout }; },
  };
  const api: any = {};
  const imports: Record<string, any> = {
    "../page-route": { hasPageRoute: () => true, pageSearch: () => `?${params}`, subscribePageRoute: () => {}, updatePageRoute: () => {}, workspaceSessionHistoryMode: (search: string, next: string | null) => {
      const current = new URLSearchParams(search).get("session");
      return new URLSearchParams(search).get("view") === "workspace" && current && next && next !== current ? "replace" : "push";
    } },
    "../react/page-route-notice": { reportPageRouteFailure: (value: string) => { failure = value; } },
    "../react/workspaces/controller": { workspacesStore: { getRuntime: () => runtime } },
    "../react/workspaces/repository": { httpWorkspacesRepository: { getTask: async (id: string) => { if (readTask) return readTask(); if (id !== "t") throw Error("无权访问"); return { id, workspaceId: "w", name: "Task", cwd: "/repo" }; }, list: async () => [{ id: "w" }] } },
    "../react/workspaces/workspace-context": { workspaceContextStore: { getSnapshot: () => context, subscribe: () => {} }, setActiveWorkspaceContext: (patch: any) => { context = { ...context, ...patch }; } },
    "../react/workspaces/window-layout": { activeWorkWindowTab: () => tab, layoutSessionIds: () => ["s"] },
    "../react/workspaces/layout-tree": { findLayoutTab: (_: any, id: string) => id === tab.id ? tab : null },
    "./page-selection": { configurePageSelection: (listener: () => void) => { onSelection = listener; }, configurePageRestore: () => {}, withoutPageSelection: (action: () => unknown) => action() },
    "./session-engine": { goHome: () => { state.selectedId = null; }, selectSession: async (id: string) => { state.selectedId = id; } },
    "./state": { state },
    "../react/conversations/state": { conversationUi: { getSnapshot: () => ({ active: false }) } },
  };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports: api, require: (id: string) => { assert.ok(imports[id], id); return imports[id]; }, URLSearchParams, queueMicrotask });
  api.installPageNavigation();
  return { restore: api.restorePageNavigation, state, calls,
    deferTask: (reader: () => Promise<any>) => { readTask = reader; },
    select: (id: string) => { state.selectedId = id; onSelection(); }, context: () => context, failure: () => failure,
    navigate: (search: string) => { params = new URLSearchParams(search); } };
}

test("explicit session, task, window and pane restore without selecting another default", async () => {
  const f = fixture("view=workspace&workspace=w&workspaceTask=t&window=win&tab=tab-s&session=s");
  assert.equal(await f.restore(), true);
  assert.deepEqual(f.calls, ["t"]);
  assert.equal(f.state.selectedId, "s");
  assert.equal(f.context().layout.activeWindowId, "win");
  assert.equal(f.failure(), "");
});

test("missing, inaccessible and mismatched entities fail closed with a returnable notice", async () => {
  for (const search of ["session=deleted", "workspaceTask=forbidden", "workspace=deleted", "workspaceTask=t&workspace=wrong", "workspaceTask=t&window=deleted", "workspaceTask=t&window=win&tab=deleted", "window=win"]) {
    const f = fixture(search);
    f.state.selectedId = "some-default";
    await f.restore();
    assert.equal(f.state.selectedId, null, search);
    assert.ok(f.failure(), search);
  }
});

test("a direct feature page clears a remembered session instead of opening it underneath", async () => {
  const f = fixture("view=taskboard&task=task-stable&q=URL");
  f.state.selectedId = "local-old-session";
  await f.restore();
  assert.equal(f.state.selectedId, null);
  assert.deepEqual(f.calls, []);
});

test("a user selection invalidates an older delayed route before it can reopen its task", async () => {
  const f = fixture("view=workspace&workspaceTask=t&session=s");
  let release!: (value: any) => void;
  f.deferTask(() => new Promise(resolve => { release = resolve; }));
  const pending = f.restore();
  f.select("user-choice");
  release({ id: "t", workspaceId: "w", name: "Old task", cwd: "/repo" });
  await pending;
  assert.equal(f.state.selectedId, "user-choice");
  assert.deepEqual(f.calls, [], "late route must not reopen or reselect the old task");
});
