import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createSessionReads } from "../src/web-ui/browser/session-reads.js";
import { parseJsonResponse } from "../src/web-ui/react/http-adapter.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

function harness() {
  const state: Record<string, any> = {
    sessions: [], selectedId: null, drafts: {}, attachmentsBySession: {}, terminalStatesBySession: {},
    crossSessionQueue: [], config: {}, currentMessages: [], chatMode: "default", availableModels: [],
  };
  const requests: Array<{ url: string; response: ReturnType<typeof deferred<Response>> }> = [];
  const errors: unknown[] = [];
  const noop = () => {};
  const fallback = new Proxy({}, { get: () => noop });
  const dependencies: Record<string, unknown> = {
    "./state": { state, writeStoredBoolean: noop },
    "./session-reads": { createSessionReads },
    "../react/http-adapter": { parseJsonResponse },
    "./chat-scroll": new Proxy({}, { get: (_, key) => key === "normalizeStructuredSnapshot" ? (s: unknown) => s : noop }),
    "./input": new Proxy({}, { get: (_, key) => key === "buildMessagesForRender" ? (_s: unknown, messages: unknown) => messages : noop }),
  };
  const source = readFileSync(new URL("../src/web-ui/browser/session-engine.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const api: Record<string, any> = {};
  runInNewContext(outputText, {
    exports: api, require: (id: string) => dependencies[id] ?? fallback,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: {}, localStorage: { getItem: () => null, setItem: noop },
    console: { error: (...args: unknown[]) => errors.push(args) },
    setTimeout: noop, clearTimeout: noop, clearInterval: noop,
    fetch: (url: string) => { const response = deferred<Response>(); requests.push({ url, response }); return response.promise; },
  });
  const respond = (index: number, body: unknown, status = 200) => requests[index].response.resolve(new Response(JSON.stringify(body), { status }));
  return { state, api, requests, respond, errors };
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
  h.state.sessions = [{ id: "A", messageOffset: 40, messages: ["old tail"] }, { id: "B", messageOffset: 40, messages: ["B tail"] }];
  h.state.selectedId = "A";
  assert.equal(h.api.fetchEarlierMessages(), true);
  assert.equal(h.api.fetchEarlierMessages(), false);
  h.state.sessions[0] = { id: "A", messageOffset: 40, messages: ["live tail"] };
  h.state.selectedId = "B";
  assert.equal(h.api.fetchEarlierMessages(), true);
  h.respond(0, { messages: ["history"], total: 41 }); await tick();
  assert.deepEqual(Array.from(h.state.sessions[0].messages), ["history", "live tail"]);
  assert.equal(h.state.sessions[0].messageOffset, 0);
  assert.equal(h.state.currentMessages.length, 0, "inactive session does not render");
  h.respond(1, { messages: ["B history"], total: 41 }); await tick();
  assert.deepEqual(Array.from(h.state.currentMessages), ["B history", "B tail"]);
});

test("logout invalidates pending list, detail, and pagination even when the same id is later selected", async () => {
  const h = harness();
  h.state.selectedId = "A"; h.state.sessions = [{ id: "A", messageOffset: 40, messages: [] }];
  const list = h.api.loadSessions(); const detail = h.api.loadOutput("A"); h.api.fetchEarlierMessages();
  h.api.logout();
  h.state.selectedId = "A"; h.state.sessions = [{ id: "A", messageOffset: 40, messages: ["new login"] }];
  h.respond(0, [{ id: "old login" }]); h.respond(1, { id: "A", title: "old login" }); h.respond(2, { messages: ["old history"] });
  await Promise.all([list, detail]); await tick();
  assert.equal(h.state.sessions[0].title, undefined);
  assert.deepEqual(h.state.sessions[0].messages, ["new login"]);
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
