import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { jsonErrorHandler } from "../src/express-async.ts";
import { registerStorageCleanupRoutes } from "../src/server-storage-cleanup-routes.ts";
import type { StorageCleanup } from "../src/storage-cleanup.ts";

test("cleanup is admin-only, GET never applies deletion, arbitrary paths are refused, busy work conflicts", async t => {
  const app = express(); app.use(express.json());
  let running = false; const calls: boolean[] = [];
  const cleanup = { status: () => ({ enabled: true, running }), run: async (apply = false) => { calls.push(apply); return { applied: apply }; } } as unknown as StorageCleanup;
  registerStorageCleanupRoutes(app, cleanup, (req, res, next) => { if (req.headers.authorization !== "admin") res.sendStatus(403); else next(); });
  app.use(jsonErrorHandler);
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/storage-cleanup`;
  const request = (route: string, method = "GET", auth = "admin", body?: unknown) => fetch(base + route, { method,
    headers: { authorization: auth, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  for (const auth of ["", "app", "files", "sessions"]) {
    assert.equal((await request("/status", "GET", auth)).status, 403);
    assert.equal((await request("/preview", "GET", auth)).status, 403);
    assert.equal((await request("/run", "POST", auth, {})).status, 403);
  }
  assert.deepEqual(calls, []);
  const status = await request("/status"); assert.equal(status.status, 200); assert.equal(status.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, []);
  assert.equal((await request("/preview")).status, 200); assert.deepEqual(calls, [false]);
  for (const body of [{ path: "/" }, { retentionDays: 0 }, [], null, "all"]) assert.equal((await request("/run", "POST", "admin", body)).status, 400);
  assert.equal((await request("/run", "POST", "admin", {})).status, 200); assert.deepEqual(calls, [false, true]);
  running = true;
  assert.equal((await request("/preview")).status, 409); assert.equal((await request("/run", "POST", "admin", {})).status, 409);
  assert.deepEqual(calls, [false, true]);
});
