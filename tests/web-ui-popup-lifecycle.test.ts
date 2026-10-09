import assert from "node:assert/strict";
import test from "node:test";
import { registerPopupDismiss } from "../src/web-ui/react/ui/popup-lifecycle.ts";

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
