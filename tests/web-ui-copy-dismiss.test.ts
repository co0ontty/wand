import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type CopyButton = {
  classes: Set<string>;
  classList: { add: (name: string) => void; remove: (name: string) => void };
};

function makeCopyButton(): CopyButton {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      add: (name: string) => { classes.add(name); },
      remove: (name: string) => { classes.delete(name); },
    },
  };
}

// chat-render 的复制按钮长按 IIFE 只在模块加载时自执行一次，所以必须用 vm 载入并在
// 注入的 document 上收集监听器（依赖用 Proxy stub，参照 web-ui-session-activation.test.ts）。
function harness() {
  const listeners: Record<string, Array<(event: any) => void>> = {};
  let querySelectorAllCalls = 0;
  const longPressTimers: Array<() => void> = [];
  const noop = () => {};
  const documentStub = new Proxy({
    addEventListener: (type: string, handler: (event: any) => void) => {
      (listeners[type] ||= []).push(handler);
    },
    querySelectorAll: (_selector: string) => { querySelectorAllCalls++; return []; },
  }, { get: (obj: Record<string, unknown>, key: string) => obj[key] ?? noop });
  const windowStub = new Proxy(
    { matchMedia: () => ({ matches: true }) },
    { get: (obj: Record<string, unknown>, key: string) => obj[key] ?? noop },
  );
  const fallback = new Proxy({}, { get: () => noop });
  const source = readFileSync(new URL("../src/web-ui/browser/chat-render.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  runInNewContext(outputText, {
    exports: {}, require: (id: string) => id === "./state" ? { state: {} } : fallback,
    document: documentStub, window: windowStub, Element: class {}, console,
    setTimeout: (handler: () => void) => { longPressTimers.push(handler); return longPressTimers.length; },
    clearTimeout: noop, requestAnimationFrame: noop,
  });

  const fire = (type: string, event: any) => {
    const handlers = listeners[type] || [];
    // 模块加载时会在 document 上注册多个 click（todo 折叠 + 复制按钮取消）。
    // 复制按钮的取消处理器是最后注册的那个。
    const targets = type === "click" ? handlers.slice(-1) : handlers;
    for (const handler of targets) handler(event);
  };
  return {
    listeners,
    querySelectorAllCalls: () => querySelectorAllCalls,
    // 长按成功后执行被挂起的 setTimeout 回调（模拟 500ms 计时器到点）
    runLongPress: () => { const timer = longPressTimers.pop(); if (timer) timer(); },
    longPress: (btn: CopyButton) => {
      const msgEl = {
        querySelector: (selector: string) => selector === ".chat-message-bubble" ? {} : selector === ".msg-copy-btn" ? btn : null,
      };
      fire("touchstart", { target: { closest: (selector: string) => selector === ".chat-message" ? msgEl : null }, touches: [{ clientY: 10 }] });
      const timer = longPressTimers.pop();
      if (timer) timer();
    },
    click: (target: unknown) => fire("click", { target }),
  };
}

test("没有可见按钮时点击页面任意位置不会全量扫 DOM", () => {
  const h = harness();
  assert.equal(h.listeners.touchstart?.length, 1, "长按 IIFE 必须挂上 touchstart");
  const before = h.querySelectorAllCalls();
  // target 连 closest 都没有：提前 return 必须发生在任何 DOM 查询之前
  h.click({});
  assert.equal(h.querySelectorAllCalls() - before, 0, "无可见按钮时不得调用 querySelectorAll");
});

test("长按第二个按钮时按引用隐藏上一个，且取消只作用于新引用", () => {
  const h = harness();
  const first = makeCopyButton();
  const second = makeCopyButton();
  h.longPress(first);
  assert.equal(first.classes.has("visible"), true);
  h.longPress(second);
  assert.equal(first.classes.has("visible"), false, "上一个可见按钮必须被隐藏");
  assert.equal(second.classes.has("visible"), true);
  // 引用只指向新的：一次外部点击只隐藏新按钮
  h.click({ closest: () => null });
  assert.equal(second.classes.has("visible"), false, "外部点击必须隐藏当前引用");
  assert.equal(first.classes.has("visible"), false);
});

test("点击复制按钮自身不隐藏（closest 命中 msg-copy-btn）", () => {
  const h = harness();
  const btn = makeCopyButton();
  h.longPress(btn);
  const before = h.querySelectorAllCalls();
  h.click({ closest: (selector: string) => selector === ".msg-copy-btn" ? btn : null });
  assert.equal(btn.classes.has("visible"), true, "点按钮自身不得隐藏");
  assert.equal(h.querySelectorAllCalls() - before, 0, "取消路径同样不得调用 querySelectorAll");
});
