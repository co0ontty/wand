import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function harness() {
  const state: Record<string, any> = { selectedId: "A", sessions: [{ id: "A" }], drafts: { A: "draft A", B: "draft B" }, messageQueue: ["queued A"], chatMode: "default", config: {}, claudeHistory: [], codexHistory: [] };
  const selections: Array<{ from: string; to: string }> = [];
  const noop = () => {};
  const fallback = new Proxy({}, { get: () => noop });
  const engine = new Proxy({
    isStructuredSession: () => true,
    withTerminalDimensions: (value: unknown) => value,
    updateSessionSnapshot: (data: any) => { state.sessions.push(data); },
    clearDraftValueForSession: (id: string) => { delete state.drafts[id]; },
    loadOutput: async () => {},
    selectSession: async (id: string) => { selections.push({ from: state.selectedId, to: id }); state.selectedId = id; state.messageQueue = []; },
  }, { get: (obj, key: keyof typeof obj) => obj[key] ?? noop });
  const api: Record<string, any> = {};
  const source = readFileSync(new URL("../src/web-ui/browser/input.ts", import.meta.url), "utf8");
  let resolve!: (response: Response) => void;
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports: api, require: (id: string) => id === "./state" ? { state } : id === "./session-engine" ? engine : fallback,
    document: { getElementById: () => null, querySelector: () => null, addEventListener: noop },
    window: {}, setInterval: noop,
    fetch: () => new Promise<Response>((yes) => { resolve = yes; }),
  });
  return { api, state, selections, respond: (data: any) => resolve(new Response(JSON.stringify(data))) };
}

test("activation delegates selection before replacing the previous session and clears cross-session queues", async () => {
  const h = harness();
  await h.api.activateSession({ id: "B", status: "running" });
  assert.deepEqual(h.selections, [{ from: "A", to: "B" }]);
  assert.deepEqual(h.state.messageQueue, []);
  assert.equal(h.state.drafts.A, "draft A");
});

test("history resume preserves both drafts and hands the original selection to the shared switch", async () => {
  const h = harness();
  const pending = h.api.resumeHistoryFromList("claude", "history", "/tmp");
  h.respond({ id: "B", status: "running" }); await pending;
  assert.deepEqual(h.selections, [{ from: "A", to: "B" }]);
  assert.equal(h.state.drafts.B, "draft B");
});

test("session resume delegates the switch without preselecting or erasing drafts", async () => {
  const h = harness();
  const pending = h.api.resumeSessionFromList("B");
  h.respond({ id: "B", status: "running" }); await pending;
  assert.deepEqual(h.selections, [{ from: "A", to: "B" }]);
  assert.equal(h.state.drafts.B, "draft B");
});
