import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { defaultConfig } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { registerTaskRoutes, whenWandTaskTitlesSettled } from "../src/server-task-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";

interface Harness {
  url: string;
  storage: WandStorage;
  manager: StructuredSessionManager;
  registry: SessionRegistry;
  close: () => Promise<void>;
}

function start(
  storage: WandStorage,
  manager: StructuredSessionManager,
  registry: SessionRegistry,
  config = defaultConfig(),
  extra: Partial<Pick<Parameters<typeof registerTaskRoutes>[1] & object, "generateTitle">> = {},
): Promise<Harness> {
  const app = express();
  app.use(express.json());
  registerTaskRoutes(app, { storage, sessions: registry, structured: manager, config, ...extra });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        storage,
        manager,
        registry,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function withHarness(
  run: (ctx: Harness) => Promise<void>,
  options: { generateTitle?: (description: string) => Promise<string> } = {},
): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-task-board-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root };
  const manager = new StructuredSessionManager(storage, config);
  // Task routes only ever read the registry, so the PTY manager can stay absent.
  const registry = new SessionRegistry({ getOwned: () => null } as never, manager, storage);
  const harness = await start(storage, manager, registry, config, options.generateTitle
    ? { generateTitle: ((description: string) => options.generateTitle!(description)) as never }
    : {});
  try {
    await run(harness);
  } finally {
    await harness.close();
    manager.dispose();
    storage.close();
  }
}

function jsonOf<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

test("task board creates, moves, binds, and deletes tasks", async () => {
  await withHarness(async ({ url, storage, manager }) => {
    const created = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "看板任务", status: "todo", priority: "high", labels: ["mvp"] }),
    }).then(jsonOf<{ id: string; status: string; labels: string[] }>);
    assert.equal(created.status, "todo");
    assert.deepEqual(created.labels, ["mvp"]);

    const session = manager.createSession({ cwd: storage.directory(), provider: "codex", mode: "full-access" });
    const moved = await fetch(`${url}/api/wand-tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "doing" }),
    }).then(jsonOf<{ status: string }>);
    assert.equal(moved.status, "doing");

    const bound = await fetch(`${url}/api/wand-tasks/${created.id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id }),
    }).then(jsonOf<{ sessionIds: string[] }>);
    assert.deepEqual(bound.sessionIds, [session.id]);
    assert.equal((await fetch(`${url}/api/wand-tasks`).then(jsonOf<unknown[]>)).length, 1);
  });
});

test("tasks can be pointed at a workspace and expose its directory", async () => {
  await withHarness(async ({ url, storage }) => {
    const workspace = storage.createWorkspace({
      name: "wand",
      cwd: "/Users/co0ontty/Self/vibe_coding/wand",
    });

    const created = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "完成某个任务", workspaceId: workspace.id }),
    }).then(jsonOf<{ id: string; workspaceId: string; workspace: { id: string; name: string; cwd: string } | null }>);

    assert.equal(created.workspaceId, workspace.id);
    assert.deepEqual(created.workspace, {
      id: workspace.id,
      name: "wand",
      cwd: "/Users/co0ontty/Self/vibe_coding/wand",
    });

    const unassigned = await fetch(`${url}/api/wand-tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: null }),
    }).then(jsonOf<{ workspaceId: string | null; workspace: unknown }>);
    assert.equal(unassigned.workspaceId, null);
    assert.equal(unassigned.workspace, null);

    const unknown = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "不该落地", workspaceId: "missing-workspace" }),
    });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json() as { error: string }).error, /项目不存在/);
  });
});

test("a task can be created from the description alone and gets a generated title", async () => {
  const calls: string[] = [];
  await withHarness(async ({ url, storage }) => {
    const created = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "", description: "修复 Android 终端输入乱码\n另外检查列宽" }),
    }).then(jsonOf<{ id: string; title: string; titleSource: string }>);

    // 创建请求立刻返回：先给描述首行占位，不阻塞等模型。
    assert.equal(created.title, "修复 Android 终端输入乱码");
    assert.equal(created.titleSource, "auto");

    await whenWandTaskTitlesSettled();
    const stored = storage.getWandTask(created.id);
    assert.equal(stored?.title, "终端乱码修复");
    assert.equal(stored?.titleSource, "auto");
    assert.deepEqual(calls, ["修复 Android 终端输入乱码\n另外检查列宽"]);
    assert.equal(created.title.length > 0, true);
  }, { generateTitle: async (description) => { calls.push(description); return "终端乱码修复"; } });
});

test("an explicit title is never replaced by the generator", async () => {
  const calls: string[] = [];
  await withHarness(async ({ url, storage }) => {
    const created = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "我自己写的标题", description: "描述" }),
    }).then(jsonOf<{ id: string; title: string; titleSource: string }>);

    assert.equal(created.title, "我自己写的标题");
    assert.equal(created.titleSource, "user");
    await whenWandTaskTitlesSettled();
    assert.equal(storage.getWandTask(created.id)?.title, "我自己写的标题");
    assert.deepEqual(calls, []);
  }, { generateTitle: async (description) => { calls.push(description); return "自动标题"; } });
});

test("a task needs a title or a description", async () => {
  await withHarness(async ({ url }) => {
    const blank = await fetch(url + "/api/wand-tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "   ", description: "  " }),
    });
    assert.equal(blank.status, 400);
    assert.match((await blank.json() as { error: string }).error, /任务标题或任务描述/);
  });
});

test("editing the title of an auto-titled task keeps the manual title", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await withHarness(async ({ url, storage }) => {
    const created = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "先建一张只有描述的任务" }),
    }).then(jsonOf<{ id: string; titleSource: string }>);
    assert.equal(created.titleSource, "auto");

    // 后台还没总结完，用户自己先改了标题；PATCH 要把它标回 user。
    const patched = await fetch(`${url}/api/wand-tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "用户改过的标题" }),
    }).then(jsonOf<{ title: string; titleSource: string }>);
    assert.equal(patched.title, "用户改过的标题");
    assert.equal(patched.titleSource, "user");

    release();
    await whenWandTaskTitlesSettled();
    assert.equal(storage.getWandTask(created.id)?.title, "用户改过的标题");
  }, { generateTitle: async () => { await gate; return "迟到的自动标题"; } });
});

test("tasks persist and validate the selected CLI tool", async () => {  await withHarness(async ({ url }) => {
    const created = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "选择工具",
        agent: { provider: "codex", model: "gpt-5", thinkingEffort: "deep" },
      }),
    }).then(jsonOf<{ id: string; agent: { provider: string; model: string; thinkingEffort: string } | null }>);
    assert.deepEqual(created.agent, { provider: "codex", model: "gpt-5", thinkingEffort: "deep" });

    // 未指定工具的新任务保持 null，前端据此显示「未指定 CLI 工具」。
    const bare = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "未选工具" }),
    }).then(jsonOf<{ agent: unknown }>);
    assert.equal(bare.agent, null);

    const updated = await fetch(`${url}/api/wand-tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { provider: "claude", model: "default", thinkingEffort: "max" } }),
    }).then(jsonOf<{ agent: { provider: string } }>);
    assert.equal(updated.agent.provider, "claude");

    const invalidProvider = await fetch(`${url}/api/wand-tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { provider: "cursor", model: "x", thinkingEffort: "off" } }),
    });
    assert.equal(invalidProvider.status, 400);
    assert.match((await invalidProvider.json() as { error: string }).error, /CLI 工具/);

    const invalidEffort = await fetch(`${url}/api/wand-tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { provider: "claude", model: "x", thinkingEffort: "insane" } }),
    });
    assert.equal(invalidEffort.status, 400);
  });
});

test("dispatching an issue creates a structured session in the issue workspace and binds it", async () => {
  await withHarness(async ({ url, storage, manager, registry }) => {
    const workspace = storage.createWorkspace({ name: "wand", cwd: storage.directory() });
    const issue = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "修复构建",
        description: "跑通 assembleDebug",
        workspaceId: workspace.id,
        agent: { provider: "claude", model: "default", thinkingEffort: "standard" },
      }),
    }).then(jsonOf<{ id: string; status: string }>);

    const dispatched = await fetch(`${url}/api/wand-tasks/${issue.id}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(dispatched.status, 202);
    const payload = await dispatched.json() as { ok: boolean; session: { id: string; provider: string; cwd: string } };
    assert.equal(payload.ok, true);
    assert.equal(payload.session.provider, "claude");
    assert.equal(payload.session.cwd, storage.directory());
    assert.ok(registry.get(payload.session.id));

    const detail = await fetch(`${url}/api/wand-tasks/${issue.id}`).then(jsonOf<{ status: string; sessionIds: string[] }>);
    assert.deepEqual(detail.sessionIds, [payload.session.id]);
    assert.equal(detail.status, "doing");
  });
});

test("dispatch refuses an issue whose CLI tool is still unset", async () => {
  await withHarness(async ({ url }) => {
    const noAgent = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "没有工具" }),
    }).then(jsonOf<{ id: string }>);
    const rejected = await fetch(`${url}/api/wand-tasks/${noAgent.id}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json() as { error: string }).error, /CLI 工具/);
  });
});

test("deleting a project detaches its issues and dispatch falls back to the default cwd", async () => {
  await withHarness(async ({ url, storage }) => {
    const workspace = storage.createWorkspace({ name: "gone", cwd: storage.directory() });
    const issue = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "项目会被删",
        workspaceId: workspace.id,
        agent: { provider: "claude", model: "default", thinkingEffort: "off" },
      }),
    }).then(jsonOf<{ id: string }>);

    // wand_tasks.workspace_id 是 ON DELETE SET NULL：删项目后任务回到「未指定项目」，
    // 而不是留下指向已删项目的悬空外键。
    storage.deleteWorkspace(workspace.id, { cascade: true });
    const detached = await fetch(`${url}/api/wand-tasks/${issue.id}`)
      .then(jsonOf<{ workspaceId: string | null; workspace: unknown }>);
    assert.equal(detached.workspaceId, null);
    assert.equal(detached.workspace, null);

    const dispatched = await fetch(`${url}/api/wand-tasks/${issue.id}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(dispatched.status, 202);
    const payload = await dispatched.json() as { session: { cwd: string } };
    assert.equal(payload.session.cwd, storage.directory());
  });
});

test("deleting a board task archives it as done instead of removing it", async () => {
  await withHarness(async ({ url, storage }) => {
    const workspace = storage.createWorkspace({ name: "wand", cwd: storage.directory() });
    const work = storage.createWorkspaceTask({ workspaceId: workspace.id, name: "要归档的工作任务" });
    const created = storage.createWandTask({
      title: "要归档",
      workspaceId: workspace.id,
      workspaceTaskId: work.id,
    });
    assert.equal(created.status, "todo");

    const archived = await fetch(`${url}/api/wand-tasks/${created.id}`, { method: "DELETE" });
    assert.equal(archived.status, 200);
    const payload = await archived.json() as { ok: boolean; status: string; id: string };
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "done");
    assert.equal(payload.id, created.id);

    const listed = await fetch(`${url}/api/wand-tasks`).then(jsonOf<Array<{ id: string; status: string }>>);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, created.id);
    assert.equal(listed[0]!.status, "done");
    assert.equal(storage.getWorkspaceTask(work.id)?.status, "done");
  });
});

test("task board remembers last selected agent defaults", async () => {
  await withHarness(async ({ url }) => {
    const initial = await fetch(`${url}/api/wand-task-agent-defaults`)
      .then(jsonOf<{ provider: string; model: string; thinkingEffort: string }>);
    assert.deepEqual(initial, { provider: "claude", model: "default", thinkingEffort: "off" });

    const saved = await fetch(`${url}/api/wand-task-agent-defaults`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "pi", model: "gpt-5", thinkingEffort: "deep" }),
    }).then(jsonOf<{ provider: string; model: string; thinkingEffort: string }>);
    assert.deepEqual(saved, { provider: "pi", model: "gpt-5", thinkingEffort: "deep" });

    const loaded = await fetch(`${url}/api/wand-task-agent-defaults`)
      .then(jsonOf<{ provider: string; model: string; thinkingEffort: string }>);
    assert.deepEqual(loaded, saved);

    const created = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "沿用上次选择",
        agent: { provider: "codex", model: "gpt-5.1", thinkingEffort: "max" },
      }),
    }).then(jsonOf<{ id: string }>);
    const afterCreate = await fetch(`${url}/api/wand-task-agent-defaults`)
      .then(jsonOf<{ provider: string }>);
    assert.equal(afterCreate.provider, "codex");

    await fetch(`${url}/api/wand-tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { provider: "grok", model: "grok-4", thinkingEffort: "standard" } }),
    });
    const afterPatch = await fetch(`${url}/api/wand-task-agent-defaults`)
      .then(jsonOf<{ provider: string; thinkingEffort: string }>);
    assert.equal(afterPatch.provider, "grok");
    assert.equal(afterPatch.thinkingEffort, "standard");

    const invalid = await fetch(`${url}/api/wand-task-agent-defaults`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "cursor", model: "x", thinkingEffort: "off" }),
    });
    assert.equal(invalid.status, 400);
  });
});
