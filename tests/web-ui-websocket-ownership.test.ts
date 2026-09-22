import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function loadBrowserModule(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown>) {
  const source = readFileSync(new URL(`../src/web-ui/browser/${file}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const exports: Record<string, any> = {};
  const fallback = new Proxy({}, { get: () => () => {} });
  runInNewContext(outputText, { exports, require: (id: string) => dependencies[id] ?? fallback, ...globals });
  return exports;
}

function harness() {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    sent: string[] = [];
    constructor(_url: string) { sockets.push(this); }
    close() { this.readyState = 3; this.onclose?.(); }
    send(value: string) { this.sent.push(value); }
  }
  const state: Record<string, any> = { config: {}, ws: null, selectedId: "selected", lastSeqBySession: {} };
  let subscribed = 0;
  let toasted = 0;
  let foregroundBindings = 0;
  let listUpdates = 0;
  let gitPollsStarted = 0;
  let gitPollsStopped = 0;
  const listeners: string[] = [];
  const timeEls: unknown[] = [];
  const intervals: Array<{ id: number; handler: () => void; ms: number | undefined; cleared: boolean }> = [];
  let nextTimerId = 1;
  const globals = {
    WebSocket: FakeSocket, window: { WebSocket: FakeSocket, location: { protocol: "http:", host: "example" }, addEventListener: (name: string) => listeners.push(name) },
    document: {
      hidden: false, addEventListener: () => {},
      getElementById: () => null, querySelectorAll: () => timeEls,
    }, Date, console,
    fetch: () => new Promise(() => {}),
    setInterval: (handler: () => void, ms?: number) => { const id = nextTimerId++; intervals.push({ id, handler, ms, cleared: false }); return id; },
    clearInterval: (id: number) => { const entry = intervals.find((item) => item.id === id); if (entry) entry.cleared = true; },
    setTimeout: () => 1, clearTimeout: () => {},
  };
  const dependencies = {
    "./state": { state },
    "./render": { bindForegroundSyncListeners: () => { foregroundBindings++; } },
    "./notifications": { showToast: () => { toasted++; } },
    "./git-commit": new Proxy({
      startGitStatusPolling: () => { gitPollsStarted++; },
      stopGitStatusPolling: () => { gitPollsStopped++; },
      scheduleGitStatusRefresh: () => {},
    }, { get: (obj: Record<string, unknown>, key: string) => obj[key] ?? (() => {}) }),
    "./session-engine": new Proxy({}, { get: (_target, key) => key === "subscribeToSession"
      ? () => { subscribed++; }
      : key === "scheduleSessionListUpdate" ? () => { listUpdates++; } : () => Promise.resolve() }),
  };
  const ws = loadBrowserModule("websocket", dependencies, globals);
  const render = loadBrowserModule("render", { ...dependencies, "./websocket": ws }, globals);
  const liveIntervals = () => intervals.filter((item) => !item.cleared);
  return {
    state, sockets, ws, render, listeners, timeEls,
    subscribed: () => subscribed, toasted: () => toasted, foregroundBindings: () => foregroundBindings,
    listUpdates: () => listUpdates, gitPollsStarted: () => gitPollsStarted, gitPollsStopped: () => gitPollsStopped,
    liveIntervals,
  };
}

test("polling startup binds foreground recovery for a fresh login as well as restored login", () => {
  const h = harness(); h.ws.startPolling();
  assert.equal(h.foregroundBindings(), 1);
});

test("foreground listener installation remains idempotent across repeated polling startups", () => {
  const h = harness();
  h.render.bindForegroundSyncListeners(); h.render.bindForegroundSyncListeners();
  assert.equal(h.listeners.filter((name) => name === "focus").length, 1);
  assert.equal(h.listeners.filter((name) => name === "pageshow").length, 1);
});

test("session-time polling and git polling start with polling and stop on teardown", () => {
  const h = harness();
  assert.equal(h.liveIntervals().length, 0, "模块导入时不得自带 interval（登出后仍在跑的历史问题）");
  h.ws.startPolling();
  const timeTimer = h.liveIntervals().find((item) => item.ms === 30_000);
  assert.ok(timeTimer, "登录后应该有侧边栏相对时间节拍器");
  assert.equal(h.gitPollsStarted(), 1);
  h.timeEls.push("<span class=\"session-time\"></span>");
  timeTimer.handler();
  assert.equal(h.listUpdates(), 1);
  timeTimer.handler();
  assert.equal(h.listUpdates(), 2);

  const stopsBefore = h.gitPollsStopped();
  h.ws.stopPolling();
  assert.equal(h.gitPollsStopped(), stopsBefore + 1);
  assert.equal(h.liveIntervals().some((item) => item.ms === 30_000), false, "登出后相对时间节拍器必须停");
});

test("repeated polling startups keep exactly one session-time timer", () => {
  const h = harness();
  h.ws.startPolling();
  h.ws.startPolling();
  h.timeEls.push("<span class=\"session-time\"></span>");
  h.liveIntervals().filter((item) => item.ms === 30_000).forEach((item) => item.handler());
  assert.equal(h.listUpdates(), 1, "重复 startPolling 不得叠加节拍器");
});

test("foreground stale recovery owns the replacement while CONNECTING and opens only one socket", async () => {
  const h = harness();
  h.ws.initWebSocket();
  const first = h.sockets[0]; first.readyState = 1; first.onopen!();
  h.state.lastWsMessageAt = Date.now() - 60_000;
  await h.render.syncOnForeground("test");
  assert.equal(h.sockets.length, 2);
  assert.equal(h.state.ws, h.sockets[1]);
  h.ws.initWebSocket();
  assert.equal(h.sockets.length, 2, "ordinary init reuses CONNECTING socket");
});

test("obsolete open/message/close/error callbacks cannot act on a replacement socket", () => {
  const h = harness();
  h.ws.initWebSocket();
  const old = h.sockets[0];
  const callbacks = { open: old.onopen!, message: old.onmessage!, close: old.onclose!, error: old.onerror! };
  h.ws.forceReconnectWebSocket("test");
  const replacement = h.sockets[1];
  assert.equal(old.onopen, null);
  assert.equal(old.onmessage, null);
  callbacks.open();
  callbacks.message({ data: JSON.stringify({ type: "pty_error", error: "obsolete" }) });
  callbacks.close(); callbacks.error();
  assert.equal(h.state.ws, replacement);
  assert.equal(h.subscribed(), 0);
  assert.equal(h.toasted(), 0);
  replacement.readyState = 1; replacement.onopen!();
  assert.equal(h.subscribed(), 1);
  callbacks.close();
  assert.equal(h.state.wsConnected, true);
  assert.equal(h.state.ws, replacement);
});

test("forced foreground recovery does not first create an extra heartbeat replacement", async () => {
  const h = harness();
  h.ws.initWebSocket(); h.sockets[0].readyState = 1; h.sockets[0].onopen!();
  h.state.lastWsMessageAt = Date.now() - 60_000;
  await h.render.syncOnForeground("forced", true);
  assert.equal(h.sockets.length, 2);
});
