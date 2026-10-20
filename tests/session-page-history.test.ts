import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function routeFixture() {
  const source = readFileSync(new URL("../src/web-ui/page-route.ts", import.meta.url), "utf8");
  const previous = "https://wand.invalid/?view=taskboard&task=board-task&q=keep&session=old&workspaceTask=old-task&window=old-window&tab=old-tab";
  let href = previous;
  const entries = [href];
  const events: string[] = [];
  const eventTarget = new EventTarget();
  const api: any = {};
  const window = {
    get location() { const url = new URL(href); return { href, pathname: url.pathname, search: url.search, hash: url.hash }; },
    history: {
      state: null,
      pushState(_state: unknown, _title: string, url: string) { href = new URL(url, href).href; entries.push(href); },
      replaceState(_state: unknown, _title: string, url: string) { href = new URL(url, href).href; entries[entries.length - 1] = href; },
    },
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent(event: Event) { events.push(event.type); return eventTarget.dispatchEvent(event); },
  };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports: api, window, URL, URLSearchParams, Event, setTimeout, clearTimeout });
  return { api, window, entries, events, previous, url: () => new URL(href) };
}

test("switching sessions inside a workspace replaces history so edge swipe leaves the page", () => {
  const f = routeFixture();
  assert.equal(f.api.workspaceSessionHistoryMode("?view=workspace&session=a", "b"), "replace");
  assert.equal(f.api.workspaceSessionHistoryMode("?view=workspace&session=a", "a"), "push");
  assert.equal(f.api.workspaceSessionHistoryMode("?view=chats", "b"), "push");
  assert.equal(f.api.workspaceSessionHistoryMode("?view=workspace", "b"), "push");
  assert.equal(f.api.workspaceSessionHistoryMode("?view=workspace&session=pty", "terminal"), "replace");
});

test("opening a comment execution creates exactly one complete history entry", () => {
  const f = routeFixture();
  f.api.openSessionPage(" new-session ");
  assert.equal(f.entries.length, 2);
  assert.equal(f.entries[0], f.previous, "Back retains the exact original task and filters");
  assert.equal(f.url().searchParams.get("view"), "workspace");
  assert.equal(f.url().searchParams.get("session"), "new-session");
  for (const key of ["task", "workspace", "workspaceTask", "window", "tab"]) assert.equal(f.url().searchParams.has(key), false, key);
  assert.equal(f.url().searchParams.get("q"), null, "task-board-only filters do not leak into the session page");
  assert.equal(new URL(f.entries[0]!).searchParams.get("q"), "keep", "Back restores the original board filter");
  assert.deepEqual(f.events, ["wand:page-route"]);
  f.api.openSessionPage("new-session");
  f.api.openSessionPage(" ");
  assert.equal(f.entries.length, 2, "same destination and blank input add no history");
});

test("pagehide flushes pending route replacement and route subscriptions can be removed", () => {
  const f = routeFixture();
  let notifications = 0;
  const unsubscribe = f.api.subscribePageRoute(() => notifications++);
  f.api.scheduleReplacePageRoute({ q: "latest filter" });
  assert.equal(f.url().searchParams.get("q"), "keep");
  f.window.dispatchEvent(new Event("pagehide"));
  assert.equal(f.url().searchParams.get("q"), "latest filter");
  assert.equal(f.entries.length, 1, "typing/pagehide replaces, never pushes an extra history entry");
  assert.equal(notifications, 1);
  unsubscribe();
  f.api.updatePageRoute({ q: "after unsubscribe" }, "replace");
  assert.equal(notifications, 1);
});

test("pending search replacement precedes a single complete session navigation", () => {
  const f = routeFixture();
  f.api.scheduleReplacePageRoute({ q: "latest filter" });
  f.api.openSessionPage("next-session");
  assert.equal(f.entries.length, 2);
  assert.equal(new URL(f.entries[0]!).searchParams.get("q"), "latest filter");
  assert.equal(f.url().searchParams.get("q"), null);
  assert.equal(f.url().searchParams.get("session"), "next-session");
});

test("all feature-to-session links use the same route intent, not intermediate close/suspend navigation", () => {
  const source = readFileSync(new URL("../src/web-ui/react/shell/shell-main-content.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/onOpenSession=\{openSessionPage\}/g) ?? []).length, 5);
  assert.doesNotMatch(source, /openSessionWithOwningTask|conversationUi\.suspend\(\)/);
});
