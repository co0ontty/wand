import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createStartupPreload } from "../src/web-ui/startup-preload.js";
import { capturePageSelection, notifyPageSelection, withoutPageSelection } from "../src/web-ui/browser/page-selection.js";
import { HttpWorkspacesRepository } from "../src/web-ui/react/workspaces/repository.js";
import { clearTaskBoardPreload, loadTaskBoardList, preloadTaskBoardList } from "../src/web-ui/react/issues/task-board-list-repository.js";
import { notifyTasksChanged } from "../src/web-ui/react/task-changes.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("startup handoff survives module latency, is used once and never becomes a polling cache", async () => {
  let reads = 0;
  const query = createStartupPreload(async () => ++reads);
  query.preload(); query.preload();
  await tick();
  assert.equal(reads, 1);
  assert.equal(await query.load(), 1);
  assert.equal(await query.load(), 2);
});

test("failed preloads retry and invalidation detaches a late pre-mutation/logout result", async () => {
  const first = deferred<number>();
  let reads = 0;
  const query = createStartupPreload(() => ++reads === 1 ? first.promise : Promise.resolve(reads));
  query.preload();
  query.clear();
  query.preload();
  first.resolve(1);
  await tick();
  assert.equal(await query.load(), 2);
  const failed = createStartupPreload(() => ++reads === 3 ? Promise.reject(Error("offline")) : Promise.resolve(reads));
  failed.preload(); await tick();
  assert.equal(await failed.load(), 4);
});

test("only real selection invalidates the boot cursor, not a suppressed projection", () => {
  const current = capturePageSelection();
  withoutPageSelection(() => notifyPageSelection());
  assert.equal(current(), true);
  notifyPageSelection();
  assert.equal(current(), false);
});

test("workspace directory mount consumes the completed boot read once and retains revision polling", async () => {
  const urls: string[] = [];
  const repository = new HttpWorkspacesRepository(async input => {
    urls.push(String(input));
    return new Response(JSON.stringify({ groups: [], revision: "r1" }));
  });
  repository.preloadTaskGroups(); await tick();
  await repository.listTaskGroups();
  assert.equal(urls.length, 1);
  await repository.listTaskGroups("r1");
  assert.equal(urls.length, 2);
  assert.ok(urls[1].includes("revision=r1"));
});

test("board boot read is separate from filtered reads and discarded after a mutation", async t => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async input => {
    urls.push(String(input));
    return new Response(JSON.stringify([]));
  };
  t.after(() => { clearTaskBoardPreload(); globalThis.fetch = original; });
  clearTaskBoardPreload();
  preloadTaskBoardList(); await tick();
  await loadTaskBoardList("project");
  await loadTaskBoardList();
  assert.deepEqual(urls, ["/api/wand-tasks", "/api/wand-tasks?workspaceId=project"]);
  preloadTaskBoardList(); await tick();
  notifyTasksChanged();
  await loadTaskBoardList();
  assert.equal(urls.length, 4, "post-mutation read must not reuse the pre-mutation handoff");
});

function boot() {
  const file = readFileSync(new URL("../src/web-ui/browser/render.ts", import.meta.url), "utf8");
  const source = file.slice(file.indexOf("export function restoreLoginSession()"), file.indexOf("// ===== 桌面："));
  const auth = deferred<unknown>();
  const config = deferred<unknown>();
  const sessions = deferred<void>();
  let selection = true;
  let search = "?view=taskboard";
  const events: string[] = [];
  const frames: Array<() => void> = [];
  const state = { config: null, loginChecked: false };
  const scope: Record<string, unknown> = {
    exports: {}, state, navigator: { onLine: true }, isStandaloneSettingsPage: () => false,
    fetch: () => auth.promise, loadConfigSnapshot: () => { events.push("config"); return config.promise; },
    preloadAuthenticatedPage: () => events.push("preload"), clearStartupPreloads: () => events.push("clear"),
    invalidateSessionList: () => events.push("invalidate-sessions"),
    capturePageSelection: () => () => selection, pageSearch: () => search, hasPageRoute: () => true,
    requestAnimationFrame: (frame: () => void) => frames.push(frame),
    render: () => events.push("render"), startPolling: () => events.push("poll"),
    applyConfigDefaultThinking: () => {},
    loadSessions: (options: unknown) => { events.push(`sessions:${JSON.stringify(options)}`); return sessions.promise; },
    restoreActiveTask: () => events.push("restore"), fetchAvailableModels: () => {}, requestNotificationPermission: () => {},
    _apkVersion: null, _macAppVersion: null,
  };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, scope);
  (scope.exports as { restoreLoginSession(): void }).restoreLoginSession();
  return { auth, config, sessions, frames, events, state,
    select: () => { selection = false; }, navigate: () => { search = "?view=workspace"; } };
}

test("auth gates preloads; config and page data overlap before rAF or host effects", async () => {
  const b = boot();
  assert.deepEqual(b.events, []);
  b.auth.resolve({ ok: true, json: async () => ({ authed: true }) }); await tick();
  assert.deepEqual(b.events, ["config", "preload"]);
  assert.equal(b.frames.length, 0, "data starts while config is still pending");
  b.config.resolve({}); await tick(); b.frames.shift()!();
  assert.ok(b.events.includes('sessions:{"reuseSnapshot":true,"skipSelectedOutputReload":true}'));
  b.sessions.resolve(); await tick();
  assert.ok(b.events.includes("restore"));
});

test("anonymous/expired auth starts no protected data or page module", async () => {
  const b = boot();
  b.auth.resolve({ ok: true, json: async () => ({ authed: false }) }); await tick();
  assert.deepEqual(b.events, ["render"]);
});

test("config permission failure clears the handoff and never mounts a protected shell", async () => {
  const b = boot();
  b.auth.resolve({ ok: true, json: async () => ({ authed: true }) }); await tick();
  b.config.reject({ status: 403 }); await tick();
  assert.deepEqual(b.events, ["config", "preload", "clear", "invalidate-sessions", "render"]);
  assert.equal(b.frames.length, 0);
});

test("logout before the scheduled frame cannot restart the protected shell or poll", async () => {
  const b = boot();
  b.auth.resolve({ ok: true, json: async () => ({ authed: true }) }); await tick();
  b.config.resolve({}); await tick();
  b.state.config = null;
  b.frames.shift()!();
  assert.equal(b.events.includes("poll"), false);
  assert.equal(b.events.includes("render"), false);
});

test("a route changed before sessions arrive is restored as the live target", async () => {
  const b = boot();
  b.auth.resolve({ ok: true, json: async () => ({ authed: true }) }); await tick();
  b.config.resolve({}); await tick(); b.frames.shift()!();
  b.navigate();
  b.sessions.resolve(); await tick();
  assert.equal(b.events.includes("restore"), true);
});

test("late session loading cannot restore over a newer selection or logout", async () => {
  for (const change of ["select", "logout"] as const) {
    const b = boot();
    b.auth.resolve({ ok: true, json: async () => ({ authed: true }) }); await tick();
    b.config.resolve({}); await tick(); b.frames.shift()!();
    if (change === "logout") b.state.config = null;
    else b[change]();
    b.sessions.resolve(); await tick();
    assert.equal(b.events.includes("restore"), false, change);
  }
});
