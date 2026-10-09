import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { registerDaemonMaintenanceRoutes } from "../src/server-daemon-maintenance-routes.js";

test("maintenance GET is read-only; forced update needs admin and literal confirmation, failure hides internals", async () => {
  const app = express(); app.use(express.json());
  let updates = 0, fail = false, logs = 0;
  registerDaemonMaintenanceRoutes(app, {
    requireAdmin(req, res, next) { if (req.headers["x-fixture-admin"] !== "yes") { res.status(403).json({ error: "forbidden" }); return; } next(); },
    canForceUpdate: req => req.headers["x-fixture-admin"] === "yes",
    maintenance: { status: () => ({ pending: true, phase: "waiting" }),
      async forceUpdate() { updates++; if (fail) throw new Error("private-daemon-path-and-token"); return { pending: false, phase: "idle" }; } },
    log: () => { logs++; },
  });
  const server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/daemon-maintenance`;
  try {
    const status = await fetch(base);
    assert.deepEqual(await status.json(), { pending: true, phase: "waiting", canForceUpdate: false });
    assert.equal(status.headers.get("cache-control"), "no-store"); assert.equal(updates, 0);
    const submit = (admin: boolean, body: unknown) => fetch(base + "/force-update", {
      method: "POST", headers: { "content-type": "application/json", "x-fixture-admin": admin ? "yes" : "no" }, body: JSON.stringify(body),
    });
    assert.equal((await submit(false, { confirmInterrupt: true, admin: true })).status, 403);
    for (const body of [{}, { confirmInterrupt: "true" }, { confirmInterrupt: false }]) assert.equal((await submit(true, body)).status, 400);
    assert.equal(updates, 0);
    const accepted = await submit(true, { confirmInterrupt: true });
    assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), { pending: false, phase: "idle" });
    assert.equal(updates, 1);
    fail = true;
    const failure = await submit(true, { confirmInterrupt: true });
    assert.equal(failure.status, 409); assert.doesNotMatch(await failure.text(), /private-daemon/); assert.equal(logs, 1);
  } finally { server.close(); await once(server, "close"); }
});
