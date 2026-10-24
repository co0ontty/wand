import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { connect, createServer as createHttp2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";
import { ApnsClient, type ApnsConfiguration, type ApnsMessage, type ApnsResult, type ApnsTransport } from "../src/apns-client.js";
import { ApnsService } from "../src/apns-service.js";
import { defaultConfig } from "../src/config.js";
import { LiveActivityService } from "../src/live-activity-service.js";
import { APPLE_REFERENCE_UNIX_SECONDS, liveActivityPayload, liveActivityText, projectLiveActivity } from "../src/live-activity-state.js";
import { registerApnsRoutes } from "../src/server-apns-routes.js";
import { generateAppToken } from "../src/server-app-connect.js";
import { apnsDigest } from "../src/storage/apns-repository.js";
import { WandStorage } from "../src/storage.js";
import { SessionRegistry } from "../src/session-registry.js";
import type { SessionSnapshot } from "../src/types.js";

const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
const cfg: ApnsConfiguration = { key, topic: "com.example.wand", teamId: "TESTTEAM01", keyId: "TESTKEY001", environment: "production" };
const config = { ...defaultConfig(), password: "test-only-password", appSecret: "test-only-secret" };
const bearer = generateAppToken(config.password, config.appSecret);
const secret = "1".repeat(64), otherSecret = "2".repeat(64), token = "a".repeat(128);
const start = 1_800_000_000_000;
function session(id = "s"): SessionSnapshot {
  return { id, sessionKind: "structured", command: "not-to-include", cwd: "/not-to-include", provider: "pi", status: "running", mode: "assist", exitCode: null,
    startedAt: new Date(start - 30_000).toISOString(), endedAt: null, archived: false, archivedAt: null, output: "private-transcript", claudeSessionId: null,
    title: "当前任务", currentTaskTitle: "检查构建", queuedMessages: ["not-to-include"],
    structuredState: { runner: "pi-cli-json", lastError: null, inFlight: true, activeRequestId: null, engine: "core", turnStartedAt: new Date(start - 30_000).toISOString() } };
}
class Transport implements ApnsTransport {
  messages: ApnsMessage[] = [];
  results: ApnsResult[] = [];
  async send(m: ApnsMessage): Promise<ApnsResult> { this.messages.push(m); return this.results.shift() ?? { outcome: "accepted", reason: "AcceptedByAPNs" }; }
  close(): void {}
}
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "wand-live-apns-"));
  const dbPath = join(root, "wand.db");
  const storage = new WandStorage(dbPath);
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  let now = start;
  let snapshots: SessionSnapshot[] | null = [session()];
  let digest = apnsDigest(bearer);
  const transport = new Transport(), warnings: string[] = [];
  const service = new LiveActivityService(storage, cfg, transport, () => digest, () => snapshots, m => warnings.push(m), () => now);
  const register = (s = secret, activityToken = token, activityId = "activity-one") => storage.liveActivities.register({
    secret: s, token: activityToken, activityId, serverId: "server_a", credentialDigest: digest, topic: cfg.topic, environment: cfg.environment,
  }, now);
  return { root, dbPath, storage, service, transport, warnings, register,
    record: (s = secret) => storage.liveActivities.get(apnsDigest(s))!,
    advance(ms: number) { now += ms; }, set(value: SessionSnapshot[] | null) { snapshots = value; }, rotate() { digest = apnsDigest("new-credential"); } };
}

test("ActivityKit uses its own token, derived topic and low-priority header without a banner", async t => {
  const server = createHttp2Server();
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const client = new ApnsClient(cfg, () => connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  t.after(() => client.close());
  server.on("stream", (stream, h) => {
    assert.equal(h[":path"], `/3/device/${token}`);
    assert.equal(h["apns-topic"], "com.example.wand.push-type.liveactivity");
    assert.equal(h["apns-push-type"], "liveactivity");
    assert.equal(h["apns-priority"], "5");
    let body = ""; stream.setEncoding("utf8"); stream.on("data", x => { body += x; });
    stream.on("end", () => { assert.equal(JSON.parse(body).aps.alert, undefined); stream.respond({ ":status": 200 }); stream.end(); });
  });
  const p = projectLiveActivity([session()], [], "server_a", start);
  assert.equal((await client.send({ id: "00000000-0000-4000-8000-000000000001", token, payload: liveActivityPayload(p.content, "update", start / 1000), expiresAt: start + 60_000, collapseId: "activity", pushType: "liveactivity" })).outcome, "accepted");
});

test("projection matches Swift Codable dates, keeps one aggregate, bounded Unicode and private-field exclusions", () => {
  const permission = { ...session("p"), pendingEscalation: { requestId: "r", scope: "run_command" as const, runner: "structured" as const, source: "tool_permission_request" as const, reason: "secret-argument", target: "/private-target" } };
  const p = projectLiveActivity([session(), permission], [], "server_a", start);
  assert.deepEqual(p.entries.map(x => x.stateRaw), ["permission", "responding"]);
  assert.equal(p.content.updatedAt + APPLE_REFERENCE_UNIX_SECONDS, start / 1000);
  assert.equal(p.content.sessions[1]!.startedAt! + APPLE_REFERENCE_UNIX_SECONDS, start / 1000 - 30);
  const payload = liveActivityPayload(p.content, p.event, start / 1000);
  for (const secret of ["private-transcript", "not-to-include", "secret-argument", "/private-target", "finishedUntil"]) assert.equal(payload.includes(secret), false);
  const family = "👨‍👩‍👧‍👦";
  const bounded = liveActivityText(family.repeat(80), 24, 96);
  assert.equal(bounded, family.repeat(Math.floor(96 / Buffer.byteLength(family))));
  const many = projectLiveActivity(Array.from({ length: 30 }, (_, i) => ({ ...session(String(i)), title: family.repeat(80), currentTaskTitle: "中".repeat(300) })), [], "server_a", start);
  assert.ok(many.entries.length <= 8);
  assert.ok(Buffer.byteLength(liveActivityPayload(many.content, "update", start / 1000)) < 4096);
});

test("blank PTY is not fabricated progress; PTY busy and structured background are real facts", () => {
  const pty = { ...session("pty"), sessionKind: "pty" as const, provider: undefined, structuredState: undefined, ptyBusy: false };
  assert.equal(projectLiveActivity([pty], [], "server_a", start).entries.length, 0);
  assert.equal(projectLiveActivity([{ ...pty, ptyCommandRunning: true }], [], "server_a", start).entries[0]?.stateRaw, "responding");
  const bg = { ...session(), structuredState: { ...session().structuredState!, phase: "background" as const } };
  assert.equal(projectLiveActivity([bg], [], "server_a", start).entries[0]?.stateRaw, "background");
});

test("runtime-only catalog excludes stale stored execution flags without changing the default list projection", t => {
  const f = setup(t), live = session("live"), stale = session("unowned-old");
  f.storage.saveSession(live); f.storage.saveSession(stale);
  const registry = new SessionRegistry(
    { listSlim: () => [] } as unknown as ConstructorParameters<typeof SessionRegistry>[0],
    { listSlim: () => [live] } as unknown as ConstructorParameters<typeof SessionRegistry>[1], f.storage);
  assert.deepEqual(registry.listSlim({ runtimeOnly: true }).map(s => s.id), ["live"]);
  assert.equal(registry.listSlim().length, 2);
  const old = projectLiveActivity([stale], [], "server_a", start);
  const missing = projectLiveActivity([], old.entries, "server_a", start + 1000);
  assert.equal(missing.event, "end");
  assert.equal(missing.content.sessions[0]?.stateRaw, "responding", "lost ownership must not invent successful completion");
});

test("completed/failure grace periods do not renew on heartbeat and disappear into a real end event", () => {
  const active = projectLiveActivity([session()], [], "server_a", start);
  const done = { ...session(), status: "idle" as const, structuredState: { ...session().structuredState!, inFlight: false } };
  const linger = projectLiveActivity([done], active.entries, "server_a", start + 2000);
  assert.equal(linger.entries[0]?.stateRaw, "done");
  assert.equal(linger.entries[0]?.finishedUntil, start + 14_000);
  assert.equal(linger.entries[0]!.finishedAt! + APPLE_REFERENCE_UNIX_SECONDS, (start + 2000) / 1000);
  const again = projectLiveActivity([done], linger.entries, "server_a", start + 5000);
  assert.equal(again.entries[0]?.finishedUntil, start + 14_000);
  assert.equal(again.entries[0]?.finishedAt, linger.entries[0]?.finishedAt);
  assert.equal(projectLiveActivity([done], again.entries, "server_a", start + 14_001).event, "end");
  assert.equal(projectLiveActivity([done], [], "server_a", start).entries.length, 0, "no historical completion replay");
});

test("real aggregate updates coalesce redundant status, heartbeat safely, then remotely end after grace", async t => {
  const f = setup(t); f.register(); await f.service.flush();
  assert.equal(f.transport.messages.length, 1); assert.equal(f.transport.messages[0]!.priority, 5);
  f.service.ingest({ type: "status", sessionId: "s", data: {} }); f.advance(2000); await f.service.flush();
  assert.equal(f.transport.messages.length, 1, "redundant metadata does not consume push budget");
  f.advance(58_000); await f.service.flush();
  assert.equal(f.transport.messages.length, 2);
  const done = { ...session(), status: "idle" as const, structuredState: { ...session().structuredState!, inFlight: false } };
  f.set([done]); f.service.ingest({ type: "ended", sessionId: "s", data: {} }); f.advance(2000); await f.service.flush();
  assert.equal(JSON.parse(f.transport.messages.at(-1)!.payload).aps["content-state"].sessions[0].stateRaw, "done");
  f.advance(12_001); await f.service.flush();
  const end = JSON.parse(f.transport.messages.at(-1)!.payload).aps;
  assert.equal(end.event, "end"); assert.equal(end["dismissal-date"], 0);
  assert.equal(f.record().enabled, 0); assert.equal(f.record().token, "");
  assert.equal(f.storage.apns.device(apnsDigest(secret)), null, "live bindings are not ordinary notification devices");
});

test("an unchanged attention state does not turn heartbeats or another task progress into high-priority pushes", async t => {
  const f = setup(t);
  const permission = { ...session(), pendingEscalation: { requestId: "request", scope: "run_command" as const, runner: "structured" as const, source: "tool_permission_request" as const, reason: "private" } };
  f.set([permission, session("peer")]); f.register(); await f.service.flush();
  assert.equal(f.transport.messages.at(-1)!.priority, 10);
  f.advance(60_000); await f.service.flush();
  assert.equal(f.transport.messages.at(-1)!.priority, 5);
  f.set([permission, { ...session("peer"), currentTaskTitle: "新步骤" }]);
  f.service.ingest({ type: "task", sessionId: "peer", data: {} }); f.advance(2000); await f.service.flush();
  assert.equal(f.transport.messages.at(-1)!.priority, 5);
});

test("registration race gets an initial grace; failed recovery does not synthesize end or refresh stale data", async t => {
  const f = setup(t); f.set([]); f.register(); await f.service.flush();
  assert.equal(f.transport.messages.length, 0);
  f.advance(5000); f.set([session()]); await f.service.flush();
  assert.equal(f.transport.messages.length, 1);
  f.advance(60_000); f.set(null); await f.service.flush();
  assert.equal(f.transport.messages.length, 1);
  assert.equal(f.record().enabled, 1, "unknown recovery is not completion");
});

test("credential change, lease expiry and explicit revocation prevent all further ActivityKit updates", async t => {
  for (const action of ["rotate", "expire", "revoke"] as const) await t.test(action, async st => {
    const f = setup(st); f.register();
    if (action === "rotate") f.rotate();
    if (action === "expire") f.advance(8 * 3_600_000 + 1);
    if (action === "revoke") f.storage.liveActivities.revoke(secret);
    await f.service.flush(); assert.equal(f.transport.messages.length, 0); assert.equal(f.record().enabled, 0);
  });
});

test("redundant metadata cannot reset the retry cap or timestamp; permanent rejection blocks until renewed", async t => {
  const f = setup(t); f.register();
  f.transport.results.push(...Array.from({ length: 5 }, () => ({ outcome: "retry" as const, reason: "Timeout" })));
  await f.service.flush();
  const firstId = f.transport.messages[0]!.id, stamp = JSON.parse(f.transport.messages[0]!.payload).aps.timestamp;
  for (let i = 0; i < 4; i++) { f.service.ingest({ type: "status", sessionId: "s", data: {} }); f.advance(17_000); await f.service.flush(); }
  assert.equal(f.transport.messages.length, 5); assert.equal(f.record().outcome, "failed");
  for (const m of f.transport.messages) { assert.equal(m.id, firstId); assert.equal(JSON.parse(m.payload).aps.timestamp, stamp); }
  f.transport.results.push({ outcome: "rejected", reason: "InvalidProviderToken" }); f.advance(61_000); await f.service.flush();
  assert.equal(f.record().blocked, 1);
  const sent = f.transport.messages.length; f.advance(61_000); f.service.ingest({ type: "status", sessionId: "s", data: {} }); await f.service.flush();
  assert.equal(f.transport.messages.length, sent);
});

test("a backwards clock never creates an older or fabricated future ActivityKit progress timestamp", async t => {
  const f = setup(t); f.register(); await f.service.flush();
  const original = JSON.parse(f.transport.messages[0]!.payload).aps.timestamp;
  f.advance(-10_000); f.set([{ ...session(), currentTaskTitle: "新事实" }]);
  f.service.ingest({ type: "task", sessionId: "s", data: {} }); f.advance(2000); await f.service.flush();
  assert.equal(f.transport.messages.length, 1);
  assert.equal(f.record().next_at, (original + 1) * 1000);
});

test("new facts during in-flight acceptance are not lost and old token rejection cannot disable a replacement", async t => {
  const f = setup(t); f.register();
  let resolve!: (r: ApnsResult) => void;
  let sent = 0;
  f.transport.send = async m => { f.transport.messages.push(m); return sent++ === 0 ? await new Promise<ApnsResult>(r => { resolve = r; }) : { outcome: "accepted", reason: "AcceptedByAPNs" }; };
  const inFlight = f.service.flush();
  f.set([{ ...session(), currentTaskTitle: "新步骤" }]); f.service.ingest({ type: "task", sessionId: "s", data: {} });
  resolve({ outcome: "accepted", reason: "AcceptedByAPNs" }); await inFlight;
  f.advance(2000); await f.service.flush();
  assert.equal(f.transport.messages.length, 2);
  assert.equal(JSON.parse(f.transport.messages[1]!.payload).aps["content-state"].sessions[0].taskTitle, "新步骤");
  const old = f.record(); f.register(secret, "b".repeat(128));
  f.storage.liveActivities.disable(old.id, "Unregistered", old.generation);
  assert.equal(f.record().enabled, 1);
});

test("shutdown during in-flight ActivityKit HTTP never touches closed storage", async t => {
  const f = setup(t); f.register();
  let resolve!: (result: ApnsResult) => void;
  f.transport.send = async () => await new Promise<ApnsResult>(r => { resolve = r; });
  const sending = f.service.flush();
  f.storage.close();
  resolve({ outcome: "accepted", reason: "AcceptedByAPNs" });
  await sending;
});

test("pending payload survives actual SQLite reopening", async t => {
  const f = setup(t); f.register(); f.transport.results.push({ outcome: "retry", reason: "Timeout" }); await f.service.flush();
  const oldId = f.transport.messages[0]!.id; f.storage.close();
  const storage = new WandStorage(f.dbPath), transport = new Transport();
  const service = new LiveActivityService(storage, cfg, transport, () => apnsDigest(bearer), () => [session()], () => {}, () => start + 3000);
  await service.flush(); assert.equal(transport.messages[0]!.id, oldId); service.dispose(); storage.close();
});

test("authenticated live registration uses a separate revoke-only capability and never broadens public API", async t => {
  const f = setup(t);
  const normal = new ApnsService(f.storage, cfg, f.transport, () => apnsDigest(bearer), () => session());
  const app = express(); registerApnsRoutes(app, { storage: f.storage, config, service: normal, liveActivity: f.service });
  const server = createServer(app); await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/push/apns/live-activity`;
  const body = { secret, activityId: "activity-one", activityToken: token, serverId: "server_a", environment: "production" };
  const put = (auth: string, data = body) => fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  assert.equal((await put(secret)).status, 401);
  assert.equal((await put(bearer, { ...body, environment: "sandbox" })).status, 400);
  assert.deepEqual(await (await put(bearer)).json(), { available: true, leaseSeconds: 8 * 3600 });
  const expiry = f.record().expires_at; f.advance(3_600_000); f.register(); assert.equal(f.record().expires_at, expiry, "renewal never exceeds original ActivityKit lease");
  f.storage.apns.register({ secret: otherSecret, token: "c".repeat(64), environment: cfg.environment, topic: cfg.topic, serverId: "server_a", credentialDigest: apnsDigest(bearer) }, start);
  assert.equal((await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${secret}` } })).status, 204);
  assert.equal(f.record().enabled, 0); assert.equal(f.storage.apns.device(apnsDigest(otherSecret))?.enabled, 1);
});
