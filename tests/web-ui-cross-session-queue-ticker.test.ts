import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/**
 * 跨会话排队条的节拍器生命周期。
 *
 * 历史问题：节拍器是模块级 `setInterval`，导入即启动、永不清理；登出后仍在每 5s
 * 调 `flushCrossSessionQueue()`，把已经登出的用户当成能开会话的人。
 * 现在它按需启停（`renderCrossSessionQueue()` 在每次变更后对齐），并且
 * `flushCrossSessionQueue()` 在未登录时直接返回。
 */
function harness() {
  const state: Record<string, any> = {
    config: {}, crossSessionQueue: [], sessions: [], selectedId: null,
    chatMode: "managed", terminalInteractive: false, drafts: {},
  };
  const intervals: Array<{ id: number; handler: () => void; ms: number | undefined; cleared: boolean }> = [];
  let nextTimerId = 1;
  let fetches = 0;
  const noop = () => {};
  const fallback = new Proxy({}, { get: () => noop });
  const api: Record<string, any> = {};
  const source = readFileSync(new URL("../src/web-ui/browser/input.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  runInNewContext(outputText, {
    exports: api,
    require: (id: string) => (id === "./state" ? { state } : id === "./chat-scroll" ? new Proxy({}, { get: () => noop }) : fallback),
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, removeEventListener: noop,
      documentElement: { classList: { contains: () => false, add: noop, remove: noop, toggle: noop } },
    },
    window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }) },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: () => 1, clearTimeout: noop,
    setInterval: (handler: () => void, ms?: number) => { const id = nextTimerId++; intervals.push({ id, handler, ms, cleared: false }); return id; },
    clearInterval: (id: number) => { const entry = intervals.find((item) => item.id === id); if (entry) entry.cleared = true; },
    fetch: () => { fetches++; return Promise.resolve(new Response("{}", { status: 200 })); },
    console: { error: noop, log: noop, warn: noop },
    Date, JSON, Promise, Math, String, Number, Array, Object, Error, WebSocket: class {},
  });
  return {
    api, state,
    liveTickers: () => intervals.filter((item) => !item.cleared && item.ms === 5000),
    fetches: () => fetches,
  };
}

test("排队条节拍器只在队列非空时运行，排空即停", () => {
  const h = harness();
  assert.equal(h.liveTickers().length, 0, "模块导入不得自带 interval");

  h.state.crossSessionQueue = [{ id: "q1", text: "hello", queuedAt: Date.now() }];
  h.api.renderCrossSessionQueue();
  assert.equal(h.liveTickers().length, 1);

  // 重复渲染不得叠加节拍器。
  h.api.renderCrossSessionQueue();
  assert.equal(h.liveTickers().length, 1);

  h.state.crossSessionQueue = [];
  h.api.renderCrossSessionQueue();
  assert.equal(h.liveTickers().length, 0, "队列排空后必须自停");
});

test("登出时显式停掉节拍器", () => {
  const h = harness();
  h.state.crossSessionQueue = [{ id: "q1", text: "hello", queuedAt: Date.now() }];
  h.api.renderCrossSessionQueue();
  assert.equal(h.liveTickers().length, 1);
  h.api.stopCrossSessionQueueTicker();
  assert.equal(h.liveTickers().length, 0);
});

test("未登录时 flushCrossSessionQueue 不发任何请求", () => {
  const h = harness();
  h.state.config = null;
  h.state.crossSessionQueue = [{ id: "q1", text: "hello", cwd: "/tmp", mode: "managed", tool: "claude", queuedAt: Date.now() }];
  h.api.flushCrossSessionQueue();
  assert.equal(h.fetches(), 0, "登录页/登出后不得拿着 401 去 POST /api/commands");
  assert.equal(h.state.crossSessionQueue.length, 1, "队列要原样留着，等登录后再续");

  h.state.config = {};
  h.api.flushCrossSessionQueue();
  assert.equal(h.fetches(), 1, "登录后同一队列可以继续 flush");
});
