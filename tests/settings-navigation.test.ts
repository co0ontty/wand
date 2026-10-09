import assert from "node:assert/strict";
import test from "node:test";
import { settingsController, settingsStore } from "../src/web-ui/react/settings/controller.js";
import { installSettingsHistory, settingsRoute, settingsSearch } from "../src/web-ui/react/settings/history.js";

test("settings navigation preserves the selected section and unwinds nested content before leaving", () => {
  settingsController.close();
  settingsStore.setCompact(true);
  settingsController.open();
  assert.equal(settingsStore.getSnapshot().detail, false);
  settingsStore.setTab("general");
  settingsStore.setNested("environment");
  assert.equal(settingsController.closeTopmost(), true);
  assert.equal(settingsStore.getSnapshot().nested, null);
  assert.equal(settingsStore.getSnapshot().detail, true);
  assert.equal(settingsController.closeTopmost(), true);
  assert.equal(settingsStore.getSnapshot().tab, "general");
  assert.equal(settingsStore.getSnapshot().detail, false);
  assert.equal(settingsController.isOpen(), true);
  settingsStore.setTab("general");
  assert.equal(settingsStore.getSnapshot().detail, true, "reselecting the same section enters it again");
  settingsStore.setCompact(false);
  assert.equal(settingsController.closeTopmost(), true);
  assert.equal(settingsController.isOpen(), false);
});

test("settings links preserve the underlying workspace route and reject unknown sections", () => {
  assert.equal(settingsSearch("?view=teamchat&run=abc&reactUi=0", "general"), "?view=teamchat&run=abc&reactUi=0&settings=general");
  assert.equal(settingsSearch("?view=teamchat&settings=general&run=abc", null), "?view=teamchat&run=abc");
  assert.equal(settingsRoute("?settings=directory"), "directory");
  assert.equal(settingsRoute("?settings=security"), "security");
  assert.equal(settingsRoute("?settings=unknown"), null);
});

test("browser Back and Forward restore settings without pushing another history entry", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window");
  const listeners = new Map<string, () => void>();
  const urls = ["http://localhost/?view=teamchat&run=abc"];
  let index = 0;
  const location = { get href() { return urls[index]; }, get search() { return new URL(urls[index]).search; } };
  const history = {
    state: { underlying: "teamchat" },
    pushState(_state: unknown, _title: string, url: string) { urls.splice(++index); urls[index] = new URL(url, urls[index - 1]).href; },
    replaceState(_state: unknown, _title: string, url: string) { urls[index] = new URL(url, urls[index]).href; },
  };
  let stop = () => {};
  try {
    settingsController.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location, history, addEventListener(type: string, listener: () => void) { listeners.set(type, listener); },
      removeEventListener(type: string) { listeners.delete(type); },
    } });
    stop = installSettingsHistory();
    settingsController.open();
    settingsStore.setTab("about");
    assert.equal(urls.length, 2);
    assert.equal(settingsRoute(location.search), "about");
    index = 0; listeners.get("popstate")!();
    assert.equal(settingsController.isOpen(), false);
    index = 1; listeners.get("popstate")!();
    assert.equal(settingsController.isOpen(), true);
    assert.equal(settingsStore.getSnapshot().tab, "about");
    assert.equal(urls.length, 2);
    settingsController.close();
    assert.equal(settingsRoute(location.search), null);
    assert.equal(new URL(location.href).searchParams.get("run"), "abc");
  } finally {
    stop();
    settingsController.close();
    if (before) Object.defineProperty(globalThis, "window", before);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
