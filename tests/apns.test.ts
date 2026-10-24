import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, createServer as createHttp2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import express from "express";
import { ApnsClient, classifyApnsResponse, createApnsJwt, loadApnsConfiguration, type ApnsConfiguration, type ApnsMessage, type ApnsResult, type ApnsTransport } from "../src/apns-client.js";
import { ApnsService } from "../src/apns-service.js";
import { defaultConfig } from "../src/config.js";
import { registerApnsRoutes } from "../src/server-apns-routes.js";
import { generateAppToken } from "../src/server-app-connect.js";
import { SessionCompletionTracker } from "../src/session-completion.js";
import { apnsDigest } from "../src/storage/apns-repository.js";
import { WandStorage } from "../src/storage.js";
import type { SessionSnapshot } from "../src/types.js";

const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const configuration: ApnsConfiguration = { key: key.privateKey, keyId: "TESTKEY001", teamId: "TESTTEAM01", topic: "com.wand.app", environment: "production" };
const secret = "a".repeat(64), secondSecret = "b".repeat(64), deviceToken = "c".repeat(64);
const config = { ...defaultConfig(), password: "only-test-password", appSecret: "test-app-secret" };
const appToken = generateAppToken(config.password, config.appSecret);
function snapshot(): SessionSnapshot {
  return { id: "chat-A", sessionKind: "structured", provider: "pi", command: "pi", cwd: "/tmp", mode: "assist", status: "idle", exitCode: 0,
    startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:01Z", output: "private code must not be pushed", archived: false, archivedAt: null,
    claudeSessionId: null, completionRevision: 1, viewedCompletionRevision: 0,
    structuredState: { runner: "pi-cli-json", lastError: null, inFlight: false, activeRequestId: null } };
}
class Transport implements ApnsTransport {
  messages: ApnsMessage[] = [];
  results: ApnsResult[] = [];
  async send(message: ApnsMessage): Promise<ApnsResult> {
    this.messages.push(message);
    return this.results.shift() ?? { outcome: "accepted", reason: "AcceptedByAPNs" };
  }
  close(): void {}
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "wand-apns-"));
  const path = join(root, "wand.db");
  const storage = new WandStorage(path);
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  let now = 1_800_000_000_000;
  let digest = apnsDigest(appToken);
  let live: SessionSnapshot | null = snapshot();
  const transport = new Transport();
  const warnings: string[] = [];
  const service = new ApnsService(storage, configuration, transport, () => digest, () => live, m => warnings.push(m), () => now);
  const register = (capability = secret, token = deviceToken) => storage.apns.register({ secret: capability, token,
    environment: "production", topic: configuration.topic, serverId: "saved-server-A", credentialDigest: digest }, now);
  const enqueue = (kind: "completed" | "permission" = "completed", revision = "1") => storage.apns.enqueue("chat-A", kind, revision, digest, configuration.topic, configuration.environment, now);
  const rows = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return db.prepare("SELECT state, reason, attempts FROM apns_deliveries ORDER BY rowid").all() as Array<{ state: string; reason: string; attempts: number }>; }
    finally { db.close(); }
  };
  return { storage, transport, service, path, warnings, register, enqueue, rows,
    setLive(value: SessionSnapshot | null) { live = value; },
    advance(ms: number) { now += ms; }, rotate() { digest = apnsDigest("new-owner-credential"); } };
}

test("APNs configuration is opt-in, validates private key permissions, and signs ES256 JWT", t => {
  const root = mkdtempSync(join(tmpdir(), "wand-apns-key-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "auth.p8");
  writeFileSync(path, key.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  assert.equal(loadApnsConfiguration({}), null);
  assert.throws(() => loadApnsConfiguration({ WAND_APNS_KEY_ID: "TESTKEY001" }), /配置不完整/);
  const env = { WAND_APNS_KEY_PATH: path, WAND_APNS_KEY_ID: configuration.keyId, WAND_APNS_TEAM_ID: configuration.teamId, WAND_APNS_TOPIC: configuration.topic };
  assert.equal(loadApnsConfiguration(env)?.environment, "production");
  const localFile = join(root, "apns.json");
  writeFileSync(localFile, JSON.stringify({ keyPath: path, keyId: configuration.keyId, teamId: configuration.teamId,
    topic: configuration.topic, environment: "production" }), { mode: 0o600 });
  assert.equal(loadApnsConfiguration({}, root)?.topic, configuration.topic);
  assert.throws(() => loadApnsConfiguration({ WAND_APNS_KEY_ID: "TESTKEY001" }, root), /配置不完整/, "partial env cannot mix with private file");
  chmodSync(localFile, 0o644);
  assert.throws(() => loadApnsConfiguration({}, root), /apns.json/);
  chmodSync(path, 0o644);
  assert.throws(() => loadApnsConfiguration(env), /0600/);
  assert.throws(() => loadApnsConfiguration({ ...env, WAND_APNS_ENVIRONMENT: "arbitrary-host" }), /environment/);
  const jwt = createApnsJwt(configuration, 1_800_000_000_000);
  const [header, body, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "ES256", kid: configuration.keyId });
  assert.deepEqual(JSON.parse(Buffer.from(body!, "base64url").toString()), { iss: configuration.teamId, iat: 1_800_000_000 });
  assert.equal(verify("sha256", Buffer.from(`${header}.${body}`), { key: key.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url")), true);
});

test("native HTTP/2 sends Apple alert headers and bounds/normalizes the response", async t => {
  const server = createHttp2Server();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  let endpoint = "";
  const client = new ApnsClient(configuration, url => { endpoint = url; return connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); });
  t.after(() => client.close());
  server.once("stream", (stream, headers) => {
    assert.equal(headers[":path"], `/3/device/${deviceToken}`);
    assert.equal(headers["apns-topic"], configuration.topic);
    assert.equal(headers["apns-push-type"], "alert");
    assert.equal(headers["apns-priority"], "10");
    assert.match(String(headers.authorization), /^bearer ey/);
    stream.resume();
    stream.on("end", () => { stream.respond({ ":status": 410 }); stream.end(JSON.stringify({ reason: "Unregistered" })); });
  });
  const result = await client.send({ id: "00000000-0000-4000-8000-000000000001", token: deviceToken, payload: "{}", expiresAt: Date.now() + 60_000, collapseId: "stable-event" });
  assert.equal(endpoint, "https://api.push.apple.com");
  assert.deepEqual(result, { outcome: "invalid-device", reason: "Unregistered" });
  assert.equal(classifyApnsResponse(503, "ServiceUnavailable").outcome, "retry");
  assert.equal(classifyApnsResponse(403, "InvalidProviderToken").outcome, "rejected");
  assert.equal(classifyApnsResponse(403, "secret\nnot-a-reason").reason, "HTTP403");
});

test("completion facts enqueue once, preserve scoped navigation, and never include conversation content", async t => {
  const f = fixture(t); f.register();
  f.service.completed("chat-A", 1);
  await f.service.flush();
  f.service.completed("chat-A", 1);
  await f.service.flush();
  assert.equal(f.transport.messages.length, 1);
  const payload = JSON.parse(f.transport.messages[0]!.payload);
  assert.equal(payload.serverId, "saved-server-A");
  assert.equal(payload.sessionId, "chat-A");
  assert.equal(payload.kind, "completed");
  assert.match(payload.eventId, /^[a-f0-9]{64}$/);
  assert.equal(f.transport.messages[0]!.payload.includes("private code"), false);
  assert.equal(f.transport.messages[0]!.payload.includes(appToken), false);
  assert.equal(f.rows()[0]?.state, "accepted", "APNs acceptance must not be called device delivery");
});

test("pending permission is keyed by request identity, resolution cancels queued alerts", async t => {
  const f = fixture(t); f.register();
  f.setLive({ ...snapshot(), pendingEscalation: { requestId: "permission-2", reason: "sensitive command", scope: "run_command", runner: "structured", source: "tool_permission_request" } });
  f.service.ingest({ type: "status", sessionId: "chat-A", data: { permissionBlocked: true } });
  await f.service.flush();
  assert.equal(f.transport.messages.length, 1);
  assert.equal(f.transport.messages[0]!.payload.includes("sensitive command"), false);
  f.enqueue("permission", "old-permission");
  await f.service.flush();
  assert.equal(f.transport.messages.length, 1);
  assert.equal(f.rows()[1]?.state, "canceled");
});

test("persistent outbox survives restart, transient failures back off with stable APNs id", async t => {
  const f = fixture(t); f.register(); f.enqueue(); f.service.dispose();
  const transport = new Transport();
  transport.results.push({ outcome: "retry", reason: "Timeout" });
  let now = 1_800_000_000_000;
  const service = new ApnsService(f.storage, configuration, transport, () => apnsDigest(appToken), () => snapshot(), () => {}, () => now);
  await service.flush();
  assert.equal(f.rows()[0]?.attempts, 1);
  await service.flush();
  assert.equal(transport.messages.length, 1);
  now += 2001;
  await service.flush();
  assert.equal(transport.messages.length, 2);
  assert.equal(transport.messages[0]!.id, transport.messages[1]!.id);
  assert.equal(f.rows()[0]?.state, "accepted");
  service.dispose();
});

test("unsubscribe, credential rotation, viewed completion and missing session prevent delivery", async t => {
  for (const change of ["revoke", "rotate", "viewed", "missing", "busy", "expired"] as const) {
    await t.test(change, async st => {
      const f = fixture(st); f.register(); f.enqueue();
      if (change === "revoke") f.storage.apns.revoke(secret);
      if (change === "rotate") f.rotate();
      if (change === "viewed") f.setLive({ ...snapshot(), viewedCompletionRevision: 1 });
      if (change === "missing") f.setLive(null);
      if (change === "busy") f.setLive({ ...snapshot(), structuredState: { ...snapshot().structuredState!, inFlight: true } });
      if (change === "expired") f.advance(3_600_001);
      await f.service.flush();
      assert.equal(f.transport.messages.length, 0);
      assert.equal(f.rows()[0]?.state, "canceled");
    });
  }
});

test("late invalid-token response cannot revoke a replacement token or resurrect canceled work", async t => {
  const f = fixture(t); f.register();
  const old = f.storage.apns.device(apnsDigest(secret))!;
  f.enqueue();
  f.register(secret, "d".repeat(64));
  f.storage.apns.invalidateDevice(old.id, old.generation);
  assert.equal(f.storage.apns.device(old.id)?.enabled, 1);
  await f.service.flush();
  assert.equal(f.transport.messages.length, 0);
  f.register(secondSecret, "e".repeat(64));
  f.storage.apns.revoke(secret);
  assert.equal(f.storage.apns.device(apnsDigest(secondSecret))?.enabled, 1);
});

test("same-token alias has one active binding and storage close is safe during a send", async t => {
  const f = fixture(t); f.register(); f.register(secondSecret);
  assert.equal(f.storage.apns.device(apnsDigest(secret))?.enabled, 0);
  f.storage.apns.revoke(secret);
  assert.equal(f.storage.apns.device(apnsDigest(secondSecret))?.enabled, 1);
  f.enqueue();
  let resolve!: (result: ApnsResult) => void;
  const transport: ApnsTransport = { send: () => new Promise(r => { resolve = r; }), close() {} };
  const service = new ApnsService(f.storage, configuration, transport, () => apnsDigest(appToken), () => snapshot(), () => {}, () => 1_800_000_000_000);
  const pending = service.flush();
  f.storage.close();
  resolve({ outcome: "accepted", reason: "AcceptedByAPNs" });
  await pending;
});

test("new successful completion callback is not fired for duplicate snapshots or failed execution", t => {
  const f = fixture(t);
  const live = snapshot(); f.storage.saveSession(live);
  const notices: number[] = [];
  const tracker = new SessionCompletionTracker(f.storage, () => live, (_id, revision) => notices.push(revision));
  tracker.ingest({ type: "ended", sessionId: live.id, data: {} });
  tracker.ingest({ type: "ended", sessionId: live.id, data: { completionRevision: 1 } });
  assert.deepEqual(notices, [1]);
  live.status = "failed"; live.exitCode = 1; live.endedAt = "2026-01-02T00:00:01Z";
  tracker.ingest({ type: "ended", sessionId: live.id, data: {} });
  assert.deepEqual(notices, [1]);
});

test("outbox and binding recover after a real SQLite close and reopen", async t => {
  const f = fixture(t); f.register(); f.enqueue();
  f.storage.close();
  const reopened = new WandStorage(f.path);
  const transport = new Transport();
  const service = new ApnsService(reopened, configuration, transport, () => apnsDigest(appToken), () => snapshot(), () => {}, () => 1_800_000_000_000);
  try {
    await service.flush();
    assert.equal(transport.messages.length, 1);
    assert.equal(f.rows()[0]?.state, "accepted");
  } finally { service.dispose(); reopened.close(); }
});

test("each device receives one scoped alert; retry exhaustion never resends forever", async t => {
  const f = fixture(t); f.register();
  f.storage.apns.register({ secret: secondSecret, token: "e".repeat(64), environment: "production", topic: configuration.topic,
    serverId: "saved-server-B", credentialDigest: apnsDigest(appToken) }, 1_800_000_000_000);
  f.enqueue(); await f.service.flush();
  assert.equal(f.transport.messages.length, 2);
  assert.deepEqual(new Set(f.transport.messages.map(m => JSON.parse(m.payload).serverId)), new Set(["saved-server-A", "saved-server-B"]));
  assert.notEqual(f.transport.messages[0]!.id, f.transport.messages[1]!.id);
  f.setLive({ ...snapshot(), completionRevision: 2 });
  f.storage.apns.revoke(secondSecret);
  f.transport.results.push(...Array.from({ length: 5 }, () => ({ outcome: "retry" as const, reason: "Timeout" })));
  f.enqueue("completed", "2");
  for (let i = 0; i < 8; i++) { await f.service.flush(); f.advance(61_000); }
  assert.equal(f.transport.messages.length, 7, "two successful devices plus five bounded attempts");
  assert.equal(f.rows().at(-1)?.state, "failed");
});

test("APNs invalid device disables only that generation; thrown transport failures count toward the retry cap", async t => {
  const f = fixture(t); f.register();
  f.transport.results.push({ outcome: "invalid-device", reason: "Unregistered" });
  f.enqueue(); await f.service.flush();
  assert.equal(f.storage.apns.device(apnsDigest(secret))?.enabled, 0);
  f.register(secret, "d".repeat(64));
  f.setLive({ ...snapshot(), completionRevision: 2 });
  let calls = 0;
  f.transport.send = async () => { calls++; throw new Error("do not log arbitrary transport detail"); };
  f.enqueue("completed", "2");
  for (let i = 0; i < 7; i++) { await f.service.flush(); f.advance(61_000); }
  assert.equal(calls, 5);
  assert.equal(f.rows().at(-1)?.reason, "TransportFailure");
  assert.equal(f.warnings.some(w => w.includes("arbitrary transport")), false);
});

test("notification fact read failures cannot escape into an execution event callback", t => {
  const f = fixture(t);
  const warnings: string[] = [];
  const service = new ApnsService(f.storage, configuration, f.transport, () => apnsDigest(appToken),
    () => { throw new Error("private diagnostic must not leak"); }, message => warnings.push(message));
  assert.doesNotThrow(() => service.completed("chat-A", 1));
  assert.doesNotThrow(() => service.ingest({ type: "status", sessionId: "chat-A", data: {} }));
  assert.equal(warnings.length, 1, "diagnostics are rate limited");
  assert.equal(warnings[0]!.includes("private diagnostic"), false);
});

test("HTTP registration requires real app bearer, revocation has device-only authority", async t => {
  const f = fixture(t);
  const app = express();
  registerApnsRoutes(app, { storage: f.storage, config, service: f.service });
  app.use((_req, res) => res.status(403).json({ error: "protected route" }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (method: string, bearer?: string, body?: unknown, suffix = "/api/push/apns/subscription") => fetch(base + suffix, {
    method, headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const body = { secret, deviceToken, environment: "production", serverId: "saved-server-A" };
  assert.equal((await request("PUT", undefined, body)).status, 401);
  assert.equal((await request("PUT", secret, body)).status, 401, "revoke capability cannot register");
  assert.equal((await request("PUT", appToken, { ...body, environment: "sandbox" })).status, 400);
  const registered = await request("PUT", appToken, body);
  assert.equal(registered.status, 200);
  assert.deepEqual(await registered.json(), { available: true, leaseSeconds: 14 * 86_400 });
  assert.equal((await request("DELETE", secondSecret)).status, 204);
  assert.equal(f.storage.apns.device(apnsDigest(secret))?.enabled, 1);
  assert.equal((await request("GET", secret, undefined, "/api/config")).status, 403);
  assert.equal((await request("DELETE", secret)).status, 204);
  assert.equal(f.storage.apns.device(apnsDigest(secret))?.enabled, 0);
  assert.equal((await request("DELETE", secret)).status, 204, "revocation is idempotent");
});
