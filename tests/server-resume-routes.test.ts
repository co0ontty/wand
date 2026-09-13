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
import { registerStructuredResumeRoutes } from "../src/server-resume-routes.js";
import { toSessionDetailDTO } from "../src/session-transport.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";

/**
 * provider 原生 ID 恢复曾经是 5 份近乎逐行复制的 handler。这里锁住拆分后的契约：
 * 错误文案、状态码，以及两类 provider（有历史记录 / 只接受客户端 cwd）的差异。
 */
async function withRoutes(
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-resume-routes-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const app = express();
  app.use(express.json());
  registerStructuredResumeRoutes(app, {
    processes,
    structured,
    storage,
    defaultMode: config.defaultMode,
    toDetailDTO: (snapshot) => toSessionDetailDTO(snapshot),
  });
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
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    structured.dispose();
    processes.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function post(baseUrl: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("codex resume rejects an id that is not a UUID before touching history", async () => {
  await withRoutes(async (baseUrl) => {
    const response = await post(baseUrl, "/api/codex-sessions/not-a-uuid/resume", { cwd: "/tmp" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Codex 会话 ID 必须是有效的 UUID。" });
  });
});

test("codex resume reports a missing scanned history instead of creating a shell", async () => {
  await withRoutes(async (baseUrl) => {
    const missing = "11111111-2222-3333-4444-555555555555";
    const response = await post(baseUrl, `/api/codex-sessions/${missing}/resume`, {});
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "对应的 Codex 历史会话不存在，无法恢复。" });
  });
});

test("opencode resume validates the session id shape without requiring history", async () => {
  await withRoutes(async (baseUrl) => {
    const response = await post(baseUrl, "/api/opencode-sessions/has%20space/resume", { cwd: "/tmp" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "OpenCode 会话 ID 格式无效。" });
  });
});

test("grok and pi resume require a cwd because the server cannot look one up", async () => {
  await withRoutes(async (baseUrl) => {
    for (const provider of ["grok", "pi"]) {
      const response = await post(baseUrl, `/api/${provider}-sessions/native-123/resume`, {});
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "无法确定工作目录 (cwd)，无法恢复。" });
    }
  });
});

test("grok resume creates a structured shell carrying the native id", async () => {
  await withRoutes(async (baseUrl) => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "wand-grok-resume-"));
    try {
      const response = await post(baseUrl, "/api/grok-sessions/native-123/resume", { cwd, mode: "assist" });
      assert.equal(response.status, 201);
      const payload = await response.json() as { resumedClaudeSessionId: string; provider: string; sessionKind: string; cwd: string };
      assert.equal(payload.resumedClaudeSessionId, "native-123");
      assert.equal(payload.provider, "grok");
      assert.equal(payload.sessionKind, "structured");
      assert.equal(payload.cwd, cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
