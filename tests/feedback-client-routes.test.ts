import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { FeedbackReceiver, FeedbackReporter, parseClientFeedback, sanitizeFeedbackText } from "../src/feedback.js";
import { feedbackFeatureForApiPath } from "../src/feedback-feature-map.js";
import { feedbackRequestSecrets, registerFeedbackClientRoutes } from "../src/server-feedback-routes.js";
import { createApiScopeMiddleware, requiredApiScope } from "../src/middleware/api-scope.js";

const diagnostic = (source = "web") => ({ schema: 1, source, event: "update_failed", version: "4.99.0", error: {
  name: "IOException", code: "ENOSPC", message: "Download failed: No space left on device", stack: "IOException: No space left on device\n at UpdateManager.download(UpdateManager.java:393)",
} });

test("client protocol retains original error text and accepts the same contract on all four platforms", () => {
  for (const source of ["web", "macos", "android", "ios"]) assert.equal(parseClientFeedback(diagnostic(source)).source, source);
  assert.throws(() => parseClientFeedback({ ...diagnostic(), environment: { token: "secret" } }));
  assert.throws(() => parseClientFeedback({ ...diagnostic(), source: "other" }));
  assert.throws(() => parseClientFeedback({ ...diagnostic(), username: "客户端伪造姓名" }));
  assert.throws(() => parseClientFeedback({ ...diagnostic(), feature: "__proto__" }));
  assert.equal(parseClientFeedback({ ...diagnostic(), feature: "tasks" }).feature, "tasks");
  assert.throws(() => parseClientFeedback({ ...diagnostic(), error: { name: "Error", message: "a".repeat(8193) } }), RangeError);
  assert.throws(() => parseClientFeedback({ ...diagnostic(), error: { name: "Error", message: "x", stack: "a".repeat(16385) } }), RangeError);
  const raw = 'fetch failed: Authorization: Bearer aaa\npassword="secret password" api_key=abcd token=efgh\nhttps://name:pass@example.test/a?access_token=secret\nknown-opaque-secret';
  const clean = sanitizeFeedbackText(raw, ["known-opaque-secret"]);
  assert.doesNotMatch(clean, /aaa|secret password|abcd|efgh|name:pass|access_token=secret|known-opaque-secret/);
  assert.match(clean, /fetch failed/);
  assert.match(clean, /\[REDACTED\]/);
  assert.ok(Buffer.byteLength(sanitizeFeedbackText("啊".repeat(10000))) <= 8192);
  assert.equal(requiredApiScope("/api/feedback/client"), "sessions");
  assert.equal(requiredApiScope("/api/feedback/reports"), "admin");
  assert.equal(feedbackFeatureForApiPath("/api/sessions/private-id/messages"), "sessions");
  assert.equal(feedbackFeatureForApiPath("/api/wand-tasks/private-id/comments"), "tasks");
  assert.equal(feedbackFeatureForApiPath("/api/not-a-known-route"), "api");
  assert.equal(feedbackFeatureForApiPath("/api/workspaces/private-id"), "tasks");
  assert.equal(feedbackFeatureForApiPath("/api/android-apk-update?currentVersion=1.2.3"), "app_update");
  assert.equal(feedbackFeatureForApiPath("/api/model-groups"), "models");
  assert.equal(feedbackFeatureForApiPath("/api/__proto__"), "api");
  const secretValues = feedbackRequestSecrets({ headers: { authorization: "Bearer opaque-auth-value", cookie: "session=opaque-cookie-value; other=short" } });
  assert.equal(sanitizeFeedbackText("opaque-auth-value opaque-cookie-value short", secretValues), "[REDACTED] [REDACTED] [REDACTED]");
  assert.equal(sanitizeFeedbackText("weak 123", ["123"]), "weak [REDACTED]");
});

test("authenticated client relay sends original diagnostics encrypted and never forwards Wand credentials", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-feedback-relay-"));
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const file = path.join(root, "private.pem");
  writeFileSync(file, keys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const receiver = new FeedbackReceiver(root, file);
  let posts = 0;
  const reporter = new FeedbackReporter({ configDir: root, version: "4.99.1", env: {}, secrets: () => ["known-server-secret"], fetch: async (_url, init) => {
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    if (!init?.method) return Response.json(receiver.publicInfo());
    posts++; receiver.accept(JSON.parse(String(init.body))); return new Response(null, { status: 202 });
  } });
  const app = express(); app.use(express.json({ limit: "32kb" }));
  app.use("/api", (req, res, next) => {
    if (!req.headers.authorization) { res.sendStatus(401); return; }
    req.principal = { kind: "app", scopes: req.headers["x-test-no-scope"] ? [] : ["sessions"] } as never;
    next();
  });
  app.use("/api", createApiScopeMiddleware());
  registerFeedbackClientRoutes(app, reporter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { reporter.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/feedback/client`;
  const payload = diagnostic("android");
  payload.error.message += " known-server-secret opaque-client-token";
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post(payload)).status, 401);
  assert.equal((await post(payload, { Authorization: "Bearer opaque-client-token", "x-test-no-scope": "1" })).status, 403);
  assert.equal((await post(payload, { Authorization: "Bearer opaque-client-token" })).status, 202);
  await reporter.flush();
  assert.equal(posts, 1);
  const log = receiver.latest()[0]!.report;
  assert.equal(log.source, "android"); assert.equal(log.clientVersion, "4.99.0"); assert.equal(log.version, "4.99.1");
  assert.match(log.error.message, /No space left on device/);
  assert.doesNotMatch(log.error.message, /known-server-secret|opaque-client-token/);
  assert.equal(log.error.stack, payload.error.stack);
  assert.equal((await post({ ...payload, arbitrary: "extra" }, { Authorization: "Bearer opaque-client-token" })).status, 400);
});
