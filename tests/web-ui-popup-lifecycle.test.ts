import assert from "node:assert/strict";
import test from "node:test";
import { hasOpenOwnedPopupSurface, registerPopupDismiss, registerPopupOwner } from "../src/web-ui/react/ui/popup-lifecycle.ts";

function withPopupEnvironment(run: (document: EventTarget, window: EventTarget) => void): void {
  const descriptors = ["document", "window"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const document = new EventTarget();
  const window = new EventTarget();
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  try { run(document, window); }
  finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function escape(document: EventTarget, composing = false): Event {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperties(event, { key: { value: "Escape" }, isComposing: { value: composing } });
  document.dispatchEvent(event);
  return event;
}

test("visible popup ownership follows only registered ancestors and excludes retired/unrelated surfaces", () => {
  const descriptors = ["document", "Element", "getComputedStyle"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  class Popup {
    constructor(readonly owner: string, readonly visible = true, readonly hidden = false) {}
    closest() { return this; }
    getAttribute() { return this.owner; }
    getClientRects() { return this.visible ? [{}] : []; }
  }
  let surfaces = [new Popup("child")];
  Object.defineProperty(globalThis, "Element", { configurable: true, value: Popup });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelectorAll: () => surfaces } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: (element: Popup) => ({ visibility: element.hidden ? "hidden" : "visible" }) });
  const child = registerPopupOwner("child", "parent");
  const parent = registerPopupOwner("parent", "composer");
  const cycleA = registerPopupOwner("cycle-a", "cycle-b");
  const cycleB = registerPopupOwner("cycle-b", "cycle-a");
  try {
    assert.equal(hasOpenOwnedPopupSurface(["composer"]), true, "registered descendants retain the parent focus lease");
    assert.equal(hasOpenOwnedPopupSurface(["unrelated"]), false);
    assert.equal(hasOpenOwnedPopupSurface([]), false);
    surfaces = [new Popup("child", false), new Popup("composer", true, true), new Popup("unrelated")];
    assert.equal(hasOpenOwnedPopupSurface(["composer"]), false, "hidden/unmounted owners cannot block closing forever");
    assert.equal(hasOpenOwnedPopupSurface(["unrelated"]), true);
    surfaces = [new Popup("cycle-a")];
    assert.equal(hasOpenOwnedPopupSurface(["composer"]), false, "malformed ownership cycles terminate safely");
    child(); surfaces = [new Popup("child")];
    assert.equal(hasOpenOwnedPopupSurface(["composer"]), false, "released ownership is not inherited");
  } finally {
    child(); parent(); cycleA(); cycleB();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("ordinary popup leases preserve nested order and yield composing Escape", () => {
  withPopupEnvironment((document) => {
    const events: string[] = [];
    const parent = registerPopupDismiss(() => events.push("parent"));
    const child = registerPopupDismiss(() => events.push("child"));
    try {
      assert.equal(escape(document, true).defaultPrevented, false);
      assert.deepEqual(events, []);
      assert.equal(escape(document).defaultPrevented, true);
      assert.deepEqual(events, ["child"]);
      child();
      escape(document);
      assert.deepEqual(events, ["child", "parent"]);
    } finally { child(); parent(); }
    assert.equal(escape(document).defaultPrevented, false, "final lease removes the shared keyboard listener");
  });
});

test("a blocking recovery lease retains Escape/back when ordinary dialogs mount later", () => {
  withPopupEnvironment((document, window) => {
    const events: string[] = [];
    const parent = registerPopupDismiss(() => events.push("parent"));
    const blocker = registerPopupDismiss(() => events.push("recovery"), "blocking");
    const late = registerPopupDismiss(() => events.push("late-dialog"));
    try {
      escape(document);
      window.dispatchEvent(new Event("popstate"));
      assert.deepEqual(events, ["recovery", "recovery"]);
      blocker();
      escape(document);
      assert.deepEqual(events, ["recovery", "recovery", "late-dialog"]);
      late();
      escape(document);
      assert.deepEqual(events, ["recovery", "recovery", "late-dialog", "parent"]);
    } finally { late(); blocker(); parent(); }
  });
});
