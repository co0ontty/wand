import assert from "node:assert/strict";
import test from "node:test";
import { DingTalkAuth } from "../src/dingtalk-auth.js";
import type { DwsTransport } from "../src/dingtalk-dws.js";
const microtasks = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function transport(exchange: (args: string[], input?: string) => Promise<Record<string, unknown>>): DwsTransport {
  return { call: (args, options) => exchange(args, options?.input), stream() { return { close() {} }; } };
}
const request = async (url: string) => Buffer.from(JSON.stringify(url.endsWith("/cli/clientId")
  ? { success: true, result: "cli-fixture-app" }
  : url.includes("/device/code.json")
    ? { success: true, result: { deviceCode: "fixture-device", userCode: "fixture-visible-code", verificationUriComplete: "https://login.dingtalk.com/fixture", expiresIn: 600, interval: 2, flowId: "fixture-flow" } }
    : { success: true, data: { status: "APPROVED", authCode: "fixture-one-time-code" } }));

test("device authorization cancellation before code exchange suppresses all credential writes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let exchanges = 0;
  const auth = new DingTalkAuth(transport(async () => { exchanges++; return {}; }), request);
  t.after(() => auth.dispose());
  const first = await auth.begin();
  assert.equal(first.state, "waiting"); assert.equal((await auth.begin()).id, first.id);
  const cancelled = auth.cancel(first.id); assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.url, undefined); assert.equal(cancelled.userCode, undefined);
  t.mock.timers.tick(10000); await microtasks(); assert.equal(exchanges, 0);
});

test("an exchange already handed to DWS is reported honestly, bound to the discovered app and not falsely cancelled", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: (value: Record<string, unknown>) => void, exchanges = 0;
  const dws = transport(async (args, input) => {
    exchanges++; assert.equal(args[args.indexOf("--client-id") + 1], "cli-fixture-app");
    assert.equal(args.includes("--code-stdin"), true); assert.equal(args.includes("fixture-one-time-code"), false); assert.equal(input, "fixture-one-time-code");
    return new Promise(resolve => { release = resolve; });
  });
  const auth = new DingTalkAuth(dws, request); t.after(() => auth.dispose());
  const attempt = await auth.begin(); t.mock.timers.tick(2000); await microtasks();
  assert.equal(exchanges, 1); assert.equal(auth.get(attempt.id).state, "exchanging");
  assert.equal(auth.cancel(attempt.id).state, "exchanging", "a consumed one-time code cannot be presented as revoked");
  release({ corpId: "fixture-corp", userId: "fixture-user" }); await microtasks();
  assert.equal(auth.get(attempt.id).state, "connected"); assert.equal(auth.get(attempt.id).account?.id, "fixture-corp:fixture-user");
  assert.equal(auth.get(attempt.id).url, undefined); assert.equal(auth.get(attempt.id).userCode, undefined);
});
