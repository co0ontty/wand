import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { AuthService } from "../src/auth.js";
import { createRequireAuth } from "../src/middleware/auth.js";
import { registerAuthRoutes } from "../src/server-auth-routes.js";
import { SettingsWebAccess } from "../src/settings-web-access.js";
import { WebLoginTickets, webLoginOrigin } from "../src/web-login-tickets.js";
import { parseSystemCliCommand } from "../src/system-cli.js";
import { conversationHarness } from "./helpers/conversation-harness.js";
import { generateAppToken } from "../src/server-app-connect.js";
import { installSystemSkill } from "../src/system-skill.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const subject = { sessionId: "session-one", employeeId: "employee-one" };
test("ticket is short-lived, origin-bound, single-use and never caller-selected admin", () => {
  let now = Date.now();
  const service = new WebLoginTickets(() => now);
  const id = randomUUID();
  const issued = service.issue(id, "https://wand.example", subject);
  assert.match(issued.ticket, /^wlt_[a-zA-Z0-9_-]{43}$/);
  assert.equal(Date.parse(issued.expiresAt) - now, 60_000);
  assert.deepEqual(issued.principal, { kind: "connected-app", scopes: ["sessions"], webSession: subject });
  assert.throws(() => service.consume(issued.ticket, "https://evil.example"), /票据无效/);
  assert.deepEqual(service.consume(issued.ticket, issued.origin), { principal: issued.principal, subject });
  assert.throws(() => service.consume(issued.ticket, issued.origin), /票据无效/);
  assert.throws(() => service.issue(id, issued.origin, subject), /不会重发/);
  const expired = service.issue(randomUUID(), issued.origin, subject);
  now += 60_000;
  assert.throws(() => service.consume(expired.ticket, expired.origin), /票据无效/);
  const cancelled = service.issue(randomUUID(), issued.origin, subject);
  service.cancel(cancelled.requestId);
  assert.throws(() => service.consume(cancelled.ticket, cancelled.origin), /票据无效/);
  const early = randomUUID(); service.cancel(early);
  assert.throws(() => service.issue(early, issued.origin, subject), /不会重发/);
  service.clear();
  assert.throws(() => service.consume(cancelled.ticket, cancelled.origin), /票据无效/);
  for (const bad of ["http://remote.example", "https://u:p@wand.example", "https://wand.example/?ticket=x", "https://wand.example/#x", "https://wand.example/path", null]) {
    assert.throws(() => webLoginOrigin(bad), /origin/);
  }
  assert.equal(webLoginOrigin("http://127.0.0.1:8181"), "http://127.0.0.1:8181");
});

test("ticket records are bounded and duplicate/early cancel tombstones survive TTL", () => {
  let now = 1_000;
  const service = new WebLoginTickets(() => now);
  for (let i = 0; i < 4096; i++) service.issue(`request-number-${i.toString().padStart(8, "0")}`, "https://wand.example", subject);
  assert.throws(() => service.issue(randomUUID(), "https://wand.example", subject), /请求过多/);
  now += 60_001;
  assert.throws(() => service.issue("request-number-00000000", "https://wand.example", subject), /不会重发/);
  now += 12 * 60 * 60_000;
  assert.ok(service.issue(randomUUID(), "https://wand.example", subject));
});

test("CLI binds subject from runtime and rejects permission/subject/TTL injection before auth", async () => {
  async function* input(value: unknown) { yield JSON.stringify(value); }
  const requestId = randomUUID();
  const body = { requestId, origin: "https://wand.example" };
  const previousProof = process.env.WAND_WEB_LOGIN_PROOF;
  const proof = `wlp_${"a".repeat(43)}`;
  process.env.WAND_WEB_LOGIN_PROOF = proof;
  try {
    const op = await parseSystemCliCommand("web-login:issue", ["--stdin"], input(body));
    let sent: unknown;
    await op({ get: async () => { throw new Error(); }, patch: async () => { throw new Error(); },
      post: async <T>(route: string, value: unknown, headers?: Record<string, string>) => {
        assert.equal(route, "/api/login/ticket/issue"); sent = value;
        assert.deepEqual(headers, { "X-Wand-Web-Login-Proof": proof }); return {} as T;
      } });
    assert.deepEqual(sent, body, "non-secret session IDs are not sent as identity proof");
    delete process.env.WAND_WEB_LOGIN_PROOF;
    await assert.rejects(parseSystemCliCommand("web-login:issue", ["--stdin"], input(body)), /有效的网页登录证明/);
  } finally { if (previousProof === undefined) delete process.env.WAND_WEB_LOGIN_PROOF; else process.env.WAND_WEB_LOGIN_PROOF = previousProof; }
  for (const extra of [{ scopes: ["admin"] }, { employeeId: "another" }, { sessionId: "another" }, { ttl: 3600 }]) {
    await assert.rejects(parseSystemCliCommand("web-login:issue", ["--stdin"], input({ ...body, ...extra })), /不支持字段/);
  }
});

test("installed memory helper captures bound CLI output, supports cancellation and does not reissue", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wand-ticket-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tickets = new WebLoginTickets();
  const app = express(); app.use(express.json());
  let issuedCount = 0;
  app.post("/api/login", (_req, res) => { res.setHeader("Set-Cookie", "fixture=owner; HttpOnly"); res.json({ ok: true }); });
  app.post("/api/login/ticket/issue", (req, res) => {
    issuedCount++;
    try { res.status(201).json(tickets.issue(req.body.requestId, req.body.origin, subject)); }
    catch { res.status(409).json({ error: "duplicate_request" }); }
  });
  app.post("/api/login/ticket/cancel", (req, res) => { tickets.cancel(req.body.requestId); res.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const configPath = path.join(root, "config/config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ port: address.port, https: false, password: "fixture-password" }));
  await installSystemSkill(configPath, ["pi"], path.join(root, "home"));
  const helper = await import(pathToFileURL(path.join(root, "config/skills/wand-system/scripts/web-login.mjs")).href);
  const previousProof = process.env.WAND_WEB_LOGIN_PROOF;
  process.env.WAND_WEB_LOGIN_PROOF = `wlp_${"b".repeat(43)}`;
  t.after(() => { if (previousProof === undefined) delete process.env.WAND_WEB_LOGIN_PROOF; else process.env.WAND_WEB_LOGIN_PROOF = previousProof; });
  const requestId = randomUUID();
  const result = await helper.issueWebLoginTicket({ origin, requestId });
  assert.match(result.ticket, /^wlt_/); assert.equal(issuedCount, 1);
  await assert.rejects(helper.issueWebLoginTicket({ origin, requestId }), /DELIVERY_UNKNOWN/);
  assert.equal(issuedCount, 2, "one HTTP attempt per explicit call, never automatic retry");
  await helper.cancelWebLoginTicket(requestId);
  assert.throws(() => tickets.consume(result.ticket, origin));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(helper.issueWebLoginTicket({ origin, requestId: randomUUID() }, { signal: abort.signal }), /CANCELLED/);
  assert.equal(issuedCount, 2);
  await assert.rejects(helper.issueWebLoginTicket({ origin: "http://remote.example", requestId: randomUUID() }), /ISSUANCE_REJECTED/);
  assert.equal(issuedCount, 2, "explicit local refusal is distinguishable and never reaches HTTP");
});

test("HTTP visible-login contract: local admin issuance, origin checks, atomic redemption, cancellation and revocation", async t => {
  const h = conversationHarness(t);
  const authService = new AuthService(h.storage);
  t.after(() => authService.dispose());
  const app = express(); app.use(express.json());
  const config = { ...h.config, password: "fixture-password", appSecret: "fixture-secret" };
  const requireAuth = createRequireAuth({ config, storage: h.storage, authService, useHttps: false, settingsAccess: new SettingsWebAccess() });
  let liveSubject = { ...h.structured.createSession({ cwd: h.cwd, mode: "managed", employeeId: "e_test_1", provider: "pi" }), status: "running" as const };
  h.storage.saveSession(liveSubject);
  const tickets = new WebLoginTickets();
  const grant = tickets.grant({ sessionId: liveSubject.id, employeeId: liveSubject.employeeId });
  registerAuthRoutes(app, { config, storage: h.storage, authService, useHttps: false, requireAuth, tickets,
    getSession: id => id === liveSubject.id ? liveSubject as import("../src/types.js").SessionSnapshot : null, disconnectAuthenticatedSockets() {} });
  app.use("/api", requireAuth);
  app.get("/api/sessions/:id", (req, res) => res.json({ id: req.params.id }));
  app.post("/api/sessions/:id/input", (_req, res) => res.json({ accepted: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const cookie = `wand_session_local=${authService.createSession()}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const issue = (requestId = randomUUID(), extra: object = {}, headers: Record<string, string> = { cookie, "x-wand-web-login-proof": grant.proof }) => post("/api/login/ticket/issue", { requestId, origin, ...extra }, headers);
  assert.equal((await issue(randomUUID(), {}, {})).status, 401);
  assert.equal((await issue(randomUUID(), {}, { cookie, origin })).status, 403);
  assert.equal((await issue(randomUUID(), {}, { cookie, "x-forwarded-for": "127.0.0.1" })).status, 403);
  assert.equal((await issue(randomUUID(), {}, { cookie, "sec-fetch-site": "same-origin" })).status, 403);
  assert.equal((await issue(randomUUID(), {}, { Authorization: `Bearer ${generateAppToken(config.password, config.appSecret)}` })).status, 403);
  assert.equal((await issue(randomUUID(), { scopes: ["admin"] })).status, 400);
  assert.equal((await issue(randomUUID(), { sessionId: "does-not-exist" })).status, 400);
  assert.equal((await issue(randomUUID(), {}, { cookie })).status, 403, "owner cookie and a guessed session ID cannot attest an execution");
  const response = await issue(); assert.equal(response.status, 201); assert.equal(response.headers.get("cache-control"), "no-store");
  const ticket = await response.json();
  assert.equal((await post("/api/login/ticket", { ticket: ticket.ticket })).status, 403);
  assert.equal((await post("/api/login/ticket", { ticket: ticket.ticket }, { origin: "https://evil.example" })).status, 403);
  const results = await Promise.all(Array.from({ length: 5 }, () => post("/api/login/ticket", { ticket: ticket.ticket }, { origin })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401, 401, 401, 401]);
  const success = results.find(r => r.status === 200)!;
  const cookies = success.headers.get("set-cookie")!; assert.match(cookies, /HttpOnly/); assert.doesNotMatch(cookies, /wlt_/);
  const principal = (await success.json()).principal;
  assert.deepEqual(principal, { kind: "connected-app", scopes: ["sessions"], webSession: { sessionId: liveSubject.id, employeeId: liveSubject.employeeId } });
  const scopedCookie = cookies.match(/wand_session_local=[^;,]+/)![0];
  const scopedToken = scopedCookie.split("=")[1]!;
  assert.equal(h.storage.getAuthSession(scopedToken), null, "runtime boundary cannot be dropped by persistence");
  const projection = authService.authenticateSession(scopedToken)!;
  projection.webSession!.sessionId = "attempted-projection-mutation";
  assert.equal(authService.authenticateSession(scopedToken)!.webSession!.sessionId, liveSubject.id);
  const legacyPrototype = authService.createSession({ kind: "connected-app", scopes: ["sessions"] });
  assert.equal(authService.authenticateSession(legacyPrototype), null, "pre-hardening subjectless ticket cookies cannot regain broad access");
  assert.throws(() => h.storage.saveAuthSession(scopedToken, Date.now() + 60_000, principal), /must not be persisted/);
  const restarted = new AuthService(h.storage); t.after(() => restarted.dispose());
  assert.equal(restarted.authenticateSession(scopedToken), null, "restart fails closed instead of broadening to sessions");
  assert.equal((await fetch(`${origin}/api/sessions/${liveSubject.id}`, { headers: { cookie: scopedCookie } })).status, 200);
  assert.equal((await fetch(`${origin}/api/sessions/synthetic-other-employee`, { headers: { cookie: scopedCookie } })).status, 403);
  assert.equal((await post(`/api/sessions/${liveSubject.id}/input`, { input: "must-not-run" }, { cookie: scopedCookie })).status, 403);
  assert.equal((await issue(ticket.requestId)).status, 409);
  const cancelled = await (await issue()).json();
  assert.equal((await post("/api/login/ticket/cancel", { requestId: cancelled.requestId }, { cookie })).status, 200);
  assert.equal((await post("/api/login/ticket", { ticket: cancelled.ticket }, { origin })).status, 401);
  const bound = await (await issue()).json();
  assert.deepEqual(bound.subject, { sessionId: liveSubject.id, employeeId: liveSubject.employeeId });
  liveSubject = { ...liveSubject, employeeId: "changed-employee" };
  assert.equal((await post("/api/login/ticket", { ticket: bound.ticket }, { origin })).status, 401);
  liveSubject = { ...liveSubject, status: "idle" as typeof liveSubject.status };
  assert.equal((await issue()).status, 403);
  liveSubject = { ...liveSubject, employeeId: "e_test_1", status: "running" };
  const revokeResponse = await issue(); assert.equal(revokeResponse.status, 201);
  const revoke = await revokeResponse.json(); authService.revokeAllSessions();
  assert.equal((await post("/api/login/ticket", { ticket: revoke.ticket }, { origin })).status, 401);
});
