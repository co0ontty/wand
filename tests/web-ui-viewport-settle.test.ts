import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Timer = { id: number; delay: number | undefined; handler: () => void; cleared: boolean };

function loadBrowserModule(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown>) {
  const source = readFileSync(new URL(`../src/web-ui/browser/${file}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const exports: Record<string, any> = {};
  const fallback = new Proxy({}, { get: () => () => {} });
  runInNewContext(outputText, { exports, require: (id: string) => dependencies[id] ?? fallback, ...globals });
  return exports;
}

function harness() {
  const timers: Timer[] = [];
  let nextTimerId = 1;
  const documentListeners: Record<string, (e: unknown) => void> = {};
  const windowListeners: Record<string, (e: unknown) => void> = {};
  const timeouts: Timer[] = [];

  const vv = { height: 800, width: 390, offsetTop: 0, addEventListener: () => {} } as Record<string, unknown> & {
    addEventListener: () => void;
  };
  const rootStyle = { setProperty: () => {} };
  const globals = {
    console,
    Date,
    Promise,
    window: {
      visualViewport: vv,
      innerWidth: 390,
      innerHeight: 800,
      scrollY: 0,
      addEventListener: (name: string, handler: (e: unknown) => void) => {
        windowListeners[name] = handler;
      },
      removeEventListener: () => {},
    },
    document: {
      activeElement: null as unknown,
      hidden: false,
      visibilityState: "visible",
      documentElement: { classList: { toggle: () => {} }, style: rootStyle, clientWidth: 390, clientHeight: 800 },
      body: { clientHeight: 800 },
      getElementById: () => null,
      addEventListener: (name: string, handler: (e: unknown) => void) => {
        documentListeners[name] = handler;
      },
      removeEventListener: () => {},
    },
    // 同步执行：debouncedUpdate 走 rAF，测试里要让它立刻落到 updateViewport。
    requestAnimationFrame: (cb: () => void) => {
      cb();
      return 1;
    },
    cancelAnimationFrame: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (handler: () => void, delay?: number) => {
      const id = nextTimerId++;
      const timer: Timer = { id, delay, handler, cleared: false };
      timers.push(timer);
      timeouts.push(timer);
      return id;
    },
    clearTimeout: (id: number) => {
      // 兼容 setTimeout 句柄被当作对象/数字传回的实现。
      const entry = timers.find((item) => item.id === (typeof id === "object" ? (id as unknown as Timer).id : id));
      if (entry) entry.cleared = true;
    },
  };
  const state: Record<string, unknown> = {};
  const dependencies = { "./state": { state, writeStoredBoolean: () => {} } };
  const viewport = loadBrowserModule("viewport", dependencies, globals);
  return {
    viewport,
    timers,
    documentListeners,
    windowListeners,
    liveTimers: () => timeouts.filter((item) => !item.cleared),
  };
}

// focus 相关路径注册的 focusin 监听器就是 focused-input settle 的唯一触发点。
function triggerFocusIn(h: ReturnType<typeof harness>) {
  const target = { tagName: "INPUT", getAttribute: () => "text" };
  h.documentListeners["focusin"]?.({ target });
}

// iOS IME 状态事件是唯一同时排两批 settle 的入口（focus 批次 + viewport 批次）。
function triggerImeState(h: ReturnType<typeof harness>) {
  h.windowListeners["wand-ios-ime-state"]?.({ detail: { state: "hidden" } });
}

test("settle 定时器在 setup 后为空，focus 批次的档位与旧实现保持一致", () => {
  const h = harness();
  h.viewport.setupVisualViewportHandlers();
  assert.equal(h.liveTimers().length, 0, "setup 阶段不得预排 settle 回调");

  triggerFocusIn(h);
  assert.deepEqual(
    h.liveTimers().map((item) => item.delay).sort((a, b) => (a as number) - (b as number)),
    [0, 50, 120, 220, 360, 560],
    "focused-input settle 档位不得改变"
  );
});

test("连续两次 scheduleFocusedInputSettle 只保留 6 个 live 定时器", () => {
  const h = harness();
  h.viewport.setupVisualViewportHandlers();

  triggerFocusIn(h);
  const firstBatch = h.liveTimers();
  assert.equal(firstBatch.length, 6);

  triggerFocusIn(h);
  assert.equal(h.liveTimers().length, 6, "重排前必须清掉上一批，不能叠加成 12 个");
  assert.ok(firstBatch.every((item) => item.cleared), "旧一批的每个定时器都要被 clearTimeout");
  assert.equal(h.timers.length, 12, "两批各 6 个回调，只是旧的一批被清掉");
});

test("teardownTerminal 清空两批 settle 定时器", () => {
  const h = harness();
  h.viewport.setupVisualViewportHandlers();
  triggerFocusIn(h);
  triggerImeState(h);
  // focus 批次 [0,50,120,220,360,560] 被重排成 6 个，viewport 批次再叠 [60,180,360,620,900]。
  assert.deepEqual(
    h.liveTimers().map((item) => item.delay).sort((a, b) => (a as number) - (b as number)),
    [0, 50, 60, 120, 180, 220, 360, 360, 560, 620, 900],
    "两批 settle 定时器应同时在 live 集合里"
  );

  h.viewport.teardownTerminal();
  assert.equal(h.liveTimers().length, 0, "teardown 后不得残留任何 settle 定时器");
});

test("保留下来的 settle 回调在 document.getElementById 返回 null 时不抛异常", () => {
  const h = harness();
  h.viewport.setupVisualViewportHandlers();
  triggerFocusIn(h);
  triggerFocusIn(h);

  const live = h.liveTimers();
  assert.equal(live.length, 6);
  for (const timer of live) {
    assert.doesNotThrow(() => timer.handler());
  }

  h.viewport.teardownTerminal();
  for (const timer of live) {
    assert.doesNotThrow(() => timer.handler(), "teardown 之后旧的 settle 回调仍应是安全 no-op");
  }
});
