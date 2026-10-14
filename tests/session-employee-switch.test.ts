import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
import type { SessionSnapshot } from "../src/types.js";
import type { StructuredRunnerAdapter } from "../src/structured-runner.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";

function harness(t: TestContext, claudeCli?: StructuredRunnerAdapter, core?: StructuredRunnerAdapter) {
  const root = mkdtempSync(join(tmpdir(), "wand-employee-switch-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, defaultCodexModel: "codex-default",
    defaultThinkingEffort: "pi:high" as const,
    harness: { ...defaultConfig().harness, agentDir: join(root, "unconfigured-agent") } };
  const manager = new StructuredSessionManager(storage, config, null, { claudeCli, core });
  t.after(async () => {
    manager.dispose();
    await whenIterationPromptsSettled();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const create = () => manager.createSession({ cwd: root, mode: "default", provider: "pi",
    employeeId: "employee-test", employeeName: "测试员工", employeeAvatar: "cat:1",
    systemPrompt: "保留员工规则和知识归属", workspaceId: "workspace-test", workspaceTaskId: "task-test",
    model: "pi-model", thinkingEffort: "pi:high", employeeCandidates: [
      { provider: "pi", model: "pi-model", thinkingEffort: "pi:high", mode: "default", kind: "structured" },
      { provider: "codex", model: "codex-model", thinkingEffort: "deep", mode: "managed", kind: "structured" },
    ], employeeCandidateIndex: 0 });
  return { root, storage, config, manager, create };
}

function employee(id = "employee-next", provider: "codex" | "pi" = "codex") {
  return { id, name: "新员工", duty: "测试", prompt: "新员工独立规则", avatar: "cat:2",
    agents: [{ provider, model: "new-model", thinkingEffort: "deep" as const, mode: "default" as const,
      kind: "structured" as const }], createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z" };
}

test("blank employee selection changes role and candidates atomically while keeping session and task binding", (t) => {
  const { manager, storage, create } = harness(t);
  const original = create();
  const next = employee();
  storage.saveSiliconEmployee(next);
  const events: any[] = [];
  manager.setEventEmitter((event) => events.push(event));
  const updated = manager.setSessionEmployee(original.id, next.id);
  for (const key of ["id", "cwd", "workspaceId", "workspaceTaskId", "startedAt"] as const) {
    assert.equal(updated[key], original[key]);
  }
  assert.equal(updated.employeeId, next.id);
  assert.equal(updated.employeeName, next.name);
  assert.equal(updated.employeeAvatar, next.avatar);
  assert.equal(updated.systemPrompt, next.prompt);
  assert.deepEqual(updated.employeeCandidates, storage.getSiliconEmployee(next.id)!.agents);
  assert.equal(updated.provider, "codex");
  assert.equal(updated.mode, "full-access");
  assert.equal(updated.selectedModel, "new-model");
  assert.equal(updated.thinkingEffort, "deep");
  assert.equal(updated.employeeCandidateIndex, 0);
  assert.deepEqual(updated.messages, []);
  assert.deepEqual(updated.queuedMessages, []);
  assert.equal(storage.getSession(original.id)?.employeeId, next.id);
  assert.equal(storage.getSession(original.id)?.systemPrompt, next.prompt);
  assert.equal(manager.listSlim().length, 1);
  assert.equal(events.at(-1)?.data?.employeeId, next.id);
  manager.setSessionProvider(original.id, "claude");
  assert.equal(manager.get(original.id)?.employeeId, next.id);
  assert.equal(manager.get(original.id)?.systemPrompt, next.prompt);
});

test("same tool with a different employee uses the new role settings; selecting current employee keeps manual choices", (t) => {
  const { manager, storage, create } = harness(t);
  const original = create();
  const next = employee("employee-next", "pi");
  storage.saveSiliconEmployee(next);
  const updated = manager.setSessionEmployee(original.id, next.id);
  assert.equal(updated.selectedModel, "new-model");
  assert.equal(updated.systemPrompt, next.prompt);
  manager.setSessionModel(original.id, "explicit-model");
  assert.equal(manager.setSessionEmployee(original.id, next.id).selectedModel, "explicit-model");
});

test("unknown, archived or unusable employees never replace the current identity", (t) => {
  const { manager, storage, create } = harness(t);
  const original = create();
  storage.saveSiliconEmployee({ ...employee("archived"), archivedAt: "2026-10-10T00:00:00Z" });
  storage.saveSiliconEmployee({ ...employee("empty"), agents: [] });
  for (const id of ["missing", "archived", "empty"]) {
    assert.throws(() => manager.setSessionEmployee(original.id, id));
    assert.equal(manager.get(original.id), original);
    assert.equal(storage.getSession(original.id)?.employeeId, original.employeeId);
  }
});

test("history, accepted or queued input, active execution, resume and automation forbid employee replacement", (t) => {
  const { manager, storage, create } = harness(t);
  storage.saveSiliconEmployee(employee());
  const blocked: Partial<SessionSnapshot>[] = [
    { messages: [{ role: "user", content: [{ type: "text", text: "已接受" }] }] },
    { queuedMessages: ["已排队"] }, { status: "running" }, { archived: true },
    { claudeSessionId: "native-id" }, { resumedFromSessionId: "restored" }, { autoRecovered: true },
    { automationId: "ai-team:run" }, { sessionSource: "automation" }, { sessionSource: "startup" },
    { structuredState: { provider: "pi", runner: "pi-cli-json", inFlight: false,
      activeRequestId: "pending", lastError: null } },
  ];
  for (const patch of blocked) {
    const original = create();
    Object.assign(manager.get(original.id)!, patch);
    assert.throws(() => manager.setSessionEmployee(original.id, employee().id), /空白对话/);
    assert.equal(storage.getSession(original.id)?.employeeId, original.employeeId);
  }
});

test("persistence failure and unavailable SDK cannot publish partial role or tool changes", (t) => {
  const { manager, storage, create } = harness(t);
  const original = create();
  storage.saveSiliconEmployee(employee());
  storage.saveSiliconEmployee({ ...employee("sdk", "pi"), agents: [{ ...employee("sdk", "pi").agents[0]!, engine: "sdk" }] });
  assert.throws(() => manager.setSessionEmployee(original.id, "sdk"));
  assert.equal(manager.get(original.id), original);
  const save = storage.saveSession.bind(storage);
  storage.saveSession = () => { throw new Error("数据库不可写"); };
  try {
    assert.throws(() => manager.setSessionEmployee(original.id, employee().id), /数据库不可写/);
    assert.equal(manager.get(original.id), original);
    assert.equal(storage.getSession(original.id)?.employeeId, original.employeeId);
  } finally { storage.saveSession = save; }
});

test("employee HTTP endpoint validates IDs and owner, returns safe same-session DTO and rejects sent conversations", async (t) => {
  const { root, storage, config, manager, create } = harness(t);
  storage.saveSiliconEmployee(employee());
  const processes = new ProcessManager(config, storage, root);
  const registry = new SessionRegistry(processes, manager, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, { processes, structured: manager, storage, defaultMode: config.defaultMode, config, sessions: registry });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (id: string, employeeId: unknown) => fetch(`${base}/api/sessions/${id}/employee`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeId }),
  });
  const original = create();
  for (const invalid of ["", " ", null, 42, {}, "missing"]) assert.equal((await request(original.id, invalid)).status, 400);
  assert.equal((await request("missing-session", employee().id)).status, 404);
  storage.saveSession({ ...original, id: "stored-pty", sessionKind: "pty", runner: "pty" });
  assert.equal((await request("stored-pty", employee().id)).status, 400);
  const changed = await request(original.id, employee().id);
  assert.equal(changed.status, 200);
  const dto = await changed.json();
  assert.equal(dto.id, original.id);
  assert.equal(dto.employeeId, employee().id);
  for (const secret of ["systemPrompt", "runtimeSystemPrompt", "employeeCandidates"]) assert.equal(secret in dto, false);
  manager.get(original.id)!.messages!.push({ role: "user", content: [{ type: "text", text: "已接受" }] });
  assert.equal((await request(original.id, "employee-test")).status, 400);
  assert.equal(manager.get(original.id)?.employeeId, employee().id);
});
