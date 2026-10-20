import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function browser(initial = "?reactUi=0") {
  const entries = [{ url: `http://wand.test/${initial}`, state: {} }];
  let index = 0;
  const events = new EventTarget();
  const window = {
    get location() { return new URL(entries[index].url); },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
    history: {
      get state() { return entries[index].state; },
      pushState(state: any, _: string, url: string) { const next = new URL(url, window.location).href; entries.splice(++index); entries.push({ state, url: next }); },
      replaceState(state: any, _: string, url: string) { entries[index] = { state, url: new URL(url, window.location).href }; },
    },
  };
  const modules = new Map<string, Record<string, any>>();
  function load(path: string): Record<string, any> {
    if (modules.has(path)) return modules.get(path)!;
    const api = {}; modules.set(path, api);
    const source = readFileSync(new URL(`../src/web-ui/${path}.ts`, import.meta.url), "utf8");
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { exports: api, window, URL, URLSearchParams, Event, require: () => load("page-route") });
    return api;
  }
  const api = load("react/issues/task-board-controller");
  api.installTaskBoardHistory();
  const traverse = (delta: number) => { index += delta; assert.ok(entries[index]); events.dispatchEvent(new Event("popstate")); };
  return { ...api, route: load("page-route"), window, entries, back: () => traverse(-1), forward: () => traverse(1) };
}

test("explicit close is synchronous; Back/Forward restore independent feature pages", () => {
  const h = browser();
  h.taskBoardController.open();
  h.taskBoardController.close();
  assert.equal(h.taskBoardStore.getSnapshot().open, false);
  h.back(); assert.equal(h.taskBoardStore.getSnapshot().open, true);
  h.back(); assert.equal(h.taskBoardStore.getSnapshot().open, false);
  h.forward(); assert.equal(h.taskBoardStore.getSnapshot().open, true);
});

test("rapid close-open cannot be overwritten by a pending browser traversal", () => {
  const h = browser();
  h.taskBoardController.open("old");
  h.taskBoardController.close();
  h.taskBoardController.open("new", "session");
  assert.equal(h.taskBoardStore.getSnapshot().workspaceId, "new");
  assert.equal(h.taskBoardStore.getSnapshot().open, true);
});

test("Back/Forward between team runs restores each stable run id", () => {
  const h = browser();
  h.taskBoardController.open("", "", "teamchat", "run_9");
  h.taskBoardController.open("", "", "teamchat", "run_10");
  h.back(); assert.equal(h.taskBoardStore.getSnapshot().runId, "run_9");
  h.forward(); assert.equal(h.taskBoardStore.getSnapshot().runId, "run_10");
});

test("direct legacy links, detail and filters survive controller installation unchanged", () => {
  const h = browser("?view=issues&task=stable-id&q=URL&boardView=list&session=stable-session");
  assert.equal(h.taskBoardStore.getSnapshot().open, true);
  assert.equal(h.window.location.search, "?view=issues&task=stable-id&q=URL&boardView=list&session=stable-session");
  h.taskBoardController.open("", "", "calendar");
  h.taskBoardController.calendarRange("week");
  h.back(); assert.equal(h.taskBoardStore.getSnapshot().calendarRange, "month");
  h.back(); assert.equal(h.taskBoardStore.getSnapshot().page, "board");
  assert.equal(h.window.location.search.includes("task=stable-id"), true);
});

test("copied links strip credentials, tickets, fragments, unknown params and native shell flags", () => {
  const h = browser();
  assert.equal(h.route.shareablePageUrl("https://user:password@wand.test/?view=taskboard&task=t&token=secret&ticket=secret&embed=terminal&unknown=value#secret"), "https://wand.test/?view=taskboard&task=t");
  assert.deepEqual(Array.from(h.route.unknownPageParameters("?view=chats&reactUi=0&bogus=value")), ["bogus"]);
});
