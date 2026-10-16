import assert from "node:assert/strict";
import test from "node:test";
import { clearLoginCredential } from "../src/web-ui/login-credential.js";

test("credential clearing notifies React's value tracker instead of leaving a resurrectable internal value", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "HTMLInputElement");
  class NativeInput {
    native = "fixture-one-use-value";
    tracker = this.native;
    internal = this.native;
    events: string[] = [];
    get value() { return this.native; }
    set value(value: string) { this.native = value; }
    dispatchEvent(event: Event) {
      this.events.push(event.type);
      assert.equal(event.bubbles, true);
      if (this.tracker !== this.native) { this.tracker = this.native; this.internal = this.native; }
      return true;
    }
  }
  Object.defineProperty(globalThis, "HTMLInputElement", { value: NativeInput, configurable: true });
  try {
    const field = new NativeInput();
    // React installs an own-property setter that updates its tracker immediately.
    Object.defineProperty(field, "value", { get() { return this.native; }, set(value) { this.native = value; this.tracker = value; }, configurable: true });
    clearLoginCredential(field as unknown as HTMLInputElement);
    assert.equal(field.value, "");
    assert.equal(field.internal, "", "a later Ant render must not restore the submitted ticket");
    assert.deepEqual(field.events, ["input"]);
  } finally {
    if (original) Object.defineProperty(globalThis, "HTMLInputElement", original);
    else Reflect.deleteProperty(globalThis, "HTMLInputElement");
  }
});
