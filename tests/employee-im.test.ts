import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";
import { WandStorage } from "../src/storage.js";
import { vaultKeyPath } from "../src/storage/vault-keys.js";
import { emptyEmployeeImConfig, type EmployeeImConfigInput } from "../src/employee-im-types.js";
import { EmployeeImService } from "../src/employee-im.js";
import { registerEmployeeImRoutes } from "../src/server-employee-im-routes.js";
import { requireAdmin } from "../src/middleware/auth.js";
import { BROWSER_ADMIN_PRINCIPAL, CONNECTED_APP_PRINCIPAL } from "../src/auth.js";

// Explicit non-working fixture credentials. No test may call a real IM endpoint.
const token = `123456:${"x".repeat(30)}`;
const webhook = `https://oapi.dingtalk.com/robot/send?access_token=${"a".repeat(64)}`;
const config = (): EmployeeImConfigInput => ({ events: ["task_started", "task_completed", "task_failed"],
  telegram: { enabled: true, botToken: token, chatId: "-1234" },
  dingtalk: { enabled: true, webhook, secret: "SEC_fixture_only" } });
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "wand-im-")), path = join(root, "wand.db");
  const storage = new WandStorage(path);
  const employee = storage.ensureDefaultSiliconEmployee();
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  return { storage, employee, root, path };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test("IM settings are opt-in, isolated, encrypted and survive reopen without leaking employee DTOs", t => {
  const { storage, employee, path } = fixture(t);
  assert.deepEqual(storage.getEmployeeImConfig(employee.id), emptyEmployeeImConfig());
  const saved = storage.saveEmployeeImConfig(employee.id, config());
  assert.equal(saved.telegram.botTokenConfigured, true);
  assert.equal(saved.dingtalk.webhookConfigured, true);
  assert.equal(saved.dingtalk.secretConfigured, true);
  assert.equal(JSON.stringify(saved).includes(token), false);
  assert.equal(JSON.stringify(storage.getSiliconEmployee(employee.id)).includes("botToken"), false);
  const ops = storage.ensureSystemSiliconEmployee();
  assert.equal(storage.getEmployeeImConfig(ops.id).telegram.enabled, false);
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT credentials FROM employee_im_settings WHERE employee_id = ?").get(employee.id) as { credentials: string };
  db.close();
  assert.match(row.credentials, /^enc:v2:/);
  assert.equal(row.credentials.includes(token), false);
  assert.equal(row.credentials.includes(webhook), false);
  const second = new WandStorage(path);
  assert.equal(second.getEmployeeImSettings(employee.id).credentials.botToken, token);
  assert.deepEqual(second.getEmployeeImConfig(employee.id), saved);
  second.close();
});

test("older per-channel draft settings project to one common event set without GET writes", t => {
  const { storage, employee, path } = fixture(t);
  storage.saveEmployeeImConfig(employee.id, config());
  const db = new DatabaseSync(path);
  db.prepare("UPDATE employee_im_settings SET config_json = ? WHERE employee_id = ?").run(JSON.stringify({
    telegram: { enabled: true, chatId: "-1234", botTokenConfigured: true, events: ["task_started"] },
    dingtalk: { enabled: true, webhookConfigured: true, secretConfigured: true, events: ["task_failed", "task_started"] },
  }), employee.id);
  const before = db.prepare("SELECT config_json FROM employee_im_settings").get();
  const projected = storage.getEmployeeImConfig(employee.id);
  assert.deepEqual(projected.events, ["task_started", "task_failed"]);
  assert.equal("events" in projected.telegram, false); assert.equal("events" in projected.dingtalk, false);
  assert.deepEqual(db.prepare("SELECT config_json FROM employee_im_settings").get(), before);
  db.close();
  assert.equal(storage.getEmployeeImSettings(employee.id).credentials.botToken, token);
});

test("blank/omitted credentials preserve, explicit null clears, disabled channels keep credentials", t => {
  const { storage, employee } = fixture(t);
  storage.saveEmployeeImConfig(employee.id, config());
  const input = config(); delete input.telegram.botToken; input.dingtalk.webhook = ""; delete input.dingtalk.secret;
  input.telegram.enabled = false;
  storage.saveEmployeeImConfig(employee.id, input);
  assert.equal(storage.getEmployeeImSettings(employee.id).credentials.botToken, token);
  input.telegram.botToken = null; input.dingtalk.enabled = false; input.dingtalk.webhook = null; input.dingtalk.secret = null;
  const cleared = storage.saveEmployeeImConfig(employee.id, input);
  assert.equal(cleared.telegram.botTokenConfigured, false);
  assert.equal(cleared.dingtalk.webhookConfigured, false);
  assert.deepEqual(storage.getEmployeeImSettings(employee.id).credentials, {});
  assert.throws(() => storage.saveEmployeeImConfig("not-found", input), /不存在/);
});

test("configuration rejects unknown events, malformed credentials and arbitrary URLs atomically", t => {
  const { storage, employee } = fixture(t);
  for (const patch of [
    { events: ["unknown"] },
    { telegram: { ...config().telegram, botToken: "secret/path?bad" } },
    { telegram: { ...config().telegram, chatId: "invalid id" } },
    { dingtalk: { ...config().dingtalk, webhook: "http://127.0.0.1:123/robot/send?access_token=anything" } },
    ...["https://evil.invalid/robot/send?access_token=abcdefgh", "https://oapi.dingtalk.com.evil.invalid/robot/send?access_token=abcdefgh", "https://oapi.dingtalk.com/robot/send?access_token=abcdefgh&access_token=duplicate", "https://oapi.dingtalk.com:444/robot/send?access_token=abcdefgh", "https://a@oapi.dingtalk.com/robot/send?access_token=abcdefgh", "https://oapi.dingtalk.com/robot/send?access_token=abcdefgh&sign=untrusted"].map(webhook => ({ dingtalk: { ...config().dingtalk, webhook } })),
  ]) {
    assert.throws(() => storage.saveEmployeeImConfig(employee.id, { ...config(), ...patch }));
    assert.deepEqual(storage.getEmployeeImConfig(employee.id), emptyEmployeeImConfig());
  }
});

test("IM-only encrypted rows guard against recreating a missing master key", t => {
  const { storage, employee, path } = fixture(t);
  storage.saveEmployeeImConfig(employee.id, config());
  storage.close(); unlinkSync(vaultKeyPath(path));
  const reopened = new WandStorage(path);
  try {
    assert.equal(existsSync(vaultKeyPath(path)), false);
    assert.equal(reopened.getEmployeeImConfig(employee.id).telegram.botTokenConfigured, true);
    assert.throws(() => reopened.getEmployeeImSettings(employee.id), /key file is missing/);
    assert.throws(() => reopened.saveEmployeeImConfig(employee.id, config()), /key file is missing/);
    assert.equal(existsSync(vaultKeyPath(path)), false);
  } finally { reopened.close(); }
});

test("shared selected events fan out to every enabled employee channel; provider payload/signature and test semantics", async t => {
  const { storage, employee } = fixture(t);
  storage.saveEmployeeImConfig(employee.id, config());
  const calls: { url: URL; body: Record<string, unknown>; redirect: string | undefined }[] = [];
  const im = new EmployeeImService(storage, { now: () => 1234567890, fetch: (async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, body: JSON.parse(String(init?.body)), redirect: init?.redirect });
    return Response.json(url.hostname === "api.telegram.org" ? { ok: true } : { errcode: 0 });
  }) as typeof fetch });
  t.after(() => im.dispose());
  im.notify(employee.id, "task_started", { sessionId: "s_1", title: "测试任务" });
  im.notify(employee.id, "task_stopped");
  im.notify(storage.ensureSystemSiliconEmployee().id, "task_started");
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.hostname, "oapi.dingtalk.com");
  assert.equal(calls[0].url.hostname, "api.telegram.org");
  assert.equal(calls[0].body.chat_id, "-1234");
  assert.match(String(calls[0].body.text), /开始处理任务.*\n员工：.*\n任务：测试任务/);
  assert.equal(calls[0].redirect, "error");
  im.notify(employee.id, "task_failed"); await settle();
  assert.equal(calls.length, 4);
  assert.match(String(calls[2].body.text), /任务失败/);
  assert.match(JSON.stringify(calls[3].body.text), /任务失败/);
  assert.equal(calls[1].body.msgtype, "text");
  assert.equal(calls[1].url.searchParams.get("timestamp"), "1234567890");
  assert.equal(calls[1].url.searchParams.get("sign"), createHmac("sha256", "SEC_fixture_only").update("1234567890\nSEC_fixture_only").digest("base64"));
  const single = config(); single.dingtalk.enabled = false;
  storage.saveEmployeeImConfig(employee.id, single); im.notify(employee.id, "task_completed"); await settle();
  assert.equal(calls.length, 5); assert.equal(calls[4].url.hostname, "api.telegram.org");
  single.telegram.enabled = false; single.dingtalk.enabled = true;
  storage.saveEmployeeImConfig(employee.id, single); im.notify(employee.id, "task_completed"); await settle();
  assert.equal(calls.length, 6); assert.equal(calls[5].url.hostname, "oapi.dingtalk.com");
  const disabled = config(); disabled.telegram.enabled = false; disabled.dingtalk.enabled = false;
  storage.saveEmployeeImConfig(employee.id, disabled);
  im.notify(employee.id, "task_started"); await settle(); assert.equal(calls.length, 6);
  await im.test(employee.id, "telegram"); assert.equal(calls.length, 7);
});

test("delivery failure is sanitized, queue is bounded, disabled queued events are discarded, dispose aborts", async t => {
  const { storage, employee } = fixture(t);
  storage.saveEmployeeImConfig(employee.id, config());
  let calls = 0, failures = 0;
  const im = new EmployeeImService(storage, { onFailure: () => { failures += 1; }, fetch: (async (_input, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error(token)), { once: true }));
  }) as typeof fetch });
  for (let i = 0; i < 500; i++) im.notify(employee.id, "task_started");
  assert.equal(calls, 4); assert.ok(failures > 0);
  await assert.rejects(im.test(employee.id, "telegram"), /繁忙/);
  im.dispose(); await settle(); assert.equal(calls, 4);
  const fail = new EmployeeImService(storage, { fetch: (async () => { throw new Error(token); }) as typeof fetch });
  await assert.rejects(fail.test(employee.id, "telegram"), error => error instanceof Error && !error.message.includes(token));
  fail.dispose();
});

test("a queued notice is discarded when the employee disables the channel before delivery", async t => {
  const { storage, employee } = fixture(t);
  const telegramOnly = config(); telegramOnly.dingtalk.enabled = false; storage.saveEmployeeImConfig(employee.id, telegramOnly);
  let calls = 0;
  const releases: Array<() => void> = [];
  const im = new EmployeeImService(storage, { fetch: (async () => {
    calls += 1; return new Promise<Response>(resolve => { releases.push(() => resolve(Response.json({ ok: true }))); });
  }) as typeof fetch });
  for (let i = 0; i < 5; i++) im.notify(employee.id, "task_started");
  assert.equal(calls, 4);
  const disabled = config(); disabled.telegram.enabled = false; disabled.dingtalk.enabled = false; storage.saveEmployeeImConfig(employee.id, disabled);
  releases.forEach(release => release()); await settle();
  assert.equal(calls, 4); im.dispose();
});

test("timeouts and oversized/provider-rejected replies are bounded and never expose bodies", async t => {
  const { storage, employee } = fixture(t); storage.saveEmployeeImConfig(employee.id, config());
  for (const response of [Response.json({ ok: false, description: token }), new Response(token, { status: 302, headers: { Location: "http://127.0.0.1" } }), new Response("x".repeat(17000)), new Response("not-json")]) {
    const im = new EmployeeImService(storage, { fetch: (async () => response) as typeof fetch });
    await assert.rejects(im.test(employee.id, "telegram"), error => error instanceof Error && !error.message.includes(token)); im.dispose();
  }
  const timeout = new EmployeeImService(storage, { timeoutMs: 10, fetch: (async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })) as typeof fetch });
  // Keep the test process alive while the production timeout remains unref'ed.
  const keepAlive = setTimeout(() => {}, 200);
  await assert.rejects(timeout.test(employee.id, "telegram"), /未确认/); clearTimeout(keepAlive); timeout.dispose();
});

test("IM API requires admin for reads/writes/tests, accepts built-ins, and never returns credentials", async t => {
  const { storage, employee } = fixture(t);
  const im = new EmployeeImService(storage, { fetch: (async () => Response.json({ ok: true })) as typeof fetch });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.principal = req.headers["x-test-admin"] === "yes" ? BROWSER_ADMIN_PRINCIPAL : CONNECTED_APP_PRINCIPAL; next(); });
  registerEmployeeImRoutes(app, { storage, im, requireAdmin });
  const server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { im.dispose(); server.close(); server.closeAllConnections(); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, path = `${origin}/api/silicon-employees/${employee.id}/im`;
  for (const [method, suffix] of [["GET", ""], ["PUT", ""], ["POST", "/test"]]) assert.equal((await fetch(path + suffix, { method })).status, 403);
  const headers = { "x-test-admin": "yes", "Content-Type": "application/json" };
  const saved = await fetch(path, { method: "PUT", headers, body: JSON.stringify(config()) });
  assert.equal(saved.status, 200); assert.equal(saved.headers.get("cache-control"), "no-store");
  const output = await saved.text(); assert.equal(output.includes(token), false); assert.equal(output.includes(webhook), false);
  assert.equal((await fetch(path, { headers })).status, 200);
  assert.equal((await fetch(path + "/test", { method: "POST", headers, body: JSON.stringify({ provider: "telegram" }) })).status, 200);
  assert.equal((await fetch(path + "/test", { method: "POST", headers, body: JSON.stringify({ provider: "other" }) })).status, 400);
  assert.equal((await fetch(`${origin}/api/silicon-employees/missing/im`, { headers })).status, 404);
});
