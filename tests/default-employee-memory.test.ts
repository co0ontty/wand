import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { DEFAULT_EMPLOYEE_ID, DEFAULT_EMPLOYEE_KEY, DEFAULT_EMPLOYEE_NAME, SYSTEM_EMPLOYEE_ID, isDefaultSiliconEmployee } from "../src/ai-team-types.js";
import { defaultConfig, loadConfigWithStorage } from "../src/config.js";
import { DEFAULT_EMPLOYEE_PROMPT } from "../src/default-employee.js";
import { SPEECH_POLISHER_ID } from "../src/speech-polisher-identity.js";
import { DECISION_EXPERT_ID, DECISION_EXPERT_KEY } from "../src/decision-expert-identity.js";
import { dispatchAgentForTask } from "../src/agent-dispatch.js";
import { recordIterationPrompt, whenIterationPromptsSettled } from "../src/iteration-log.js";
import { registerSiliconEmployeeRoutes } from "../src/server-employee-routes.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import { registerUserMemoryRoutes, userMemoryOperationLog } from "../src/server-user-memory.js";
import { ProcessManager } from "../src/process-manager.js";
import { toSessionListItemDTO } from "../src/session-transport.js";
import { SessionRegistry } from "../src/session-registry.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";
import { SYSTEM_EMPLOYEE_PROMPT } from "../src/system-employee.js";
import { parseUserMemoryPreferences, recordUserMemory, redactUserMemoryText, UserMemoryService, whenUserMemorySettled } from "../src/user-memory.js";
import { USER_MEMORY_MAX_EVENTS, USER_MEMORY_REFRESH_MS, USER_MEMORY_RETENTION_MS, type UserMemoryPreference } from "../src/user-memory-types.js";
import type { SessionSnapshot } from "../src/types.js";

const PI = { provider: "pi", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" } as const;
const CODEX = { provider: "codex", model: "user-model", thinkingEffort: "deep", mode: "full-access", kind: "structured" } as const;

function temporary(): { storage: WandStorage; root: string; cleanup: () => Promise<void> } {
  const root = mkdtempSync(join(tmpdir(), "wand-default-memory-"));
  const storage = new WandStorage(join(root, "wand.db"));
  return { root, storage, async cleanup() {
    await whenUserMemorySettled(storage);
    await whenIterationPromptsSettled();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  } };
}

function seedEvents(storage: WandStorage, now = Date.now()): void {
  for (let index = 0; index < 3; index++) {
    storage.appendUserMemoryEvent("session.prompt", "希望回复先写结论，再给验证证据。", `seed-${index}`, storage.getUserMemoryState(now).revision, now - index * 1000);
  }
}

test("default partner is seeded alongside ops, idempotent and preserves candidates on restart", async (t) => {
  const { storage, root, cleanup } = temporary();
  t.after(cleanup);
  await loadConfigWithStorage(join(root, "config.json"), storage);
  const role = storage.getDefaultSiliconEmployee()!;
  assert.equal(role.id, DEFAULT_EMPLOYEE_ID);
  assert.equal(role.systemKey, DEFAULT_EMPLOYEE_KEY);
  assert.equal(role.prompt, DEFAULT_EMPLOYEE_PROMPT);
  assert.ok(isDefaultSiliconEmployee(role));
  assert.equal(storage.getSystemSiliconEmployee()?.prompt, SYSTEM_EMPLOYEE_PROMPT);
  const decisionExpert = storage.getSystemSiliconEmployee(DECISION_EXPERT_KEY)!;
  assert.equal(decisionExpert.id, DECISION_EXPERT_ID);
  const decisionCandidates = decisionExpert.agents.slice().reverse();
  storage.saveSiliconEmployee({ ...decisionExpert, agents: decisionCandidates });
  storage.saveSiliconEmployee({ ...role, agents: [CODEX, PI] });
  await loadConfigWithStorage(join(root, "config.json"), storage);
  assert.deepEqual(storage.listSiliconEmployees().map((employee) => employee.id), [SYSTEM_EMPLOYEE_ID, DEFAULT_EMPLOYEE_ID, DECISION_EXPERT_ID, SPEECH_POLISHER_ID]);
  assert.deepEqual(storage.getDefaultSiliconEmployee()?.agents, [CODEX, PI]);
  assert.equal(storage.getSystemSiliconEmployee(DECISION_EXPERT_KEY)?.id, decisionExpert.id);
  assert.deepEqual(storage.getSystemSiliconEmployee(DECISION_EXPERT_KEY)?.agents, decisionCandidates);
});

test("memory strips secret lines, links, long keys and private paths before clipping", () => {
  const input = [
    "请简洁用中文汇报。", "api_key = sk-not-real-secret-value", "连接码=not-real-connection-code",
    "密码: only-a-fixture", "https://user:fixture@example.test/path?auth=fixture",
    "-----BEGIN PRIVATE KEY-----", "PRIVATE-FIXTURE-MATERIAL", "-----END PRIVATE KEY-----",
    "放在 /Users/fixture/private-repo 里。", "x".repeat(80),
  ].join("\n");
  const redacted = redactUserMemoryText(input);
  assert.match(redacted, /简洁用中文/);
  for (const secret of ["not-real", "only-a-fixture", "user:", "PRIVATE-FIXTURE", "/Users/fixture", "x".repeat(40)]) {
    assert.ok(!redacted.includes(secret), secret);
  }
  assert.ok(redactUserMemoryText("中文".repeat(500)).length <= 600);
});

test("memory recording is asynchronous, deduplicated, bounded and reset-safe", async (t) => {
  const { storage, cleanup } = temporary();
  t.after(cleanup);
  recordUserMemory(storage, "session.prompt", "请先写结论。", "s1");
  assert.equal(storage.listUserMemoryEvents().length, 0);
  recordUserMemory(storage, "session.prompt", "请先写结论。", "s1");
  await whenUserMemorySettled(storage);
  assert.equal(storage.listUserMemoryEvents().length, 1);
  recordUserMemory(storage, "session.prompt", "这条在清空前排队，不能晚到。", "s1");
  storage.clearUserMemory();
  await whenUserMemorySettled(storage);
  assert.equal(storage.listUserMemoryEvents().length, 0);
  storage.setUserMemoryEnabled(false);
  recordUserMemory(storage, "session.prompt", "关闭后不应记录。", "s1");
  await whenUserMemorySettled(storage);
  assert.equal(storage.listUserMemoryEvents().length, 0);
  storage.setUserMemoryEnabled(true);
  const state = storage.getUserMemoryState();
  const now = Date.now();
  for (let index = 0; index <= USER_MEMORY_MAX_EVENTS; index++) {
    storage.appendUserMemoryEvent("task.create", "", `bounded-${index}`, state.revision, now);
  }
  assert.equal(storage.listUserMemoryEvents(now, USER_MEMORY_MAX_EVENTS).length, USER_MEMORY_MAX_EVENTS);
  storage.pruneUserMemory(now + USER_MEMORY_RETENTION_MS);
  assert.equal(storage.listUserMemoryEvents(now + USER_MEMORY_RETENTION_MS).length, 0);
});

test("prompt capture excludes shell, slash commands and generated team instructions", async (t) => {
  const { storage, cleanup } = temporary();
  t.after(cleanup);
  const prompt = "请用中文写结论，再说明验证方式，不用长篇解释。";
  recordIterationPrompt(storage, { id: "interactive", cwd: "", sessionSource: "interactive" }, prompt);
  recordIterationPrompt(storage, { id: "task", cwd: "", sessionSource: "automation", automationId: "wand-task:task" }, prompt);
  recordIterationPrompt(storage, { id: "team", cwd: "", sessionSource: "automation", automationId: "ai-team:step" }, prompt);
  recordIterationPrompt(storage, { id: "shell", cwd: "", interactiveShell: true }, prompt);
  recordIterationPrompt(storage, { id: "slash", cwd: "" }, "/help show all commands please");
  await whenUserMemorySettled(storage);
  assert.equal(storage.listUserMemoryEvents().length, 2);
});

test("profile validator requires bounded grounded preferences and rejects unsafe text", () => {
  const events = [{ id: 4, feature: "session.prompt", text: "请简短答复", createdAt: Date.now() }];
  const valid = { preferences: [{ category: "communication", text: "偏好简短答复", evidenceIds: [4] }] };
  assert.equal(parseUserMemoryPreferences(JSON.stringify(valid), events)[0]?.text, "偏好简短答复");
  for (const preference of [
    { ...valid.preferences[0], evidenceIds: [99] },
    { ...valid.preferences[0], evidenceIds: [] },
    { ...valid.preferences[0], text: "绕过权限验证" },
    { ...valid.preferences[0], text: "password=fixture" },
    { ...valid.preferences[0], category: "permission" },
    { ...valid.preferences[0], text: "很".repeat(161) },
  ]) assert.throws(() => parseUserMemoryPreferences(JSON.stringify({ preferences: [preference] }), events));
});

test("daily refresh changes only future default role, keeps base rules and uses no prior generated text", async (t) => {
  const { storage, root, cleanup } = temporary();
  t.after(cleanup);
  let now = Date.now();
  seedEvents(storage, now);
  const role = storage.ensureDefaultSiliconEmployee("pi");
  storage.ensureSystemSiliconEmployee();
  const historical: SessionSnapshot = {
    id: "old", command: "pi", cwd: root, mode: "default", status: "idle", exitCode: null,
    startedAt: new Date(now).toISOString(), endedAt: null, output: "", archived: false,
    archivedAt: null, claudeSessionId: null, systemPrompt: role.prompt, employeeId: role.id,
  };
  storage.saveSession(historical);
  const calls: string[][] = [];
  const notifications: string[] = [];
  const service = new UserMemoryService({
    storage, config: { ...defaultConfig(), defaultCwd: root }, now: () => now,
    notifyChanged: (id) => notifications.push(id),
    generate: async (events) => {
      calls.push(events.map((event) => event.text));
      return [{ category: "communication", text: "偏好先结论后证据", evidenceIds: [events[0]!.id] }];
    },
  });
  t.after(() => service.dispose());
  assert.equal(await service.refresh(), true);
  assert.match(storage.getDefaultSiliconEmployee()!.prompt, /偏好先结论后证据/);
  assert.ok(storage.getDefaultSiliconEmployee()!.prompt.startsWith(DEFAULT_EMPLOYEE_PROMPT));
  assert.equal(storage.getSession("old")!.systemPrompt, role.prompt);
  assert.equal(storage.getSystemSiliconEmployee()!.prompt, SYSTEM_EMPLOYEE_PROMPT);
  assert.equal(await service.refresh(), false);
  now += USER_MEMORY_REFRESH_MS;
  assert.equal(await service.refresh(), false, "unchanged evidence does not consume a daily model call");
  storage.appendUserMemoryEvent("session.prompt", "新要求：仍要简短。", "new", 0, now);
  assert.equal(await service.refresh(), true);
  assert.equal(calls.length, 2);
  assert.ok(calls.flat().every((text) => !text.includes("偏好先结论后证据")));
  assert.deepEqual(notifications, [DEFAULT_EMPLOYEE_ID, DEFAULT_EMPLOYEE_ID]);
  assert.equal(storage.getDefaultSiliconEmployee()!.prompt, storage.ensureDefaultSiliconEmployee().prompt);
});

test("a slow generation preserves candidate edits and cannot resurrect cleared/disabled memory", async (t) => {
  const { storage, root, cleanup } = temporary();
  t.after(cleanup);
  seedEvents(storage);
  storage.ensureDefaultSiliconEmployee("pi");
  let finish!: (value: UserMemoryPreference[]) => void;
  let evidence = 0;
  const service = new UserMemoryService({ storage, config: { ...defaultConfig(), defaultCwd: root },
    generate: (events) => { evidence = events[0]!.id; return new Promise((resolve) => { finish = resolve; }); },
  });
  t.after(() => service.dispose());
  const refreshing = service.refresh();
  const role = storage.getDefaultSiliconEmployee()!;
  storage.saveSiliconEmployee({ ...role, agents: [CODEX] });
  finish([{ category: "workflow", text: "关注验证结果", evidenceIds: [evidence] }]);
  assert.equal(await refreshing, true);
  assert.deepEqual(storage.getDefaultSiliconEmployee()!.agents, [CODEX]);
  storage.clearUserMemory();
  seedEvents(storage);
  const next = service.refresh(true);
  storage.setUserMemoryEnabled(false);
  finish([{ category: "workflow", text: "关注验证结果", evidenceIds: [evidence] }]);
  assert.equal(await next, false);
  assert.equal(storage.getDefaultSiliconEmployee()!.prompt, DEFAULT_EMPLOYEE_PROMPT);
  assert.equal(service.view().profile, null);
});

test("expired or evicted evidence disappears from role even before the timer runs", async (t) => {
  const { storage, cleanup } = temporary();
  t.after(cleanup);
  const now = Date.now();
  seedEvents(storage, now - USER_MEMORY_RETENTION_MS + 20_000);
  storage.ensureDefaultSiliconEmployee();
  const events = storage.listUserMemoryEvents(now);
  assert.ok(storage.applyUserMemoryProfile({ generatedAt: now, expiresAt: now + 19_000,
    preferences: [{ category: "focus", text: "最近关注前端", evidenceIds: [events[0]!.id] }],
  }, 0, events.at(-1)!.id, now));
  assert.match(storage.getDefaultSiliconEmployee()!.prompt, /最近关注前端/);
  assert.equal(storage.getUserMemoryState(now + 20_000).profile, null);
  storage.pruneUserMemory(now + 20_000);
  assert.equal(storage.getDefaultSiliconEmployee()!.prompt, DEFAULT_EMPLOYEE_PROMPT);
});

test("failed generation keeps prior profile and is throttled across attempts", async (t) => {
  const { storage, root, cleanup } = temporary();
  t.after(cleanup);
  seedEvents(storage);
  let calls = 0;
  const service = new UserMemoryService({ storage, config: { ...defaultConfig(), defaultCwd: root },
    generate: async () => { calls++; throw new Error("a-private-fixture-error-that-must-not-be-logged"); },
  });
  t.after(() => service.dispose());
  assert.equal(await service.refresh(), false);
  assert.equal(await service.refresh(), false);
  assert.equal(await service.refresh(true), false);
  assert.equal(calls, 1);
});

test("HTTP memory logs only allowlisted successful actions; default built-in cannot be deleted", async (t) => {
  const { storage, root, cleanup } = temporary();
  t.after(cleanup);
  storage.ensureDefaultSiliconEmployee("pi");
  const service = new UserMemoryService({ storage, config: { ...defaultConfig(), defaultCwd: root },
    generate: async (events) => [{ category: "focus", text: "近期在维护任务", evidenceIds: [events[0]!.id] }],
  });
  t.after(() => service.dispose());
  const app = express();
  app.use(express.json());
  app.use(userMemoryOperationLog(storage));
  registerUserMemoryRoutes(app, { storage, service });
  registerSiliconEmployeeRoutes(app, { storage });
  app.post("/api/tasks", (req, res) => res.status(req.body.fail ? 400 : 201).json({ ok: !req.body.fail }));
  app.post("/api/login", (_req, res) => res.json({ ok: true }));
  app.get("/api/tasks", (_req, res) => res.json([]));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method,
      headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() as Record<string, unknown> };
  };
  await call("POST", "/api/tasks", { description: "请把关键操作补齐验证。\npassword=private-fixture" });
  await call("POST", "/api/tasks", { fail: true, description: "不能学习这次失败" });
  await call("POST", "/api/login", { password: "private-fixture" });
  await call("GET", "/api/tasks");
  await whenUserMemorySettled(storage);
  assert.equal(storage.listUserMemoryEvents().length, 1);
  assert.match(storage.listUserMemoryEvents()[0]!.text, /关键操作/);
  assert.ok(!storage.listUserMemoryEvents()[0]!.text.includes("private-fixture"));
  assert.equal((await call("DELETE", `/api/silicon-employees/${DEFAULT_EMPLOYEE_ID}`)).status, 400);
  assert.equal((await call("POST", `/api/silicon-employees/${DEFAULT_EMPLOYEE_ID}/archive`)).status, 400);
  assert.equal((await call("PUT", `/api/silicon-employees/${DEFAULT_EMPLOYEE_ID}`, { agents: [CODEX] })).status, 200);
  assert.equal((await call("PUT", `/api/silicon-employees/${DEFAULT_EMPLOYEE_ID}`, { agents: [PI], prompt: "手动覆盖" })).status, 400);
  assert.equal((await call("PATCH", "/api/user-memory", { enabled: false })).status, 200);
  await call("POST", "/api/tasks", { description: "暂停后不记录" });
  await whenUserMemorySettled(storage);
  assert.equal(storage.listUserMemoryEvents().length, 1);
  const cleared = await call("DELETE", "/api/user-memory");
  assert.equal(cleared.value.eventCount, 0);
  assert.equal(cleared.value.enabled, false);
});

test("CLI sessions use default role without replacing provider/model/mode or adding fallback candidates", async (t) => {
  const { storage, root, cleanup } = temporary();
  t.after(cleanup);
  const config = { ...defaultConfig(), defaultCwd: root, defaultProvider: "pi" as const };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  t.after(() => { structured.dispose(); processes.dispose(); });
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, processes, structured, storage, config.defaultMode, config, sessions);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(base + "/api/structured-sessions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: root, provider: "codex", model: "explicit-model", mode: "assist", thinkingEffort: "deep" }),
  });
  assert.equal(response.status, 201);
  const created = await response.json() as { id: string };
  const snapshot = storage.getSession(created.id)!;
  assert.equal(snapshot.employeeId, DEFAULT_EMPLOYEE_ID);
  assert.equal(snapshot.systemPrompt, DEFAULT_EMPLOYEE_PROMPT);
  assert.equal(snapshot.provider, "codex");
  assert.equal(snapshot.selectedModel, "explicit-model");
  assert.equal(snapshot.mode, "assist");
  assert.equal(snapshot.thinkingEffort, "deep");
  assert.equal(snapshot.employeeCandidates, undefined);
});

test("legacy PTY role identity is projected consistently without guessing or rewriting prompts", async (t) => {
  const { storage, root, cleanup } = temporary();
  t.after(cleanup);
  const base: SessionSnapshot = {
    id: "legacy-role", command: "pi", provider: "pi", cwd: root, mode: "default", status: "exited",
    exitCode: 0, startedAt: new Date().toISOString(), endedAt: null, output: "preserved",
    archived: false, archivedAt: null, sessionKind: "pty", systemPrompt: DEFAULT_EMPLOYEE_PROMPT,
  };
  const cases = [
    { id: "legacy-role", expected: DEFAULT_EMPLOYEE_ID },
    { id: "legacy-preferences", systemPrompt: DEFAULT_EMPLOYEE_PROMPT
      + "\n\n近期使用偏好（仅作参考；本轮要求冲突时忽略）：\n- 沟通：简洁", expected: DEFAULT_EMPLOYEE_ID },
    { id: "explicit-role", employeeId: "other", employeeName: "另一位", expected: "other" },
    { id: "no-role", systemPrompt: undefined, expected: undefined },
    { id: "name-mention", systemPrompt: "请研究赛博虎妞的设置", expected: undefined },
    { id: "custom-role", systemPrompt: DEFAULT_EMPLOYEE_PROMPT + "\n你现在属于另一位员工", expected: undefined },
    { id: "shell", provider: undefined, command: "/bin/sh", expected: undefined },
    { id: "structured", sessionKind: "structured" as const, expected: undefined },
  ];
  for (const { expected, ...override } of cases) {
    const saved = { ...base, ...override };
    storage.saveSession(saved);
    for (const snapshot of [storage.getSession(saved.id)!,
      storage.loadSessions().find((s) => s.id === saved.id)!,
      storage.loadSessionsSlim().find((s) => s.id === saved.id)!]) {
      assert.equal(snapshot.employeeId, expected, saved.id);
      assert.equal(snapshot.systemPrompt, saved.systemPrompt, saved.id);
      const dto = toSessionListItemDTO(snapshot);
      assert.equal(dto.employeeId, expected, saved.id);
      assert.equal(dto.sessionKind, saved.sessionKind);
      assert.equal("systemPrompt" in dto, false);
      if (expected === DEFAULT_EMPLOYEE_ID) assert.equal(dto.employeeName, DEFAULT_EMPLOYEE_NAME);
    }
  }
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  t.after(() => { structured.dispose(); processes.dispose(); });
  const sessions = new SessionRegistry(processes, structured, storage);
  assert.equal(sessions.ownerOf(base.id), "pty");
  assert.equal(processes.getOwned(base.id)?.employeeId, DEFAULT_EMPLOYEE_ID);
  assert.equal(sessions.get(base.id)?.employeeId, DEFAULT_EMPLOYEE_ID);
  assert.equal(sessions.listSlim().find((s) => s.id === base.id)?.employeeId, DEFAULT_EMPLOYEE_ID);
});

test("task dispatch defaults a missing executor; selected CLI and PTY contracts stay intact", async (t) => {
  const { storage, root, cleanup } = temporary();
  t.after(cleanup);
  const config = { ...defaultConfig(), defaultCwd: root, defaultProvider: "pi" as const };
  const created: Array<Record<string, unknown>> = [];
  const inputs: string[] = [];
  const structured = {
    createSession(options: Record<string, unknown>) {
      created.push(options);
      const snapshot: SessionSnapshot = {
        id: `created-${created.length}`, command: "pi", cwd: root, mode: "default", status: "idle", exitCode: null,
        startedAt: new Date().toISOString(), endedAt: null, output: "", archived: false,
        archivedAt: null, claudeSessionId: null, sessionKind: "structured", ...options,
      } as SessionSnapshot;
      storage.saveSession(snapshot);
      return snapshot;
    },
    sendMessage(_id: string, text: string) { inputs.push(text); return Promise.resolve(); },
  } as unknown as StructuredSessionManager;
  const sessions = { listSlim: () => [] } as unknown as SessionRegistry;
  const app = express();
  app.use(express.json());
  registerTaskRoutes(app, { storage, config, structured, sessions });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const task = storage.createWandTask({ title: "默认处理", description: "只做当前工作" });
  const response = await fetch(`${base}/api/wand-tasks/${task.id}/dispatch`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "真实用户提示词" }),
  });
  assert.equal(response.status, 202, await response.text());
  assert.equal(created[0]!.employeeId, DEFAULT_EMPLOYEE_ID);
  assert.equal(created[0]!.provider, "pi");
  assert.equal(created[0]!.systemPrompt, DEFAULT_EMPLOYEE_PROMPT);
  assert.deepEqual(inputs, ["真实用户提示词"]);
  assert.deepEqual(storage.getWandTask(task.id)?.executionSubject, { type: "cli", id: "pi" });
  let ptyOptions: Record<string, unknown> = {};
  const processes = { async start(_command: string, _cwd: string, _mode: string, text: string, options: Record<string, unknown>) {
    ptyOptions = options;
    assert.equal(text, "PTY 用户文本");
    const snapshot = { ...storage.getSession("created-1")!, id: "pty-new", sessionKind: "pty" as const, employeeId: undefined };
    storage.saveSession(snapshot);
    return snapshot;
  } } as unknown as ProcessManager;
  await dispatchAgentForTask({ storage, config, structured, processes }, {
    task, agent: { ...CODEX, kind: "pty" }, prompt: "PTY 用户文本", automationId: `wand-task:${task.id}`,
  });
  assert.equal(ptyOptions.systemPrompt, DEFAULT_EMPLOYEE_PROMPT);
  assert.equal(ptyOptions.provider, "codex");
  assert.equal(ptyOptions.model, "user-model");
  assert.equal(ptyOptions.employeeId, DEFAULT_EMPLOYEE_ID);
  assert.equal(ptyOptions.employeeName, DEFAULT_EMPLOYEE_NAME);
  assert.equal(ptyOptions.employeeAvatar, "");
  assert.equal(ptyOptions.employeeCandidates, undefined);
});
