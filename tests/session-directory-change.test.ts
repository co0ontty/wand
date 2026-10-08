import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";

import { defaultConfig } from "../src/config.js";
import { ProcessManager } from "../src/process-manager.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";
import type { SessionSnapshot } from "../src/types.js";

function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "wand-directory-change-"));
  const target = join(root, "unused");
  mkdirSync(target);
  const storage = new WandStorage(join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root };
  const manager = new StructuredSessionManager(storage, config);
  t.after(async () => {
    manager.dispose();
    await whenIterationPromptsSettled();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const create = () => manager.createSession({ cwd: root, mode: "default", provider: "pi",
    employeeId: "employee-test", employeeName: "测试员工", systemPrompt: "保留员工角色与知识",
    model: "chosen-model", thinkingEffort: "pi:high" });
  return { root, target, storage, config, manager, create };
}

test("blank employee conversation changes directory in place and reuses or creates its workspace", (t) => {
  const { target, manager, storage, create } = harness(t);
  const original = create();
  const events: unknown[] = [];
  manager.setEventEmitter((event) => events.push(event));
  const updated = manager.setSessionDirectory(original.id, target);
  assert.equal(updated.id, original.id);
  assert.equal(updated.cwd, target);
  for (const key of ["employeeId", "employeeName", "systemPrompt", "provider", "runner", "startedAt", "selectedModel", "thinkingEffort", "mode"] as const) {
    assert.equal(updated[key], original[key]);
  }
  assert.deepEqual(updated.messages, []);
  assert.deepEqual(updated.queuedMessages, []);
  assert.equal(storage.getSession(original.id)?.cwd, target);
  assert.equal(storage.getSession(original.id)?.workspaceId, updated.workspaceId);
  assert.equal(storage.getWorkspace(updated.workspaceId!)?.cwd, target);
  assert.equal(manager.listSlim().length, 1);
  const count = storage.listWorkspaces().length;
  assert.equal(manager.setSessionDirectory(original.id, `${target}/`).workspaceId, updated.workspaceId);
  assert.equal(storage.listWorkspaces().length, count);
  assert.ok(events.some((event) => (event as { data?: { cwd?: string } }).data?.cwd === target));
});

test("invalid paths and locked conversation states do not mutate cwd or create workspaces", (t) => {
  const { root, target, manager, storage, create } = harness(t);
  const file = join(root, "file.txt");
  writeFileSync(file, "fixture");
  const original = create();
  const count = storage.listWorkspaces().length;
  for (const path of [join(root, "missing"), file]) {
    assert.throws(() => manager.setSessionDirectory(original.id, path), /工作目录/);
    assert.equal(manager.get(original.id)?.cwd, root);
  }
  const blocked: Partial<SessionSnapshot>[] = [
    { messages: [{ role: "user", content: [{ type: "text", text: "已接受" }] }] },
    { queuedMessages: ["已排队"] }, { status: "running" }, { archived: true },
    { claudeSessionId: "native-history" }, { automationId: "ai-team:run" }, { sessionSource: "startup" },
    { resumedFromSessionId: "old" }, { autoRecovered: true }, { workspaceTaskId: "task" },
    { worktreeEnabled: true },
    { structuredState: { provider: "pi", runner: "pi-cli-json", inFlight: true,
      activeRequestId: "busy", lastError: null } },
  ];
  for (const patch of blocked) {
    const session = create();
    Object.assign(manager.get(session.id)!, patch);
    assert.throws(() => manager.setSessionDirectory(session.id, target), /空白对话|原运行目录/);
    assert.equal(storage.getSession(session.id)?.cwd, root);
  }
  assert.equal(storage.listWorkspaces().length, count);
});

test("failed atomic directory persistence rolls back a newly created workspace and keeps runtime unchanged", (t) => {
  const { target, root, manager, storage, create } = harness(t);
  const original = create();
  const count = storage.listWorkspaces().length;
  const createWorkspace = storage.createWorkspace.bind(storage);
  storage.createWorkspace = (draft) => {
    createWorkspace(draft);
    throw new Error("数据库不可写");
  };
  assert.throws(() => manager.setSessionDirectory(original.id, target), /数据库不可写/);
  assert.equal(manager.get(original.id)?.cwd, root);
  assert.equal(storage.getSession(original.id)?.cwd, root);
  assert.equal(storage.listWorkspaces().length, count);
  storage.createWorkspace = createWorkspace;
});

test("HTTP directory route validates input, ownership and empty-state restrictions without exposing role data", async (t) => {
  const { target, root, storage, config, manager, create } = harness(t);
  const processes = new ProcessManager(config, storage, root);
  const registry = new SessionRegistry(processes, manager, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, processes, manager, storage, config.defaultMode, config, registry);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (id: string, cwd: unknown) => fetch(`${base}/api/sessions/${id}/directory`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }),
  });
  const original = create();
  for (const invalid of ["", "  ", null, 42, {}]) assert.equal((await request(original.id, invalid)).status, 400);
  assert.equal((await request("missing", target)).status, 404);
  storage.saveSession({ ...original, id: "stored-pty", sessionKind: "pty", runner: "pty" });
  assert.equal((await request("stored-pty", target)).status, 400);
  const changed = await request(original.id, target);
  assert.equal(changed.status, 200);
  const dto = await changed.json() as SessionSnapshot;
  assert.equal(dto.id, original.id);
  assert.equal(dto.cwd, target);
  assert.equal(dto.employeeId, original.employeeId);
  assert.equal("systemPrompt" in dto, false);
  assert.equal("runtimeSystemPrompt" in dto, false);
  manager.get(original.id)!.messages!.push({ role: "user", content: [{ type: "text", text: "已发送" }] });
  assert.equal((await request(original.id, root)).status, 400);
  assert.equal(manager.get(original.id)?.cwd, target);
});
