import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import express, { type Express } from "express";

import { defaultConfig, getDefaultModelForProvider } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";
import { taskBoardRepository } from "../src/web-ui/react/issues/task-board-repository.js";

/**
 * 直接驱动一个 Express app，不绑定端口。
 *
 * 多数环境用 fetch + 真实监听即可；但受限沙箱会拒绝 `listen()`（EPERM），
 * 让所有 HTTP 级用例集体失败。这里用最小 req/res 桩把请求喂给 app，路由、
 * body parser 与错误中间件照常执行，因此仍覆盖真实服务端行为。
 */
function invokeApp(
  app: Express,
  options: { method?: string; url: string; body?: string },
): Promise<{ status: number; text: string; json: unknown }> {
  const { method = "GET", url, body = "" } = options;
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : null;
    const req = new Readable({ read() {} });
    Object.assign(req, {
      method,
      url,
      originalUrl: url,
      headers: {
        host: "localhost",
        ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
      },
      httpVersion: "1.1",
      httpVersionMajor: 1,
      httpVersionMinor: 1,
    });
    const socket = new PassThrough();
    Object.assign(socket, { remoteAddress: "127.0.0.1", encrypted: false, writable: true, setNoDelay() {}, ref() {}, unref() {} });
    req.connection = req.socket = socket;

    const chunks: Buffer[] = [];
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      statusMessage: "OK",
      headers: {} as Record<string, unknown>,
      headersSent: false,
      writableEnded: false,
      setHeader(name: string, value: unknown) { (this.headers as Record<string, unknown>)[name.toLowerCase()] = value; return this; },
      getHeader(name: string) { return (this.headers as Record<string, unknown>)[name.toLowerCase()]; },
      getHeaders() { return { ...(this.headers as Record<string, unknown>) }; },
      removeHeader(name: string) { delete (this.headers as Record<string, unknown>)[name.toLowerCase()]; },
      getHeaderNames() { return Object.keys(this.headers as Record<string, unknown>); },
      hasHeader(name: string) { return name.toLowerCase() in (this.headers as Record<string, unknown>); },
      writeHead(code: number, message?: string) { this.statusCode = code; this.headersSent = true; if (typeof message === "string") this.statusMessage = message; return this; },
      flushHeaders() { this.headersSent = true; },
      writeContinue() {},
      write(chunk: unknown) { chunks.push(Buffer.from(chunk as Buffer)); return true; },
      end(chunk?: unknown) {
        if (chunk) chunks.push(Buffer.from(chunk as Buffer));
        this.finished = true;
        this.writableEnded = true;
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: this.statusCode as number, text, json });
      },
      socket,
    });
    req.on("error", () => {});
    res.on("error", reject);
    app(req, res as never);
    setImmediate(() => { req.push(payload ?? ""); req.push(null); });
  });
}

/**
 * 任务管理的端到端派发：用前端真正的 taskBoardRepository 打服务端真正的
 * `/api/wand-tasks*` 路由，落到真实的 StructuredSessionManager，并 spawn 一个
 * 协议兼容的 codex CLI 替身。覆盖「创建任务 → 指派 Agent → 派发 → 会话在任务
 * 项目目录里跑完 → 任务推进并绑定会话」整条链路。
 */
test("native board creates an issue, dispatches an agent, and binds the real session", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-board-dispatch-"));
  const binDir = path.join(root, "bin");
  const projectDir = path.join(root, "project");
  mkdirSync(binDir);
  mkdirSync(projectDir);
  const captured = path.join(root, "prompt.txt");

  // codex CLI 替身：同样只从 stdin 读 prompt、按 codex exec --json 协议吐事件。
  const cli = path.join(binDir, "codex");
  writeFileSync(cli, `#!/bin/sh
cat > "${captured}"
printf '%s\\n' \\
'{"type":"thread.started","thread_id":"thread-e2e"}' \\
'{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"已收到任务"}}' \\
'{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":7}}'
`, "utf8");
  chmodSync(cli, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: path.join(root, "fallback"), inheritEnv: true };
  const manager = new StructuredSessionManager(storage, config);
  const registry = new SessionRegistry({ getOwned: () => null } as never, manager, storage);
  const app = express();
  app.use(express.json());
  registerTaskRoutes(app, { storage, sessions: registry, structured: manager, config });
  app.use(jsonErrorHandler);

  // 让前端 repository 的 fetch 走到真实 Express 路由上。
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const parsed = new URL(raw, "http://localhost");
    const response = await invokeApp(app, {
      method: init?.method ?? "GET",
      url: parsed.pathname + parsed.search,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return { ok: response.status < 300, status: response.status, json: async () => response.json ?? {} } as Response;
  };

  t.after(() => {
    process.env.PATH = previousPath;
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  const workspace = storage.createWorkspace({ name: "wand-board", cwd: projectDir });

  // 1. 顶部表单创建任务（不带 Agent，指派属于任务自己的配置）。
  const created = await taskBoardRepository.create({
    workspaceId: workspace.id,
    title: "跑通任务管理",
    description: "验证原生看板能派发 Agent",
    status: "todo",
    priority: "none",
    labels: [],
    agent: null,
  });
  assert.equal(created.agent, null);
  assert.equal(created.workspace?.cwd, projectDir);

  // 2. 在任务上指派 CLI 工具 / 模型 / 思考深度。
  const agent = { provider: "codex" as const, model: "default", thinkingEffort: "standard" as const };
  await taskBoardRepository.update(created.id, { agent });

  // 3. 一键派发。
  const dispatched = await taskBoardRepository.dispatch(created.id, agent);
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.session.provider, "codex");
  assert.equal(dispatched.session.cwd, projectDir, "会话必须跑在任务项目目录里");
  assert.equal(dispatched.session.thinkingEffort, "standard");
  if (getDefaultModelForProvider(config, "codex")) {
    assert.equal(dispatched.session.model, getDefaultModelForProvider(config, "codex"), "default 模型要解析成服务端默认值");
  }

  // 4. 真实子进程跑完，会话带回 Agent 回复与 provider 原生 resume id。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const current = manager.get(dispatched.session.id);
    if (current && (current.messages?.length ?? 0) >= 2 && current.structuredState?.inFlight === false) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const session = manager.get(dispatched.session.id)!;
  assert.equal(session.mode, "agent", "派发会话必须是 agent 模式");
  assert.equal(session.sessionSource, "automation");
  assert.equal(session.automationId, `wand-task:${created.id}`);
  assert.equal(session.claudeSessionId, "thread-e2e", "provider 原生 resume id 必须回写");
  assert.equal(session.messages.at(-1)?.content?.[0]?.text, "已收到任务");
  // 任务标题 + 描述作为首个 prompt 交给 CLI。
  const prompt = readFileSync(captured, "utf8");
  assert.match(prompt, /跑通任务管理/);
  assert.match(prompt, /验证原生看板能派发 Agent/);

  // 5. 列表 DTO 反映推进后的状态与绑定会话。
  const listed = await taskBoardRepository.list();
  const refreshed = listed.find((task) => task.id === created.id)!;
  assert.equal(refreshed.status, "doing", "派发后任务应从待办推进到进行中");
  assert.deepEqual(refreshed.sessionIds, [dispatched.session.id]);
  assert.deepEqual(refreshed.agent, agent);
  assert.deepEqual(refreshed.sessions.map((entry) => entry.provider), ["codex"]);
});

test("dispatch refuses an issue that has no CLI tool yet", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-board-noagent-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root };
  const manager = new StructuredSessionManager(storage, config);
  const registry = new SessionRegistry({ getOwned: () => null } as never, manager, storage);
  const app = express();
  app.use(express.json());
  registerTaskRoutes(app, { storage, sessions: registry, structured: manager, config });
  app.use(jsonErrorHandler);
  t.after(() => {
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  const task = storage.createWandTask({ title: "没有工具", agent: null });
  const response = await invokeApp(app, {
    method: "POST",
    url: `/api/wand-tasks/${task.id}/dispatch`,
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(response.json), /CLI 工具/);
});
