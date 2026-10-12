import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const code = ts.transpileModule(readFileSync(new URL("../src/web-ui/browser/chat-render-loader.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function harness() {
  let root = { isConnected: true };
  const state = { selectedId: "A", currentView: "chat", chatRenderEpoch: 1, currentMessages: ["first"], draft: "keep" };
  const paints: Array<{ id: string; messages: string[]; force: boolean }> = [];
  const schedules: boolean[] = [];
  const assets: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
  const feedback: Array<{ root: object; failed: boolean; retry(): void; disposed: boolean }> = [];
  let clears = 0;
  let registered: unknown = null;
  const runtime = { renderChat(force = false) { paints.push({ id: state.selectedId, messages: [...state.currentMessages], force }); },
    scheduleChatRender(immediate = false) { schedules.push(immediate); }, clearActivityDetailState() { clears++; } };
  const api: Record<string, (...args: any[]) => any> = {};
  runInNewContext(code, { exports: api, window: {}, console: { warn() {} },
    document: { getElementById: () => ({}), querySelector: () => root },
    require(id: string) {
      if (id === "./state") return { state };
      if (id === "./chat-render-runtime") return { chatRuntime: () => registered };
      if (id === "./chat-host") return { ensureChatMessagesContainer: () => root };
      if (id === "./chat-load-state") return { mountChatLoadState(host: object, failed: boolean, retry: () => void) {
        const entry = { root: host, failed, retry, disposed: false }; feedback.push(entry);
        return () => { entry.disposed = true; };
      } };
      if (id === "./chat-render") return new Promise((resolve, reject) => assets.push({ resolve, reject }));
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return { api, state, assets, paints, schedules, feedback, runtime, clears: () => clears, register: () => { registered = runtime; },
    replaceRoot() { root.isConnected = false; root = { isConnected: true }; } };
}

test("direct compatibility consumers register the same synchronous runtime without another download", async () => {
  const h = harness(); h.register(); h.api.renderChat(true); h.api.scheduleChatRender(true);
  await tick(); assert.equal(h.assets.length, 0); assert.equal(h.feedback.length, 0);
  assert.deepEqual(h.paints, [{ id: "A", messages: ["first"], force: true }]);
  assert.deepEqual(h.schedules, [true]);
});

test("cold Home/terminal do not download chat; queued updates paint the newest authoritative messages", async () => {
  const h = harness();
  h.state.currentView = "terminal"; h.api.renderChat(true); await tick(); assert.equal(h.assets.length, 0);
  h.state.currentView = "chat"; h.api.renderChat(true); h.state.currentMessages = ["latest"];
  for (let index = 0; index < 100; index++) h.api.scheduleChatRender();
  await tick(); assert.equal(h.assets.length, 1); assert.equal(h.feedback.length, 1);
  h.assets[0]!.resolve(h.runtime); await tick();
  assert.deepEqual(h.paints, [{ id: "A", messages: ["latest"], force: true }]);
  assert.equal(h.state.draft, "keep"); assert.equal(h.feedback[0]!.disposed, true);
  h.api.scheduleChatRender(false); h.api.scheduleChatRender(true);
  assert.deepEqual(h.schedules, [false, true], "warm scheduling remains in the original owner");
});

test("cold A-B-A retires old requests and paints only the new A epoch", async () => {
  const h = harness(); h.api.renderChat(true); await tick();
  h.api.clearActivityDetailState(); h.state.selectedId = "B"; h.state.chatRenderEpoch++;
  h.api.renderChat();
  h.api.clearActivityDetailState(); h.state.selectedId = "A"; h.state.chatRenderEpoch++;
  h.state.currentMessages = ["new A"]; h.api.renderChat(true);
  h.assets[0]!.resolve(h.runtime); await tick();
  assert.deepEqual(h.paints, [{ id: "A", messages: ["new A"], force: true }]);
  assert.equal(h.clears(), 1);
});

for (const stop of ["Home", "terminal", "detached"] as const) test(`late chat download cannot paint ${stop}`, async () => {
  const h = harness(); h.api.renderChat(true); await tick();
  if (stop === "detached") h.replaceRoot();
  else { h.api.clearActivityDetailState(); h.state.currentView = stop === "Home" ? "chat" : "terminal"; if (stop === "Home") h.state.selectedId = ""; }
  h.assets[0]!.resolve(h.runtime); await tick();
  assert.equal(h.paints.length, 0); assert.ok(h.feedback.every(item => item.disposed));
});

test("failed download does not retry on messages/cache epochs; explicit retry retains the newest draft/state", async () => {
  const h = harness(); h.api.renderChat(true); await tick();
  h.assets[0]!.reject(new Error("download")); await tick();
  assert.ok(h.feedback.at(-1)!.failed);
  h.state.chatRenderEpoch++; h.state.currentMessages = ["after failure"];
  for (let i = 0; i < 100; i++) h.api.renderChat();
  await tick(); assert.equal(h.assets.length, 1);
  h.feedback.at(-1)!.retry(); await tick(); assert.equal(h.assets.length, 2);
  h.assets[1]!.resolve(h.runtime); await tick();
  assert.deepEqual(h.paints, [{ id: "A", messages: ["after failure"], force: true }]);
  assert.equal(h.state.draft, "keep");
});
