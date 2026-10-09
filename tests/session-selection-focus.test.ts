import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

/** Execute the real input view/resume owners; only IO and native focus are controlled. */
function harness() {
  const source = readFileSync(new URL("../src/web-ui/browser/input.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("input.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ["switchToSessionView", "resumeTerminalPageSession", "canAutoResumeSession", "ensureSessionReadyForInput", "captureSessionViewFocus"];
  const functions = file.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text ?? ""));
  assert.ok(functions.length >= 4, "production view and both resume functions are exercised");
  const variables = file.statements.filter(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => ["terminalPageResumeSessionId", "sessionViewRevision"].includes(declaration.name.getText(file))));
  const compiled = ts.transpileModule([...variables, ...functions].map(statement => statement.getText(file)).join("\n")
    + "\nexports.ensureSessionReadyForInput = ensureSessionReadyForInput;", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const a = { id: "A", provider: "claude", sessionKind: "pty", status: "exited", claudeSessionId: "fixture-history" };
  const b = { id: "B", provider: "pi", sessionKind: "structured", status: "idle" };
  const state = { sessions: [a, b], selectedId: "A", terminal: {}, terminalInteractive: true, currentView: "terminal" };
  const calls: string[] = [];
  const reconciledViews: string[] = [];
  const resumes: ReturnType<typeof deferred<typeof a>>[] = [];
  const outputs: ReturnType<typeof deferred<void>>[] = [];
  const body = {};
  const input = {};
  const tab = {};
  const document = { body, activeElement: body };
  const api: Record<string, any> = {};
  const noop = () => {};
  const sandbox: Record<string, unknown> = {
    exports: api, state, document, PROVIDER_IDS: ["claude", "pi"], PROVIDER_LABELS: { claude: "Claude" },
    isStructuredSession: (session: typeof a) => session?.sessionKind === "structured",
    isTouchDevice: () => false,
    focusTerminalInteractionTarget: () => { calls.push("focus-terminal"); document.activeElement = input; },
    focusInputBox: () => { calls.push("focus-input"); document.activeElement = input; },
    resumeSession: () => { const pending = deferred<typeof a>(); resumes.push(pending); return pending.promise; },
    loadOutput: () => { const pending = deferred<void>(); outputs.push(pending); return pending.promise; },
    updateSessionSnapshot: (data: typeof a) => Object.assign(a, data),
    waitForProviderPaint: () => { calls.push("paint"); return Promise.resolve(); },
    reconcileInteractiveState: () => { reconciledViews.push(state.selectedId); },
  };
  for (const name of ["initTerminal", "applyCurrentView", "restoreComposerStateForSession",
    "ensureTerminalFit", "notifyLegacyUiChange", "updateSessionsList", "subscribeToSession", "flashComposerFailed"]) sandbox[name] = noop;
  runInNewContext(compiled.outputText, sandbox);
  const switchTo = (id: string, focusInput = false) => {
    state.selectedId = id;
    state.terminalInteractive = id === "A";
    const ticket = api.switchToSessionView(id, { focusInput });
    if (!focusInput) document.activeElement = tab;
    return ticket;
  };
  return { api, a, b, state, calls, resumes, outputs, document, input, tab, switchTo, reconciledViews };
}

for (const returnToA of [false, true]) test(`late automatic PTY resume retains native tab focus after A→B${returnToA ? "→A" : ""}`, async () => {
  const h = harness();
  h.switchTo("A", true);
  assert.deepEqual(h.calls, ["focus-terminal"], "default view still focuses synchronously");
  h.resumes[0].resolve({ ...h.a, status: "running" });
  await tick();
  assert.equal(h.outputs.length, 1, "resume is now awaiting its output read");
  h.switchTo("B");
  if (returnToA) h.switchTo("A");
  const beforeOutput = h.reconciledViews.length;
  h.outputs[0].resolve();
  await tick();
  assert.equal(h.document.activeElement, h.tab);
  assert.deepEqual(h.calls, ["focus-terminal"], "late output does not transfer native keyboard focus");
  if (!returnToA) assert.equal(h.reconciledViews.length, beforeOutput, "A output does not reconcile B controls");
});

for (const returnToA of [false, true]) test(`sending resume keeps A data and provider paint while withholding late focus after A→B${returnToA ? "→A" : ""}`, async () => {
  const h = harness();
  const ready = h.api.ensureSessionReadyForInput(h.a);
  const resumed = { ...h.a, status: "running" };
  h.resumes[0].resolve(resumed); await tick();
  h.switchTo("B");
  if (returnToA) h.switchTo("A");
  h.outputs[0].resolve();
  assert.equal(await ready, resumed, "accepted resume still returns its original A execution data");
  assert.deepEqual(h.calls, ["paint"], "execution readiness is retained without moving UI focus");
  assert.equal(h.document.activeElement, h.tab);
});

test("current default resume may focus, but an explicit control focus within the same view is preserved", async () => {
  const current = harness();
  current.switchTo("A", true);
  current.resumes[0].resolve({ ...current.a, status: "running" }); await tick();
  current.outputs[0].resolve(); await tick();
  assert.deepEqual(current.calls, ["focus-terminal", "focus-terminal"]);
  const changed = harness();
  changed.switchTo("A", true);
  changed.resumes[0].resolve({ ...changed.a, status: "running" }); await tick();
  changed.document.activeElement = changed.tab;
  changed.outputs[0].resolve(); await tick();
  assert.equal(changed.document.activeElement, changed.tab, "same-view deliberate control focus is not stolen");
});
