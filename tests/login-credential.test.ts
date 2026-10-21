import assert from "node:assert/strict";
import test from "node:test";
import { clearLoginCredential, isWebLoginTicket } from "../src/web-ui/login-credential.js";
import { readFileSync } from "node:fs";

test("the shared password field recognizes only the complete issued ticket format", () => {
  assert.equal(isWebLoginTicket(`wlt_${"a".repeat(43)}`), true);
  assert.equal(isWebLoginTicket(`wlt_${"A0_-".repeat(10)}abc`), true);
  for (const password of ["", "password", "一次性票据", "wlt_short", `wlp_${"a".repeat(43)}`, `wlt_${"a".repeat(42)}`, `wlt_${"a".repeat(44)}`, ` wlt_${"a".repeat(43)}`, `wlt_${"a".repeat(43)}\n`]) {
    assert.equal(isWebLoginTicket(password), false);
  }
});

test("one input routes password/ticket without fallback and clears tickets even on unknown delivery", async () => {
  // 登录协议是唯一真源（独立登录页与会话内重新登录共用），所以直接跑协议本身：
  // 它不碰 DOM、不读全局 state，比在 vm 里拼一份 handler 更能证明真实行为。
  const { submitLoginCredential } = await import("../src/web-ui/browser/login-protocol.js");
  const ticket = `wlt_${"a".repeat(43)}`;
  const originalFetch = globalThis.fetch;
  try {
    for (const value of ["normal-password", "wlt_short", ticket]) {
      for (const outcome of ["success", "rejected", "unknown"]) {
        const calls: Array<{ url: string; body?: string }> = [];
        globalThis.fetch = (async (url: string, options?: { body: string }) => {
          calls.push({ url: String(url), body: options?.body });
          if (calls.length === 1 && outcome === "unknown") throw new Error("fixture transport failure");
          return {
            ok: outcome !== "rejected",
            status: outcome === "rejected" ? 401 : 200,
            json: async () => outcome === "rejected" ? { error: "fixture refusal" } : {},
          } as unknown as Response;
        }) as typeof fetch;
        const result = await submitLoginCredential(value);
        const isTicket = value === ticket;
        assert.equal(calls[0]!.url, isTicket ? "/api/login/ticket" : "/api/login");
        assert.deepEqual(JSON.parse(calls[0]!.body!), isTicket ? { ticket: value } : { password: value });
        assert.equal(calls.length, outcome === "success" ? 2 : 1, "failures never fall back or replay credentials");
        assert.equal(result.ok, outcome === "success");
        if (isTicket && outcome === "unknown") {
          assert.equal(result.ok, false);
          assert.equal(result.ok === false && result.kind, "unknown", "a ticket is never replayed");
          assert.match(result.ok === false ? result.message : "", /不要重复提交|结果未确认/);
        }
        if (outcome === "rejected" && !isTicket) {
          assert.equal(result.ok === false && result.credentialInvalid, true, "password refusal marks the field");
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the anonymous login entry is a separate lightweight bundle and clears tickets in the DOM", async () => {
  const { clearSubmittedCredential } = await import("../src/web-ui/browser/login-protocol.js");
  const { readFileSync } = await import("node:fs");
  const entry = readFileSync(new URL("../src/web-ui/browser/login-main.ts", import.meta.url), "utf8");
  // 登录页不得引入控制台图形栈，否则匿名访客仍要下载整份 runtime。
  assert.doesNotMatch(entry, /from "react"|from "antd"|@ant-design/, "登录入口不能拉入 React/AntD");
  assert.match(entry, /submitLoginCredential/, "登录页复用同一份登录协议");
  assert.match(readFileSync(new URL("../src/web-ui/browser/session-engine.ts", import.meta.url), "utf8"),
    /submitLoginCredential/, "会话内重新登录也走同一份协议");
  const original = Object.getOwnPropertyDescriptor(globalThis, "HTMLInputElement");
  class FixtureInput { value = ""; dispatchEvent() { return true; } }
  Object.defineProperty(globalThis, "HTMLInputElement", { value: FixtureInput, configurable: true });
  try {
    const input = new FixtureInput() as unknown as HTMLInputElement;
    input.value = `wlt_${"a".repeat(43)}`;
    clearSubmittedCredential(input, `wlt_${"a".repeat(43)}`);
    assert.equal(input.value, "", "a submitted ticket never stays in the DOM");
    const passwordInput = new FixtureInput() as unknown as HTMLInputElement;
    passwordInput.value = "ordinary-password";
    clearSubmittedCredential(passwordInput, "ordinary-password");
    assert.equal(passwordInput.value, "ordinary-password", "a password is not treated as a ticket");
  } finally {
    if (original) Object.defineProperty(globalThis, "HTMLInputElement", original);
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
