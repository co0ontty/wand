import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function browser() {
  const entries = [{ url: "http://wand.test/?reactUi=0", state: {} }];
  let index = 0;
  let pop = () => {};
  const pending: Array<() => void> = [];
  const window = {
    get location() { return new URL(entries[index].url); },
    addEventListener: (_: string, handler: () => void) => { pop = handler; },
    history: {
      get state() { return entries[index].state; },
      pushState(state: any, _: string, url: string) { const next = new URL(url, window.location).href; entries.splice(++index); entries.push({ state, url: next }); },
      replaceState(state: any, _: string, url: string) { entries[index] = { state, url: new URL(url, window.location).href }; },
      back() { pending.push(() => { index--; pop(); }); },
    },
  };
  const api: Record<string, any> = {};
  const source = readFileSync(new URL("../src/web-ui/react/issues/task-board-controller.ts", import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: api, window, URL, URLSearchParams });
  return { ...api, window, entries, flush: () => { while (pending.length) pending.shift()!(); }, forward: () => { index++; pop(); } };
}

test("closing a board preserves its forward history entry with asynchronous browser traversal", () => {
  const h = browser();
  h.taskBoardController.open();
  h.taskBoardController.close();
  h.flush(); h.forward();
  assert.equal(h.window.location.search, "?reactUi=0&view=taskboard");
  assert.equal(h.taskBoardStore.getSnapshot().open, true);
});

test("rapid close-open waits for the pending back navigation without losing the new context", () => {
  const h = browser();
  h.taskBoardController.open("old");
  h.taskBoardController.close();
  h.taskBoardController.open("new", "session");
  h.flush();
  assert.equal(h.taskBoardStore.getSnapshot().open, true);
  assert.equal(h.taskBoardStore.getSnapshot().workspaceId, "new");
  assert.equal(h.window.location.search, "?reactUi=0&view=taskboard");
});

test("teamchat page is a routed view carrying its run id in the URL", () => {
  const h = browser();
  h.taskBoardController.open("", "", "teamchat", "run_9");
  assert.equal(h.window.location.search, "?reactUi=0&view=teamchat&run=run_9");
  assert.equal(h.taskBoardStore.getSnapshot().page, "teamchat");
  assert.equal(h.taskBoardStore.getSnapshot().runId, "run_9");

  // 换一个群聊只改地址，不多压历史。
  h.taskBoardController.open("", "", "teamchat", "run_10");
  assert.equal(h.window.location.search, "?reactUi=0&view=teamchat&run=run_10");

  // 浏览器返回一步回会话；再前进回到群聊时 run 从 URL 恢复。
  h.taskBoardController.close();
  h.flush(); h.forward();
  assert.equal(h.window.location.search, "?reactUi=0&view=teamchat&run=run_10");
  assert.equal(h.taskBoardStore.getSnapshot().open, true);
  assert.equal(h.taskBoardStore.getSnapshot().runId, "run_10");
});
