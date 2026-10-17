import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import { taskDispatchReceipt } from "../src/task-dispatch-receipt.js";
import type { WandStorage } from "../src/storage.js";

test("same dispatch receipt never starts a second execution, including response loss and unknown delivery", async t => {
  const receipts = new Map();
  const storage = { transaction: (action: () => unknown) => action(), getPreference: (key: string, fallback: unknown) => receipts.get(key) ?? fallback, setPreference: (key: string, value: unknown) => receipts.set(key, value) } as WandStorage;
  let calls = 0;
  let release: (() => void) | undefined;
  const app = express(); app.use(express.json());
  app.post("/tasks/:id/dispatch", taskDispatchReceipt(storage), async (req, res) => {
    calls++;
    if (req.params.id === "concurrent") await new Promise<void>(resolve => { release = resolve; });
    if (req.params.id === "unknown") { res.status(503).json({ error: "unknown" }); return; }
    res.status(202).json({ session: { id: "exact-execution" } });
  });
  const server = app.listen(0, "127.0.0.1"); await once(server,"listening");t.after(() => server.close());
  const address = server.address();assert.ok(address&&typeof address === "object");
  const send = (task: string, requestId = "request-1234") => fetch(`http://127.0.0.1:${address.port}/tasks/${task}/dispatch`, { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({requestId}) });
  assert.equal((await send("accepted")).status, 202);
  assert.equal((await (await send("accepted")).json()).session.id,"exact-execution");assert.equal(calls,1);
  assert.equal((await send("accepted", "second-request")).status,202);
  assert.equal((await send("accepted")).status,202);
  assert.equal(calls,2,"an older accepted request remains idempotent after a later dispatch");
  const changed = await fetch(`http://127.0.0.1:${address.port}/tasks/accepted/dispatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "request-1234", prompt: "new input must not be acknowledged by an old receipt" }) });
  assert.equal(changed.status,409);
  assert.equal(calls,2,"an old accepted response cannot clear a different draft");
  const first = send("concurrent");while(!release) await new Promise(resolve => setTimeout(resolve,1));
  assert.equal((await send("concurrent", "another-request")).status,409);release();assert.equal((await first).status,202);assert.equal(calls,3);
  assert.equal((await send("unknown")).status,503);assert.equal((await send("unknown")).status,409);assert.equal(calls,4);
  assert.equal((await send("unknown","new-request-123")).status,409,"a different request ID cannot replay unknown delivery");
});
