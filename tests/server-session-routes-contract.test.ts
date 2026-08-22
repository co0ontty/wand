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
import { registerClaudeHistoryRoutes, registerSessionRoutes } from "../src/server-session-routes.js";
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
  registerClaudeHistoryRoutes(app, processes, structured, storage, sessions);
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

    for (const provider of ["claude", "codex", "opencode", "qoder"]) {
      const historyResponse = await fetch(`${baseUrl}/api/${provider}-history`);
      assert.equal(historyResponse.status, 200);
      assert.deepEqual(await historyResponse.json(), []);
    }

    const firstPageResponse = await fetch(`${baseUrl}/api/session-list?offset=0&limit=1`);
    assert.equal(firstPageResponse.status, 200);
    const firstPage = await firstPageResponse.json() as { entries: Array<{ key: string }>; revision: string };
    assert.deepEqual(firstPage.entries.map((entry) => entry.key), [`session-${created.id}`]);
    assert.equal(typeof firstPage.revision, "string");

    const unchangedResponse = await fetch(
      `${baseUrl}/api/session-list?offset=0&limit=1&revision=${encodeURIComponent(firstPage.revision)}`,
    );
    assert.equal(unchangedResponse.status, 200);
    const unchanged = await unchangedResponse.json() as { unchanged?: boolean; entries: unknown[]; revision: string };
    assert.equal(unchanged.unchanged, true);
    assert.deepEqual(unchanged.entries, []);
    assert.equal(unchanged.revision, firstPage.revision);

    const directoriesResponse = await fetch(`${baseUrl}/api/session-directories`);
    assert.equal(directoriesResponse.status, 200);
    type DirectoryNode = {
      path: string;
      name: string;
      customName?: string;
      directCount: number;
      totalCount: number;
      entries: Array<{ key: string }>;
      children: DirectoryNode[];
    };
    const directories = await directoriesResponse.json() as {
      roots: DirectoryNode[];
      totalSessions: number;
      directoryCount: number;
      revision: string;
      treeRevision: string;
    };
    const findDirectory = (nodes: DirectoryNode[], target: string): DirectoryNode | undefined => {
      for (const node of nodes) {
        if (node.path === target) return node;
        const nested = findDirectory(node.children, target);
        if (nested) return nested;
      }
      return undefined;
    };
    const createdDirectory = findDirectory(directories.roots, root);
    assert.ok(directories.totalSessions >= 1);
    assert.ok(directories.directoryCount >= 1);
    assert.ok(createdDirectory);
    assert.ok(createdDirectory.directCount >= 1);
    assert.ok(createdDirectory.totalCount >= 1);
    assert.ok(createdDirectory.entries.some((entry) => entry.key === `session-${created.id}`));
    assert.equal(directories.revision, firstPage.revision);
    assert.equal(directories.treeRevision, directories.revision);

    const renameResponse = await fetch(`${baseUrl}/api/session-directories/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: `${root}/`, name: "  演示工作区  " }),
    });
    assert.equal(renameResponse.status, 200);
    assert.deepEqual(await renameResponse.json(), { ok: true, path: root, name: "演示工作区" });

    const renamedDirectories = await (await fetch(`${baseUrl}/api/session-directories`)).json() as {
      roots: DirectoryNode[];
      revision: string;
      treeRevision: string;
    };
    const renamedDirectory = findDirectory(renamedDirectories.roots, root);
    assert.equal(renamedDirectory?.customName, "演示工作区");
    assert.equal(renamedDirectory?.name, createdDirectory.name);
    assert.equal(renamedDirectories.revision, directories.revision);
    assert.notEqual(renamedDirectories.treeRevision, directories.treeRevision);

    const tooLongName = await fetch(`${baseUrl}/api/session-directories/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root, name: "x".repeat(81) }),
    });
    assert.equal(tooLongName.status, 400);
    const multilineName = await fetch(`${baseUrl}/api/session-directories/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root, name: "两行\n名称" }),
    });
    assert.equal(multilineName.status, 400);
    const missingDirectory = await fetch(`${baseUrl}/api/session-directories/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(root, "missing"), name: "Missing" }),
    });
    assert.equal(missingDirectory.status, 404);

    const resetNameResponse = await fetch(`${baseUrl}/api/session-directories/name`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root, name: null }),
    });
    assert.equal(resetNameResponse.status, 200);
    assert.deepEqual(await resetNameResponse.json(), { ok: true, path: root, name: null });
    const resetDirectories = await (await fetch(`${baseUrl}/api/session-directories`)).json() as {
      roots: DirectoryNode[];
      revision: string;
      treeRevision: string;
    };
    assert.equal(findDirectory(resetDirectories.roots, root)?.customName, undefined);
    assert.equal(resetDirectories.revision, directories.revision);
    assert.equal(resetDirectories.treeRevision, directories.treeRevision);

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

test("session list and detail DTOs keep workspace binding and queue skills", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-session-dto-"));
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
      body: JSON.stringify({
        cwd: root,
        provider: "opencode",
        mode: "assist",
        workspaceId: "ws-dto",
        workspaceTaskId: "task-dto",
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as {
      id: string;
      workspaceId?: string;
      workspaceTaskId?: string;
    };
    assert.equal(created.workspaceId, "ws-dto");
    assert.equal(created.workspaceTaskId, "task-dto");

    const listed = await (await fetch(`${baseUrl}/api/sessions`)).json() as Array<{
      id: string;
      workspaceId?: string;
      workspaceTaskId?: string;
    }>;
    const item = listed.find((session) => session.id === created.id);
    assert.ok(item);
    assert.equal(item.workspaceId, "ws-dto");
    assert.equal(item.workspaceTaskId, "task-dto");

    const page = await (await fetch(`${baseUrl}/api/session-list?limit=10`)).json() as {
      entries: Array<{ session: { id: string; workspaceId?: string; workspaceTaskId?: string } }>;
    };
    const pageItem = page.entries.find((entry) => entry.session.id === created.id);
    assert.ok(pageItem);
    assert.equal(pageItem.session.workspaceId, "ws-dto");
    assert.equal(pageItem.session.workspaceTaskId, "task-dto");

    const detail = await (await fetch(`${baseUrl}/api/sessions/${created.id}`)).json() as {
      workspaceId?: string;
      workspaceTaskId?: string;
    };
    assert.equal(detail.workspaceId, "ws-dto");
    assert.equal(detail.workspaceTaskId, "task-dto");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    processes.dispose();
    structured.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
