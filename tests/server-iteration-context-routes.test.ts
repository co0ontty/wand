// 迭代上下文 HTTP 契约：模式偏好、默认勾选、仓库隔离、错误码。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import express from "express";

import { defaultConfig } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { repoKeyForCwd, resetRepoKeyCache } from "../src/iteration-log.js";
import { ProcessManager } from "../src/process-manager.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(root: string): string {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "wand-test@example.test");
  git(root, "config", "user.name", "Wand Test");
  writeFileSync(path.join(root, "tracked.txt"), "before\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "initial");
  return root;
}

interface Harness {
  baseUrl: string;
  storage: WandStorage;
  config: ReturnType<typeof defaultConfig>;
  close(): Promise<void>;
}

async function startHarness(t: TestContext, root: string): Promise<Harness> {
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
  t.after(() => storage.close());
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    storage,
    config,
    close: () => new Promise((done) => {
      processes.dispose();
      structured.dispose();
      server.close(() => done());
    }),
  };
}

interface IterationContextBody {
  iteration: { id: string; name: string; isDefault: boolean };
  repoKey: string | null;
  entries: Array<{ id: string; title: string; consumed: boolean; consumedCommit: string | null }>;
  defaultEntryIds: string[];
  selectableIds: string[];
  effectiveMode: string;
  mode: string;
}

test("iteration context route exposes the window between commits and remembers the mode", async (t) => {
  resetRepoKeyCache();
  t.after(() => resetRepoKeyCache());
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-iteration-route-"));
  const repo = initRepo(path.join(root, "repo"));
  const harness = await startHarness(t, root);
  const { baseUrl, storage } = harness;

  try {
    // 建一个真实会话（structured 不启动 CLI），cwd 指向 git 仓库。
    const created = await fetch(`${baseUrl}/api/structured-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: repo, provider: "opencode", mode: "assist" }),
    });
    assert.equal(created.status, 201);
    const session = await created.json() as { id: string };

    // 直接落两条记录：一条未提交（默认勾选），一条已提交（历史里可选）。
    const fallback = storage.ensureDefaultWandMilestone();
    const repoKey = await repoKeyForCwd(repo);
    const committed = storage.createIterationPrompt({
      milestoneId: fallback.id, sessionId: session.id, repoKey, cwd: repo,
      title: "第一版登录页", detail: "",
    });
    storage.markIterationPromptsConsumed([committed.id], "abc1234");
    // 后加的那条才是「本次提交以来」的变更。
    const pending = storage.createIterationPrompt({
      milestoneId: fallback.id, sessionId: session.id, repoKey, cwd: repo,
      title: "把登录页的错误提示改成中文", detail: "顺手补一条空密码的测试",
    });
    // 别的仓库的记录不能混进这个会话的上下文。
    storage.createIterationPrompt({
      milestoneId: fallback.id, sessionId: session.id, repoKey: await repoKeyForCwd(initRepo(path.join(root, "other"))),
      cwd: path.join(root, "other"), title: "别的项目的改动", detail: "",
    });

    const first = await fetch(`${baseUrl}/api/sessions/${session.id}/iteration-context`)
      .then((response) => response.json() as Promise<IterationContextBody>);
    assert.equal(first.iteration.id, fallback.id);
    assert.equal(first.iteration.isDefault, true);
    assert.equal(first.repoKey, repoKey);
    assert.equal(first.mode, "iteration");
    assert.equal(first.effectiveMode, "iteration");
    assert.deepEqual(first.entries.map((entry) => entry.title), ["把登录页的错误提示改成中文", "第一版登录页"]);
    assert.deepEqual(first.defaultEntryIds, [pending.id]);
    assert.deepEqual(first.entries.map((entry) => entry.consumed), [false, true]);
    assert.equal(first.entries[1]?.consumedCommit, "abc1234");
    assert.ok(first.selectableIds.includes(committed.id));

    // 模式写进偏好：换会话 / 重启后仍然是用户上次的选择。
    const saved = await fetch(`${baseUrl}/api/sessions/${session.id}/iteration-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "diff" }),
    });
    assert.deepEqual(await saved.json(), { ok: true, mode: "diff" });
    assert.equal(storage.getPreference("pref:commitContextMode", "iteration"), "diff");
    const reread = await fetch(`${baseUrl}/api/sessions/${session.id}/iteration-context`)
      .then((response) => response.json() as Promise<IterationContextBody>);
    assert.equal(reread.mode, "diff");
    // 模式只是输入源偏好，勾选集合照旧。
    assert.deepEqual(reread.defaultEntryIds, [pending.id]);

    const invalid = await fetch(`${baseUrl}/api/sessions/${session.id}/iteration-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "whatever" }),
    });
    assert.equal(invalid.status, 400);

    const missing = await fetch(`${baseUrl}/api/sessions/does-not-exist/iteration-context`);
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty iteration reports diff as the effective mode", async (t) => {
  resetRepoKeyCache();
  t.after(() => resetRepoKeyCache());
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-iteration-empty-"));
  const repo = initRepo(path.join(root, "repo"));
  const harness = await startHarness(t, root);
  try {
    const created = await fetch(`${harness.baseUrl}/api/structured-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: repo, provider: "opencode", mode: "assist" }),
    });
    const session = await created.json() as { id: string };
    const body = await fetch(`${harness.baseUrl}/api/sessions/${session.id}/iteration-context`)
      .then((response) => response.json() as Promise<IterationContextBody>);
    // 一条提示词都没有：默认迭代仍然存在（面板要能显示「本次迭代：默认迭代」）。
    assert.equal(body.iteration.isDefault, true);
    assert.equal(body.iteration.name, "默认迭代");
    assert.deepEqual(body.entries, []);
    assert.deepEqual(body.defaultEntryIds, []);
    assert.equal(body.effectiveMode, "diff");
  } finally {
    await harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});
