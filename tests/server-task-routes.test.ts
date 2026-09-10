import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { defaultConfig } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";

function start(storage: WandStorage): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express(); app.use(express.json()); registerTaskRoutes(app, storage); app.use(jsonErrorHandler);
  const server = createServer(app);
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); const address = server.address() as { port: number }; resolve({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => server.close(() => done())) }); }); });
}

test("task board creates, moves, binds, and deletes tasks", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-board-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root });
  const server = await start(storage);
  try {
    const created = await fetch(`${server.url}/api/wand-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "看板任务", status: "todo", priority: "high", labels: ["mvp"] }) }).then((response) => response.json()) as { id: string; status: string; labels: string[] };
    assert.equal(created.status, "todo"); assert.deepEqual(created.labels, ["mvp"]);
    const session = manager.createSession({ cwd: root, provider: "codex", mode: "full-access" });
    const moved = await fetch(`${server.url}/api/wand-tasks/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "doing" }) }).then((response) => response.json()) as { status: string };
    assert.equal(moved.status, "doing");
    const bound = await fetch(`${server.url}/api/wand-tasks/${created.id}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: session.id }) }).then((response) => response.json()) as { sessionIds: string[] };
    assert.deepEqual(bound.sessionIds, [session.id]);
    assert.equal((await fetch(`${server.url}/api/wand-tasks`).then((response) => response.json()) as unknown[]).length, 1);
  } finally { await server.close(); manager.dispose(); storage.close(); }
});
