import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import express from "express";
import { createFeedbackReport, decryptFeedback, DEFAULT_FEEDBACK_URL, encryptFeedback, FeedbackReceiver, FeedbackReporter, validateFeedbackReport } from "../src/feedback.js";
import { registerFeedbackAdminRoutes, registerFeedbackIngress } from "../src/server-feedback-routes.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-feedback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keyFile = path.join(root, "private.pem");
  writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return { root, keyFile, receiver: new FeedbackReceiver(root, keyFile) };
}
const report = () => createFeedbackReport("update_failed", "4.99.0-beta.1", Object.assign(new Error("secret error, token=DO-NOT-SEND /Users/private/chat"), { code: "ENOSPC" }));

function reportFiles(root: string): string[] {
  const outbox = path.join(root, "feedback-outbox");
  let scopes: string[];
  try { scopes = readdirSync(outbox); } catch { return []; }
  return scopes.flatMap(scope => readdirSync(path.join(outbox, scope)).filter(name => name.endsWith(".json")).map(name => path.join(outbox, scope, name)));
}

test("feedback preserves raw diagnostic text but serializes no arbitrary properties or credentials", () => {
  const error = Object.assign(new Error("Bearer secret, password=hello"), { code: "my-secret-token", config: { password: "secret" } });
  error.name = "secret-user-name";
  error.stack = `Error: token\n    at token (${fileURLToPath(new URL("../src/server.ts", import.meta.url))}:24:7)\n    at token (/Users/private/workspace/chat.ts:2:1)`;
  const r = createFeedbackReport("http_5xx", "4.99.0", error);
  assert.equal(r.error.name, "Error"); assert.equal(r.error.code, "UNKNOWN");
  assert.deepEqual(r.error.frames, ["server.ts:24:7"]);
  assert.equal(r.error.message, "Bearer [REDACTED], password=[REDACTED]");
  assert.equal(r.error.stack, error.stack, "original diagnostic stack, including paths, is retained");
  assert.doesNotMatch(JSON.stringify(r), /Bearer secret|password=hello|my-secret-token/);
  assert.equal(validateFeedbackReport(r), r);
  assert.throws(() => validateFeedbackReport({ ...r, message: "extra" }));
  assert.throws(() => validateFeedbackReport({ ...r, error: { ...r.error, token: "extra" } }));
  assert.throws(() => validateFeedbackReport({ ...r, id: "../../outside" }));
  assert.throws(() => validateFeedbackReport({ ...r, event: "arbitrary user text" }));
  assert.throws(() => validateFeedbackReport({ ...r, error: { ...r.error, frames: ["/Users/alice/chat.ts:1:1"] } }));
});

test("hybrid encryption is randomized, authenticated, and only the collection private key decrypts", () => {
  const r = report();
  const a = encryptFeedback(r, keys.publicKey), b = encryptFeedback(r, keys.publicKey);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.deepEqual(decryptFeedback(a, keys.privateKey), r);
  assert.doesNotMatch(JSON.stringify(a), /ENOSPC|update_failed|DO-NOT-SEND/);
  assert.throws(() => decryptFeedback({ ...a, keyId: "0".repeat(64) }, keys.privateKey));
  const ciphertext = Buffer.from(a.ciphertext, "base64"); ciphertext[0] = ciphertext[0]! ^ 1;
  assert.throws(() => decryptFeedback({ ...a, ciphertext: ciphertext.toString("base64") }, keys.privateKey));
  assert.throws(() => decryptFeedback({ ...a, iv: "AAAA" }, keys.privateKey));
  assert.throws(() => decryptFeedback({ ...a, ciphertext: "A".repeat(10000) }, keys.privateKey));
  assert.throws(() => decryptFeedback({ ...a, extra: "field" }, keys.privateKey));
  assert.throws(() => encryptFeedback(r, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey));
});

test("receiver persists ciphertext only, deduplicates retries, and exposes owner-only files", t => {
  const { root, receiver } = fixture(t);
  const envelope = encryptFeedback(report(), keys.publicKey);
  assert.equal(receiver.accept(envelope), "stored");
  assert.equal(receiver.accept(envelope), "duplicate");
  assert.equal(readdirSync(receiver.dir).length, 1);
  const file = path.join(receiver.dir, readdirSync(receiver.dir)[0]!);
  assert.doesNotMatch(readFileSync(file, "utf8"), /update_failed|ENOSPC|DO-NOT-SEND/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(receiver.dir).mode & 0o777, 0o700);
  assert.equal(receiver.latest()[0]!.report.event, "update_failed");
  assert.deepEqual(createPublicKey((receiver.publicInfo() as { publicKey: string }).publicKey).export({ format: "der", type: "spki" }), keys.publicKey.export({ format: "der", type: "spki" }));
  assert.equal(readdirSync(root).includes("feedback-inbox"), true);
});

test("receiver refuses insecure key permissions and stops at its storage quota without deleting reports", t => {
  const { receiver, root } = fixture(t);
  const insecure = path.join(root, "insecure.pem");
  writeFileSync(insecure, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o644 });
  assert.throws(() => new FeedbackReceiver(root, insecure), /owner-only/);
  for (let i = 0; i < 2000; i++) writeFileSync(path.join(receiver.dir, `${randomUUID()}.json`), "{}", { mode: 0o600 });
  assert.equal(receiver.accept(encryptFeedback(report(), keys.publicKey)), "full");
  assert.equal(readdirSync(receiver.dir).length, 2000);
});

test("reporter defaults to HTTPS, persists encrypted retry outbox and resumes with stable ids", async t => {
  const { root, receiver } = fixture(t);
  let online = false;
  const bodies: string[] = [], urls: string[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input); urls.push(url);
    assert.equal(init?.redirect, "error");
    if (url.endsWith("/key")) return Response.json(receiver.publicInfo());
    const body = String(init?.body); bodies.push(body);
    if (!online) throw new Error("network down");
    receiver.accept(JSON.parse(body));
    return Response.json({ accepted: true }, { status: 202 });
  };
  const options = { configDir: root, version: "4.99.0", env: {}, fetch: mockFetch };
  const first = new FeedbackReporter(options);
  first.capture("update_failed", Object.assign(new Error("never-send-this"), { code: "ENOSPC" }));
  await first.flush(); first.stop();
  assert.equal(urls[0], `${DEFAULT_FEEDBACK_URL}/api/feedback/key`);
  assert.equal(reportFiles(root).length, 1);
  assert.doesNotMatch(readFileSync(reportFiles(root)[0]!, "utf8"), /never-send-this|update_failed/);
  online = true;
  const resumed = new FeedbackReporter(options);
  await resumed.flush(); resumed.stop();
  assert.equal(reportFiles(root).length, 0);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(receiver.latest().length, 1);
});

test("fatal capture is synchronously encrypted using the cached public key, without changing exit semantics", async t => {
  const { root, receiver } = fixture(t);
  const warmup = new FeedbackReporter({ configDir: root, version: "4.99.0", env: {}, fetch: async () => Response.json(receiver.publicInfo()) });
  await warmup.flush(); warmup.stop();
  const fatal = new FeedbackReporter({ configDir: root, version: "4.99.0", env: {}, fetch: async () => { throw new Error("offline"); } });
  fatal.capture("uncaught_exception", new TypeError("private data"));
  // No await: process.exit can happen immediately after capture.
  assert.equal(reportFiles(root).length, 1);
  assert.equal(decryptFeedback(JSON.parse(readFileSync(reportFiles(root)[0]!, "utf8")), keys.privateKey).event, "uncaught_exception");
  fatal.stop(); await fatal.flush();
});

test("reporting is deduplicated, bounded, disabled in tests/opt-out, and errors never recurse", async t => {
  const { root, receiver } = fixture(t);
  let posts = 0;
  const reporter = new FeedbackReporter({ configDir: root, version: "4.99.0", env: {}, fetch: async (url) => {
    if (String(url).endsWith("/key")) return Response.json(receiver.publicInfo());
    posts++; return new Response(null, { status: 503 });
  } });
  for (let i = 0; i < 200; i++) reporter.capture("update_failed", new Error(`secret ${i}`));
  await reporter.flush();
  assert.equal(posts, 1); assert.equal(reportFiles(root).length, 1);
  await reporter.flush(); assert.equal(posts, 1, "backoff prevents immediate network retry");
  reporter.stop();
  for (const env of [{ WAND_TEST_MODE: "1" }, { WAND_FEEDBACK_ENABLED: "0" }, { WAND_FEEDBACK_URL: "http://unsafe.invalid" }]) {
    const disabled = new FeedbackReporter({ configDir: root, version: "4.99.0", env, fetch: async () => { assert.fail("disabled feedback must not send"); } });
    disabled.start(); disabled.capture("http_5xx"); await disabled.flush(); disabled.stop();
  }
});

test("public key bootstrap is size bounded and cannot downgrade to plaintext or upload after failure", async t => {
  const { root } = fixture(t);
  for (const response of [new Response("A".repeat(9000)), Response.json({ schema: 1, publicKey: "invalid" }), new Response(null, { status: 401 })]) {
    let calls = 0;
    const reporter = new FeedbackReporter({ configDir: root, version: "4.99.0", env: {}, fetch: async () => { calls++; return response; } });
    reporter.capture("update_failed", new Error("secret")); await reporter.flush(); reporter.stop();
    assert.equal(calls, 1); assert.equal(reportFiles(root).length, 0);
  }
});

test("ingress validates ciphertext, limits body/CPU, and admin readback stays authenticated", async t => {
  const { receiver } = fixture(t);
  const app = express();
  registerFeedbackIngress(app, receiver);
  app.use("/api", (req, res, next) => { if (req.headers["x-test-auth"] !== "yes") res.sendStatus(401); else next(); });
  registerFeedbackAdminRoutes(app, receiver, (req, res, next) => { if (req.headers["x-test-admin"] !== "yes") res.sendStatus(403); else next(); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await fetch(`${base}/api/feedback/key`)).status, 200);
  const post = (value: unknown) => fetch(`${base}/api/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await post(report())).status, 400);
  assert.equal((await post({ ciphertext: "a".repeat(70000) })).status, 413);
  const envelope = encryptFeedback(report(), keys.publicKey);
  assert.equal((await post(envelope)).status, 202);
  assert.equal((await post(envelope)).status, 202);
  assert.equal((await fetch(`${base}/api/feedback/reports`)).status, 401);
  assert.equal((await fetch(`${base}/api/feedback/reports`, { headers: { "x-test-auth": "yes" } })).status, 403);
  const admin = await fetch(`${base}/api/feedback/reports`, { headers: { "x-test-auth": "yes", "x-test-admin": "yes" } });
  assert.equal(admin.status, 200); assert.equal(admin.headers.get("cache-control"), "no-store");
  assert.equal(((await admin.json()) as { reports: unknown[] }).reports.length, 1);
  for (let i = 0; i < 27; i++) await post(envelope);
  assert.equal((await post(envelope)).status, 429);
});

test("disabled receiver exposes neither key nor encrypted ingestion", async t => {
  const app = express(); registerFeedbackIngress(app, null);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await fetch(`${base}/api/feedback/key`)).status, 404);
  assert.equal((await fetch(`${base}/api/feedback`, { method: "POST" })).status, 404);
});

test("server hooks cover explicit failures without replacing existing lifecycle and the helper survives promotion", () => {
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  for (const event of ["uncaught_exception", "unhandled_rejection", "http_5xx", "daemon_update_failed", "websocket_error", "provider_update_failed", "startup_failed"]) assert.ok(server.includes(`capture("${event}"`));
  assert.ok(server.indexOf("registerFeedbackIngress(app,") < server.indexOf('app.use(express.json('));
  const helper = readFileSync(new URL("../src/update-helper.ts", import.meta.url), "utf8");
  assert.match(helper, /feedback\.mjs/);
  assert.match(helper, /reporter\.capture\("update_failed", new Error\(message\)\)/);
  assert.match(helper, /setTimeout\(\(\) => reporter.stop\(\), 5000\)/);
  assert.match(helper, /"WAND_FEEDBACK_ENABLED", "WAND_FEEDBACK_URL", "WAND_TEST_MODE"/);
});
