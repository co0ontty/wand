import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";

import { defaultConfig } from "../src/config.js";
import { ProcessManager } from "../src/process-manager.js";
import { SESSION_PROVIDERS } from "../src/session-provider.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { WandStorage } from "../src/storage.js";
import { defaultStructuredRunner } from "../src/structured-provider-common.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { SessionSnapshot } from "../src/types.js";
import type { StructuredRunnerAdapter } from "../src/structured-runner.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";

function harness(t: TestContext, claudeCli?: StructuredRunnerAdapter, core?: StructuredRunnerAdapter) {
  const root = mkdtempSync(join(tmpdir(), "wand-provider-switch-"));
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

test("blank conversation switches all seven tools in place and persists identity and task binding", (t) => {
  const { manager, storage, create } = harness(t);
  const original = create();
  for (const provider of SESSION_PROVIDERS) {
    const updated = manager.setSessionProvider(original.id, provider);
    assert.equal(updated.id, original.id);
    assert.equal(updated.provider, provider);
    assert.equal(updated.runner, defaultStructuredRunner(provider));
    assert.equal(updated.structuredState?.provider, provider);
    assert.equal(updated.structuredState?.runner, updated.runner);
    assert.equal(updated.employeeId, original.employeeId);
    assert.equal(updated.systemPrompt, original.systemPrompt);
    assert.equal(updated.employeeName, original.employeeName);
    assert.equal(updated.employeeAvatar, original.employeeAvatar);
    assert.equal(updated.cwd, original.cwd);
    assert.equal(updated.workspaceId, original.workspaceId);
    assert.equal(updated.workspaceTaskId, original.workspaceTaskId);
    assert.equal(updated.startedAt, original.startedAt);
    assert.deepEqual(updated.employeeCandidates, original.employeeCandidates);
    assert.deepEqual(updated.messages, []);
    assert.deepEqual(updated.queuedMessages, []);
    assert.equal(storage.getSession(original.id)?.provider, provider);
  }
  assert.equal(manager.listSlim().length, 1);
});

test("tool switch uses its candidate settings or its own defaults, never the previous tool's model", (t) => {
  const { manager, create } = harness(t);
  const original = create();
  const codex = manager.setSessionProvider(original.id, "codex");
  assert.equal(codex.selectedModel, "codex-model");
  assert.equal(codex.thinkingEffort, "deep");
  assert.equal(codex.mode, "full-access");
  assert.equal(codex.employeeCandidateIndex, 1);
  assert.equal(codex.autoApprovePermissions, true);
  const gemini = manager.setSessionProvider(original.id, "gemini");
  assert.equal(gemini.selectedModel, null);
  assert.equal(gemini.thinkingEffort, "off");
  assert.equal(gemini.employeeCandidateIndex, undefined);
  const pi = manager.setSessionProvider(original.id, "pi");
  assert.equal(pi.selectedModel, "pi-model");
  assert.equal(pi.thinkingEffort, "pi:high");
  assert.equal(pi.employeeCandidateIndex, 0);
});

test("selecting the same tool is a no-op preserving explicit model and thinking choices", (t) => {
  const { manager, create } = harness(t);
  const original = create();
  manager.setSessionModel(original.id, "chosen-model");
  manager.setSessionThinkingEffort(original.id, "max");
  const updated = manager.setSessionProvider(original.id, "pi");
  assert.equal(updated.selectedModel, "chosen-model");
  assert.equal(updated.thinkingEffort, "max");
});

test("Pi and Wand Agent switch in place using the matching engine candidate and persist their decision", (t) => {
  const { manager, storage, create } = harness(t, undefined, {} as StructuredRunnerAdapter);
  const original = create();
  original.employeeCandidates!.push({ provider: "pi", engine: "sdk", model: "sdk-model",
    thinkingEffort: "deep", mode: "default", kind: "structured" });
  const sdk = manager.setSessionProvider(original.id, "pi", "sdk");
  assert.equal(sdk.id, original.id);
  assert.equal(sdk.structuredState?.engine, "core");
  assert.equal(sdk.selectedModel, "sdk-model");
  assert.equal(sdk.employeeCandidateIndex, 2);
  assert.equal(sdk.piSettings?.globalTools, false);
  assert.equal(sdk.employeeId, original.employeeId);
  assert.equal(sdk.systemPrompt, original.systemPrompt);
  assert.equal(storage.getSession(original.id)?.structuredState?.engine, "core");
  assert.equal(manager.getPiSettings(original.id).resolution.engine, "core");
  manager.setSessionModel(original.id, "explicit-sdk-model");
  assert.equal(manager.setSessionProvider(original.id, "pi").selectedModel, "explicit-sdk-model", "legacy same-provider request keeps engine");
  const cli = manager.setSessionProvider(original.id, "pi", "cli");
  assert.equal(cli.structuredState?.engine, "cli");
  assert.equal(cli.selectedModel, "pi-model");
  assert.equal(cli.employeeCandidateIndex, 0);
  assert.equal(cli.piSettings?.globalTools, true);
  assert.equal(manager.getPiSettings(original.id).resolution.engine, "cli");
  const other = manager.setSessionProvider(original.id, "codex");
  assert.equal(other.structuredState?.engine, undefined);
  assert.equal(other.piSettings, undefined, "other tools do not inherit Pi capabilities");
});

test("engine switch rejects unsupported capability selections without discarding them", (t) => {
  const { manager, create } = harness(t, undefined, {} as StructuredRunnerAdapter);
  for (const patch of [
    { resources: { skills: ["skill-test"], mcpServers: [] } },
    { resources: { skills: [], mcpServers: ["mcp-test"] } },
    { lockedSkills: ["skill-test"] }, { autoResources: true }, { codemodeOverride: "off" as const },
  ]) {
    const original = create();
    const settings = { ...manager.getPiSettings(original.id).settings, ...patch };
    manager.get(original.id)!.piSettings = settings;
    assert.throws(() => manager.setSessionProvider(original.id, "pi", "sdk"), /Wand Agent 不支持/);
    assert.equal(manager.get(original.id)?.piSettings, settings);
    assert.notEqual(manager.get(original.id)?.structuredState?.engine, "core");
  }
});

test("an unavailable SDK or failed persistence cannot publish an engine switch", (t) => {
  const { manager, storage, create } = harness(t);
  const original = create();
  assert.throws(() => manager.setSessionProvider(original.id, "pi", "sdk"));
  assert.equal(manager.get(original.id), original);
  assert.throws(() => manager.setSessionProvider(original.id, "codex", "sdk"), /只支持 Pi/);
  const available = harness(t, undefined, {} as StructuredRunnerAdapter);
  const blank = available.create();
  const save = available.storage.saveSession.bind(available.storage);
  available.storage.saveSession = () => { throw new Error("数据库不可写"); };
  try {
    assert.throws(() => available.manager.setSessionProvider(blank.id, "pi", "sdk"), /数据库不可写/);
    assert.equal(available.manager.get(blank.id), blank);
    assert.notEqual(storage.getSession(original.id)?.structuredState?.engine, "core");
  } finally { available.storage.saveSession = save; }
});

test("accepted input, queued input, active execution, resume ids and automation forbid provider changes", (t) => {
  const { manager, create } = harness(t);
  const blocked: Partial<SessionSnapshot>[] = [
    { messages: [{ role: "user", content: [{ type: "text", text: "已经发送" }] }] },
    { queuedMessages: ["已经排队"] },
    { status: "running" },
    { claudeSessionId: "native-session" },
    { resumedFromSessionId: "restored-session" },
    { autoRecovered: true },
    { automationId: "ai-team:run-1" },
    { sessionSource: "automation" },
    { sessionSource: "startup" },
    { archived: true },
    { structuredState: { provider: "pi", runner: "pi-cli-json", inFlight: true,
      activeRequestId: "busy", lastError: null } },
  ];
  for (const patch of blocked) {
    const original = create();
    Object.assign(manager.get(original.id)!, patch);
    assert.throws(() => manager.setSessionProvider(original.id, "codex"), /空白对话/);
    assert.equal(manager.get(original.id)?.provider, "pi");
  }
});

test("explicit tool outside the employee chain is not silently replaced after spawn rejection", async (t) => {
  let starts = 0;
  const claudeCli: StructuredRunnerAdapter = { start() {
    starts++;
    return { args: [], spawnedAt: new Date().toISOString(), pid: null, interrupt() {},
      completion: Promise.resolve({
        state: { blocks: [], result: "", sessionId: null }, exitCode: null, signal: null,
        stderr: "", primaryError: null, spawnError: Object.assign(new Error("unavailable"), { code: "ENOENT" }),
      }) };
  } };
  const { manager, create } = harness(t, claudeCli);
  const original = create();
  manager.setSessionProvider(original.id, "claude");
  await assert.rejects(manager.sendMessage(original.id, "不能重发给别的工具"));
  assert.equal(starts, 1);
  assert.equal(manager.get(original.id)?.provider, "claude");
  assert.equal(manager.get(original.id)?.messages?.filter((turn) => turn.role === "user").length, 1);
});

test("failed persistence cannot publish a tool change that was not saved", (t) => {
  const { manager, storage, create } = harness(t);
  const original = create();
  const save = storage.saveSession.bind(storage);
  storage.saveSession = () => { throw new Error("数据库不可写"); };
  try {
    assert.throws(() => manager.setSessionProvider(original.id, "codex"), /数据库不可写/);
    assert.equal(manager.get(original.id)?.provider, "pi");
  } finally {
    storage.saveSession = save;
  }
});

test("HTTP provider switch routes by owner, validates input and never rewrites a nonempty conversation", async (t) => {
  const { root, storage, config, manager, create } = harness(t);
  const processes = new ProcessManager(config, storage, root);
  const registry = new SessionRegistry(processes, manager, storage);
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, processes, manager, storage, config.defaultMode, config, registry);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (id: string, provider: unknown, engine?: unknown) => fetch(`${base}/api/sessions/${id}/provider`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, engine }),
  });
  const original = create();
  assert.equal(registry.ownerOf(original.id), "structured");
  const changed = await request(original.id, "codex");
  assert.equal(changed.status, 200);
  const dto = await changed.json() as SessionSnapshot;
  assert.equal(dto.id, original.id);
  assert.equal(dto.provider, "codex");
  assert.equal(dto.employeeId, original.employeeId);
  assert.equal("systemPrompt" in dto, false);
  assert.equal("runtimeSystemPrompt" in dto, false);
  for (const invalid of ["shell", "bad-cli", "", null, 42]) {
    assert.equal((await request(original.id, invalid)).status, 400);
  }
  assert.equal((await request(original.id, "pi", "core")).status, 400);
  assert.equal((await request(original.id, "codex", "sdk")).status, 400);
  assert.equal((await request(original.id, "pi", "sdk")).status, 400, "unavailable SDK must not mutate the session");
  assert.equal(manager.get(original.id)?.provider, "codex");
  const cli = await request(original.id, "pi", "cli");
  assert.equal(cli.status, 200);
  assert.equal((await cli.json() as SessionSnapshot).structuredState?.engine, "cli");
  manager.setSessionProvider(original.id, "codex");
  assert.equal((await request("missing", "pi")).status, 404);
  const stored = { ...original, id: "stored-pty", sessionKind: "pty" as const, runner: "pty" as const };
  storage.saveSession(stored);
  assert.equal(registry.ownerOf(stored.id), "storage");
  assert.equal((await request(stored.id, "pi")).status, 400);
  manager.get(original.id)!.messages!.push({ role: "user", content: [{ type: "text", text: "已接受" }] });
  assert.equal((await request(original.id, "pi")).status, 400);
  assert.equal(manager.get(original.id)?.provider, "codex");
});
