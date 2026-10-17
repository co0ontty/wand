import assert from "node:assert/strict";
import test from "node:test";
import { clearLoginCredential, isWebLoginTicket } from "../src/web-ui/login-credential.js";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

test("the shared password field recognizes only the complete issued ticket format", () => {
  assert.equal(isWebLoginTicket(`wlt_${"a".repeat(43)}`), true);
  assert.equal(isWebLoginTicket(`wlt_${"A0_-".repeat(10)}abc`), true);
  for (const password of ["", "password", "一次性票据", "wlt_short", `wlp_${"a".repeat(43)}`, `wlt_${"a".repeat(42)}`, `wlt_${"a".repeat(44)}`, ` wlt_${"a".repeat(43)}`, `wlt_${"a".repeat(43)}\n`]) {
    assert.equal(isWebLoginTicket(password), false);
  }
});

test("one input routes password/ticket without fallback and clears tickets even on unknown delivery", async () => {
  const source = readFileSync(new URL("../src/web-ui/browser/session-engine.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function login()");
  const end = source.indexOf("export function hasNativeSwitchServer()", start);
  assert.ok(start >= 0 && end > start);
  // Execute the production handler without booting the unrelated terminal graph.
  const handler = transformSync(source.slice(start, end).replace("export function", "function")
    .replace('fetch(ticketMode ?', 'return fetch(ticketMode ?'), { loader: "ts" }).code;
  const ticket = `wlt_${"a".repeat(43)}`;
  for (const value of ["normal-password", "wlt_short", ticket]) {
    for (const outcome of ["success", "rejected", "unknown"]) {
      const field = { value, dataset: {} as Record<string, string>, setAttribute() {} };
      const button = { disabled: false, textContent: "进入控制台" };
      const error = {};
      const state = { loginPending: false, loginLockUntil: 0 };
      const calls: Array<{ url: string; body?: string }> = [];
      const messages: string[] = [];
      const execute = runInNewContext(handler + "\nlogin", {
        document: { getElementById: (id: string) => ({ password: field, "login-button": button, "login-error": error })[id] },
        state, isWebLoginTicket, clearLoginCredential: () => { field.value = ""; },
        hideError() {}, hideLoginCertHint() {}, scheduleLoginLockTick() {},
        showError: (_: unknown, message: string) => messages.push(message),
        fetch: async (url: string, options?: { body: string }) => {
          calls.push({ url, body: options?.body });
          if (calls.length === 1 && outcome === "unknown") throw new Error("fixture transport failure");
          return { ok: outcome !== "rejected", status: outcome === "rejected" ? 401 : 200,
            json: async () => outcome === "rejected" ? { error: "fixture refusal" } : {} };
        },
        location: { protocol: "http:" }, console: { error() {} },
        applyConfigDefaultThinking() {}, refreshAll: async () => {}, startPolling() {}, render() {},
      }) as () => Promise<void>;
      const pending = execute();
      assert.equal(state.loginPending, true);
      assert.equal(execute(), undefined, "pending attempt must not submit twice");
      const isTicket = value === ticket;
      assert.equal(field.value, isTicket ? "" : value, "ticket is cleared before the request settles");
      await pending;
      assert.equal(calls[0].url, isTicket ? "/api/login/ticket" : "/api/login");
      assert.deepEqual(JSON.parse(calls[0].body!), isTicket ? { ticket: value } : { password: value });
      assert.equal(calls.length, outcome === "success" ? 2 : 1, "failures never fall back or replay credentials");
      assert.equal(state.loginPending, false);
      assert.equal(button.disabled, false);
      assert.equal(messages.length, outcome === "success" ? 0 : 1);
      if (isTicket && outcome === "unknown") assert.match(messages[0], /不要重复提交/);
    }
  }
});

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
