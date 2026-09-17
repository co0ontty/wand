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
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";
import type { SessionSnapshot } from "../src/types.js";

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
  registerWorkspaceRoutes(app, storage, registry, extra.generateTitle
    ? { config, generateTitle: extra.generateTitle }
    : {});
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

function sessionSnapshot(overrides: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    id: "session-auto-name",
    sessionKind: "structured",
    provider: "claude",
    command: "claude",
    cwd: "/tmp/wand",
    mode: "default",
    status: "idle",
    exitCode: null,
    startedAt: "2026-09-11T00:00:00.000Z",
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    ...overrides,
  };
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

test("GET /api/wand-tasks returns newest created tasks first", async () => {
  await withHarness(async ({ url }) => {
    const older = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "先创建" }),
    }).then(jsonOf<{ id: string }>);
    const newer = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "后创建" }),
    }).then(jsonOf<{ id: string }>);
    await fetch(`${url}/api/wand-tasks/${older.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "doing" }),
    });
    const listed = await fetch(`${url}/api/wand-tasks`).then(jsonOf<Array<{ id: string }>>);
    assert.deepEqual(listed.map((task) => task.id), [newer.id, older.id]);
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

test("a sidebar task created with only a prompt is summarized right away", async () => {
  const calls: string[] = [];
  await withHarness(async ({ url, storage }) => {
    const workspace = storage.createWorkspace({ name: "wand", cwd: storage.directory() });
    const prompt = "帮我排查登录页 Safari 白屏\n只在 iOS 16 复现";
    const created = await fetch(`${url}/api/workspaces/${workspace.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: prompt }),
    }).then(jsonOf<{ id: string; name: string }>);
    // 建任务时就能看到提示词临时标题，不会出现「未命名任务」。
    assert.equal(created.name, "帮我排查登录页 Safari 白屏");
    await whenWandTaskTitlesSettled();
    const card = storage.getWandTaskByWorkspaceTaskId(created.id);
    assert.equal(card?.title, "修复 Safari 登录页白屏");
    assert.equal(storage.getWorkspaceTask(created.id)?.name, "修复 Safari 登录页白屏");
    assert.deepEqual(calls, [prompt]);
  }, { generateTitle: async (description) => { calls.push(description); return "修复 Safari 登录页白屏"; } });
});

test("a sidebar task created without a name is titled from its sessions", async () => {
  const calls: string[] = [];
  await withHarness(async ({ url, storage }) => {
    const workspace = storage.createWorkspace({ name: "wand", cwd: storage.directory() });
    const created = await fetch(`${url}/api/workspaces/${workspace.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktree: false }),
    }).then(jsonOf<{ id: string; name: string }>);
    assert.match(created.name, /^未命名任务 \d{4}$/);

    // 先建任务、后开会话：轮询时用会话内容把占位标题换成真实标题。
    storage.saveSession(sessionSnapshot({
      id: "sess-auto",
      workspaceId: workspace.id,
      workspaceTaskId: created.id,
      title: "修复安卓终端乱码",
      description: "定位列宽与字号问题",
    }));
    await fetch(`${url}/api/wand-tasks`).then(jsonOf<unknown[]>);
    await whenWandTaskTitlesSettled();

    const card = storage.getWandTaskByWorkspaceTaskId(created.id);
    assert.equal(card?.titleSource, "auto");
    assert.equal(card?.title, "会话总结的任务标题");
    assert.deepEqual(calls, ["修复安卓终端乱码"]);
    assert.equal(storage.getWorkspaceTask(created.id)?.name, "会话总结的任务标题");
  }, { generateTitle: async (description) => { calls.push(description); return "会话总结的任务标题"; } });
});

test("tasks persist and validate the selected CLI tool", async () => {  await withHarness(async ({ url }) => {
    const created = await fetch(`${url}/api/wand-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "选择工具",
        agent: { provider: "codex", model: "gpt-5", thinkingEffort: "deep" },
      }),
    }).then(jsonOf<{ id: string; agent: { provider: string; model: string; thinkingEffort: string; mode: string } | null }>);
    // 老客户端不传 mode：服务端按 provider 支持的模式兼容落地（codex 只有 full-access）。
    assert.deepEqual(created.agent, { provider: "codex", model: "gpt-5", thinkingEffort: "deep", mode: "full-access" });

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

    const invalidMode = await fetch(`${url}/api/wand-tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { provider: "claude", model: "x", thinkingEffort: "off", mode: "yolo" } }),
    });
    assert.equal(invalidMode.status, 400);
    assert.match((await invalidMode.json() as { error: string }).error, /工作模式/);

    // 显式指定的工作模式必须往返保存。
    const withMode = await fetch(`${url}/api/wand-tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { provider: "claude", model: "default", thinkingEffort: "off", mode: "managed" } }),
    }).then(jsonOf<{ agent: { mode: string } }>);
    assert.equal(withMode.agent.mode, "managed");

    // Codex 只收 full-access：传 default 也要夹到有效值，否则会以只读沙箱跑任务。
    const clamped = await fetch(`${url}/api/wand-tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { provider: "codex", model: "gpt-5", thinkingEffort: "off", mode: "default" } }),
    }).then(jsonOf<{ agent: { mode: string } }>);
    assert.equal(clamped.agent.mode, "full-access");
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
    const payload = await dispatched.json() as { ok: boolean; session: { id: string; provider: string; cwd: string; mode: string } };
    assert.equal(payload.ok, true);
    assert.equal(payload.session.provider, "claude");
    assert.equal(payload.session.cwd, storage.directory());
    // agent 未指定 mode 时落到标准模式，不再是旧的 "agent"。
    assert.equal(payload.session.mode, "default");
    assert.ok(registry.get(payload.session.id));

    const again = await fetch(`${url}/api/wand-tasks/${issue.id}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(again.status, 400);
    assert.match((await again.json() as { error: string }).error, /提示词/);

    const second = await fetch(`${url}/api/wand-tasks/${issue.id}/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "再看一遍构建" }),
    });
    assert.equal(second.status, 202);
    const secondPayload = await second.json() as { session: { id: string } };

    const detail = await fetch(`${url}/api/wand-tasks/${issue.id}`).then(jsonOf<{ status: string; sessionIds: string[] }>);
    assert.deepEqual(detail.sessionIds, [payload.session.id, secondPayload.session.id]);
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

test("deleting a board task archives it instead of removing it", async () => {
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
    assert.equal(payload.status, "archived");
    assert.equal(payload.id, created.id);

    const listed = await fetch(`${url}/api/wand-tasks`).then(jsonOf<Array<{ id: string; status: string }>>);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, created.id);
    assert.equal(listed[0]!.status, "archived");
    assert.equal(storage.getWorkspaceTask(work.id)?.status, "done");
  });
});

test("marking a board task done keeps it in done instead of archiving", async () => {
  await withHarness(async ({ url, storage }) => {
    const created = storage.createWandTask({ title: "待确认", status: "doing" });
    const updated = await fetch(`${url}/api/wand-tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    }).then(jsonOf<{ status: string }>);
    assert.equal(updated.status, "done");
    assert.equal(storage.getWandTask(created.id)?.status, "done");
  });
});

test("task board remembers last selected agent defaults", async () => {
  await withHarness(async ({ url }) => {
    const initial = await fetch(`${url}/api/wand-task-agent-defaults`)
      .then(jsonOf<{ provider: string; model: string; thinkingEffort: string; mode: string }>);
    assert.deepEqual(initial, { provider: "claude", model: "default", thinkingEffort: "off", mode: "default" });

    const saved = await fetch(`${url}/api/wand-task-agent-defaults`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "pi", model: "gpt-5", thinkingEffort: "deep", mode: "full-access" }),
    }).then(jsonOf<{ provider: string; model: string; thinkingEffort: string; mode: string }>);
    assert.deepEqual(saved, { provider: "pi", model: "gpt-5", thinkingEffort: "deep", mode: "full-access" });

    const loaded = await fetch(`${url}/api/wand-task-agent-defaults`)
      .then(jsonOf<{ provider: string; model: string; thinkingEffort: string; mode: string }>);
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

    // 显式指定工作模式会写回任务与“上次选择”。
    await fetch(`${url}/api/wand-tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { provider: "grok", model: "grok-4", thinkingEffort: "standard", mode: "managed" } }),
    });
    const afterPatch = await fetch(`${url}/api/wand-task-agent-defaults`)
      .then(jsonOf<{ provider: string; thinkingEffort: string; mode: string }>);
    assert.equal(afterPatch.provider, "grok");
    assert.equal(afterPatch.thinkingEffort, "standard");
    assert.equal(afterPatch.mode, "managed");

    // 老客户端 PUT 默认选项不带 mode：沿用已保存模式，不能把全局默认复位成标准。
    const defaultsWithoutMode = await fetch(`${url}/api/wand-task-agent-defaults`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "grok", model: "grok-4", thinkingEffort: "standard" }),
    }).then(jsonOf<{ mode: string }>);
    assert.equal(defaultsWithoutMode.mode, "managed");
    const reloadedDefaults = await fetch(`${url}/api/wand-task-agent-defaults`)
      .then(jsonOf<{ mode: string }>);
    assert.equal(reloadedDefaults.mode, "managed");

    // 老客户端 PATCH 不带 mode：要沿用任务当前值，不能复位成标准。
    const withoutMode = await fetch(`${url}/api/wand-tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: { provider: "grok", model: "grok-4", thinkingEffort: "standard" } }),
    }).then(jsonOf<{ agent: { mode: string } }>);
    assert.equal(withoutMode.agent.mode, "managed");

    const invalid = await fetch(`${url}/api/wand-task-agent-defaults`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "cursor", model: "x", thinkingEffort: "off" }),
    });
    assert.equal(invalid.status, 400);
  });
});

test("sidebar and board share containers and moving a live CLI session preserves its cwd", async () => {
  await withHarness(async ({ url, storage, manager, registry }) => {
    const send = (route: string, body: unknown, method = "POST") => fetch(`${url}${route}`, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const workspace = storage.createWorkspace({ name: "Project", cwd: process.cwd() });
    const board = await send("/api/wand-tasks", { workspaceId: workspace.id, title: "Board task" })
      .then(jsonOf<{ id: string; workspaceTaskId: string }>);
    assert.ok(storage.getWorkspaceTask(board.workspaceTaskId));
    const sidebar = await send(`/api/workspaces/${workspace.id}/tasks`, { name: "Sidebar task" })
      .then(jsonOf<{ id: string; cwd: string; isolated: boolean }>);
    assert.equal(sidebar.isolated, false);
    const card = storage.getWandTaskByWorkspaceTaskId(sidebar.id)!;
    assert.ok(card);
    const session = manager.createSession({ cwd: sidebar.cwd, mode: "default",
      workspaceId: workspace.id, workspaceTaskId: sidebar.id });
    assert.equal(registry.ownerOf(session.id), "structured");
    const moved = await send(`/api/wand-tasks/${board.id}/sessions`, { sessionId: session.id });
    assert.equal(moved.status, 201);
    assert.equal(manager.get(session.id)?.workspaceTaskId, board.workspaceTaskId);
    assert.equal(registry.getLatest(session.id)?.cwd, session.cwd);
    assert.deepEqual(storage.listWandTaskSessionIds(card.id), []);
    assert.deepEqual(storage.listWandTaskSessionIds(board.id), [session.id]);
    const movedBack = await send(`/api/workspace-tasks/${sidebar.id}/sessions`, { sessionId: session.id });
    assert.equal(movedBack.status, 200);
    assert.equal(manager.get(session.id)?.workspaceTaskId, sidebar.id);
    assert.equal(manager.get(session.id)?.cwd, session.cwd);
    await send(`/api/workspace-tasks/${sidebar.id}`, { name: "Renamed", status: "done" }, "PATCH");
    assert.equal(storage.getWandTask(card.id)?.title, "Renamed");
    await send(`/api/wand-tasks/${card.id}`, { status: "doing", title: "Reopened" }, "PATCH");
    assert.equal(storage.getWorkspaceTask(sidebar.id)?.status, "active");
    assert.equal(storage.getWorkspaceTask(sidebar.id)?.name, "Reopened");
    const missing = await send("/api/workspace-tasks/missing/sessions", { sessionId: session.id });
    assert.equal(missing.status, 404);
    assert.equal(manager.get(session.id)?.workspaceTaskId, sidebar.id);
  });
});
