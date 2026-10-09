import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the production stop transaction with controlled confirmation/HTTP
// completion. Browser coverage supplies the actual controls and PTY transport.
function harness(kind = "structured") {
  const source = readFileSync(new URL("../src/web-ui/browser/input.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("input.ts", source, ts.ScriptTarget.Latest, true);
  const stop = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "stopSession")!;
  const state = { selectedId: "A", sessions: [{ id: "A", sessionKind: kind }] };
  const effects: string[] = [];
  const requests: Array<{ path: string; options: any }> = [];
  let confirm: (answer: boolean) => void = () => {};
  let release: (response: Response) => void = () => {};
  const snapshot = { id: "A", status: "idle", structuredState: { inFlight: false } };
  const api: any = {};
  runInNewContext(ts.transpileModule("const composerStops = new Set<string>();\n" + stop.getText(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    exports: api, state,
    updateInteractiveControls() { effects.push("controls"); },
    t: (value: string) => value,
    wandConfirm: () => new Promise<boolean>(resolve => { confirm = resolve; }),
    isStructuredSession: (session: any) => session.sessionKind === "structured",
    compactSessionFetch(path: string, options: any) {
      requests.push({ path, options });
      return new Promise<Response>(resolve => { release = resolve; });
    },
    parseJsonResponse: async (response: Response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      return body;
    },
    updateSessionSnapshot(value: any) { assert.equal(value.id, "A"); effects.push("snapshot"); },
    getControlInput: (key: string) => { assert.equal(key, "ctrl_c"); return "\x03"; },
    queueDirectInput(...args: any[]) {
      assert.deepEqual(args, ["\x03", "ctrl_c", "chat", "A"]);
      effects.push("interrupt"); return Promise.resolve();
    },
    flashComposerDone() { effects.push("done"); },
    flashComposerFailed() { effects.push("failed"); },
    showToast() { effects.push("toast"); },
    refreshAll: async () => { effects.push("refresh"); },
    getErrorMessage: (error: Error) => error.message,
  });
  return { api, state, effects, requests, snapshot,
    confirm: (answer: boolean) => confirm(answer),
    release: (body = snapshot, status = 200) => release(new Response(JSON.stringify(body), { status })) };
}

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test("structured stop consumes its response and releases the control for a second turn", async () => {
  const h = harness();
  for (let turn = 0; turn < 2; turn++) {
    const done = h.api.stopSession(); h.confirm(true); await tick(); h.release(); await done;
  }
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].path, "/api/sessions/A/stop");
  assert.ok(h.effects.indexOf("snapshot") < h.effects.indexOf("done"));
  assert.ok(h.effects.indexOf("done") < h.effects.indexOf("refresh"));
});

test("PTY composer stop interrupts the foreground command and keeps the shell reusable", async () => {
  const h = harness("pty");
  for (let turn = 0; turn < 2; turn++) { const done = h.api.stopSession(); h.confirm(true); await done; }
  assert.equal(h.requests.length, 0);
  assert.equal(h.effects.filter(effect => effect === "interrupt").length, 2);
});

test("cancel and duplicate clicks do not issue a stop and allow the next confirmation", async () => {
  const h = harness();
  const first = h.api.stopSession(); assert.equal(h.api.stopSession(), undefined);
  h.confirm(false); await first; assert.equal(h.requests.length, 0);
  const next = h.api.stopSession(); h.confirm(true); await tick();
  assert.equal(h.api.stopSession(), undefined);
  h.release(); await next; assert.equal(h.requests.length, 1);
});

test("switching sessions during confirmation cannot stop the new owner", async () => {
  const h = harness(); const done = h.api.stopSession(); h.state.selectedId = "B"; h.confirm(true); await done;
  assert.equal(h.requests.length, 0); assert.equal(h.effects.includes("done"), false);
});

test("late stop responses update their owning session without painting the new composer", async () => {
  const h = harness(); const done = h.api.stopSession(); h.confirm(true); await tick();
  h.state.selectedId = "B"; h.release(); await done;
  assert.ok(h.effects.includes("snapshot")); assert.equal(h.effects.includes("done"), false);
});

test("a rejected stop releases the pending guard and can be retried", async () => {
  const h = harness(); const failed = h.api.stopSession(); h.confirm(true); await tick();
  h.release({ error: "stop failed" } as any, 503); await failed;
  assert.ok(h.effects.includes("failed"));
  const retry = h.api.stopSession(); h.confirm(true); await tick(); h.release(); await retry;
  assert.equal(h.requests.length, 2); assert.ok(h.effects.includes("done"));
});
