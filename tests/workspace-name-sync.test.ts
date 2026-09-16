// 目录显示名（工作区名称）与项目名必须同步：任意一端改名，各端拿到的都是同一个名字。
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
  workspaceCwd: string;
  synthetic?: boolean;
  global?: boolean;
}

interface DirectoryNode {
  path: string;
  name: string;
  customName?: string;
  children?: DirectoryNode[];
}

interface WorkspaceRow {
  id: string;
  name: string;
  cwd: string;
}

function findNode(nodes: readonly DirectoryNode[], target: string): DirectoryNode | undefined {
  for (const node of nodes) {
    if (node.path === target) return node;
    const hit = findNode(node.children ?? [], target);
    if (hit) return hit;
  }
  return undefined;
}

async function startApp(root: string): Promise<{
  baseUrl: string;
  storage: WandStorage;
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
    storage,
    close: () => new Promise<void>((resolve) => {
      structured.dispose?.();
      server.close(() => resolve());
    }),
  };
}

test("无会话项目的侧边栏目录改名只更新别名，不改变工作路径", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-name-sync-"));
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "wand-name-project-"));
  const { baseUrl, close } = await startApp(root);
  try {
    const created = await fetch(`${baseUrl}/api/workspaces`, json("POST", {
      name: "初始项目", cwd: projectDir,
    }));
    assert.equal(created.status, 201);
    const workspace = await created.json() as WorkspaceRow;

    const renamed = await fetch(`${baseUrl}/api/session-directories/name`, json("PUT", {
      path: projectDir, name: "显示别名",
    }));
    assert.equal(renamed.status, 200);
    assert.deepEqual(await renamed.json(), { ok: true, path: projectDir, name: "显示别名" });

    const listed = await fetch(`${baseUrl}/api/workspaces`).then((response) => response.json()) as WorkspaceRow[];
    assert.equal(listed.find((item) => item.id === workspace.id)?.cwd, projectDir);
    assert.equal(listed.find((item) => item.id === workspace.id)?.name, "显示别名");
    const groups = await fetch(`${baseUrl}/api/tasks`).then((response) => response.json()) as TaskGroup[];
    assert.equal(groups.find((group) => group.workspaceId === workspace.id)?.workspaceCwd, projectDir);
    assert.equal(groups.find((group) => group.workspaceId === workspace.id)?.workspaceName, "显示别名");
    assert.equal((await fetch(`${baseUrl}/api/session-directories/name`, json("PUT", {
      path: "显示别名", name: "错误路径",
    }))).status, 404);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("目录工作区名称与项目名双向同步，且改名会刷新任务聚合 revision", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-name-sync-"));
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "wand-name-project-"));
  const { baseUrl, close } = await startApp(root);
  try {
    // 建一个会话，让该目录出现在会话目录树里（rename 路由要求目录已存在）。
    const created = await fetch(`${baseUrl}/api/structured-sessions`, json("POST", {
      cwd: projectDir,
      provider: "opencode",
      mode: "assist",
    }));
    assert.equal(created.status, 201);

    const tasksBefore = await fetch(`${baseUrl}/api/tasks?revision=`).then((r) => r.json()) as {
      groups?: TaskGroup[];
      revision?: string;
    };
    const groupsBefore = tasksBefore.groups ?? [];
    const baseline = groupsBefore.find((group) => group.workspaceCwd === projectDir);
    assert.ok(baseline, "会话所在目录应出现在任务聚合里");
    assert.equal(baseline.workspaceName, path.basename(projectDir));

    // 1) 会话目录改名（iOS「重命名工作区」）→ 项目名同步。
    const renamed = await fetch(`${baseUrl}/api/session-directories/name`, json("PUT", {
      path: projectDir,
      name: "  核心工作区  ",
    }));
    assert.equal(renamed.status, 200);
    assert.deepEqual(await renamed.json(), { ok: true, path: projectDir, name: "核心工作区" });

    const tasksAfter = await fetch(`${baseUrl}/api/tasks`).then((r) => r.json()) as TaskGroup[];
    const groupAfter = tasksAfter.find((group) => group.workspaceCwd === projectDir);
    assert.equal(groupAfter?.workspaceName, "核心工作区");

    const listed = await fetch(`${baseUrl}/api/workspaces`).then((r) => r.json()) as WorkspaceRow[];
    const workspace = listed.find((item) => item.cwd === projectDir);
    assert.equal(workspace?.name, "核心工作区");

    // 2) 反向：项目改名 → 会话目录自定义名同步。
    assert.ok(workspace);
    const patched = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, json("PATCH", { name: "重命名后的项目" }));
    assert.equal(patched.status, 200);

    const tree = await fetch(`${baseUrl}/api/session-directories`).then((r) => r.json()) as {
      roots: DirectoryNode[];
    };
    assert.equal(findNode(tree.roots, projectDir)?.customName, "重命名后的项目");

    const tasksAfterPatch = await fetch(`${baseUrl}/api/tasks`).then((r) => r.json()) as TaskGroup[];
    assert.equal(
      tasksAfterPatch.find((group) => group.workspaceCwd === projectDir)?.workspaceName,
      "重命名后的项目",
    );

    // 3) 改名必须让 revision 失效，否则客户端会一直显示旧名字。
    const beforeRename = await fetch(`${baseUrl}/api/tasks?revision=`).then((r) => r.json()) as {
      groups: TaskGroup[];
      revision: string;
    };
    const staleCheck = await fetch(
      `${baseUrl}/api/tasks?revision=${encodeURIComponent(beforeRename.revision)}`,
    ).then((r) => r.json()) as { unchanged?: boolean };
    assert.equal(staleCheck.unchanged, true, "未改名时 revision 应命中缓存");

    await fetch(`${baseUrl}/api/session-directories/name`, json("PUT", { path: projectDir, name: "再次改名" }));
    const afterRename = await fetch(
      `${baseUrl}/api/tasks?revision=${encodeURIComponent(beforeRename.revision)}`,
    ).then((r) => r.json()) as { unchanged?: boolean; groups?: TaskGroup[] };
    assert.notEqual(afterRename.unchanged, true, "改名后 revision 必须失效");
    assert.equal(
      afterRename.groups?.find((group) => group.workspaceCwd === projectDir)?.workspaceName,
      "再次改名",
    );

    // 4) 清空名字 = 恢复目录名，项目名同样回退。
    await fetch(`${baseUrl}/api/session-directories/name`, json("PUT", { path: projectDir, name: "   " }));
    const tasksReset = await fetch(`${baseUrl}/api/tasks`).then((r) => r.json()) as TaskGroup[];
    assert.equal(
      tasksReset.find((group) => group.workspaceCwd === projectDir)?.workspaceName,
      path.basename(projectDir),
    );
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});
