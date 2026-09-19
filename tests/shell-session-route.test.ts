import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";
import { WandStorage } from "../src/storage.js";
import type { SessionSnapshot } from "../src/types.js";

test("commands endpoint dispatches shell requests without a provider command", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-shell-route-"));
  const configPath = path.join(root, "config.json");
  const handle = await startServer({
    ...defaultConfig(),
    host: "127.0.0.1",
    port: 0,
    https: false,
    password: "test-password",
    startupCommands: [],
  }, configPath);
  t.after(async () => {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  });

  const calls: unknown[][] = [];
  handle.processManager.startShell = ((...args: unknown[]) => {
    calls.push(args);
    return {
      id: "shell-route-1",
      sessionKind: "pty",
      runner: "pty",
      command: defaultConfig().shell,
      cwd: root,
      mode: "default",
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      output: "",
      archived: false,
      archivedAt: null,
      claudeSessionId: null,
    } satisfies SessionSnapshot;
  }) as typeof handle.processManager.startShell;

  const login = await fetch(`${handle.urls[0]!.url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-password", client: "browser-extension" }),
  });
  const { appToken } = await login.json() as { appToken?: string };
  assert.ok(appToken);

  const response = await fetch(`${handle.urls[0]!.url}/api/commands`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ shell: true, cwd: root, cols: 92, rows: 27 }),
  });

  assert.equal(response.status, 201);
  const created = await response.json() as SessionSnapshot;
  assert.equal(created.id, "shell-route-1");
  assert.equal(created.provider, undefined);
  assert.equal(calls.length, 1);
  const [cwd, mode, opts] = calls[0] as [string, string, {
    worktreeEnabled?: boolean;
    cols?: number;
    rows?: number;
    sessionSource?: string;
    workspaceId?: string;
    workspaceTaskId?: string;
  }];
  assert.equal(cwd, root);
  assert.equal(mode, "default");
  assert.equal(opts.worktreeEnabled, false);
  assert.equal(opts.cols, 92);
  assert.equal(opts.rows, 27);
  assert.equal(opts.sessionSource, "interactive");
  assert.equal(typeof opts.workspaceId, "string");
  assert.ok(opts.workspaceId);
  assert.equal(opts.workspaceTaskId, undefined);

  const inputCalls: Array<[string, string, string | undefined, string | undefined]> = [];
  handle.processManager.get = ((id: string) => id === created.id ? created : undefined) as
    typeof handle.processManager.get;
  handle.processManager.sendInput = ((id, input, view, shortcutKey) => {
    inputCalls.push([id, input, view, shortcutKey]);
    return { ...created, output: "x".repeat(200_000) };
  }) as typeof handle.processManager.sendInput;

  const inputResponse = await fetch(`${handle.urls[0]!.url}/api/sessions/${created.id}/input`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: "\r",
      view: "terminal",
      shortcutKey: "enter_text",
      responseMode: "accepted",
    }),
  });

  assert.equal(inputResponse.status, 202);
  assert.deepEqual(await inputResponse.json(), { accepted: true });
  assert.deepEqual(inputCalls, [[created.id, "\r", "terminal", "enter_text"]]);
});

test("commands endpoint puts a new session on its task card without a board reload", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pty-task-card-"));
  const configPath = path.join(root, "config.json");
  const handle = await startServer({
    ...defaultConfig(),
    host: "127.0.0.1",
    port: 0,
    https: false,
    password: "test-password",
    startupCommands: [],
  }, configPath);
  t.after(async () => {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  });

  const baseUrl = handle.urls[0]!.url;
  const login = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-password", client: "browser-extension" }),
  });
  const { appToken } = await login.json() as { appToken?: string };
  assert.ok(appToken);
  const authHeaders = { Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" };

  const workspace = await fetch(`${baseUrl}/api/workspaces`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "mk2api", cwd: root }),
  }).then((response) => response.json() as Promise<{ id: string }>);
  const task = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "按渠道配置 API" }),
  }).then((response) => response.json() as Promise<{ id: string }>);

  const created = {
    id: "pty-task-card-1",
    sessionKind: "pty",
    runner: "pty",
    provider: "pi",
    command: "pi",
    cwd: root,
    mode: "default",
    status: "running",
    exitCode: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    workspaceId: workspace.id,
    workspaceTaskId: task.id,
  } satisfies SessionSnapshot;
  const observer = new WandStorage(handle.dbPath);
  t.after(() => observer.close());
  // 真的 `start` 会先把会话落库再返回快照；桩里补上落库这一步，
  // 不然看板同步查不到这个会话，测的就不是路由的钩子了。
  handle.processManager.start = ((_command, _cwd, _mode, _input, opts) => {
    observer.saveSession({ ...created, workspaceId: opts?.workspaceId, workspaceTaskId: opts?.workspaceTaskId });
    return created;
  }) as typeof handle.processManager.start;

  const response = await fetch(`${baseUrl}/api/commands`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ command: "pi", cwd: root, workspaceId: workspace.id, workspaceTaskId: task.id }),
  });
  assert.equal(response.status, 201);

  // 侧栏「＋」建出来的 PTY 会话：卡片绑定在创建时就写好了，不需要再拉一次看板列表。
  const db = new DatabaseSync(handle.dbPath, { readOnly: true });
  try {
    const bound = db.prepare(
      "select b.session_id as session_id from wand_task_sessions b join wand_tasks t on t.id = b.task_id where t.workspace_task_id = ?",
    ).all(task.id) as Array<{ session_id: string }>;
    assert.deepEqual(bound.map((row) => row.session_id), [created.id]);
  } finally {
    db.close();
  }
});
