import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";

import { defaultConfig } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";
import { ProcessManager } from "../src/process-manager.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { selectEmployeeCandidate } from "../src/silicon-employee-dispatch.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";
import { parseSiliconEmployeeInput, registerSiliconEmployeeRoutes } from "../src/server-employee-routes.js";
import {
  availableEmployeeProviders,
  buildEmployeeDraftPrompt,
  employeeAgentFor,
  generateSiliconEmployeeDraft,
  parseSiliconEmployeeDraft,
  SiliconEmployeeDraftError,
} from "../src/silicon-employee-draft.js";
import type { SiliconEmployee } from "../src/ai-team-types.js";
import type { StructuredRunnerAdapter } from "../src/structured-runner.js";
import type { AiTeamRunner } from "../src/ai-team-runner.js";

const CODEX = { provider: "codex", model: "default", thinkingEffort: "off", mode: "full-access", kind: "structured" } as const;
const PI = { provider: "pi", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" } as const;

function employee(overrides: Partial<SiliconEmployee> = {}): SiliconEmployee {
  return {
    id: "e_test123", name: "测试员工", duty: "自动化测试", prompt: "你是严谨的测试工程师。",
    avatar: "cat:1", agents: [CODEX, PI],
    createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

test("SiliconEmployee storage: CRUD & archive operations", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "wand-employee-test-"));
  const dbPath = join(tempDir, "wand.db");
  const storage = new WandStorage(dbPath);

  try {
    const initialList = storage.listSiliconEmployees();
    assert.deepEqual(initialList, []);

    const employee: SiliconEmployee = {
      id: "e_test123",
      name: "测试员工",
      duty: "前端开发与动效实现",
      prompt: "你是一名资深前端工程师",
      avatar: "cat:1",
      agents: [
        {
          provider: "claude",
          model: "claude-3-7-sonnet",
          thinkingEffort: "standard",
          mode: "default",
          kind: "structured",
        },
      ],
      createdAt: "2026-03-30T10:00:00.000Z",
      updatedAt: "2026-03-30T10:00:00.000Z",
    };

    storage.saveSiliconEmployee(employee);

    const fetched = storage.getSiliconEmployee("e_test123");
    assert.ok(fetched);
    assert.equal(fetched.name, "测试员工");
    assert.equal(fetched.agents.length, 1);
    assert.equal(fetched.agents[0]?.provider, "claude");

    // 更新
    storage.saveSiliconEmployee({
      ...employee,
      name: "更新后的员工",
      updatedAt: "2026-03-30T11:00:00.000Z",
    });
    const updated = storage.getSiliconEmployee("e_test123");
    assert.equal(updated?.name, "更新后的员工");

    // 归档
    storage.archiveSiliconEmployee("e_test123", "2026-03-30T12:00:00.000Z");
    assert.equal(storage.listSiliconEmployees().length, 0);
    assert.equal(storage.listSiliconEmployees({ includeArchived: true }).length, 1);

    // 取消归档
    storage.unarchiveSiliconEmployee("e_test123");
    assert.equal(storage.listSiliconEmployees().length, 1);

    // 删除
    storage.deleteSiliconEmployee("e_test123");
    assert.equal(storage.getSiliconEmployee("e_test123"), null);
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parseSiliconEmployeeInput validation", () => {
  const now = "2026-03-30T10:00:00.000Z";

  // 缺少名字
  assert.throws(() => {
    parseSiliconEmployeeInput({ name: "", agents: [] }, null, now);
  }, /员工名字不能为空/);

  // 缺少候选
  assert.throws(() => {
    parseSiliconEmployeeInput({ name: "小明", agents: [] }, null, now);
  }, /至少需要一个执行候选/);

  // 有效输入
  const valid = parseSiliconEmployeeInput({
    name: "小明",
    duty: "自动化测试",
    prompt: "严谨细致",
    agents: [
      {
        provider: "codex",
        model: "gpt-4o",
        thinkingEffort: "off",
        mode: "default",
        kind: "structured",
      },
    ],
  }, null, now);

  assert.equal(valid.name, "小明");
  assert.match(valid.id, /^e_[0-9a-f]{32}$/);
  assert.equal(valid.agents.length, 1);
  assert.notEqual(parseSiliconEmployeeInput({ ...valid, id: "e_existing" }, null, now).id, "e_existing");
  assert.throws(() => parseSiliconEmployeeInput({
    name: "终端员工", agents: [{ ...PI, kind: "pty" }],
  }, null, now), /只支持结构化会话/);
});

test("employee candidates keep configured order and skip an unavailable CLI", () => {
  const selected = selectEmployeeCandidate(employee(), (agent) => agent.provider === "pi");
  assert.equal(selected.index, 1);
  assert.equal(selected.agent.provider, "pi");
  assert.equal(selectEmployeeCandidate(employee(), () => false).index, 0);
});

test("employee HTTP create cannot replace an existing id; sessions and tasks retain identity snapshots", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-employee-http-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  const teamStarts: Array<{ teamId: string; taskId: string; note?: string }> = [];
  const aiTeams = { async start(input: { teamId: string; taskId: string; note?: string }) {
    teamStarts.push(input);
    return { run: { chatSessionId: "chat-team" } };
  } } as unknown as AiTeamRunner;
  const app = express();
  app.use(express.json());
  registerSiliconEmployeeRoutes(app, { storage });
  registerSessionRoutes(app, processes, structured, storage, config.defaultMode, config, sessions);
  registerTaskRoutes(app, { storage, sessions, structured, processes, config, aiTeams });
  registerWorkspaceRoutes(app, storage, sessions);
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await whenIterationPromptsSettled();
    structured.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const request = async (route: string, method: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: response.status === 204 ? null : await response.json() as Record<string, unknown> };
  };

  storage.saveSiliconEmployee(employee());
  const created = await request("/api/silicon-employees", "POST", {
    ...employee({ name: "新员工" }), id: "e_test123",
  });
  assert.equal(created.status, 201);
  assert.notEqual(created.json?.id, "e_test123");
  assert.equal(storage.getSiliconEmployee("e_test123")?.name, "测试员工");

  const made = await request("/api/structured-sessions", "POST", {
    cwd: root, employeeId: "e_test123", provider: "grok", systemPrompt: "客户端冒充规则",
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const sessionId = made.json?.id as string;
  assert.equal(made.json?.employeeId, "e_test123");
  assert.equal(made.json?.employeeName, "测试员工");
  assert.equal(made.json?.employeeAvatar, "cat:1");
  assert.equal(made.json?.employeeCandidateIndex, selectEmployeeCandidate(employee()).index);
  assert.equal(storage.getSession(sessionId)?.systemPrompt, "你是严谨的测试工程师。");
  assert.equal(storage.getSession(sessionId)?.employeeId, "e_test123");
  assert.equal(storage.getSession(sessionId)?.employeeCandidates?.length, 2);
  assert.equal((await request("/api/structured-sessions", "POST", {
    cwd: root, employeeId: "e_test123", runner: "pty",
  })).status, 400);
  assert.equal((await request("/api/structured-sessions", "POST", {
    cwd: root, teamId: "team_test",
  })).status, 400);

  const createdTask = await request("/api/wand-tasks", "POST", {
    title: "交给员工", executionSubject: { type: "employee", id: "e_test123" },
  });
  assert.equal(createdTask.status, 201, JSON.stringify(createdTask.json));
  assert.deepEqual(createdTask.json?.executionSubject, { type: "employee", id: "e_test123" });
  assert.equal((createdTask.json?.agent as Record<string, unknown>)?.provider, "codex");
  const changedSubject = await request(`/api/wand-tasks/${createdTask.json?.id}`, "PATCH", {
    executionSubject: { type: "cli", id: "pi" },
  });
  assert.equal(changedSubject.status, 200);
  assert.equal((changedSubject.json?.agent as Record<string, unknown>)?.provider, "pi");
  assert.deepEqual(changedSubject.json?.executionSubject, { type: "cli", id: "pi" });
  const invalidTask = await request("/api/wand-tasks", "POST", {
    title: "错误的终端员工", executionSubject: { type: "employee", id: "e_test123" },
    agent: { ...PI, kind: "pty" },
  });
  assert.equal(invalidTask.status, 400);
  assert.equal(storage.getPreference("pref:taskBoardLastAgent", null), null,
    "rejected task creation must not change the saved CLI preference");
  const invalidPatch = await request(`/api/wand-tasks/${createdTask.json?.id}`, "PATCH", {
    agent: { ...PI, kind: "pty" }, executionSubject: { type: "employee", id: "e_test123" },
  });
  assert.equal(invalidPatch.status, 400);
  assert.equal(storage.getPreference("pref:taskBoardLastAgent", null), null,
    "rejected task edits must not change the saved CLI preference");

  const task = storage.createWandTask({ title: "检查 API", description: "验证员工分派" });
  structured.sendMessage = (async (id: string) => structured.get(id)!) as typeof structured.sendMessage;
  const dispatched = await request(`/api/wand-tasks/${task.id}/dispatch`, "POST", {
    subject: { type: "employee", id: "e_test123" }, prompt: "执行测试",
  });
  assert.equal(dispatched.status, 202);
  assert.deepEqual(dispatched.json?.subject, { type: "employee", id: "e_test123" });
  const assigned = await request(`/api/wand-tasks/${task.id}`, "GET");
  assert.deepEqual(assigned.json?.executionSubject, { type: "employee", id: "e_test123" });
  assert.equal((assigned.json?.sessions as Array<Record<string, unknown>>)[0]?.employeeName, "测试员工");
  const movedTo = storage.createWorkspace({ name: "另一个项目", cwd: root });
  const rejectedMove = await request(`/api/wand-tasks/${task.id}/dispatch`, "POST", {
    subject: { type: "employee", id: "e_test123" }, workspaceId: movedTo.id,
  });
  assert.equal(rejectedMove.status, 400, "repeat dispatch needs an explicit prompt");
  assert.equal(storage.getWandTask(task.id)?.workspaceId, null,
    "rejected dispatch must not move the task before validation");
  const workspaceTree = (await request("/api/tasks", "GET")).json as unknown as Array<{
    tasks: Array<{ sessions: Array<{ employeeId?: string; employeeName?: string }> }>;
  }>;
  assert.equal(workspaceTree.flatMap((group) => group.tasks.flatMap((entry) => entry.sessions))
    .some((entry) => entry.employeeId === "e_test123" && entry.employeeName === "测试员工"), true);
  await request(`/api/wand-tasks/${task.id}`, "PATCH", { status: "done" });
  assert.deepEqual(storage.getWandTask(task.id)?.executionSubject, { type: "employee", id: "e_test123" });
  assert.equal((await request(`/api/wand-tasks/${task.id}/dispatch`, "POST", {
    subject: { type: "employee", id: "e_test123" }, kind: "pty", prompt: "终端执行",
  })).status, 400);

  storage.saveAiTeam({
    id: "team_test", name: "协作组", description: "", instructions: "",
    members: [{ id: "m_lead", name: "负责人", duty: "计划", agents: [CODEX], agent: CODEX, isLeader: true }],
    requirePlanApproval: false, maxSteps: 10,
    createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z",
  });
  assert.equal((await request(`/api/wand-tasks/${task.id}/dispatch`, "POST", {
    subject: { type: "team", id: "team_test" }, kind: "pty", prompt: "终端执行",
  })).status, 400);
  assert.equal(teamStarts.length, 0);
  const teamDispatch = await request(`/api/wand-tasks/${task.id}/dispatch`, "POST", {
    subject: { type: "team", id: "team_test" }, prompt: "安排协作",
  });
  assert.equal(teamDispatch.status, 202, JSON.stringify(teamDispatch.json));
  assert.equal((teamDispatch.json?.session as Record<string, unknown>)?.id, "chat-team");
  assert.deepEqual(teamStarts, [{ teamId: "team_test", taskId: task.id, note: "安排协作" }]);
  assert.deepEqual(storage.getWandTask(task.id)?.executionSubject, { type: "team", id: "team_test" });

  const oldCliDispatch = await request(`/api/wand-tasks/${task.id}/dispatch`, "POST", {
    agent: PI, prompt: "交给 CLI",
  });
  assert.equal(oldCliDispatch.status, 202, JSON.stringify(oldCliDispatch.json));
  assert.deepEqual(storage.getWandTask(task.id)?.executionSubject, { type: "cli", id: "pi" });

  assert.equal((await request("/api/silicon-employees/e_test123/archive", "POST", {})).status, 200);
  const activeEmployees = (await request("/api/silicon-employees", "GET")).json?.employees as Array<{ id: string }>;
  assert.equal(activeEmployees.some((item) => item.id === "e_test123"), false);
  const archivedEmployees = (await request("/api/silicon-employees?includeArchived=1", "GET")).json?.employees as Array<{ id: string }>;
  assert.equal(archivedEmployees.some((item) => item.id === "e_test123"), true);
  assert.equal((await request("/api/structured-sessions", "POST", {
    cwd: root, employeeId: "e_test123",
  })).status, 400);
  assert.equal((await request("/api/silicon-employees/e_test123", "DELETE")).status, 204);
  assert.equal(storage.getSession(sessionId)?.employeeName, "测试员工");
  const list = await request("/api/sessions", "GET");
  assert.equal((list.json as unknown as Array<Record<string, unknown>>).find((entry) => entry.id === sessionId)?.employeeName, "测试员工");
});

test("a failed spawn falls back before acceptance; a CLI runtime failure never resends", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-employee-fallback-"));
  const storage = new WandStorage(join(root, "wand.db"));
  let codexStarts = 0;
  let piStarts = 0;
  let runtimeFailure = false;
  const result = (spawnError?: NodeJS.ErrnoException) => ({
    state: { blocks: [{ type: "text" as const, text: spawnError || runtimeFailure ? "" : "备用已完成" }], result: "", sessionId: null },
    exitCode: spawnError ? null : runtimeFailure ? 1 : 0,
    signal: null, stderr: runtimeFailure ? "provider failed after accepting input" : "",
    primaryError: null, spawnError,
  });
  const codex = { start() {
    codexStarts++;
    return { args: [], spawnedAt: new Date().toISOString(), pid: null,
      completion: Promise.resolve(result(runtimeFailure ? undefined : Object.assign(new Error("missing"), { code: "ENOENT" }))),
      interrupt() {} };
  } } as StructuredRunnerAdapter;
  const pi = { start() {
    piStarts++;
    return { args: [], spawnedAt: new Date().toISOString(), pid: 1,
      completion: Promise.resolve(result()), interrupt() {} };
  } } as StructuredRunnerAdapter;
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root }, null, { codex, pi });
  t.after(async () => {
    manager.dispose();
    await whenIterationPromptsSettled();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const make = () => manager.createSession({ cwd: root, mode: "full-access", provider: "codex",
    employeeId: "e_test123", employeeName: "测试员工", employeeCandidates: [CODEX, PI], employeeCandidateIndex: 0 });
  const first = make();
  await manager.sendMessage(first.id, "请完成任务");
  assert.equal(manager.get(first.id)?.provider, "pi");
  assert.equal(manager.get(first.id)?.employeeCandidateIndex, 1);
  assert.equal(manager.get(first.id)?.messages?.filter((turn) => turn.role === "user").length, 1);
  assert.equal(codexStarts, 1);
  assert.equal(piStarts, 1);

  runtimeFailure = true;
  const second = make();
  await assert.rejects(manager.sendMessage(second.id, "可能已被接受"));
  assert.equal(manager.get(second.id)?.provider, "codex");
  assert.equal(manager.get(second.id)?.employeeCandidateIndex, 0);
  assert.equal(codexStarts, 2);
  assert.equal(piStarts, 1, "结果未知时不能重发到备用 CLI");
});

test("员工起草：解析模型输出、容忍围栏并收敛非法 provider", () => {
  const draft = parseSiliconEmployeeDraft(
    "```json\n" + JSON.stringify({
      name: "接口守夜人", duty: "守护接口稳定", prompt: "你是值守接口的工程师。", provider: "codex",
    }) + "\n```",
    { allowedProviders: ["claude", "codex"], fallbackProvider: "claude" },
  );
  assert.equal(draft.name, "接口守夜人");
  assert.equal(draft.agent.provider, "codex");
  assert.equal(draft.agent.kind, "structured");
  assert.equal(draft.agent.model, "default");

  // provider 不在已安装清单里时退回首选，员工不能带着跑不起来的 CLI 落库。
  const fallback = parseSiliconEmployeeDraft(
    JSON.stringify({ name: "前端小匠", duty: "负责前端实现", prompt: "你是资深前端。", provider: "gemini" }),
    { allowedProviders: ["claude", "pi"], fallbackProvider: "pi" },
  );
  assert.equal(fallback.agent.provider, "pi");

  assert.throws(() => parseSiliconEmployeeDraft("这不是 JSON"), SiliconEmployeeDraftError);
  assert.throws(() => parseSiliconEmployeeDraft(JSON.stringify({ name: "", duty: "", prompt: "" })), /名字/);
  assert.throws(
    () => parseSiliconEmployeeDraft(JSON.stringify({ name: "有名字", duty: "职责", prompt: "" })),
    /角色设定/,
  );
});

test("员工起草：只把已安装的 CLI 交给模型，并带上重名避让清单", () => {
  const available = availableEmployeeProviders("pi", (agent) => agent.provider !== "claude");
  assert.equal(available[0], "pi");
  assert.equal(available.includes("claude"), false);

  const request = buildEmployeeDraftPrompt("帮我盯着线上接口", available, ["现有员工"]);
  assert.match(request.system, /不要与已有员工重名：现有员工/);
  assert.match(request.system, /"pi"（Pi coding agent）/);
  assert.equal(request.prompt.includes("帮我盯着线上接口"), true);
  assert.match(request.prompt, /帮我盯着线上接口/);

  // 一个 CLI 都没装时仍要给出可用的 provider 清单，而不是空列表。
  const none = availableEmployeeProviders("claude", () => false);
  assert.deepEqual(none, []);
  assert.match(buildEmployeeDraftPrompt("写代码", none).system, /"claude"（Claude Code）/);
});

test("员工起草：空期望与超长期望在调模型前就被拒", async () => {
  await assert.rejects(
    generateSiliconEmployeeDraft("   ", {}, { isProviderAvailable: () => false }),
    (error: unknown) => error instanceof SiliconEmployeeDraftError && error.code === "EMPTY_EXPECTATION",
  );
  await assert.rejects(
    generateSiliconEmployeeDraft("x".repeat(4_001), {}, { isProviderAvailable: () => false }),
    (error: unknown) => error instanceof SiliconEmployeeDraftError && error.code === "EXPECTATION_TOO_LONG",
  );
});

test("员工起草接口：注入生成器返回草稿，失败以 400 回传", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-employee-draft-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const calls: Array<{ expectation: string; existingNames: string[] }> = [];
  const app = express();
  app.use(express.json());
  registerSiliconEmployeeRoutes(app, {
    storage,
    generateDraft: async (request) => {
      calls.push(request);
      if (request.expectation === "boom") throw new Error("系统 AI 不可用");
      return { name: "接口守夜人", duty: "守护接口稳定", prompt: "你是值守接口的工程师。", agent: employeeAgentFor("claude") };
    },
  });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const post = async (body: unknown) => {
    const response = await fetch(`${base}/api/silicon-employees/draft`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };

  storage.saveSiliconEmployee(employee({ name: "既有员工" }));
  const ok = await post({ expectation: "帮我盯着线上接口" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json?.draft, {
    name: "接口守夜人", duty: "守护接口稳定", prompt: "你是值守接口的工程师。", agent: employeeAgentFor("claude"),
  });
  assert.deepEqual(calls[0], { expectation: "帮我盯着线上接口", existingNames: ["既有员工"] });

  const failed = await post({ expectation: "boom" });
  assert.equal(failed.status, 400, JSON.stringify(failed.json));
  assert.match(String(failed.json?.error), /系统 AI 不可用/);
});
