import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ComposerQueueClock, ComposerStore } from "../src/web-ui/browser/composer.js";
import { getErrorMessage } from "../src/error-utils.js";

function harness(responses: Array<Response | Error>, websocket = false) {
  const data = new Map<string, string>();
  const noop = () => {};
  const composer = new ComposerStore({
    storage: () => ({
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => { data.set(key, value); },
      removeItem: (key) => { data.delete(key); },
    }),
    isUnloading: () => false,
    disposeAttachment: noop,
  });
  composer.edit("A", { text: "draft" });
  const box = {
    value: "draft", style: {}, scrollTop: 0, scrollHeight: 40,
    classList: { contains: () => false, add: noop, remove: noop, toggle: noop },
    closest: () => null, setSelectionRange: noop, setAttribute: noop,
  };
  const state: Record<string, any> = {
    selectedId: "A", sessions: [{ id: "A", sessionKind: "pty", provider: "codex", status: "running" }],
    currentView: websocket ? "terminal" : "chat", wsConnected: true,
    inputQueue: Promise.resolve(), messageQueue: [], pendingMessages: [],
    crossSessionQueue: [], currentMessages: [], terminalInteractive: false,
  };
  const inputs: string[] = [];
  let responseIndex = 0;
  if (websocket) state.ws = {
    readyState: 1,
    send: (value: string) => {
      inputs.push(JSON.parse(value).data);
      if (inputs.length > 1) throw Object.assign(new Error("rejected Enter"), { httpStatus: 400 });
    },
  };
  const fallback = new Proxy({}, { get: () => noop });
  const dependencies: Record<string, unknown> = {
    "./state": { state, composer, composerQueue: new ComposerQueueClock() },
    "../../error-utils.js": { getErrorMessage },
    "./session-engine": new Proxy({
      isStructuredSession: (session: any) => session?.sessionKind === "structured",
      getDraftValueForSession: (id: string) => composer.read(id).text,
      getPendingAttachments: (id: string) => composer.read(id).attachments,
      canSendComposer: (text: string) => !!text.trim(),
      getComposerPlaceholder: () => "输入消息",
      getPreferredMessages: (session: any) => session.messages ?? [],
      buildAttachmentPrefix: () => "",
      restoreComposerStateForSession: (id: string) => { box.value = composer.read(id).text; },
      updateSessionSnapshot: (snapshot: any) => {
        state.sessions = state.sessions.map((session: any) => session.id === snapshot.id ? { ...session, ...snapshot } : session);
      },
    }, { get: (obj: Record<string, unknown>, key: string) => obj[key] ?? noop }),
    "./utils": { computeRunningSignal: () => ({ active: false }), collapseTodoProgress: noop },
    "./chat-scroll": new Proxy({ stripRenderOnlyStructuredMessages: (messages: unknown) => messages },
      { get: (obj: Record<string, unknown>, key: string) => obj[key] ?? noop }),
  };
  const api: Record<string, any> = {};
  const source = readFileSync(new URL("../src/web-ui/browser/input.ts", import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    exports: api,
    require: (id: string) => dependencies[id] ?? fallback,
    document: {
      getElementById: (id: string) => id === "input-box" ? box : null,
      querySelector: () => null, querySelectorAll: () => [], addEventListener: noop,
      documentElement: { classList: { contains: () => false } },
    },
    window: {
      getComputedStyle: () => ({ minHeight: "40px", maxHeight: "120px" }),
      setTimeout: () => 0,
      clearTimeout: noop,
    },
    navigator: { maxTouchPoints: 0 },
    setTimeout: (handler: () => void) => { queueMicrotask(handler); return 0; },
    clearTimeout: noop,
    fetch: async (_url: string, options: RequestInit) => {
      inputs.push(JSON.parse(String(options.body)).input);
      const response = responses[responseIndex++];
      if (response instanceof Error) throw response;
      assert.ok(response, "unexpected request");
      return response;
    },
    console: { error: noop, warn: noop },
    WebSocket: { OPEN: 1 },
  });
  return { api, composer, data, inputs, state };
}

const rejection = (status: number) => new Response(JSON.stringify({ error: "rejected" }), { status });
const accepted = () => new Response("{}");

test("PTY text accepted then Enter rejected keeps the complete draft memory-only", async () => {
  const h = harness([accepted(), rejection(400)]);
  await h.api.sendInputFromBox();
  assert.deepEqual(h.inputs, ["draft", "\r"]);
  assert.equal(h.composer.read("A").text, "draft");
  assert.equal(h.composer.read("A").memoryOnly, true);
  assert.equal(h.data.has("wand-draft-A"), false);
});

test("PTY first-packet ordinary 4xx rejection proves non-delivery and restores a durable draft", async () => {
  for (const status of [400, 401, 403, 404, 422, 429]) {
    const h = harness([rejection(status)]);
    await h.api.sendInputFromBox();
    assert.deepEqual(h.inputs, ["draft"]);
    assert.equal(h.composer.read("A").memoryOnly, false, String(status));
    assert.equal(h.data.get("wand-draft-A"), "draft", String(status));
  }
});

test("PTY 5xx, timeout, conflict, and network failure cannot prove non-delivery", async () => {
  for (const failure of [rejection(500), rejection(502), rejection(503), rejection(408), rejection(409), new Error("Failed to fetch")]) {
    const h = harness([failure]);
    await h.api.sendInputFromBox();
    assert.deepEqual(h.inputs, ["draft"]);
    assert.equal(h.composer.read("A").text, "draft");
    assert.equal(h.composer.read("A").memoryOnly, true);
    assert.equal(h.data.has("wand-draft-A"), false);
  }
});

test("PTY failure parsing an accepted acknowledgement does not persist an already sent draft", async () => {
  const h = harness([new Response("invalid json")]);
  await h.api.sendInputFromBox();
  assert.deepEqual(h.inputs, ["draft"]);
  assert.equal(h.composer.read("A").memoryOnly, true);
  assert.equal(h.data.has("wand-draft-A"), false);
});

test("a local pre-send offline failure persists the unsent draft without making a request", async () => {
  const h = harness([]);
  h.state.wsConnected = false;
  await h.api.sendInputFromBox();
  assert.deepEqual(h.inputs, []);
  assert.equal(h.composer.read("A").memoryOnly, false);
  assert.equal(h.data.get("wand-draft-A"), "draft");
});

test("a successful WS text send followed by Enter failure is an uncertain whole submission", async () => {
  const h = harness([], true);
  await h.api.sendInputFromBox();
  assert.deepEqual(h.inputs, ["draft", "\r"]);
  assert.equal(h.composer.read("A").memoryOnly, true);
  assert.equal(h.data.has("wand-draft-A"), false);
});

test("structured acknowledgement parse failure and HTTP 5xx restore only a memory draft", async () => {
  for (const response of [new Response("invalid json"), rejection(500), rejection(408), rejection(409)]) {
    const h = harness([response]);
    h.state.sessions = [{ id: "A", sessionKind: "structured", provider: "codex", status: "idle", messages: [] }];
    await h.api.sendInputFromBox();
    assert.deepEqual(h.inputs, ["draft"]);
    assert.equal(h.composer.read("A").text, "draft");
    assert.equal(h.composer.read("A").memoryOnly, true);
    assert.equal(h.data.has("wand-draft-A"), false);
  }
});
