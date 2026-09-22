import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { HttpResponseError, parseJsonResponse } from "../src/web-ui/react/http-adapter.js";
import { getErrorMessage } from "../src/error-utils.js";

const noop = (): void => {};
const fallback = new Proxy({}, { get: () => noop });

async function tick(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

/** 2xx JSON 回包的最小替身：parseJsonResponse 只读 ok / status / json。 */
function jsonResponse(body: unknown, status = 200): any {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** 非 JSON 的 5xx 错误页（反代 / express 默认处理器），过去会被当成「加载失败」或静默成功。 */
function htmlResponse(status = 500): any {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token '<'");
    },
  };
}

class FakeClassList {
  readonly names = new Set<string>();
  add(...items: string[]): void {
    items.forEach((item) => this.names.add(item));
  }
  remove(...items: string[]): void {
    items.forEach((item) => this.names.delete(item));
  }
  toggle(name: string, force?: boolean): boolean {
    const on = force === undefined ? !this.names.has(name) : force;
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
  contains(name: string): boolean {
    return this.names.has(name);
  }
}

/** 只实现被测代码真正用到的 DOM 表面；querySelector 懒创建并按选择器复用同一个元素。 */
class FakeElement {
  [key: string]: any;
  value = "";
  textContent = "";
  innerHTML = "";
  title = "";
  disabled = false;
  className = "";
  offsetHeight = 0;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  children: FakeElement[] = [];
  private readonly queries = new Map<string, FakeElement>();
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName = "div") {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement): FakeElement {
    this.children = this.children.filter((item) => item !== child);
    return child;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  focus(): void {}
  blur(): void {}
  click(): void {}
  closest(): FakeElement | null {
    return null;
  }
  contains(): boolean {
    return false;
  }
  querySelector(selector: string): FakeElement {
    let element = this.queries.get(selector);
    if (!element) {
      element = new FakeElement();
      this.queries.set(selector, element);
    }
    return element;
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }
  getBoundingClientRect(): Record<string, number> {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

function createDocument(registry: Record<string, FakeElement> = {}) {
  const body = new FakeElement("body");
  const documentStub: Record<string, any> = {
    hidden: false,
    readyState: "complete",
    cookie: "",
    body,
    head: new FakeElement("head"),
    documentElement: new FakeElement("html"),
    addEventListener: noop,
    removeEventListener: noop,
    createElement: (tagName: string) => new FakeElement(tagName),
    createTextNode: () => new FakeElement("#text"),
    getElementById: (id: string) => {
      const existing = registry[id];
      if (existing) return existing;
      const created = new FakeElement();
      registry[id] = created;
      return created;
    },
    querySelector: (selector: string) => new FakeElement(selector),
    querySelectorAll: () => [] as FakeElement[],
    hasFocus: () => true,
  };
  return { documentStub, body, registry };
}

interface LoadedModule {
  [name: string]: any;
}

/** 用 vm + ts.transpileModule 直接载入 legacy browser 模块，只注入被测路径需要的依赖。 */
function loadBrowserModule(fileName: string, sandbox: Record<string, any>): LoadedModule {
  const source = readFileSync(new URL(`../src/web-ui/browser/${fileName}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const api: LoadedModule = {};
  runInNewContext(outputText, {
    exports: api,
    require: (id: string) => sandbox.require(id),
    document: sandbox.document,
    window: {},
    navigator: { userAgent: "" },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    console: sandbox.console ?? { log: noop, warn: noop, error: noop },
    fetch: sandbox.fetch,
    setTimeout: (handler: () => void) => { handler(); return 0; },
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
  });
  return api;
}

/** 让指定模块的依赖对象在缺少某个导出时退化成 noop，避免无关 import 直接崩掉。 */
function withFallback(overrides: Record<string, any>): Record<string, any> {
  return new Proxy(overrides, { get: (target, key) => (key in target ? target[key] : noop) });
}

// ── events.ts: __fetchToolContent ──

function loadEvents(fetchImpl: (url: string, init?: any) => Promise<any>, state: Record<string, any>): LoadedModule {
  const { documentStub } = createDocument();
  return loadBrowserModule("events.ts", {
    document: documentStub,
    fetch: fetchImpl,
    require: (id: string) => {
      if (id === "./state") return { state };
      if (id === "../react/http-adapter") return { HttpResponseError, parseJsonResponse };
      if (id === "../../error-utils.js") return { getErrorMessage };
      return fallback;
    },
  });
}

test("__fetchToolContent 在 404/500 时不写缓存并回调错误（含状态码）", async () => {
  const cases: Array<{ name: string; status: number; response: () => any }> = [
    { name: "404 JSON 错误体", status: 404, response: () => jsonResponse({ error: "未找到该工具结果。" }, 404) },
    { name: "500 非 JSON 错误页", status: 500, response: () => htmlResponse(500) },
  ];

  for (const item of cases) {
    const state: Record<string, any> = { selectedId: "S1", toolContentCache: {} };
    const api = loadEvents(() => Promise.resolve(item.response()), state);
    let received: { err: string; data: unknown } | null = null;
    api.__fetchToolContent("t1", (err: string, data: unknown) => {
      received = { err, data };
    });
    await tick();

    assert.ok(received, `${item.name}: 回调必须被调用`);
    assert.equal((received as any).data, null, `${item.name}: 失败时第二个参数保持 null`);
    assert.match((received as any).err, new RegExp(String(item.status)), `${item.name}: 错误信息要能区分状态码`);
    assert.deepEqual(state.toolContentCache, {}, `${item.name}: 失败不得写缓存（否则重试永远命中旧结果）`);
  }
});

test("__fetchToolContent 成功时写缓存并命中缓存，不再重复请求", async () => {
  const state: Record<string, any> = { selectedId: "S1", toolContentCache: {} };
  let calls = 0;
  const api = loadEvents(() => {
    calls += 1;
    return Promise.resolve(jsonResponse({ content: "hi" }));
  }, state);

  let first: { err: unknown; data: unknown } | null = null;
  api.__fetchToolContent("t1", (err: unknown, data: unknown) => {
    first = { err, data };
  });
  await tick();

  assert.equal((first as any).err, null);
  assert.deepEqual(state.toolContentCache, { "S1:t1": { content: "hi" } });

  let second: { err: unknown; data: unknown } | null = null;
  api.__fetchToolContent("t1", (err: unknown, data: unknown) => {
    second = { err, data };
  });

  assert.equal((second as any).err, null);
  assert.deepEqual((second as any).data, { content: "hi" });
  assert.equal(calls, 1, "缓存命中不应再发请求");
});

// ── input.ts: sendOrStart 新建会话分支 ──

function loadInput(
  fetchImpl: (url: string, init?: any) => Promise<any>,
  options: {
    state: Record<string, any>;
    inputBox: FakeElement;
    toasts: Array<{ message: string; type?: string }>;
    cleared: string[];
    activated: any[];
  },
): LoadedModule {
  const { documentStub } = createDocument({ "input-box": options.inputBox });
  return loadBrowserModule("input.ts", {
    document: documentStub,
    fetch: fetchImpl,
    require: (id: string) => {
      if (id === "./state") return { state: options.state };
      if (id === "../react/http-adapter") return { HttpResponseError, parseJsonResponse };
      if (id === "../../error-utils.js") return { getErrorMessage };
      if (id === "./session-engine") {
        return withFallback({
          getPreferredTool: () => "claude",
          withTerminalDimensions: (payload: unknown) => payload,
          clearDraftValueForSession: (sessionId: string) => { options.cleared.push(sessionId); },
          activateSession: (data: unknown) => { options.activated.push(data); return Promise.resolve(); },
        });
      }
      if (id === "./render") return withFallback({ getEffectiveCwd: () => "/tmp/wand-recent" });
      if (id === "./notifications") {
        return withFallback({
          showToast: (message: string, type?: string) => { options.toasts.push({ message, type }); },
          wandConfirm: () => Promise.resolve(true),
        });
      }
      return fallback;
    },
  });
}

test("sendOrStart 在 /api/commands 返回 4xx/5xx 时不进入成功分支且保留草稿", async () => {
  const cases: Array<{ name: string; response: () => any; expected: RegExp }> = [
    { name: "500 非 JSON 错误页", response: () => htmlResponse(500), expected: /500/ },
    { name: "409 JSON 错误体", response: () => jsonResponse({ error: "会话数量已达上限。" }, 409), expected: /会话数量已达上限/ },
  ];

  for (const item of cases) {
    const state: Record<string, any> = { selectedId: null, chatMode: "managed", sessions: [], crossSessionQueue: [] };
    const inputBox = new FakeElement("input");
    inputBox.value = "帮我写一个测试";
    const toasts: Array<{ message: string; type?: string }> = [];
    const cleared: string[] = [];
    const activated: any[] = [];
    const api = loadInput(() => Promise.resolve(item.response()), { state, inputBox, toasts, cleared, activated });

    api.sendOrStart();
    await tick();

    assert.equal(activated.length, 0, `${item.name}: 失败不得激活会话`);
    assert.deepEqual(cleared, [], `${item.name}: 失败不得清草稿`);
    assert.equal(inputBox.value, "帮我写一个测试", `${item.name}: 失败保留用户输入的内容`);
    assert.equal(toasts.length, 1, `${item.name}: 只提示一次`);
    assert.equal(toasts[0].type, "error", `${item.name}: 用错误样式提示`);
    assert.match(toasts[0].message, item.expected, `${item.name}: 提示要可读`);
  }
});

// ── terminal.ts: addRecentPath（经 saveWorkingDir 触发） ──

function loadTerminal(
  fetchImpl: (url: string, init?: any) => Promise<any>,
  state: Record<string, any>,
  warnings: string[],
): LoadedModule {
  const { documentStub } = createDocument();
  return loadBrowserModule("terminal.ts", {
    document: documentStub,
    fetch: fetchImpl,
    console: { log: noop, warn: (...args: unknown[]) => { warnings.push(args.join(" ")); }, error: noop },
    require: (id: string) => {
      if (id === "./state") return { state };
      if (id === "../react/http-adapter") return { HttpResponseError, parseJsonResponse };
      if (id === "../../error-utils.js") return { getErrorMessage };
      return fallback;
    },
  });
}

test("addRecentPath 在 5xx / 网络错误时不抛未处理异常，也不影响工作目录切换", async () => {
  const cases: Array<{ name: string; fetchImpl: () => Promise<any> }> = [
    { name: "500 非 JSON 错误页", fetchImpl: () => Promise.resolve(htmlResponse(500)) },
    { name: "网络中断", fetchImpl: () => Promise.reject(new TypeError("Failed to fetch")) },
  ];

  for (const item of cases) {
    const state: Record<string, any> = { workingDir: "" };
    const warnings: string[] = [];
    const calls: string[] = [];
    const api = loadTerminal((url: string) => {
      calls.push(url);
      return item.fetchImpl();
    }, state, warnings);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      api.saveWorkingDir("/tmp/wand-recent");
      await tick();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    assert.deepEqual(calls, ["/api/recent-paths"], `${item.name}: 仍然发出记录请求`);
    assert.equal(state.workingDir, "/tmp/wand-recent", `${item.name}: 工作目录切换不受影响`);
    assert.deepEqual(unhandled, [], `${item.name}: 不得产生未处理异常`);
    assert.equal(warnings.length, 1, `${item.name}: 失败要留下可诊断的告警`);
  }
});

// ── notifications.ts: 更新卡片 / 重启步骤 ──

function loadNotifications(
  fetchImpl: (url: string, init?: any) => Promise<any>,
  options: { state: Record<string, any>; documentStub: Record<string, any>; restarts: number[] },
): LoadedModule {
  return loadBrowserModule("notifications.ts", {
    document: options.documentStub,
    fetch: fetchImpl,
    require: (id: string) => {
      if (id === "./state") return withFallback({ state: options.state, writeStoredBoolean: noop });
      if (id === "../react/http-adapter") return { HttpResponseError, parseJsonResponse };
      if (id === "../../error-utils.js") return { getErrorMessage };
      if (id === "../react/restart-overlay/controller") {
        return withFallback({
          restartOverlayController: {},
          showRestart: () => { options.restarts.push(1); },
          showAutoUpdate: () => { options.restarts.push(2); },
        });
      }
      return fallback;
    },
  });
}

function openUpdateCard(fetchImpl: (url: string, init?: any) => Promise<any>) {
  const { documentStub, body } = createDocument();
  const state: Record<string, any> = {
    config: { canManageSettings: true },
    notificationHistory: {},
    notifSound: false,
    notifVolume: 0,
    sessions: [],
    selectedId: null,
    _updateBubbleShown: false,
  };
  const restarts: number[] = [];
  const api = loadNotifications(fetchImpl, { state, documentStub, restarts });
  api.notifyUpdateAvailable("1.0.0", "2.0.0");

  const card = body.children[0];
  assert.ok(card, "更新卡片应挂到 body 上");
  return {
    api,
    state,
    card: card as FakeElement,
    actionBtn: card.querySelector("#update-bubble-action") as FakeElement,
    actionLabel: card.querySelector(".update-card-action-label") as FakeElement,
    statusEl: card.querySelector("#update-card-status") as FakeElement,
    progressEl: card.querySelector("#update-card-progress") as FakeElement,
    restarts,
  };
}

test("更新卡片：非 2xx 失败时复位忙碌态/进度/按钮并显示可读错误", async () => {
  const cases: Array<{ name: string; response: () => any; expected: RegExp }> = [
    { name: "409 JSON 错误体", response: () => jsonResponse({ error: "更新正在进行中，请稍候。" }, 409), expected: /更新正在进行中/ },
    { name: "500 非 JSON 错误页", response: () => htmlResponse(500), expected: /500/ },
  ];

  for (const item of cases) {
    const card = openUpdateCard(() => Promise.resolve(item.response()));
    card.actionBtn.onclick();
    await tick();

    assert.equal(card.actionBtn.disabled, false, `${item.name}: 按钮要能重试`);
    assert.equal(card.actionLabel.textContent, "重试", `${item.name}: 按钮文案复位为可重试`);
    assert.equal(card.card.classList.contains("is-busy"), false, `${item.name}: 忙碌态复位`);
    assert.equal(card.progressEl.classList.contains("active"), false, `${item.name}: 进度条复位`);
    assert.equal(card.statusEl.classList.contains("error"), true, `${item.name}: 用错误样式显示`);
    assert.match(card.statusEl.textContent, item.expected, `${item.name}: 显示可读错误`);
    assert.deepEqual(card.restarts, [], `${item.name}: 失败不得进入重启遮罩`);
  }
});

test("更新卡片：重启步骤被服务端拒绝时复位卡片，网络中断才进重启遮罩", async () => {
  // 服务端明确回错：进程还活着，停在卡片上让用户重试。
  let call = 0;
  const rejected = openUpdateCard(() => {
    call += 1;
    return Promise.resolve(call === 1
      ? jsonResponse({ message: "更新完成" }, 200)
      : jsonResponse({ error: "当前连接没有执行此操作的权限。" }, 403));
  });
  rejected.actionBtn.onclick();
  await tick();

  assert.deepEqual(rejected.restarts, [], "403 不得进入重启遮罩（否则会空等重启）");
  assert.equal(rejected.card.classList.contains("is-success"), false, "失败要撤掉成功态");
  assert.equal(rejected.card.classList.contains("is-busy"), false);
  assert.equal(rejected.progressEl.classList.contains("active"), false);
  assert.equal(rejected.actionBtn.disabled, false);
  assert.equal(rejected.actionLabel.textContent, "重试");
  assert.equal(rejected.statusEl.textContent, "当前连接没有执行此操作的权限。");

  // 网络中断：进程很可能已经退出，仍然交给重启遮罩继续探测。
  let request = 0;
  const offline = openUpdateCard(() => {
    request += 1;
    if (request === 1) return Promise.resolve(jsonResponse({ message: "更新完成" }, 200));
    return Promise.reject(new TypeError("Failed to fetch"));
  });
  offline.actionBtn.onclick();
  await tick();

  assert.deepEqual(offline.restarts, [1], "网络中断要保持进入重启遮罩的既有行为");
});
