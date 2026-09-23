import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// 分屏终端池的缩放记录清理：sessionScales 是「窗格」级别的临时偏好，
// 池实例释放时必须一起删掉，否则反复开关分屏会留下无界 Map，且同 id 重建
// 的终端会继承旧比例（而不是回落到 state.terminalScale 的默认值）。

interface FakeTerminal {
  cols: number;
  rows: number;
  options: Record<string, unknown>;
  buffer: { active: { type: string; ydisp: number; ybase: number } };
  modes: { bracketedPasteMode: boolean };
  dispose(): void;
}

function fakeElement(): any {
  const element: any = {
    className: "",
    dataset: {},
    parentNode: null,
    children: [],
    classList: { contains: () => false },
    appendChild(child: any) {
      child.parentNode = element;
      element.children.push(child);
      return child;
    },
    removeChild(child: any) {
      child.parentNode = null;
      element.children = element.children.filter((item: any) => item !== child);
      return child;
    },
    addEventListener: () => {},
    querySelector: () => null,
  };
  return element;
}

function harness(options?: { embed?: boolean }) {
  const created: FakeTerminal[] = [];
  const state: Record<string, any> = {
    sessions: [],
    terminalStatesBySession: {},
    terminalScale: 1,
    terminalBaseFontSize: 13,
    terminalInteractive: false,
    ws: null,
  };
  const noop = () => {};
  const fallback = new Proxy({}, { get: () => noop });

  class FakeXTerm {
    cols = 120;
    rows = 36;
    options: Record<string, unknown>;
    buffer = { active: { type: "normal", ydisp: 0, ybase: 0 } };
    modes = { bracketedPasteMode: false };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      created.push(this as unknown as FakeTerminal);
    }
    open(): void {}
    loadAddon(): void {}
    onData(): void {}
    onBinary(): void {}
    onResize(): void {}
    onScroll(): void {}
    write(_data: string, callback?: () => void): void {
      if (callback) callback();
    }
    reset(): void {}
    clear(): void {}
    resize(): void {}
    scrollLines(): void {}
    scrollToBottom(): void {}
    dispose(): void {}
  }

  const source = readFileSync(new URL("../src/web-ui/browser/terminal-pool.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const exports: Record<string, any> = {};
  const sandbox: Record<string, unknown> = {
    exports,
    require: (id: string) => ({
      "./state": { state },
      "./terminal": { clampClientTerminalOutput: (value: string) => value },
      "./terminal-fit": { fitTerminalToContainer: noop },
      "./terminal-wheel": {
        consumeTerminalWheelLines: () => 0,
        consumeTerminalWheelPage: () => 0,
        consumeTerminalZoomWheel: () => 0,
        installTerminalPinchZoom: () => {},
        terminalWheelPageSequence: () => "",
      },
    } as Record<string, unknown>)[id] ?? fallback,
    XTermLib: { Terminal: FakeXTerm, FitAddon: class {} },
    ResizeObserver: class {
      observe(): void {}
      disconnect(): void {}
    },
    requestAnimationFrame: () => 1,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    window: { setTimeout: () => 1 },
    document: {
      documentElement: {
        classList: {
          contains: (token: string) => options?.embed === true && token === "is-wand-embed-terminal",
        },
      },
      createElement: () => fakeElement(),
    },
  };
  runInNewContext(outputText, sandbox);
  return { pool: exports, state, created, container: fakeElement() };
}

test("释放池实例后缩放记录被丢弃，同 id 重建的终端回到默认比例", () => {
  const h = harness();
  assert.equal(h.pool.createPooledTerminal("S1", h.container), true);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].options.fontSize, 13, "首次创建用 state.terminalScale=1 的默认字号");

  assert.equal(h.pool.setPooledTerminalScale("S1", 2), 2);
  assert.equal(h.pool.getPooledTerminalScale("S1"), 2);
  assert.equal(h.created[0].options.fontSize, 26);

  h.pool.disposePooledTerminal("S1");
  assert.equal(h.pool.hasPooledTerminal("S1"), false);
  assert.equal(h.pool.getPooledTerminalScale("S1"), 1, "释放后回落到 state.terminalScale，不再记着旧比例");

  assert.equal(h.pool.createPooledTerminal("S1", h.container), true);
  assert.equal(h.created.length, 2);
  assert.equal(h.created[1].options.fontSize, 13, "重建的终端不得继承已释放实例的放大比例");
});

test("嵌入终端和桌面使用同一基础字号", () => {
  const h = harness({ embed: true });
  assert.equal(h.pool.createPooledTerminal("S1", h.container), true);
  assert.equal(h.created[0].options.fontSize, 13);
});

test("退出分屏清空整个池时同样丢弃缩放记录", () => {
  const h = harness();
  h.pool.createPooledTerminal("S1", h.container);
  h.pool.createPooledTerminal("S2", h.container);
  h.pool.setPooledTerminalScale("S1", 1.25);
  h.pool.setPooledTerminalScale("S2", 0.75);
  h.pool.disposeAllPooledTerminals();
  h.state.terminalScale = 1.5;
  assert.equal(h.pool.getPooledTerminalScale("S1"), 1.5);
  assert.equal(h.pool.getPooledTerminalScale("S2"), 1.5);
});

test("没有池实例时会话的缩放记录也要被清掉（面板已渲染但 XTermLib 未就绪）", () => {
  const h = harness();
  // createPooledTerminal 从未成功（未进池），但缩放会被写入记录。
  h.pool.setPooledTerminalScale("S9", 2);
  assert.equal(h.pool.getPooledTerminalScale("S9"), 2);
  h.pool.disposePooledTerminal("S9");
  assert.equal(h.pool.getPooledTerminalScale("S9"), 1, "早退分支也必须清掉记录，否则 Map 仍无界");
});
