import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { defaultConfig } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { ProcessManager } from "../src/process-manager.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";

test("session HTTP interface preserves create, list, update, detail, and delete behavior", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-session-routes-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, processes, structured, storage, config.defaultMode, config, sessions);
  app.use(jsonErrorHandler);
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const createdResponse = await fetch(`${baseUrl}/api/structured-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: root, provider: "opencode", mode: "assist" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { id: string; sessionKind: string; provider: string; output: string };
    assert.equal(created.sessionKind, "structured");
    assert.equal(created.provider, "opencode");
    assert.equal(created.output, "");

    const listResponse = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json() as Array<{ id: string; output: string }>;
    assert.deepEqual(listed.map((session) => session.id), [created.id]);
    assert.equal(listed[0].output, "");

    const firstPageResponse = await fetch(`${baseUrl}/api/session-list?offset=0&limit=1`);
    assert.equal(firstPageResponse.status, 200);
    const firstPage = await firstPageResponse.json() as { entries: Array<{ key: string }>; revision: string };
    assert.deepEqual(firstPage.entries.map((entry) => entry.key), [`session-${created.id}`]);
    assert.equal(typeof firstPage.revision, "string");

    const stalePageResponse = await fetch(
      `${baseUrl}/api/session-list?offset=1&limit=1&revision=${encodeURIComponent(firstPage.revision)}&cacheBust=1`,
    );
    assert.equal(stalePageResponse.status, 200);

    const secondCreatedResponse = await fetch(`${baseUrl}/api/structured-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: root, provider: "opencode", mode: "assist" }),
    });
    assert.equal(secondCreatedResponse.status, 201);

    const changedPageResponse = await fetch(
      `${baseUrl}/api/session-list?offset=1&limit=1&revision=${encodeURIComponent(firstPage.revision)}&cacheBust=2`,
    );
    assert.equal(changedPageResponse.status, 409);

    for (const [endpoint, body] of [
      ["model", { model: "anthropic/claude-sonnet-4-6" }],
      ["thinking-effort", { thinkingEffort: "deep" }],
      ["mode", { mode: "managed" }],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/sessions/${created.id}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
    }

    const detailResponse = await fetch(`${baseUrl}/api/sessions/${created.id}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { selectedModel: string; thinkingEffort: string; mode: string };
    assert.equal(detail.selectedModel, "anthropic/claude-sonnet-4-6");
    assert.equal(detail.thinkingEffort, "deep");
    assert.equal(detail.mode, "managed");

    const deleteResponse = await fetch(`${baseUrl}/api/sessions/${created.id}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(await deleteResponse.json(), { ok: true });
    assert.equal((await fetch(`${baseUrl}/api/sessions/${created.id}`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    processes.dispose();
    structured.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
