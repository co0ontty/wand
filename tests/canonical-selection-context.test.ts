import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ComposerStore } from "../src/web-ui/browser/composer.js";

function harness(taskId: string | null = "old-task", workspaceTaskId?: string) {
  const source = readFileSync(new URL("../src/web-ui/browser/session-engine.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("session-engine.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const select = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "selectSession");
  assert.ok(select, "test executes the production canonical selection function");
  const compiled = ts.transpileModule(select.getText(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const calls: string[] = [];
  const state = { selectedId: "previous", sessions: [{ id: "next", workspaceTaskId }], currentMessages: ["old"], config: {} };
  const composer = new ComposerStore({ storage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }), isUnloading: () => false, disposeAttachment: () => {} });
  composer.edit("next", { text: "new session draft" });
  const noop = () => {};
  const exports: Record<string, any> = {};
  const context = { taskId, workspaceId: taskId ? "old-project" : "project" };
  const sandbox: Record<string, unknown> = {
    exports, state, composer,
    workspaceContextStore: { getSnapshot: () => context },
    workspacesStore: { getRuntime: () => ({ closeWorkspace() {
      calls.push(`close:${state.selectedId}`);
      context.taskId = null;
      context.workspaceId = "";
    } }) },
    completionViewIntent: { open: (id: string) => { calls.push(`open:${id}`); } },
    document: { getElementById: (id: string) => id === "input-box" ? { value: "previous session draft" } : null, querySelector: () => null },
    piExecutionController: { closeIfOpen: noop },
    getPreferredTool: () => "claude", getSafeModeForTool: () => "default",
    switchToSessionView: (id: string) => { calls.push(`view:${id}`); },
    loadOutput: (id: string) => { calls.push(`load:${id}`); return Promise.resolve(); },
    focusInputBox: () => { calls.push("focus"); },
    captureSessionViewFocus: (id: string) => () => state.selectedId === id,
  };
  for (const name of ["teardownTerminal", "clearActivityDetailState", "persistSelectedId", "syncStructuredQueueFromSession",
    "restoreStructuredQueue", "updateStructuredQueueCounter", "resetChatRenderCache", "clearTimeout", "collapseTodoProgress",
    "clearInterval", "setTerminalInteractive", "updateSessionsList", "renderChat", "updateFilePanelCwd", "subscribeToSession",
    "restoreGitStatusForSession", "loadGitStatus"]) sandbox[name] = noop;
  runInNewContext(compiled.outputText, sandbox);
  return { api: exports, state, context, calls, composer };
}

test("canonical unbound selection exits an old task before selecting and preserves both composers", async () => {
  const h = harness();
  await h.api.selectSession("next");
  assert.equal(h.context.taskId, null);
  assert.equal(h.state.selectedId, "next");
  assert.deepEqual(h.calls, ["close:previous", "open:next", "view:next", "load:next", "focus"]);
  assert.equal(h.composer.read("previous").text, "previous session draft");
  assert.equal(h.composer.read("next").text, "new session draft");
});

test("canonical selection keeps task-owned and already-open standalone project contexts", async () => {
  const bound = harness("old-task", "next-task");
  await bound.api.selectSession("next");
  assert.equal(bound.context.taskId, "old-task");
  assert.ok(bound.calls.every(call => !call.startsWith("close:")));
  const project = harness(null);
  await project.api.selectSession("next");
  assert.equal(project.context.workspaceId, "project");
  assert.ok(project.calls.every(call => !call.startsWith("close:")));
});

test("unknown canonical selection leaves context, selection and drafts untouched", () => {
  const h = harness();
  h.api.selectSession("missing");
  assert.equal(h.context.taskId, "old-task");
  assert.equal(h.state.selectedId, "previous");
  assert.deepEqual(h.calls, []);
  assert.equal(h.composer.read("next").text, "new session draft");
});

test("tab selection can retain keyboard focus while canonical selection still preserves the draft", async () => {
  const h = harness(null);
  await h.api.selectSession("next", { focusInput: false });
  assert.deepEqual(h.calls, ["open:next", "view:next", "load:next"]);
  assert.equal(h.composer.read("previous").text, "previous session draft");
});
