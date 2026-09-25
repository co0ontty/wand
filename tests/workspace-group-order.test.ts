// 首页目录组顺序：拖动排序必须持久化在同一台服务器的 SQLite 里，各端共用，重启不丢。
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
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

interface TaskGroup {
  workspaceId: string;
  workspaceName: string;
}

async function startApp(root: string): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, processes, structured, storage, config.defaultMode, config, sessions);
  registerWorkspaceRoutes(app, storage, sessions);
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      structured.dispose?.();
      server.close(() => {
        storage.close();
        resolve();
      });
    }),
  };
}

async function createWorkspace(baseUrl: string, name: string, cwd: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/workspaces`, json("POST", { name, cwd }));
  assert.equal(response.status, 201);
  const created = await response.json() as { id: string };
  return created.id;
}

async function listGroupIds(baseUrl: string): Promise<string[]> {
  const groups = await fetch(`${baseUrl}/api/tasks`).then((r) => r.json()) as TaskGroup[];
  return groups.map((group) => group.workspaceId);
}

test("拖动顺序持久化到服务端，重启后仍然生效", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-group-order-"));
  const dirs = ["a", "b", "c"].map((name) => mkdtempSync(path.join(root, name)));
  const app = await startApp(root);
  let dragged: string[] = [];
  try {
    // 建 3 个项目：默认顺序是「全局组优先 + 创建时间倒序」，一定不是我们下面拖出来的顺序。
    const created = [];
    for (const [index, dir] of dirs.entries()) {
      created.push(await createWorkspace(app.baseUrl, `项目${index}`, dir));
    }
    const [a, b, c] = created;
    dragged = [c, a, b];
    assert.notDeepEqual(await listGroupIds(app.baseUrl), dragged);
    const before = await fetch(`${app.baseUrl}/api/tasks?revision=`).then((r) => r.json()) as {
      revision: string;
    };

    const saved = await fetch(`${app.baseUrl}/api/workspaces/order`, json("PUT", {
      ids: dragged,
    }));
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json() as { ids: string[] }).ids, dragged);
    assert.deepEqual(await listGroupIds(app.baseUrl), dragged);
    // 第二个客户端拿着排序前的 revision 轮询，也要能发现「只有顺序变了」。
    const after = await fetch(`${app.baseUrl}/api/tasks?revision=${encodeURIComponent(before.revision)}`)
      .then((r) => r.json()) as { unchanged: boolean; revision: string; groups: TaskGroup[] };
    assert.equal(after.unchanged, false);
    assert.notEqual(after.revision, before.revision);
    assert.deepEqual(after.groups.map((group) => group.workspaceId), dragged);
    const unchanged = await fetch(`${app.baseUrl}/api/tasks?revision=${encodeURIComponent(after.revision)}`)
      .then((r) => r.json()) as { unchanged: boolean };
    assert.equal(unchanged.unchanged, true);
  } finally {
    await app.close();
  }

  // 换一个进程重新打开同一个库：顺序来自 SQLite 偏好，不是内存状态。
  const restarted = await startApp(root);
  try {
    assert.deepEqual(await listGroupIds(restarted.baseUrl), dragged);
  } finally {
    await restarted.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("只提交部分分组时，其余分组的相对顺序不被抹掉", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-group-order-partial-"));
  const app = await startApp(root);
  try {
    const dirs = ["x", "y", "z"].map((name) => mkdtempSync(path.join(root, name)));
    const [x, y, z] = await Promise.all(dirs.map((dir, index) =>
      createWorkspace(app.baseUrl, `项目${index}`, dir)));

    assert.equal((await fetch(`${app.baseUrl}/api/workspaces/order`, json("PUT", {
      ids: [z, y, x],
    }))).status, 200);

    // 第二个客户端只知道 z，把它排到最前面：y/x 的相对顺序必须保持。
    const partial = await fetch(`${app.baseUrl}/api/workspaces/order`, json("PUT", {
      ids: [z],
    }));
    assert.equal(partial.status, 200);
    assert.deepEqual((await partial.json() as { ids: string[] }).ids, [z, y, x]);
    assert.deepEqual(await listGroupIds(app.baseUrl), [z, y, x]);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("删除工作区会清掉它的排序位，重复 id 与非法输入被忽略", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-group-order-delete-"));
  const app = await startApp(root);
  try {
    const dirs = ["m", "n"].map((name) => mkdtempSync(path.join(root, name)));
    const [m, n] = await Promise.all(dirs.map((dir, index) =>
      createWorkspace(app.baseUrl, `项目${index}`, dir)));

    await fetch(`${app.baseUrl}/api/workspaces/order`, json("PUT", { ids: [n, m, n, "  ", 7] }));
    const listed = await listGroupIds(app.baseUrl);
    assert.deepEqual(listed, [n, m]);

    assert.equal((await fetch(`${app.baseUrl}/api/workspaces/${encodeURIComponent(n)}`, {
      method: "DELETE",
    })).status, 200);
    assert.deepEqual(await listGroupIds(app.baseUrl), [m]);

    // 删除后顺序里不再留 n，重新建一个 id 不重名的项目默认可排到最后。
    const fresh = await createWorkspace(app.baseUrl, "新项目", mkdtempSync(path.join(root, "o")));
    const afterCreate = await listGroupIds(app.baseUrl);
    assert.deepEqual(afterCreate, [m, fresh]);

    assert.equal((await fetch(`${app.baseUrl}/api/workspaces/order`, json("PUT", {}))).status, 400);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
