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
    const measuredContexts: any[] = [];
    const api = load("session-engine", {
      "./state": { state },
      "./session-reads": { createSessionReads: () => ({}) },
      "../../session-completion-state.js": { createSessionCompletionViewIntent: () => ({}) },
      "../vendor-loader.js": { ensureTerminalLibrary: () => library.promise },
      "./terminal": { initTerminal: ({ prepare }: { prepare: boolean }) => {
        assert.equal(prepare, true);
        state.terminal = { cols: 80, rows: 24 };
      }, measureTerminalCreationDimensions: (context: any) => { measuredContexts.push(context); return { cols: 82, rows: 25 }; } },
    }, {
      window: { addEventListener: noop }, document: {}, console,
      setTimeout: () => 1, clearTimeout: noop,
      requestAnimationFrame: (callback: () => void) => callback(),
      fetch: (_url: string, init: RequestInit) => {
        posted.push(JSON.parse(String(init.body)));
        return Promise.resolve(new Response(JSON.stringify({ error: "fixture-complete" }), { status: 400 }));
      },
    });
    const created = api.startSessionInCwd("/tmp", { shell, provider: "codex", kind: "pty", workspaceTaskId: "self-task" });
    await tick(); assert.equal(posted.length, 0, "an unloaded terminal cannot start the process yet");
    library.resolve(); await assert.rejects(created, /fixture-complete/);
    assert.equal(posted[0].cols, 82); assert.equal(posted[0].rows, 25);
    assert.equal(posted[0].cwd, "/tmp");
    assert.equal(measuredContexts[0].kind, shell ? "shell" : "pty");
    assert.equal(measuredContexts[0].provider, shell ? undefined : "codex");
    assert.equal(measuredContexts[0].cwd, "/tmp");
    assert.equal(measuredContexts[0].workspaceTaskId, "self-task");
  }
});

class Element {
  parentNode: Element | null = null; children: Element[] = []; className = "";
  dataset: Record<string, string> = {};
  values = new Map<string, { value: string; priority: string }>();
  style = {
    getPropertyValue: (name: string) => this.values.get(name)?.value ?? "",
    getPropertyPriority: (name: string) => this.values.get(name)?.priority ?? "",
    setProperty: (name: string, value: string, priority = "") => { this.values.set(name, { value, priority }); },
    removeProperty: (name: string) => { this.values.delete(name); },
  };
  textContent = "";
  root = false; clientWidth = 390; clientHeight = 400; offsetWidth = 0; offsetHeight = 0; scrollHeight = 400; scrollTop = 0;
  listeners = new Map<string, Set<(...args: any[]) => void>>();
  get isConnected(): boolean { return this.root || !!this.parentNode?.isConnected; }
  classList = { add: noop, remove: noop, contains: () => false, toggle: noop };
  get parentElement() { return this.parentNode; }
  getBoundingClientRect() { return { width: this.clientWidth, height: this.clientHeight }; }
  insertBefore(child: Element, before: Element) { child.remove(); child.parentNode = this; this.children.splice(this.children.indexOf(before), 0, child); return child; }
  appendChild(child: Element) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
  removeChild(child: Element) { this.children = this.children.filter(item => item !== child); child.parentNode = null; }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...children: Element[]) { for (const child of [...this.children]) child.remove(); for (const child of children) this.appendChild(child); }
  setAttribute(_name?: string, _value?: string) {}
  querySelectorAll(selector: string): Element[] {
    if (selector.includes(",")) return [...new Set(selector.split(",").flatMap(part => this.querySelectorAll(part.trim())))];
    const matches = (node: Element) => selector === "button" ? (node as any).tag === "button"
      : selector === "[data-terminal-load-state]" ? !!node.dataset.terminalLoadState
        : selector === '[data-session-tabs="standalone"]' ? node.dataset.sessionTabs === "standalone"
        : selector === ".workspace-tab-bar:not([data-session-tabs='standalone'])" ? node.className.split(" ").includes("workspace-tab-bar") && node.dataset.sessionTabs !== "standalone"
        : selector.startsWith(".") && node.className.split(" ").includes(selector.slice(1));
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string): Element | null {
    if (selector.includes(",")) return selector.split(",").map(part => this.querySelector(part.trim())).find(Boolean) ?? null;
    return this.querySelectorAll(selector)[0] ?? null;
  }
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
  const conversation = { active: false };
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
    document, HTMLElement: Element, window: { addEventListener: noop, removeEventListener: noop, setTimeout: () => 1 },
    console: { error: (...values: unknown[]) => errors.push(values) },
    XTermLib: { Terminal, FitAddon, Unicode11Addon: class {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
    setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop,
  };
  const dependencies = {
    "./state": { state },
    "./ui-store-bridge": { browserEnvironment: () => ({ width:390,height:900,coarsePointer:false,online:true,embedTerminal:false,nativeInput:false,backToNative:false,switchServer:false }) },
    "../react/shell/legacy-snapshot": { deriveLegacyUiSnapshot: () => ({ viewport: { mobile: true } }) },
    "../react/shell/terminal-creation-measurement": { prepareTerminalCreationComposer: () => noop, measureTerminalCreationTopbar: () => 0, measureTerminalCreationStandaloneTabbar: () => 0 },
    "../react/conversations/state": { conversationUi: { getSnapshot: () => conversation } },
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
  return { api, state, output, document, terms, fits, errors, viewport, globals, dependencies, conversation,
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


test("conversation ownership blocks eager terminal initialization but permits explicit preparation and navigation", async () => {
  const h = terminalHarness();
  h.conversation.active = true; h.api.initTerminal(); await tick();
  assert.equal(h.terms.length, 0); assert.equal(h.state.terminalInitializing, false);
  h.api.initTerminal({ prepare: true }); await tick();
  assert.equal(h.terms.length, 1); assert.equal(h.state.terminal, h.terms[0]);
  h.viewport.teardownTerminal();
  // React may still leave the previous inert attribute in place for one commit.
  h.output.setAttribute("inert", ""); h.conversation.active = false;
  h.api.initTerminal(); await tick();
  assert.equal(h.terms.length, 2); assert.equal(h.state.terminal, h.terms[1]);
});

test("a font wait abandoned for conversation ownership releases the pending mount", async () => {
  const h = terminalHarness(); const fonts = deferred(); h.document.fonts.ready = fonts.promise;
  h.api.initTerminal(); h.conversation.active = true; fonts.resolve(); await tick();
  assert.equal(h.terms[0].openCount, 0); assert.equal(h.terms[0].disposeCount, 1);
  assert.equal(h.state.terminal, null); assert.equal(h.state.terminalInitializing, false);
  assert.equal(h.output.querySelectorAll(".terminal-scroll-wrap").length, 0);
});

test("new PTY dimensions use a pure current-slot measurement without resizing the old session", () => {
  const state = { terminal: { cols: 180, rows: 39, remeasure: () => assert.fail("must not remeasure the old instance") } };
  const api = load("session-engine", {
    "./state": { state }, "./session-reads": { createSessionReads: () => ({}) },
    "../../session-completion-state.js": { createSessionCompletionViewIntent: () => ({}) },
    "./terminal": { measureTerminalCreationDimensions: () => ({ cols: 46, rows: 39 }) },
  }, { window: { addEventListener: noop }, document: {}, console });
  const body = api.withTerminalDimensions({ shell: true });
  assert.equal(body.cols, 46); assert.equal(body.rows, 39);
  assert.equal(state.terminal.cols, 180); assert.equal(state.terminal.rows, 39);
});


test("React Shell and PTY creation adapters await readiness and use the shared pure measurement", async () => {
  for (const kind of ["shell", "pty"]) {
    const ready = deferred(); let adapter: any, measured = 0; const contexts: any[] = [];
    const state = { terminal: { cols: 180, rows: 39, remeasure: () => assert.fail("must not remeasure the old session") } };
    const sessionEngine = load("session-engine", {
      "./state": { state }, "./session-reads": { createSessionReads: () => ({}) },
      "../../session-completion-state.js": { createSessionCompletionViewIntent: () => ({}) },
      "./terminal": { measureTerminalCreationDimensions: (context: any) => { measured++; contexts.push(context); return { cols: 46, rows: 39 }; } },
    }, { window: { addEventListener: noop }, document: {}, console });
    const api = load("new-session-adapter", {
      "../react": { configureNewSessionRuntime: (runtime: any) => { adapter = runtime; return noop; } },
      "./state": { state },
      "./session-engine": { ensureTerminalReady: () => ready.promise, withTerminalDimensions: sessionEngine.withTerminalDimensions },
      "./terminal": { initTerminal: (options: any) => assert.equal(options.prepare, true) },
      "../vendor-loader.js": { ensureTerminalLibrary: async () => {} },
    }, { window: {}, document: {}, console });
    api.installNewSessionLegacyAdapter();
    const preparation = adapter.prepareCreate(kind, { kind, provider: "codex", command: "codex", cwd: "/self-future-cwd", workspaceTaskId: "self-task" }); await tick();
    assert.equal(measured, 0, "measurement happens after terminal readiness");
    ready.resolve(); const dimensions = await preparation;
    assert.equal(dimensions.cols, 46); assert.equal(dimensions.rows, 39);
    assert.equal(contexts[0].kind, kind);
    assert.equal(contexts[0].provider, kind === "pty" ? "codex" : undefined);
    assert.equal(contexts[0].cwd, "/self-future-cwd");
    assert.equal(contexts[0].workspaceTaskId, "self-task");
    assert.equal(state.terminal.cols, 180); assert.equal(state.terminal.rows, 39);
    await adapter.prepareCreate("structured"); assert.equal(measured, 1, "structured creation does not require terminal geometry");
  }
});


test("accepted creation leaves the conversation before selecting its session while failed completion keeps it", async () => {
  let adapter: any, active = true, fail = true, suspendCount = 0, selected = "";
  const engine = {
    loadSessions: async () => { if (fail) throw new Error("fixture read failure"); },
    clearDraftValueForSession: noop, dismissDrawerIfOverlay: noop,
    selectSession: (id: string) => { assert.equal(active, false, "logical owner changes before terminal selection"); selected = id; },
  };
  const api = load("new-session-adapter", {
    "../react": { configureNewSessionRuntime: (runtime: any) => { adapter = runtime; return noop; } },
    "./state": { state: {} }, "./session-engine": engine,
    "./terminal": { saveWorkingDir: noop },
    "../react/conversations/state": { conversationUi: { suspend: () => { active = false; suspendCount++; } } },
  }, { window: { setTimeout: noop }, document: {}, console });
  api.installNewSessionLegacyAdapter();
  const request = { kind: "shell", cwd: "/own-temporary-cwd", mode: "default" };
  await assert.rejects(adapter.completeCreate(request, { id: "owned-shell" }), /fixture read failure/);
  assert.equal(active, true); assert.equal(suspendCount, 0); assert.equal(selected, "");
  fail = false; await adapter.completeCreate(request, { id: "owned-shell" });
  assert.equal(active, false); assert.equal(suspendCount, 1); assert.equal(selected, "owned-shell");
});


test("only the first active empty task projects its future window bar and releases the temporary slot", () => {
  for (const variant of ["empty", "unknown", "different", "split", "existing", "throw"]) {
    const h = terminalHarness(); const main = new Element(); main.root = true; main.appendChild(h.output);
    const input = main.appendChild(new Element()); input.className = "input-panel";
    input.classList.contains = (value: string) => value === "input-panel";
    input.style.setProperty("display", "none");
    if (variant === "existing") { const bar = main.appendChild(new Element()); bar.className = "workspace-tab-bar"; }
    h.state.terminal = { cols: 180, rows: 39 };
    let projections = 0, proposals = 0;
    const api = load("terminal", { ...h.dependencies,
      "./ui-store-bridge": { browserEnvironment: () => ({ width:390,height:900,coarsePointer:false,online:true,embedTerminal:false,nativeInput:false,backToNative:false,switchServer:false }) },
      "../react/shell/legacy-snapshot": { deriveLegacyUiSnapshot: () => ({viewport:{mobile:true}}) },
      "../react/workspaces/workspace-context": { workspaceContextStore: { getSnapshot: () => ({ taskId: variant === "different" ? "other-task" : "self-task", taskName: "own-task", layout: variant === "split" ? { windows: [{}] } : null }) } },
      "../react/workspaces/task-detail-store": { taskDetailStore: { getSnapshot: () => variant === "unknown" ? null : { sessions: [], layout: null } } },
      "../react/shell/terminal-creation-measurement": { prepareTerminalCreationComposer: () => noop, measureTerminalCreationWorkspaceTabbar: (props: any) => {
        projections++; assert.equal(props.session.workspaceTaskId, "self-task"); assert.equal(props.session.provider, undefined);
        assert.equal(props.mobile, true); assert.equal(props.taskName, "own-task"); return 57;
      } },
      "./terminal-fit": { proposeTerminalDimensions: () => {
        proposals++; const slots = main.children.filter(n => n.dataset.terminalCreationSpace);
        assert.equal(slots.length, variant === "empty" || variant === "throw" ? 1 : 0);
        if (variant === "throw") throw new Error("proposal failure");
        return { cols: 46, rows: 31 };
      } },
    }, { ...h.globals, window: { ...h.globals.window, innerWidth: 390 }, getComputedStyle: () => ({ display: "none" }) });
    if (variant === "throw") assert.throws(() => api.measureTerminalCreationDimensions({ kind: "shell", cwd: "/own", workspaceTaskId: "self-task" }), /proposal failure/);
    else { const dimensions = api.measureTerminalCreationDimensions({ kind: "shell", cwd: "/own", workspaceTaskId: "self-task" }); assert.equal(dimensions.rows, 31); }
    assert.equal(projections, variant === "empty" || variant === "throw" ? 1 : 0);
    assert.equal(proposals, 1);
    assert.equal(main.children.filter(n => n.dataset.terminalCreationSpace).length, 0);
    assert.equal(h.output.style.getPropertyValue("display"), "");
    assert.equal(input.style.getPropertyValue("display"), "none");
    assert.equal(h.state.terminal.cols, 180); assert.equal(h.state.terminal.rows, 39);
  }
});

test("future PTY input presentation is released on proposal failure without resizing the old session", () => {
  for (const failure of ["none", "proposal", "release"]) {
    const h = terminalHarness(), main = new Element(); main.root = true; main.appendChild(h.output);
    const input = main.appendChild(new Element()); input.className = "input-panel";
    input.classList.contains = value => value === "input-panel";
    input.style.setProperty("display", "none");
    h.state.terminal = { cols: 180, rows: 37 };
    let prepared = 0, released = 0;
    const api = load("terminal", { ...h.dependencies,
      "../react/shell/terminal-creation-measurement": { prepareTerminalCreationComposer: (panel: Element) => {
        assert.equal(panel, input); assert.equal(panel.style.getPropertyValue("visibility"), "hidden"); prepared++;
        return () => { released++; if (failure === "release") throw new Error("presentation release failure"); };
      }, measureTerminalCreationTopbar: () => 0, measureTerminalCreationStandaloneTabbar: () => 0 },
      "./terminal-fit": { proposeTerminalDimensions: () => { if (failure === "proposal") throw new Error("proposal failure"); return { cols: 46, rows: 30 }; } },
    }, { ...h.globals, getComputedStyle: () => ({ display: "none" }) });
    if (failure === "none") assert.equal(api.measureTerminalCreationDimensions({ kind: "shell" }).rows, 30);
    else assert.throws(() => api.measureTerminalCreationDimensions({ kind: "shell" }), /failure/);
    assert.equal(prepared, 1); assert.equal(released, 1);
    assert.equal(input.style.getPropertyValue("display"), "none"); assert.equal(input.style.getPropertyValue("visibility"), "");
    assert.equal(h.output.style.getPropertyValue("display"), ""); assert.equal(h.output.style.getPropertyValue("visibility"), "");
    assert.equal(h.state.terminal.cols, 180); assert.equal(h.state.terminal.rows, 37);
    if (failure === "proposal") assert.throws(() => api.measureTerminalCreationDimensions(), /proposal failure/);
    else api.measureTerminalCreationDimensions();
    assert.equal(prepared, 1, "unqualified resume/queue keeps its existing presentation");
  }
});

test("ungrouped creation reserves its native tab row once and restores old task chrome without resizing", () => {
  for (const variant of ["first", "existing", "hidden", "from-task", "projection-throw", "proposal-throw", "no-context"]) {
    const h = terminalHarness(), main = new Element(); main.root = true; main.appendChild(h.output);
    const header = variant === "from-task" ? null : main.appendChild(new Element());
    if (header) { header.className = "main-header-row"; header.style.setProperty("height", "80px", "important"); }
    const bar = ["existing", "hidden"].includes(variant) ? main.appendChild(new Element()) : null;
    if (bar) { bar.className = "workspace-tab-bar"; bar.dataset.sessionTabs = "standalone"; bar.style.setProperty("display", variant === "hidden" ? "none" : "flex", "important"); }
    const oldTask = variant === "from-task" ? [main.appendChild(new Element()), main.appendChild(new Element())] : [];
    for (const [index, node] of oldTask.entries()) { node.className = index ? "workspace-tab-bar" : "workspace-mobile-navigation"; node.style.setProperty("display", "flex"); }
    h.state.terminal = { cols: 180, rows: 37 };
    let headerProjections = 0, tabProjections = 0, proposals = 0;
    const api = load("terminal", { ...h.dependencies,
      "../react/shell/terminal-creation-measurement": {
        prepareTerminalCreationComposer: () => noop,
        measureTerminalCreationTopbar: (_snapshot: any, width: number) => { headerProjections++; assert.equal(width, 390); return 80; },
        measureTerminalCreationStandaloneTabbar: (props: any, width: number) => {
          tabProjections++; assert.equal(width, 390); assert.equal(props.mobile, true);
          assert.equal(props.session.sessionKind, "pty"); assert.equal(props.session.status, "running");
          assert.equal(props.session.cwd, "/own-future-directory"); assert.equal(props.session.provider, undefined);
          assert.equal(props.session.workspaceTaskId, undefined);
          if (variant === "projection-throw") throw new Error("native tab projection failure");
          return 57;
        },
      },
      "./terminal-fit": { proposeTerminalDimensions: () => {
        proposals++;
        const spaces = main.children.filter(n => n.dataset.terminalCreationSpace);
        assert.equal(spaces.length, variant === "from-task" ? 2 : ["first", "proposal-throw"].includes(variant) ? 1 : 0);
        if (bar && variant !== "no-context") { assert.equal(bar.style.getPropertyValue("visibility"), "hidden"); assert.equal(bar.style.getPropertyValue("display"), "flex"); assert.equal(bar.style.getPropertyValue("height"), "57px"); }
        for (const node of oldTask) assert.equal(node.style.getPropertyValue("display"), "none");
        if (variant === "proposal-throw") throw new Error("proposal failure");
        return { cols: 46, rows: 27 };
      } },
    }, { ...h.globals, getComputedStyle: (node: Element) => ({ display: node.style.getPropertyValue("display") || "flex" }) });
    const before = [h.output, header, bar, ...oldTask].filter(Boolean).map(node => [...node!.values]);
    const context = variant === "no-context" ? undefined : { kind: "shell", cwd: "/own-future-directory" };
    if (variant.endsWith("throw")) assert.throws(() => api.measureTerminalCreationDimensions(context), /failure/);
    else assert.equal(api.measureTerminalCreationDimensions(context).rows, 27);
    assert.equal(headerProjections, variant === "no-context" ? 0 : 1);
    assert.equal(tabProjections, variant === "no-context" ? 0 : 1);
    assert.equal(proposals, variant === "projection-throw" ? 0 : 1);
    assert.deepEqual([h.output, header, bar, ...oldTask].filter(Boolean).map(node => [...node!.values]), before);
    assert.equal(main.children.filter(n => n.dataset.terminalCreationSpace).length, 0);
    assert.equal(h.state.terminal.cols, 180); assert.equal(h.state.terminal.rows, 37);
  }
});
