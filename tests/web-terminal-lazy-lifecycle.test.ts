import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const noop = () => {};
const fallback = new Proxy({}, { get: () => noop });
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function load(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown>) {
  const source = readFileSync(new URL(`../src/web-ui/browser/${file}.ts`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const api: Record<string, any> = {};
  runInNewContext(code, { exports: api, require: (id: string) => dependencies[id] ?? fallback, ...globals });
  return api;
}

test("first workspace shell and PTY creation wait for measured dimensions before POST", async () => {
  for (const shell of [true, false]) {
    const library = deferred();
    const state: Record<string, any> = { sessions: [], selectedId: null, config: {}, terminal: null };
    const posted: Record<string, unknown>[] = [];
    const api = load("session-engine", {
      "./state": { state },
      "./session-reads": { createSessionReads: () => ({}) },
      "../../session-completion-state.js": { createSessionCompletionViewIntent: () => ({}) },
      "../vendor-loader.js": { ensureTerminalLibrary: () => library.promise },
      "./terminal": { initTerminal: ({ prepare }: { prepare: boolean }) => {
        assert.equal(prepare, true);
        state.terminal = { cols: 80, rows: 24, remeasure: () => { state.terminal.cols = 82; state.terminal.rows = 25; } };
      } },
    }, {
      window: { addEventListener: noop }, document: {}, console,
      setTimeout: () => 1, clearTimeout: noop,
      requestAnimationFrame: (callback: () => void) => callback(),
      fetch: (_url: string, init: RequestInit) => {
        posted.push(JSON.parse(String(init.body)));
        return Promise.resolve(new Response(JSON.stringify({ error: "fixture-complete" }), { status: 400 }));
      },
    });
    const created = api.startSessionInCwd("/tmp", { shell, provider: "codex", kind: "pty" });
    await tick(); assert.equal(posted.length, 0, "an unloaded terminal cannot start the process yet");
    library.resolve(); await assert.rejects(created, /fixture-complete/);
    assert.equal(posted[0].cols, 82); assert.equal(posted[0].rows, 25);
    assert.equal(posted[0].cwd, "/tmp");
  }
});

class Element {
  parentNode: Element | null = null; children: Element[] = []; className = "";
  dataset: Record<string, string> = {}; style: Record<string, string> = {}; textContent = "";
  root = false; clientHeight = 400; scrollHeight = 400; scrollTop = 0;
  listeners = new Map<string, Set<(...args: any[]) => void>>();
  get isConnected(): boolean { return this.root || !!this.parentNode?.isConnected; }
  classList = { add: noop, remove: noop, contains: () => false, toggle: noop };
  appendChild(child: Element) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
  removeChild(child: Element) { this.children = this.children.filter(item => item !== child); child.parentNode = null; }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...children: Element[]) { for (const child of [...this.children]) child.remove(); for (const child of children) this.appendChild(child); }
  setAttribute() {}
  querySelectorAll(selector: string): Element[] {
    const matches = (node: Element) => selector === "button" ? (node as any).tag === "button"
      : selector === "[data-terminal-load-state]" ? !!node.dataset.terminalLoadState
        : selector.startsWith(".") && node.className.split(" ").includes(selector.slice(1));
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type: string, handler: (...args: any[]) => void) {
    const set = this.listeners.get(type) ?? new Set(); set.add(handler); this.listeners.set(type, set);
  }
  removeEventListener(type: string, handler: (...args: any[]) => void) { this.listeners.get(type)?.delete(handler); }
  click() { for (const handler of this.listeners.get("click") ?? []) handler({}); }
}

function terminalHarness() {
  const output = new Element(); output.root = true;
  const html = new Element(); html.root = true;
  const document = {
    documentElement: html, fonts: { ready: Promise.resolve() },
    getElementById: (id: string) => id === "output" ? output : null,
    createElement: (tag: string) => Object.assign(new Element(), { tag }),
    addEventListener: noop, removeEventListener: noop,
  };
  const state: Record<string, any> = { selectedId: "A", sessions: [{ id: "A", sessionKind: "pty", output: "" }],
    currentView: "terminal", terminal: null, terminalInitializing: false, terminalBaseFontSize: 13,
    terminalStatesBySession: {}, terminalRestoreGeneration: 0, terminalProgrammaticScrollUntil: 0 };
  const errors: unknown[] = [], terms: any[] = [], fits: any[] = [];
  let failAt = "", disposeThrows = false, viewport: Record<string, any> = {};
  class Terminal {
    cols = 80; rows = 24; options = {}; unicode = { activeVersion: "" }; element: Element | null = null;
    disposeCount = 0; openCount = 0;
    buffer = { active: { viewportY: 0, baseY: 0, type: "normal", getLine: () => null } };
    constructor() { if (failAt === "terminal") throw new Error("terminal constructor failed"); terms.push(this); }
    loadAddon() { if (failAt === "addon") throw new Error("loadAddon failed"); }
    open(wrap: Element) { this.openCount++; if (failAt === "open") throw new Error("open failed"); this.element = new Element(); wrap.appendChild(this.element); }
    dispose() { this.disposeCount++; if (disposeThrows) throw new Error("dispose failed"); }
    registerLinkProvider() {} attachCustomKeyEventHandler() {} onData() {} onBinary() {} onResize() {} onScroll() {}
    reset() {} clear() {}
    write(_text: string, callback?: () => void) { callback?.(); } scrollToBottom() {}
  }
  class FitAddon {
    disposeCount = 0;
    constructor() { if (failAt === "fit-constructor") throw new Error("fit constructor failed"); fits.push(this); }
    dispose() { this.disposeCount++; }
  }
  const globals = {
    document, window: { addEventListener: noop, removeEventListener: noop, setTimeout: () => 1 },
    console: { error: (...values: unknown[]) => errors.push(values) },
    XTermLib: { Terminal, FitAddon, Unicode11Addon: class {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
    setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop,
  };
  const dependencies = {
    "./state": { state },
    "./session-engine": { isStructuredSession: (session: any) => session.sessionKind === "structured" },
    "./viewport": new Proxy({}, { get: (_target, key: string) => {
      if (key === "observeTerminalResize" && failAt === "observe") return () => {
        state.resizeObserver = { disconnect: () => { state.observerDisconnected = true; } };
        throw new Error("observe failed");
      };
      return viewport[key] ?? noop;
    } }),
    "./terminal-fit": { fitTerminalToContainer: () => { if (failAt === "fit") throw new Error("fit failed"); } },
  };
  const api = load("terminal", dependencies, globals);
  viewport = load("viewport", { ...dependencies, "./terminal": api }, globals);
  // Layout-specific resize setup is outside the fixture; teardown stays real.
  for (const key of ["ensureTerminalFit", "initTerminalResizeHandle", "observeTerminalResize", "startTerminalHealthCheck"]) viewport[key] = noop;
  return { api, state, output, document, terms, fits, errors, viewport, globals, dependencies,
    fail: (where: string) => { failAt = where; }, failDispose: () => { disposeThrows = true; } };
}

test("terminal partial synchronous construction releases its wrapper and permits explicit retry", async () => {
  for (const failure of ["terminal", "fit-constructor", "addon"]) {
    const h = terminalHarness(); h.fail(failure); h.api.initTerminal();
    assert.equal(h.state.terminalInitializing, false, failure);
    assert.equal(h.state.terminal, null); assert.equal(h.output.querySelectorAll(".terminal-scroll-wrap").length, 0);
    assert.equal(h.errors.length, 1); assert.equal(h.output.querySelectorAll("button").length, 1);
    h.api.initTerminal(); assert.equal(h.errors.length, 1, "normal status refresh does not loop retries");
    h.fail("open"); h.output.querySelector("button")!.click(); await tick();
    assert.equal(h.terms.at(-1).openCount, 1, "explicit retry can start a fresh mount");
    assert.equal(h.terms.at(-1).disposeCount, 1);
    assert.equal(h.state.terminalInitializing, false);
    assert.equal(h.output.querySelectorAll(".terminal-scroll-wrap").length, 0);
  }
});

test("terminal asynchronous setup failure releases assigned state, listeners and observer", async () => {
  const h = terminalHarness(); h.fail("observe"); h.api.initTerminal(); await tick();
  assert.equal(h.terms[0].disposeCount, 1);
  assert.equal(h.state.terminal, null); assert.equal(h.state.terminalFitAddon, null);
  assert.equal(h.state.terminalInitializing, false); assert.equal(h.state.observerDisconnected, true, String(h.errors));
  assert.equal(h.state.terminalWheelHandler, null); assert.equal(h.state.terminalClickHandler, null);
  assert.equal(h.output.listeners.get("wheel")?.size ?? 0, 0);
  assert.equal(h.output.listeners.get("click")?.size ?? 0, 0);
  assert.equal(h.output.querySelectorAll(".terminal-scroll-wrap").length, 0);
  assert.equal(h.output.querySelectorAll(".terminal-scrollbar").length, 0);
});

test("a throwing terminal disposer cannot retain instance references or block retry", async () => {
  const h = terminalHarness(); h.fail("observe"); h.failDispose(); h.api.initTerminal(); await tick();
  assert.equal(h.terms[0].disposeCount, 2, "both owner teardown and independent fallback attempt disposal");
  assert.equal(h.state.terminal, null); assert.equal(h.state.terminalFitAddon, null);
  assert.equal(h.state.terminalInitializing, false);
  assert.equal(h.output.querySelectorAll(".terminal-scroll-wrap").length, 0);
  h.fail("open"); h.output.querySelector("button")!.click(); await tick();
  assert.equal(h.terms.length, 2, "a disposer exception cannot block a fresh attempt");
});

test("an abandoned font wait cannot open or clear a newer session terminal mount", async () => {
  const h = terminalHarness(); const oldFonts = deferred(), newFonts = deferred();
  h.document.fonts.ready = oldFonts.promise; h.api.initTerminal();
  h.viewport.teardownTerminal();
  h.state.selectedId = "B"; h.state.sessions = [{ id: "B", sessionKind: "pty", output: "" }];
  h.document.fonts.ready = newFonts.promise; h.api.initTerminal();
  assert.equal(h.terms.length, 2, "switching while fonts are pending permits B to mount");
  oldFonts.resolve(); await tick();
  assert.equal(h.terms[0].openCount, 0); assert.equal(h.terms[0].disposeCount, 1);
  assert.equal(h.state.terminalInitializing, true); assert.equal(h.terms[1].disposeCount, 0);
  assert.equal(h.output.querySelectorAll(".terminal-scroll-wrap").length, 1);
  newFonts.resolve(); await tick();
  assert.equal(h.state.terminal, h.terms[1], String(h.errors)); assert.equal(h.state.terminalInitializing, false);
  assert.deepEqual(h.errors, []);
});

test("a partially constructed split terminal releases resources before an explicit retry", () => {
  for (const failure of ["fit-constructor", "open", "observe"]) {
    const h = terminalHarness(); let disconnected = 0, failObserver = failure === "observe";
    const pool = load("terminal-pool", { ...h.dependencies, "./terminal": h.api }, {
      ...h.globals,
      ResizeObserver: class {
        observe() { if (failObserver) throw new Error("pool observe failed"); }
        disconnect() { disconnected++; }
      },
    });
    if (!failObserver) h.fail(failure);
    assert.throws(() => pool.createPooledTerminal("A", h.output), /failed/);
    assert.equal(pool.hasPooledTerminal("A"), false);
    assert.equal(h.output.children.length, 0);
    assert.equal(h.terms[0].disposeCount, 1);
    if (failObserver) assert.equal(disconnected, 1);
    failObserver = false; h.fail("");
    assert.equal(pool.createPooledTerminal("A", h.output), true);
    assert.equal(pool.hasPooledTerminal("A"), true);
    pool.disposePooledTerminal("A");
    assert.equal(h.terms[1].disposeCount, 1); assert.equal(h.output.children.length, 0);
  }
});
