import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { registerLocalModelRoutes } from "../src/server-local-model-routes.ts";
import type { LocalModelSetupService } from "../src/local-model-setup.ts";
import { DecisionError } from "../src/decision-types.ts";

test("model install/download/config require admin, status requires sessions and credentials never authorize another scope", async t => {
  const calls: unknown[] = [];
  const app = express(); app.use(express.json());
  app.use("/api", (req, res, next) => { if (!req.headers.authorization) res.status(401).end(); else next(); });
  registerLocalModelRoutes(app, {
    models: { status: async () => ({ laya: {}, speech: {} }), start: (...args: unknown[]) => {
      const body = args[2] as Record<string, unknown>;
      if (Object.keys(body).some(key => !["model", "backend"].includes(key))) throw new DecisionError("INVALID_REQUEST", "不允许命令和路径");
      calls.push(args);
    }, cancel: (kind: string) => calls.push(kind), setLayaEnabled: (enabled: boolean) => calls.push(enabled),
      setSpeechEnabled: async (enabled: boolean) => { calls.push(["speech", enabled]); } } as unknown as LocalModelSetupService,
    requireSessions: (req, res, next) => { if (req.headers.authorization === "files") res.status(403).end(); else next(); },
    requireAdmin: (req, res, next) => { if (req.headers.authorization !== "admin") res.status(403).end(); else next(); },
  });
  const server = createServer(app); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/local-models`;
  const request = (route: string, method = "GET", auth = "app", value?: unknown) => fetch(url + route, { method,
    headers: { authorization: auth, ...(value ? { "content-type": "application/json" } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) });
  assert.equal((await fetch(url + "/status")).status, 401);
  assert.equal((await request("/status", "GET", "files")).status, 403);
  const status = await request("/status"); assert.equal(status.status, 200); assert.equal(status.headers.get("cache-control"), "no-store");
  for (const action of ["download", "initialize", "cancel"]) assert.equal((await request(`/laya/${action}`, "POST", "app", {})).status, 403);
  assert.equal((await request("/laya/settings", "PATCH", "app", { enabled: true })).status, 403);
  assert.equal((await request("/speech/settings", "PATCH", "app", { enabled: true })).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await request("/laya/download", "POST", "admin", {})).status, 202);
  assert.equal((await request("/speech/initialize", "POST", "admin", { command: "sudo" })).status, 400);
  assert.equal((await request("/evil/download", "POST", "admin", {})).status, 404);
  assert.equal((await request("/laya/settings", "PATCH", "admin", { enabled: true, pythonPath: "/tmp/evil" })).status, 400);
  assert.equal((await request("/laya/settings", "PATCH", "admin", { enabled: false })).status, 200);
  assert.equal(calls.length, 2);
  for (const body of [{ enabled: true, command: "sudo" }, { enabled: "true" }, [], {}]) {
    assert.equal((await request("/speech/settings", "PATCH", "admin", body)).status, 400);
  }
  assert.equal((await request("/speech/settings", "PATCH", "admin", { enabled: true })).status, 202);
  assert.deepEqual(calls.at(-1), ["speech", true]);
});
