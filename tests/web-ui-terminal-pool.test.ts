import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { getWandTerminalTheme } from "../src/web-ui/react/theme.js";
import { queueTerminalWrite } from "../src/web-ui/browser/terminal-write-queue.js";
import { terminalConnectionLabel } from "../src/web-ui/react/quick-terminal/runtime.js";

// 分屏终端池的缩放记录清理：sessionScales 是「窗格」级别的临时偏好，
// 池实例释放时必须一起删掉，否则反复开关分屏会留下无界 Map，且同 id 重建
// 的终端会继承旧比例（而不是回落到 state.terminalScale 的默认值）。

interface FakeTerminal {
  cols: number;
  rows: number;
  options: Record<string, unknown>;
  buffer: { active: { type: string; ydisp: number; ybase: number } };
  modes: { bracketedPasteMode: boolean };
  writes: string[];
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
      child.parentNode?.removeChild(child);
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
    dataHandler?: (data: string) => void;
    resizeHandler?: (size: { cols: number; rows: number }) => void;
    onData(callback: (data: string) => void): void { this.dataHandler = callback; }
    onBinary(): void {}
    onResize(callback: (size: { cols: number; rows: number }) => void): void { this.resizeHandler = callback; }
    onScroll(): void {}
    writes: string[] = [];
    write(data: string, callback?: () => void): void {
      this.writes.push(data);
      if (data.includes("\x1b[6n")) this.dataHandler?.("\x1b[1;1R");
      if (callback) callback();
    }
    reset(): void {}
    clear(): void {}
    resize(cols: number, rows: number): void {
      this.cols = cols; this.rows = rows;
      this.resizeHandler?.({ cols, rows });
    }
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
      "../react/quick-terminal/runtime": { configureQuickTerminalRuntime: noop, terminalConnectionLabel },
      "../react/theme": { getWandTerminalTheme },
      "../react/theme-preference": { wandThemeStore: { subscribe: () => noop } },
      "./terminal": { clampClientTerminalOutput: (value: string) => value },
      "./terminal-fit": { fitTerminalToContainer: (term: FakeXTerm) => { if (term.cols !== 100 || term.rows !== 30) term.resize(100, 30); } },
      "./terminal-write-queue": { queueTerminalWrite },
      "./terminal-wheel": {
        consumeTerminalWheelLines: () => 0,
        consumeTerminalWheelPage: () => 0,
        consumeTerminalZoomWheel: () => 0,
        installTerminalPinchZoom: () => {},
        terminalWheelPageSequence: () => "",
      },
    } as Record<string, unknown>)[id] ?? fallback,
    WebSocket: { OPEN: 1 },
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

test("分屏方向重挂载只迁移终端容器，保留实例、缓冲和缩放直到实际释放", () => {
  const h = harness();
  h.pool.createPooledTerminal("S1", h.container);
  const terminal = h.created[0];
  const wrap = h.container.children[0];
  terminal.buffer.active.ydisp = 12;
  terminal.buffer.active.ybase = 40;
  h.pool.setPooledTerminalScale("S1", 1.5);
  const fontSize = terminal.options.fontSize;

  const nextContainer = fakeElement();
  assert.equal(h.pool.createPooledTerminal("S1", nextContainer), true);
  assert.equal(h.created.length, 1, "移动容器不重新创建 xterm");
  assert.equal(nextContainer.children[0], wrap, "迁移原终端 DOM");
  assert.equal(h.container.children.length, 0);
  assert.equal(terminal.buffer.active.ydisp, 12);
  assert.equal(terminal.buffer.active.ybase, 40);
  assert.equal(h.pool.getPooledTerminalScale("S1"), 1.5);
  assert.equal(terminal.options.fontSize, fontSize);

  h.pool.disposePooledTerminal("S1");
  assert.equal(nextContainer.children.length, 0);
  assert.equal(h.pool.hasPooledTerminal("S1"), false);
  assert.equal(h.pool.getPooledTerminalScale("S1"), 1);
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

test("快捷终端租约不被工作区分屏清理，断线禁用输入，init 后恢复", () => {
  const h = harness();
  h.pool.retainPooledTerminal("quick", true);
  h.pool.createPooledTerminal("quick", h.container);
  h.pool.createPooledTerminal("split", h.container);
  assert.equal(h.created[0].options.disableStdin, true);
  h.pool.notifyPooledTerminalEvent({ type: "init", sessionId: "quick", data: { status: "running" } });
  assert.equal(h.created[0].options.disableStdin, false);
  h.pool.notifyPooledTerminalEvent({ type: "disconnected" });
  assert.equal(h.created[0].options.disableStdin, true);
  h.pool.disposeAllPooledTerminals();
  assert.equal(h.pool.hasPooledTerminal("quick"), true);
  assert.equal(h.pool.hasPooledTerminal("split"), false);
  h.pool.retainPooledTerminal("quick", false);
  h.pool.disposePooledTerminal("quick");
  assert.equal(h.pool.hasPooledTerminal("quick"), false);
});

test("共享连接的其他错误不禁用快捷终端，进程退出状态立即禁用输入", () => {
  const h = harness();
  h.pool.retainPooledTerminal("quick", true);
  h.pool.createPooledTerminal("quick", h.container);
  h.pool.notifyPooledTerminalEvent({ type: "init", sessionId: "quick", data: { status: "running" } });
  h.pool.notifyPooledTerminalEvent({ type: "error", data: { message: "unrelated request" } });
  h.pool.notifyPooledTerminalEvent({ type: "pty_error", sessionId: "another" });
  assert.equal(h.created[0].options.disableStdin, false);
  h.pool.notifyPooledTerminalEvent({ type: "status", sessionId: "quick", data: { status: "exited" } });
  assert.equal(h.created[0].options.disableStdin, true);
});

test("隐藏的快捷终端收到重连快照不发送尺寸，重新显示后仍保留输出", async () => {
  const h = harness();
  const sent: Array<{ type: string }> = [];
  h.state.ws = { readyState: 1, send: (value: string) => sent.push(JSON.parse(value)) };
  h.pool.retainPooledTerminal("quick", true);
  h.container.clientWidth = 0;
  h.container.clientHeight = 0;
  h.pool.createPooledTerminal("quick", h.container);
  await new Promise(resolve => setTimeout(resolve, 0));
  sent.length = 0;
  h.pool.restorePooledTerminalState("quick", { version: 1, cols: 80, rows: 24, data: "KEPT", pending: [] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(sent.filter(message => message.type === "pty_resize"), []);
  assert.equal(h.created[0].writes.at(-1), "KEPT");
});

test("权威快照会跳过 reset 前已排队的实时帧，避免回放后重影", async () => {
  const h = harness();
  assert.equal(h.pool.createPooledTerminal("S1", h.container), true);
  const terminal = h.created[0];

  // Promise queue callbacks run after this synchronous turn. The snapshot
  // generation must invalidate both live frames before either reaches xterm.
  h.pool.writePooledTerminal("S1", "live-before-1");
  h.pool.writePooledTerminal("S1", "live-before-2");
  assert.equal(h.pool.restorePooledTerminalState("S1", {
    version: 1, cols: 80, rows: 24, data: "authoritative", pending: [],
  }), true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(terminal.writes.length, 1,
    "旧 live 帧不能在 reset/replay 后再次写入 xterm");
  assert.equal(terminal.writes[0], "authoritative");
});

test("快照的历史网格和终端查询只在本地重放，最终只同步一次真实网格", async () => {
  const h = harness();
  const sent: Array<{ type: string; cols?: number; rows?: number }> = [];
  h.state.ws = { readyState: 1, send: (text: string) => sent.push(JSON.parse(text)) };
  h.pool.createPooledTerminal("S1", h.container);
  await new Promise(resolve => setTimeout(resolve, 0));
  sent.length = 0;
  h.pool.restorePooledTerminalState("S1", { version: 1, cols: 80, rows: 24,
    data: "\x1b[6n", pending: [{ type: "resize", cols: 60, rows: 20 }, { type: "data", data: "\x1b[6n" }, { type: "resize", cols: 90, rows: 25 }] });
  h.pool.writePooledTerminal("S1", "live-after-restore", 16);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(sent.filter(e => e.type === "pty_input"), [], "never answer historical DA/DSR queries");
  assert.deepEqual(sent.filter(e => e.type === "pty_resize"), [{ type: "pty_resize", sessionId: "S1", cols: 100, rows: 30 }]);
  assert.equal(sent.filter(e => e.type === "pty_ack").length, 1);
  assert.equal(h.created[0].writes.at(-1), "live-after-restore");
  sent.length = 0;
  h.pool.replacePooledTerminalOutput("S1", "legacy\x1b[6n");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(sent.filter(e => e.type === "pty_input"), [], "legacy full-output replay is also read-only");
});

test("没有池实例时会话的缩放记录也要被清掉（面板已渲染但 XTermLib 未就绪）", () => {
  const h = harness();
  // createPooledTerminal 从未成功（未进池），但缩放会被写入记录。
  h.pool.setPooledTerminalScale("S9", 2);
  assert.equal(h.pool.getPooledTerminalScale("S9"), 2);
  h.pool.disposePooledTerminal("S9");
  assert.equal(h.pool.getPooledTerminalScale("S9"), 1, "早退分支也必须清掉记录，否则 Map 仍无界");
});
