import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createSessionReads } from "../src/web-ui/browser/session-reads.js";
import { parseJsonResponse } from "../src/web-ui/react/http-adapter.js";
import { getErrorMessage } from "../src/error-utils.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

function harness() {
  const state: Record<string, any> = {
    sessions: [], selectedId: null, drafts: {}, attachmentsBySession: {}, terminalStatesBySession: {},
    crossSessionQueue: [], config: {}, currentMessages: [], chatMode: "default", availableModels: [],
  };
  const requests: Array<{ url: string; response: ReturnType<typeof deferred<Response>> }> = [];
  const errors: unknown[] = [];
  const toasts: Array<{ message: string; tone?: string }> = [];
  const noop = () => {};
  const fallback = new Proxy({}, { get: () => noop });
  const dependencies: Record<string, unknown> = {
    "./state": { state, writeStoredBoolean: noop },
    "./session-reads": { createSessionReads },
    "../react/http-adapter": { parseJsonResponse },
    "../../error-utils.js": { getErrorMessage },
    "./notifications": new Proxy(
      { showToast: (message: string, tone?: string) => { toasts.push({ message, tone }); } },
      { get: (obj: Record<string, unknown>, key: string) => obj[key] ?? noop },
    ),
    "./chat-scroll": new Proxy({}, { get: (_, key) => {
      if (key === "normalizeStructuredSnapshot" || key === "stripRenderOnlyStructuredMessages") return (value: unknown) => value;
      return noop;
    } }),
    "./input": new Proxy({}, { get: (_, key) => key === "buildMessagesForRender" ? (_s: unknown, messages: unknown) => messages : noop }),
  };
  const source = readFileSync(new URL("../src/web-ui/browser/session-engine.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const api: Record<string, any> = {};
  // 事件总线：session-engine 模块级会往 window 上挂自定义事件监听
  // （与 React 层的 model-catalog 互通），假 window 光有形状不够 —— 浏览器里
  // addEventListener 永远存在，缺了它整个模块就炸在 import 阶段。
  const windowListeners = new Map<string, Set<(event: unknown) => void>>();
  runInNewContext(outputText, {
    exports: api, require: (id: string) => dependencies[id] ?? fallback,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        const set = windowListeners.get(type) ?? new Set();
        set.add(listener);
        windowListeners.set(type, set);
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => {
        windowListeners.get(type)?.delete(listener);
      },
      dispatchEvent: (event: { type?: string }) => {
        for (const listener of windowListeners.get(String(event?.type)) ?? []) listener(event);
        return true;
      },
    },
    localStorage: { getItem: () => null, setItem: noop },
    console: { error: (...args: unknown[]) => errors.push(args) },
    setTimeout: noop, clearTimeout: noop, clearInterval: noop,
    fetch: (url: string) => { const response = deferred<Response>(); requests.push({ url, response }); return response.promise; },
  });
  const respond = (index: number, body: unknown, status = 200) => requests[index].response.resolve(new Response(JSON.stringify(body), { status }));
  return { state, api, requests, respond, errors, toasts };
}

test("shared session reads protect only fields updated during a read and reset on logout", () => {
  const reads = createSessionReads();
  const read = reads.begin("list");
  reads.record({ id: "A", status: "exited", queuedMessages: [] });
  const merged = read.merge({ id: "A", status: "running", title: "remote" }, { id: "A", status: "exited", title: "old", queuedMessages: [] });
  assert.deepEqual(merged, { id: "A", status: "exited", title: "remote", queuedMessages: [] });
  const newer = reads.begin("list");
  read.finish();
  assert.equal(read.isCurrent(), false);
  assert.equal(newer.isCurrent(), true);
  reads.reset();
  assert.equal(newer.isCurrent(), false);
});

test("out-of-order list reads cannot remove newer sessions or their drafts", async () => {
  const h = harness();
  const older = h.api.loadSessions({ skipSelectedOutputReload: true });
  const newer = h.api.loadSessions({ skipSelectedOutputReload: true });
  h.respond(1, [{ id: "A", archived: true }]); await newer;
  h.state.drafts.A = "keep";
  h.respond(0, []); await older;
  assert.equal(h.state.sessions[0]?.id, "A");
  assert.equal(h.state.drafts.A, "keep");
  assert.deepEqual(h.errors, []);
});

test("HTTP detail cannot roll back a newer status push or append old queued inputs", async () => {
  const h = harness();
  h.state.selectedId = "A";
  h.state.sessions = [{ id: "A", status: "running" }];
  const pending = h.api.loadOutput("A");
  h.api.updateSessionSnapshot({ id: "A", status: "exited", queuedMessages: [] });
  h.respond(0, { id: "A", status: "running", queuedMessages: ["old"], title: "fetched" }); await pending;
  assert.equal(h.state.sessions[0].status, "exited");
  assert.equal(h.state.sessions[0].queuedMessages.length, 0);
  assert.equal(h.state.sessions[0].title, "fetched");
  assert.deepEqual(h.errors, []);
});

test("invalid or failed list responses preserve drafts and sessions", async () => {
  for (const [body, status] of [[{ error: "unavailable" }, 503], [{}, 200], [null, 200]] as const) {
    const h = harness(); h.state.sessions = [{ id: "A" }]; h.state.drafts.A = "keep";
    const pending = h.api.loadSessions(); h.respond(0, body, status); await pending;
    assert.equal(h.state.sessions[0].id, "A"); assert.equal(h.state.drafts.A, "keep");
    assert.equal(h.errors.length, 1);
  }
});

test("earlier messages use the current snapshot and deduplicate independently per session", async () => {
  const h = harness();
  h.state.sessions = [{ id: "A", messageOffset: 1, messages: ["old tail"] }, { id: "B", messageOffset: 1, messages: ["B tail"] }];
  h.state.selectedId = "A";
  assert.equal(h.api.fetchEarlierMessages(), true);
  assert.equal(h.api.fetchEarlierMessages(), false);
  h.state.sessions[0] = { id: "A", messageOffset: 1, messages: ["live tail"] };
  h.state.selectedId = "B";
  assert.equal(h.api.fetchEarlierMessages(), true);
  assert.match(h.requests[0].url, /messages\?before=1&blockBudget=60/);
  h.respond(0, { messages: ["history"], offset: 0, total: 2,
    leadingBlockOffset: 0, leadingBlockTotal: 1 }); await tick();
  assert.deepEqual(Array.from(h.state.sessions[0].messages), ["history", "live tail"]);
  assert.equal(h.state.sessions[0].messageOffset, 0);
  assert.equal(h.state.currentMessages.length, 0, "inactive session does not render");
  h.respond(1, { messages: ["B history"], offset: 0, total: 2,
    leadingBlockOffset: 0, leadingBlockTotal: 1 }); await tick();
  assert.deepEqual(Array.from(h.state.currentMessages), ["B history", "B tail"]);
});

test("logout invalidates pending list, detail, and pagination even when the same id is later selected", async () => {
  const h = harness();
  h.state.selectedId = "A"; h.state.sessions = [{ id: "A", messageOffset: 40, messages: [] }];
  const list = h.api.loadSessions(); const detail = h.api.loadOutput("A"); h.api.fetchEarlierMessages();
  // 用户主动登出要先等服务端确认（requests[3]），确认后才注销本地读取。
  const logout = h.api.logout();
  h.respond(3, { ok: true }); await logout;
  h.state.selectedId = "A"; h.state.sessions = [{ id: "A", messageOffset: 40, messages: ["new login"] }];
  h.respond(0, [{ id: "old login" }]); h.respond(1, { id: "A", title: "old login" }); h.respond(2, { messages: ["old history"] });
  await Promise.all([list, detail]); await tick();
  assert.equal(h.state.sessions[0].title, undefined);
  assert.deepEqual(h.state.sessions[0].messages, ["new login"]);
});

test("user logout keeps the session when the server refuses to revoke it", async () => {
  const h = harness();
  h.state.selectedId = "A"; h.state.sessions = [{ id: "A" }];
  const logout = h.api.logout();
  assert.deepEqual(h.state.sessions, [{ id: "A" }], "服务端确认前不拆本地状态");
  h.respond(0, { error: "无法注销。" }, 500);
  await logout;
  assert.notEqual(h.state.config, null, "注销失败必须留在已登录态，而不是假登出");
  assert.deepEqual(h.state.sessions, [{ id: "A" }]);
  assert.deepEqual(h.toasts, [{ message: "注销失败（HTTP 500），请重试。", tone: "error" }]);
});

test("user logout keeps the local session when the request never reaches the server", async () => {
  const h = harness();
  h.state.selectedId = "A"; h.state.sessions = [{ id: "A" }];
  const logout = h.api.logout();
  h.requests[0].response.reject(new TypeError("Failed to fetch"));
  await logout;
  assert.notEqual(h.state.config, null);
  assert.deepEqual(h.toasts, [{ message: "Failed to fetch", tone: "error" }]);
});

test("logout trusts any 2xx even when the body is not JSON", async () => {
  const h = harness();
  h.state.selectedId = "A"; h.state.sessions = [{ id: "A" }];
  const logout = h.api.logout();
  h.requests[0].response.resolve(new Response("ok", { status: 200 }));
  await logout;
  assert.equal(h.state.config, null, "路由已经 revoke + clearCookie，不能因为响应体不是 JSON 就留在已登录态");
  assert.equal(h.state.sessions.length, 0);
  assert.deepEqual(h.toasts, []);
});

test("user logout tears down only after the server revokes the session", async () => {
  const h = harness();
  h.state.selectedId = "A"; h.state.sessions = [{ id: "A" }];
  const logout = h.api.logout();
  h.respond(0, { ok: true });
  await logout;
  assert.equal(h.state.config, null);
  assert.equal(h.state.sessions.length, 0);
  assert.equal(h.state.selectedId, null);
  assert.deepEqual(h.toasts, []);
});

test("a 401 from the list ends the local session without a logout error", async () => {
  const h = harness();
  h.state.selectedId = "A"; h.state.sessions = [{ id: "A" }];
  const list = h.api.loadSessions({ skipSelectedOutputReload: true });
  h.respond(0, { error: "expired" }, 401);
  await list;
  assert.equal(h.state.config, null, "服务端已判定会话失效 → 本地跟着收尾");
  assert.deepEqual(h.toasts, [], "被动收尾不弹「注销失败」");
});

test("a list started before a push retains newly created sessions and fresh status fields", async () => {
  const h = harness();
  h.state.sessions = [{ id: "A", status: "running" }];
  const pending = h.api.loadSessions({ skipSelectedOutputReload: true });
  h.api.updateSessionSnapshot({ id: "A", status: "exited" });
  h.api.updateSessionSnapshot({ id: "B", title: "created" });
  h.state.drafts.B = "new draft";
  h.respond(0, [{ id: "A", status: "running", title: "loaded" }]); await pending;
  assert.equal(h.state.sessions.find((s: any) => s.id === "A").status, "exited");
  assert.equal(h.state.sessions.find((s: any) => s.id === "A").title, "loaded");
  assert.equal(h.state.sessions.find((s: any) => s.id === "B").title, "created");
  assert.equal(h.state.drafts.B, "new draft");
  assert.deepEqual(h.errors, []);
});

test("rapid A-B-A detail reads use the newest A response and ignore an obsolete 401 list", async () => {
  const h = harness(); h.state.selectedId = "A"; h.state.sessions = [{ id: "A" }];
  const older = h.api.loadOutput("A"); h.state.selectedId = "B";
  const b = h.api.loadOutput("B"); h.state.selectedId = "A";
  const newer = h.api.loadOutput("A");
  h.respond(2, { id: "A", title: "new" }); await newer;
  h.respond(0, { id: "A", title: "old" }); h.respond(1, { id: "B" }); await Promise.all([older, b]);
  assert.equal(h.state.sessions[0].title, "new");
  const oldList = h.api.loadSessions({ skipSelectedOutputReload: true });
  const newList = h.api.loadSessions({ skipSelectedOutputReload: true });
  h.respond(4, [{ id: "A", title: "new" }]); await newList;
  h.respond(3, { error: "expired" }, 401); await oldList;
  assert.notEqual(h.state.config, null);
  assert.equal(h.state.sessions[0].title, "new");
});

test("pagination does not prepend twice when a snapshot already changed the window", async () => {
  const h = harness(); h.state.selectedId = "A";
  h.state.sessions = [{ id: "A", messageOffset: 40, messages: ["tail"] }];
  h.api.fetchEarlierMessages();
  h.state.sessions[0] = { id: "A", messageOffset: 0, messages: ["already loaded", "tail"] };
  h.respond(0, { messages: ["duplicate"] }); await tick();
  assert.deepEqual(h.state.sessions[0].messages, ["already loaded", "tail"]);
});

test("slim list snapshots keep the local output buffer and messages", async () => {
  const h = harness();
  h.state.selectedId = "A";
  h.state.sessions = [{ id: "A", output: "local terminal tail", messages: [{ role: "user", content: "hi" }] }];
  const pending = h.api.loadSessions({ skipSelectedOutputReload: true });
  // 真实列表响应形状：toSessionListItemDTO 固定 output:""，且不带 messages。
  h.respond(0, [{ id: "A", output: "" }]);
  await pending;
  assert.equal(h.state.sessions[0].output, "local terminal tail", "列表占位输出不得清空本地缓冲");
  assert.equal(h.state.sessions[0].messages[0].content, "hi");
});

test("slim list snapshots that omit permission fields keep the local pending state", async () => {
  const h = harness();
  h.state.selectedId = "A";
  h.state.sessions = [{ id: "A", permissionBlocked: true, pendingEscalation: { requestId: "local" } }];
  const pending = h.api.loadSessions({ skipSelectedOutputReload: true });
  // 说明：JSON.stringify 会丢掉 undefined，所以「键存在但值为 undefined」在
  // 线上不可表达；这里覆盖的是键缺席（JS 侧与 undefined 同义）。
  h.respond(0, [{ id: "A", output: "" }]);
  await pending;
  assert.equal(h.state.sessions[0].permissionBlocked, true);
  assert.deepEqual(h.state.sessions[0].pendingEscalation, { requestId: "local" });
});

test("full session snapshots win over longer stale local output and messages", () => {
  const h = harness();
  h.state.selectedId = "A";
  const merged = h.api.mergeServerSession(
    { id: "A", output: "old output that happens to be longer", messages: [{ role: "assistant", content: [{ text: "stale longer text" }] }] },
    { id: "A", output: "new", messages: [{ role: "user", content: "new prompt" }] },
  );
  assert.equal(merged.output, "new");
  assert.deepEqual(merged.messages, [{ role: "user", content: "new prompt" }]);
});

test("structured in-flight optimistic blocks survive only for the same request", () => {
  const h = harness();
  h.state.selectedId = "A";
  const local = {
    id: "A", sessionKind: "structured", status: "running",
    structuredState: { inFlight: true, activeRequestId: "request-1" },
    messages: [{ role: "assistant", content: [{ __processing: true, text: "streaming" }] }],
  };
  const sameRequest = h.api.mergeServerSession(local, {
    id: "A", sessionKind: "structured", structuredState: { inFlight: false, activeRequestId: "request-1" },
    messages: [{ role: "user", content: "prompt" }],
  });
  assert.deepEqual(sameRequest.messages, local.messages);
  assert.equal(sameRequest.structuredState.inFlight, true);

  const newerRequest = h.api.mergeServerSession(local, {
    id: "A", sessionKind: "structured", structuredState: { inFlight: false, activeRequestId: "request-2" },
    messages: [{ role: "assistant", content: [{ text: "completed" }] }],
  });
  assert.deepEqual(newerRequest.messages, [{ role: "assistant", content: [{ text: "completed" }] }]);
  assert.equal(newerRequest.structuredState.inFlight, false);
});

test("explicit permission fields from the server clear stale local permission state", () => {
  const h = harness();
  h.state.selectedId = "A";
  const cleared = h.api.mergeServerSession(
    { id: "A", permissionBlocked: true, pendingEscalation: { requestId: "old" } },
    { id: "A", permissionBlocked: false, pendingEscalation: null },
  );
  assert.equal(cleared.permissionBlocked, false);
  assert.equal(cleared.pendingEscalation, null);

  const preserved = h.api.mergeServerSession(
    { id: "A", permissionBlocked: true, pendingEscalation: { requestId: "local" } },
    { id: "A", status: "running" },
  );
  assert.equal(preserved.permissionBlocked, true);
  assert.deepEqual(preserved.pendingEscalation, { requestId: "local" });
});

for (const kind of ["new-session", "missions"]) {
  test(`${kind} activation leaves selection and detail loading to the common selectSession path`, async () => {
    let runtime: any;
    const state = { selectedId: "previous", sessions: [{ id: "next" }] };
    const operations: string[] = [];
    const noop = () => {};
    const fallback = new Proxy({}, { get: () => noop });
    const dependencies: Record<string, unknown> = {
      "./state": { state },
      "../react": { configureNewSessionRuntime: (value: unknown) => { runtime = value; return noop; } },
      "../react/missions/controller": { configureMissionsRuntime: (value: unknown) => { runtime = value; return noop; } },
      "./session-engine": new Proxy({}, { get: (_, key) => {
        if (key === "loadSessions") return async (options: any) => {
          assert.equal(state.selectedId, "previous", "previous selection needed to save draft and release terminal");
          assert.equal(options.skipSelectedOutputReload, true);
          operations.push("list");
        };
        if (key === "selectSession") return (id: string) => { assert.equal(state.selectedId, "previous"); state.selectedId = id; operations.push("select"); };
        return noop;
      } }),
    };
    const source = readFileSync(new URL(`../src/web-ui/browser/${kind}-adapter.ts`, import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    const api: any = {};
    runInNewContext(outputText, { exports: api, require: (id: string) => dependencies[id] ?? fallback, window: { setTimeout: noop } });
    if (kind === "new-session") {
      api.installNewSessionLegacyAdapter();
      await runtime.completeCreate({ kind: "shell", mode: "default", cwd: "/tmp" }, { id: "next" });
    } else {
      api.installMissionsLegacyAdapter();
      await runtime.openSession("next");
    }
    assert.deepEqual(operations, ["list", "select"]);
    assert.equal(state.selectedId, "next");
  });
}
