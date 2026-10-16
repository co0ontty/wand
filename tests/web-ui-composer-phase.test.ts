import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { MOTION_DWELL_FAILED_MS, MOTION_DWELL_SENT_MS } from "../src/web-ui/react/ui/motion-tokens.js";

// Exercise the production send-button phase machine with controlled timers and
// host visibility. Browser coverage supplies the real button and transport.
const extracted = (file: ts.SourceFile, name: string): string => {
  const statement = file.statements.find(candidate =>
    (ts.isFunctionDeclaration(candidate) && candidate.name?.text === name)
    || (ts.isVariableStatement(candidate)
      && candidate.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name)));
  assert.ok(statement, `input.ts must still declare ${name}`);
  return statement.getText(file);
};

function harness(options: { hostVisible?: boolean } = {}) {
  const source = readFileSync(new URL("../src/web-ui/browser/input.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("input.ts", source, ts.ScriptTarget.Latest, true);
  const pieces = [
    "composerResultPhase", "composerResultText", "composerResultTimer",
    "composerResultSessionId", "composerSendToken", "composerSendingToken", "composerSendingAcceptText",
    "composerResultDwellMs", "composerResultOwns", "composerResultHostVisible",
    "flashComposerPhase", "getComposerResultPhase",
    "flashComposerSending", "flashComposerDone", "flashComposerFailed", "noteComposerSendAccepted",
  ].map(name => extracted(file, name));
  const state = { selectedId: "A" };
  const controls: number[] = [];
  const toasts: Array<{ text: string; type: string }> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const hostVisible = options.hostVisible !== false;
  const api: any = {};
  runInNewContext(ts.transpileModule(
    pieces.join("\n") + `\nexports.__probe = { text: function() { return composerResultText; },`
      + ` owner: function() { return composerResultSessionId; } };`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
  ).outputText, {
    exports: api, state,
    MOTION_DWELL_SENT_MS, MOTION_DWELL_FAILED_MS,
    updateInteractiveControls() { controls.push(controls.length + 1); },
    showToast(text: string, type: string) { toasts.push({ text, type }); },
    clearTimeout() {},
    window: { setTimeout(fn: () => void, ms: number) { timers.push({ fn, ms }); return timers.length; } },
    document: {
      getElementById: () => ({
        getClientRects: () => (hostVisible ? [{ width: 1 }] : []),
      }),
    },
  });
  return { api, state, controls, toasts, timers,
    probe: api.__probe as { text: () => string; owner: () => string | null } };
}

test("server acceptance advances the pending send to sent with its stored sentence", () => {
  const h = harness();
  h.api.flashComposerSending("正在发送…", "A", "已加入排队，等当前回复完成会自动发送。");
  assert.equal(h.api.getComposerResultPhase(), "sending");
  h.api.noteComposerSendAccepted("A");
  assert.equal(h.api.getComposerResultPhase(), "sent");
  assert.equal(h.probe.text(), "已加入排队，等当前回复完成会自动发送。");
  assert.equal(h.probe.owner(), "A");
  assert.equal(h.timers.at(-1)?.ms, MOTION_DWELL_SENT_MS);
});

test("a stale completion token cannot advance a newer submission in the same session", () => {
  const h = harness();
  const first = h.api.flashComposerSending("正在发送…", "A");
  const second = h.api.flashComposerSending("正在发送…", "A");
  h.api.noteComposerSendAccepted("A", first);
  assert.equal(h.api.getComposerResultPhase(), "sending");
  h.api.noteComposerSendAccepted("A", second);
  assert.equal(h.api.getComposerResultPhase(), "sent");
});

test("a status event for another session cannot release the pending send", () => {
  const h = harness();
  h.api.flashComposerSending("正在发送…", "A");
  h.api.noteComposerSendAccepted("B");
  assert.equal(h.api.getComposerResultPhase(), "sending");
  h.api.noteComposerSendAccepted("A");
  assert.equal(h.api.getComposerResultPhase(), "sent");
});

test("the dwell timer clears the phase, its text and its ownership", () => {
  const h = harness();
  h.api.flashComposerDone("已发送", "A");
  const paints = h.controls.length;
  h.timers.at(-1)!.fn();
  assert.equal(h.api.getComposerResultPhase(), "");
  assert.equal(h.probe.text(), "");
  assert.equal(h.probe.owner(), null);
  assert.ok(h.controls.length > paints);
});

test("flashes without an explicit owner stay bound to the selected session", () => {
  const h = harness();
  h.state.selectedId = "A";
  h.api.flashComposerDone("已发送");
  assert.equal(h.probe.owner(), "A");
  h.state.selectedId = "B";
  h.api.flashComposerFailed("晚了");
  assert.equal(h.probe.owner(), "B");
});

test("a failure that reaches another session falls back to a toast instead of that session's status line", () => {
  const h = harness();
  h.api.flashComposerFailed("发送失败", "A");
  assert.equal(h.toasts.length, 0, "owned failure paints in place");
  h.state.selectedId = "B";
  h.api.flashComposerFailed("A 的失败", "A");
  assert.equal(h.toasts.length, 1, "foreign failure must not paint B's status line");
  assert.equal(h.probe.owner(), "A");
});

test("an invisible in-place host still falls back to a toast for its own failure", () => {
  const h = harness({ hostVisible: false });
  h.api.flashComposerFailed("网络中断，这条消息可能已送达。", "A");
  assert.equal(h.toasts.length, 1);
});

test("the injected result phase only paints its owning session", () => {
  const input = readFileSync(new URL("../src/web-ui/browser/input.ts", import.meta.url), "utf8");
  assert.match(input, /var resultOwned = composerResultOwns\(\);/);
  assert.match(input, /\(resultOwned && composerResultPhase\)\s*\|\| composerBaseSendPhase/);
  assert.match(input, /var phaseText = resultOwned \? composerResultText : "";/);
  assert.match(input, /renderComposerPhaseHost\(sendPhase, phaseText, isCodex\)/);
});

test("websocket acceptance snapshots release the pending send for their own session", () => {
  const websocket = readFileSync(new URL("../src/web-ui/browser/websocket.ts", import.meta.url), "utf8");
  const releases = websocket.match(/noteComposerSendAccepted\(msg\.sessionId\)/g) || [];
  assert.equal(releases.length, 2, "status and init snapshots both release");
  assert.match(websocket, /statusUpdate\.structuredState\.inFlight === true\) \{\s*noteComposerSendAccepted/);
  assert.match(websocket, /msg\.data\.structuredState\.inFlight === true\) \{\s*noteComposerSendAccepted/);
});
