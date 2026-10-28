import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import express from "express";

import { defaultConfig } from "../src/config.js";
import { HttpError, badRequest, isHttpError, surfaceDomainError } from "../src/http-error.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { API_ROUTE_RULES, PUBLIC_API_PREFIXES, findApiRouteRule, requiredApiScope } from "../src/middleware/api-scope.js";
import { AttemptLimiter } from "../src/middleware/rate-limit.js";
import { createExtensionCors, extensionIdOf } from "../src/middleware/cors.js";
import { sendRouteError } from "../src/server-request.js";
import { resolveTrustProxy, DEFAULT_TRUST_PROXY } from "../src/server-request.js";
import { startServer } from "../src/server.js";
import type { TerminalHost, TerminalSpawnRequest } from "../src/terminal-host.js";

const ROUTE_SOURCE_FILES = readdirSync(path.join(import.meta.dirname, "..", "src"))
  .filter((name) => /^server-.*\.ts$/.test(name) || name === "server.ts" || name === "upload-routes.ts")
  .map((name) => path.join(import.meta.dirname, "..", "src", name));

test("every /api family referenced by route modules is explicitly classified", () => {
  const families = new Set<string>();
  for (const file of ROUTE_SOURCE_FILES) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/"(\/api\/[a-z][a-z0-9-]*)/g)) {
      families.add(match[1]);
    }
  }
  const unclassified = [...families].filter((family) =>
    !findApiRouteRule(family) && !PUBLIC_API_PREFIXES.some((prefix) => family === prefix || family.startsWith(`${prefix}/`)));
  assert.deepEqual(unclassified, [], "every /api family must declare its scope in api-scope.ts");
});

test("api scope matching is segment-aware and unknown paths default to admin", () => {
  assert.equal(requiredApiScope("/api/sessions"), "sessions");
  assert.equal(requiredApiScope("/api/wand-task-actions"), "sessions");
  assert.equal(requiredApiScope("/api/wand-task-actions-extra"), "admin");
  assert.equal(requiredApiScope("/api/sessions/abc/input"), "sessions");
  assert.equal(requiredApiScope("/api/commands"), "admin");
  assert.equal(requiredApiScope("/api/structured-sessions"), "sessions");
  assert.equal(requiredApiScope("/api/structured-sessions/abc/messages"), "sessions");
  assert.equal(requiredApiScope("/api/structured-sessions/abc/queued"), "sessions");
  assert.equal(requiredApiScope("/api/session-list"), "sessions");
  assert.equal(requiredApiScope("/api/sessionsx"), "admin");
  assert.equal(requiredApiScope("/api/file-raw"), "files");
  assert.equal(requiredApiScope("/api/models"), "sessions");
  assert.equal(requiredApiScope("/api/browser-extension/items/1"), "password-vault");
  assert.equal(requiredApiScope("/api/settings/config"), "route-guarded");
  assert.equal(requiredApiScope("/api/some-new-family"), "admin");
  assert.equal(requiredApiScope("/api/restart"), "admin");
  for (const rule of API_ROUTE_RULES) {
    assert.ok(rule.prefix.startsWith("/api/"), `${rule.prefix} is an /api prefix`);
  }
});

test("HttpError and route error responses never echo raw internal messages", () => {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return { json(body: unknown) { captured.body = body; return body; } };
    },
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    sendRouteError(res, new Error("ENOENT: /secret/path/db.sqlite"), "无法保存。", 500);
    assert.deepEqual(captured, { status: 500, body: { error: "无法保存。", code: "internal_error" } });

    sendRouteError(res, badRequest("名字不能为空。"), "无法保存。", 500);
    assert.deepEqual(captured, { status: 400, body: { error: "名字不能为空。", code: "invalid_request" } });

    sendRouteError(res, new HttpError(409, "conflict", "已存在。"), "无法保存。");
    assert.deepEqual(captured, { status: 409, body: { error: "已存在。", code: "conflict" } });
  } finally {
    console.error = originalError;
  }
  assert.equal(isHttpError(new HttpError(404, "not_found", "x")), true);
  assert.equal(surfaceDomainError(new Error("Git 仓库未找到"), /Git 仓库/)?.message, "Git 仓库未找到");
  assert.equal(surfaceDomainError(new Error("ENOENT /etc/passwd"), /Git 仓库/), undefined);
});

test("jsonErrorHandler maps HttpError to stable {error, code} and hides unexpected failures", async (t) => {
  const app = express();
  app.get("/typed", () => { throw new HttpError(422, "unprocessable", "资料不完整。"); });
  app.get("/boom", () => { throw new Error("internal stack detail"); });
  app.use(jsonErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as { port: number };
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });

  const typed = await fetch(`http://127.0.0.1:${port}/typed`);
  assert.equal(typed.status, 422);
  assert.deepEqual(await typed.json(), { error: "资料不完整。", code: "unprocessable" });

  const boom = await fetch(`http://127.0.0.1:${port}/boom`);
  assert.equal(boom.status, 500);
  assert.deepEqual(await boom.json(), { error: "请求处理失败。", code: "internal_error" });
});

test("extension CORS grants credentials only to allow-listed extension ids", async (t) => {
  const listed = "a".repeat(32);
  const unlisted = "b".repeat(32);
  const app = express();
  app.use(createExtensionCors([listed.toUpperCase()]));
  app.get("/api/ping", (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}/api/ping`;

  const allowed = await fetch(url, { headers: { origin: `chrome-extension://${listed}` } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), `chrome-extension://${listed}`);
  assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");

  const denied = await fetch(url, { headers: { origin: `chrome-extension://${unlisted}` } });
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  assert.equal(denied.headers.get("access-control-allow-credentials"), null);

  assert.equal(extensionIdOf(`moz-extension://${listed}`), listed);
});

test("without an extension allow-list, extension origins get CORS but never credentials", async (t) => {
  const app = express();
  app.use(createExtensionCors(undefined));
  app.get("/api/ping", (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as { port: number };
  const origin = `chrome-extension://${"c".repeat(32)}`;
  const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { headers: { origin } });
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
});

test("attempt limiters cap tracked keys and lock per key", () => {
  const limiter = new AttemptLimiter({ windowMs: 60_000, maxAttempts: 2, lockoutMs: 60_000, maxKeys: 5 });
  const now = 1_000_000;
  for (let i = 0; i < 50; i++) limiter.record(`10.0.0.${i}`, now + i);
  assert.ok(limiter.size <= 5, `tracked keys bounded, got ${limiter.size}`);
  assert.equal(limiter.record("198.51.100.1", now), null);
  assert.ok(limiter.record("198.51.100.1", now + 1));
  assert.ok(limiter.check("198.51.100.1", now + 2));
  assert.equal(limiter.check("198.51.100.1", now + 60_002), null);
});

test("trust proxy setting is explicit and refuses trust-everything values", () => {
  assert.equal(resolveTrustProxy(undefined), DEFAULT_TRUST_PROXY);
  assert.equal(resolveTrustProxy("true"), DEFAULT_TRUST_PROXY);
  assert.equal(resolveTrustProxy("*"), DEFAULT_TRUST_PROXY);
  assert.equal(resolveTrustProxy(" 10.0.0.1 "), "10.0.0.1");
});

test("connected apps are limited to declared scopes and cannot reach admin or raw commands", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-http-scope-"));
  const previousTestMode = process.env.WAND_TEST_MODE;
  process.env.WAND_TEST_MODE = "1";
  t.after(() => {
    if (previousTestMode === undefined) delete process.env.WAND_TEST_MODE;
    else process.env.WAND_TEST_MODE = previousTestMode;
    rmSync(root, { recursive: true, force: true });
  });
  const password = "http-scope-password";
  const appSecret = "http-scope-secret";
  const spawned: TerminalSpawnRequest[] = [];
  let stopped = 0;
  // This test exercises HTTP authorization, not a user's installed provider or
  // shell rc. Record the real spawn request without launching a paid CLI.
  const terminalHost: TerminalHost = {
    persistent: false, attach() { return null; }, forget() {}, disconnect() {},
    async createOrAttach(request) {
      spawned.push(request);
      const incarnationId = `http-scope-${spawned.length}`;
      return { isNew: true, replay: [], process: {
        sessionId: request.sessionId, incarnationId, pid: 0,
        write() {}, resize() {}, kill() { stopped++; },
        onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; },
      }, state: { sessionId: request.sessionId, incarnationId, pid: 0, status: "running", exitCode: null,
        cols: request.cols, rows: request.rows, seq: 0, output: "", chunks: [], terminalSnapshot: null,
        launchMarkerToken: request.launchMarkerToken ?? null } };
    },
  };
  const handle = await startServer({
    ...defaultConfig(),
    host: "127.0.0.1",
    port: 0,
    https: false,
    password,
    appSecret,
    defaultCwd: root,
    startupCommands: [],
  }, path.join(root, "config.json"), { terminalHost });
  t.after(() => handle.close());
  const baseUrl = handle.urls[0].url;
  const appToken = crypto.createHmac("sha256", appSecret).update(password).digest("hex");
  const headers = { authorization: `Bearer ${appToken}`, "content-type": "application/json" };

  // Declared families stay reachable for native clients.
  assert.equal((await fetch(`${baseUrl}/api/tasks`, { headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/workspaces`, { headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/wand-task-actions`, { headers })).status, 200, "native sessions scope can read actions without admin");
  assert.equal((await fetch(`${baseUrl}/api/silicon-employees`, { headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/knowledge/owners`, { headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/knowledge/owners`)).status, 401);

  // Default-deny: admin-only families refuse connected apps before their handlers run.
  assert.equal((await fetch(`${baseUrl}/api/restart`, { method: "POST", headers })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/set-password`, {
    method: "POST", headers, body: JSON.stringify({ password: "another-password" }),
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/update-channel`, { headers })).status, 403);

  // Unified session creation is reachable in the session scope; command strings still require admin.
  assert.equal((await fetch(`${baseUrl}/api/sessions`, { method: "POST", headers,
    body: JSON.stringify({}) })).status, 400, "kind is required before a session is created");
  assert.equal((await fetch(`${baseUrl}/api/sessions`, { method: "POST", headers,
    body: JSON.stringify({ kind: "structured", provider: "opencode", cwd: root }) })).status, 201);
  const legacyMessages = await fetch(`${baseUrl}/api/structured-sessions/not-a-session/messages`, {
    method: "POST", headers, body: JSON.stringify({ input: "no-op" }),
  });
  assert.equal(legacyMessages.status, 404, "sessions-scoped clients retain access to structured message routes");
  const legacyQueue = await fetch(`${baseUrl}/api/structured-sessions/not-a-session/queued`, {
    method: "PATCH", headers, body: JSON.stringify({ order: [] }),
  });
  assert.equal(legacyQueue.status, 400, "sessions-scoped clients retain access to structured queue routes");
  // Raw command strings require admin; provider-based CLI sessions are not rejected by the gate.
  const rawCommand = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST", headers, body: JSON.stringify({ kind: "pty", command: "touch /tmp/should-not-run", provider: "claude", cwd: root }),
  });
  assert.equal(rawCommand.status, 403);
  const noProvider = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST", headers, body: JSON.stringify({ kind: "pty", command: "touch /tmp/should-not-run", cwd: root }),
  });
  assert.equal(noProvider.status, 403);
  // Old clients send the provider id as the command; that is still a provider CLI session.
  const legacyProvider = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST", headers, body: JSON.stringify({ kind: "pty", command: "pi", cwd: root }),
  });
  assert.equal(legacyProvider.status, 201);
  const legacySession = await legacyProvider.json() as { id: string };
  assert.equal(spawned.length, 1, "denied raw commands never reach the terminal host");
  assert.equal(spawned[0]?.sessionId, legacySession.id);
  assert.equal((await fetch(`${baseUrl}/api/sessions/${legacySession.id}/stop`, { method: "POST", headers })).status, 200);
  assert.equal(stopped, 1, "the test explicitly stops its provider fixture");

  // Unauthenticated requests still get 401, and a bad bearer token is counted.
  assert.equal((await fetch(`${baseUrl}/api/tasks`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/wand-task-actions`)).status, 401);
});

test("bearer token failures are rate limited per client", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-http-bearer-"));
  const previousTestMode = process.env.WAND_TEST_MODE;
  process.env.WAND_TEST_MODE = "1";
  t.after(() => {
    if (previousTestMode === undefined) delete process.env.WAND_TEST_MODE;
    else process.env.WAND_TEST_MODE = previousTestMode;
    rmSync(root, { recursive: true, force: true });
  });
  const handle = await startServer({
    ...defaultConfig(),
    host: "127.0.0.1",
    port: 0,
    https: false,
    password: "bearer-limit-password",
    appSecret: "bearer-limit-secret",
    defaultCwd: root,
    startupCommands: [],
  }, path.join(root, "config.json"));
  t.after(() => handle.close());
  const baseUrl = handle.urls[0].url;
  const bad = { authorization: "Bearer deadbeef" };
  let last = 0;
  for (let i = 0; i < 65; i++) {
    last = (await fetch(`${baseUrl}/api/tasks`, { headers: bad })).status;
    if (last === 429) break;
  }
  assert.equal(last, 429, "repeated bearer failures lock the client");
});

test("set-password attempts are rate limited for admin sessions", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-http-setpw-"));
  const previousTestMode = process.env.WAND_TEST_MODE;
  process.env.WAND_TEST_MODE = "1";
  t.after(() => {
    if (previousTestMode === undefined) delete process.env.WAND_TEST_MODE;
    else process.env.WAND_TEST_MODE = previousTestMode;
    rmSync(root, { recursive: true, force: true });
  });
  const password = "setpw-limit-password";
  const handle = await startServer({
    ...defaultConfig(),
    host: "127.0.0.1",
    port: 0,
    https: false,
    password,
    appSecret: "setpw-limit-secret",
    defaultCwd: root,
    startupCommands: [],
  }, path.join(root, "config.json"));
  t.after(() => handle.close());
  const baseUrl = handle.urls[0].url;
  const login = await fetch(`${baseUrl}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  let last = 0;
  for (let i = 0; i < 25; i++) {
    last = (await fetch(`${baseUrl}/api/set-password`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ password: "x" }),
    })).status;
    if (last === 429) break;
  }
  assert.equal(last, 429);
});
